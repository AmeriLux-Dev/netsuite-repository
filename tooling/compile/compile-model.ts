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

    const registerComponent = (component: QueryComponent) => {
        const compiled = omitUndefined(component);
        const existing = components[compiled.path];
        if (existing && JSON.stringify(existing) !== JSON.stringify(compiled)) {
            throw new ModelValidationError(model.className, [`component '${compiled.path}' is produced twice; rename the property or read the field through another relationship.`]);
        }
        components[compiled.path] = compiled;
    };

    /**
     * The component a field read through a relationship comes from, joined off its owner's component (the root when
     * `ownerPath` is undefined) and shared by every field of that owner read through the same relationship.
     */
    const relationshipComponentPathOf = (field: ResolvedField, ownerPath: string | undefined): string | undefined => {
        if (!field.relationship) {
            return undefined;
        }
        return ownerPath === undefined ? field.relationship.fieldId : `${ownerPath}.${field.relationship.fieldId}`;
    };

    const registerRelationshipComponent = (field: ResolvedField, ownerPath: string | undefined, relationship: string | undefined, load: RelationshipLoad): string | undefined => {
        const path = relationshipComponentPathOf(field, ownerPath);
        if (path === undefined || !field.relationship) {
            return undefined;
        }
        registerComponent({
            path,
            parent: ownerPath,
            relationship: relationship ?? path,
            load,
            join: { kind: 'auto', fieldId: field.relationship.fieldId },
            conditions: field.relationship.filter,
        });
        return path;
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
            component: registerRelationshipComponent(field, undefined, undefined, 'join'),
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
        /** The fields of the class that declares the relation: where a reference finds its select field. */
        ownerFields: ResolvedField[];
        /** The component the owner's fields are read on: the root when undefined; past further joins, the last hop. */
        ownerComponentPath?: string;
    }

    function compileRelation(relation: ResolvedRelation, context: RelationContext): void {
        const path = [...context.path, relation.name];
        const componentPath = path.join('.');
        const ownerPath = context.ownerComponentPath;
        // A reference joins from wherever its select field is read: the component of a relationship the owner reads it through.
        const selectField = relation.kind === 'reference' ? context.ownerFields.find((field) => field.name === relation.selectFieldProperty) : undefined;
        const parentPath = (selectField && relationshipComponentPathOf(selectField, ownerPath)) ?? ownerPath;
        context.rootComponents.push(componentPath);
        const load: RelationshipLoad = context.path.length === 0 ? relation.load : context.root.load;
        // Items past further joins: one component per hop, each hanging off the one before, and the items' fields read
        // on the last. The hop components carry no fields of their own, so the items keep their paths.
        const hops = relation.through ?? [];
        const hopPaths = hops.reduce<string[]>((paths, hop) => [...paths, `${paths[paths.length - 1] ?? componentPath}.${hop.join.fieldId}`], []);
        const itemsComponentPath = hopPaths[hopPaths.length - 1] ?? componentPath;
        registerComponent({
            path: componentPath,
            parent: parentPath,
            relationship: context.root.name,
            load,
            join: relation.join,
            conditions: relation.filter,
            separate: relation.separate,
            lineOrderFieldId: relation.lineOrderFieldId,
            lineOrderComponent: hops.length > 0 ? itemsComponentPath : undefined,
        });
        hops.forEach((hop, index) => {
            context.rootComponents.push(hopPaths[index]);
            registerComponent({
                path: hopPaths[index],
                parent: index === 0 ? componentPath : hopPaths[index - 1],
                relationship: context.root.name,
                load,
                join: hop.join,
                conditions: hop.filter,
            });
        });

        const insideSublist = context.insideSublist || relation.kind === 'sublist';
        const isDirect = context.path.length === 0;
        const rootKind = context.root.kind;
        // Items reached through further joins are other records, not lines of the owner: nothing writes through them.
        const readOnlyItems = hops.length > 0;

        for (const field of relation.fields) {
            const key = `${path.join('_')}_${field.name}`;
            const nestedPath = `${path.slice(1).join('.')}${path.length > 1 ? '.' : ''}${field.name}`;
            context.rootFields[nestedPath] = key;
            const relationshipComponentPath = registerRelationshipComponent(field, itemsComponentPath, context.root.name, load);
            if (relationshipComponentPath !== undefined && !context.rootComponents.includes(relationshipComponentPath)) {
                context.rootComponents.push(relationshipComponentPath);
            }
            const common: QueryField = {
                queryFieldId: field.queryFieldId,
                component: relationshipComponentPath ?? itemsComponentPath,
                ...commonFieldShape(field),
                nestPath: `${componentPath}.${field.name}`,
                cardinality: insideSublist ? 'many' : undefined,
            };

            if (!isDirect || rootKind === 'reference' || readOnlyItems) {
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
            compileRelation(nested, { ...context, path, insideSublist, ownerFields: relation.fields, ownerComponentPath: itemsComponentPath });
        }
    }

    for (const relation of model.relations) {
        const rootComponents: string[] = [];
        const rootFields: RelationshipFieldMap = {};
        compileRelation(relation, { path: [], root: relation, rootComponents, rootFields, insideSublist: false, ownerFields: model.fields });
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
