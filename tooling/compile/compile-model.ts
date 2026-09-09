import type { EntityRelationship, QueryComponent, QueryConfig, QueryField, RelationshipFieldMap, RelationshipLoad } from '../../src/types';
import type { ResolvedClass, ResolvedField, ResolvedRelation } from '../collect/model-resolver';

export class ModelValidationError extends Error {
    constructor(public readonly className: string, public readonly problems: string[]) {
        super(`Model '${className}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'ModelValidationError';
    }
}

function omitUndefined<T extends object>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry;
        }
    }
    return result as T;
}

/** Turns a resolved record type into the QueryConfig the runtime consumes. */
export function compileModel(model: ResolvedClass): QueryConfig<unknown> {
    const problems: string[] = [];
    if (!model.recordType) problems.push('a record type is required (@RecordType).');
    if (!model.fields.some((field) => field.name === model.keyProperty)) problems.push(`internal id property '${model.keyProperty}' is not declared.`);
    if (problems.length > 0) {
        throw new ModelValidationError(model.className, problems);
    }

    const components: Record<string, QueryComponent> = {};
    const fields: Record<string, QueryField> = {};
    const relationships: Record<string, EntityRelationship> = {};

    const registerField = (key: string, field: QueryField) => {
        if (fields[key]) {
            throw new ModelValidationError(model.className, [`field key '${key}' is produced twice; rename one of the properties.`]);
        }
        fields[key] = omitUndefined(field);
    };

    const commonFieldShape = (field: ResolvedField): Partial<QueryField> => ({
        type: field.type,
        select: field.selectByDefault === false ? false : undefined,
        fieldContext: field.text ? 'DISPLAY' : undefined,
        transform: field.transform,
        coerce: field.coerce,
        setFirst: field.setFirst ? true : undefined,
    });

    for (const field of model.fields) {
        registerField(field.name, {
            queryFieldId: field.queryFieldId,
            ...commonFieldShape(field),
            isPrimary: field.name === model.keyProperty ? true : undefined,
            recordFieldId: field.readOnly ? undefined : field.recordFieldId,
            readonly: field.readOnly ? true : undefined,
        });
    }

    interface RelationContext {
        path: string[];
        /** The depth-1 relation this belongs to; its kind decides how fields are written and its load how they are read. */
        root: ResolvedRelation;
        rootComponents: string[];
        rootFields: RelationshipFieldMap;
        insideSublist: boolean;
    }

    function compileRelation(relation: ResolvedRelation, context: RelationContext): void {
        const path = [...context.path, relation.name];
        const componentPath = path.join('.');
        const parentPath = context.path.length > 0 ? context.path.join('.') : undefined;
        context.rootComponents.push(componentPath);
        const load: RelationshipLoad = context.path.length === 0 ? relation.load : context.root.load;
        components[componentPath] = omitUndefined({
            path: componentPath,
            parent: parentPath,
            relationship: context.root.name,
            load,
            join: relation.join,
            conditions: relation.filter,
            separate: relation.separate,
            lineOrderFieldId: relation.lineOrderFieldId,
        });

        const insideSublist = context.insideSublist || relation.kind === 'sublist';
        const isDirect = context.path.length === 0;
        const rootKind = context.root.kind;

        for (const field of relation.fields) {
            const key = `${path.join('_')}_${field.name}`;
            const nestedPath = `${path.slice(1).join('.')}${path.length > 1 ? '.' : ''}${field.name}`;
            context.rootFields[nestedPath] = key;
            const common: QueryField = {
                queryFieldId: field.queryFieldId,
                component: componentPath,
                ...commonFieldShape(field),
                nestPath: `${componentPath}.${field.name}`,
                cardinality: insideSublist ? 'many' : undefined,
            };

            if (!isDirect || rootKind === 'reference') {
                registerField(key, { ...common, readonly: true });
                continue;
            }

            if (rootKind === 'subrecord') {
                registerField(key, {
                    ...common,
                    recordFieldId: field.readOnly ? undefined : field.recordFieldId,
                    readonly: field.readOnly ? true : undefined,
                    recordAccess: 'subrecord',
                    recordAccessId: relation.subrecordFieldId,
                    subrecordNeedsReload: relation.clearListField ? true : undefined,
                    subrecordListFieldToClear: relation.clearListField,
                });
                continue;
            }

            // The line key writes through its declared field id even though the internal id is read-only elsewhere: it is what identifies the line.
            const isLineKey = field.name === relation.lineKeyProperty;
            const recordFieldId = isLineKey || !field.readOnly ? field.recordFieldId : undefined;
            const lineKeyFieldId = relation.fields.find((candidate) => candidate.name === relation.lineKeyProperty)?.recordFieldId;
            registerField(key, {
                ...common,
                recordFieldId,
                readonly: recordFieldId === undefined ? true : undefined,
                recordAccess: 'sublist',
                recordAccessId: relation.sublistId,
                updateMapping: recordFieldId === undefined ? undefined : { kind: 'sublist', sublistId: relation.sublistId as string, fieldId: recordFieldId, matchBy: lineKeyFieldId },
            });
        }

        for (const nested of relation.relations) {
            compileRelation(nested, { ...context, path, insideSublist });
        }
    }

    for (const relation of model.relations) {
        const rootComponents: string[] = [];
        const rootFields: RelationshipFieldMap = {};
        compileRelation(relation, { path: [], root: relation, rootComponents, rootFields, insideSublist: false });
        const base = omitUndefined({ fields: rootFields, components: rootComponents, load: relation.load, selectByDefault: relation.selectByDefault === false ? false : undefined });
        if (relation.kind === 'reference') {
            relationships[relation.name] = { kind: 'reference', ...base };
        } else if (relation.kind === 'subrecord') {
            relationships[relation.name] = omitUndefined({ kind: 'subrecord', recordAccessId: relation.subrecordFieldId as string, ...base, reload: relation.clearListField ? { listFieldToClear: relation.clearListField } : undefined });
        } else {
            relationships[relation.name] = omitUndefined({ kind: 'sublist', recordAccessId: relation.sublistId as string, ...base, matchField: relation.lineKeyProperty });
        }
    }

    return omitUndefined<QueryConfig<unknown>>({
        recordType: model.recordType as string,
        queryType: model.queryType,
        rootConditions: model.rootFilter,
        components,
        fields,
        relationships: Object.keys(relationships).length > 0 ? relationships : undefined,
        coerce: model.coerce ?? true,
        updaterOptions: model.updaterOptions,
    });
}
