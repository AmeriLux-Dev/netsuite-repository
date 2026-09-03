import type {
    EntityRelationship,
    JoinDef,
    JoinKeys,
    QueryConfig,
    QueryField,
    RelationshipFieldMap,
} from '../types';
import type { EntityModelMetadata, JoinMetadata, NavigationMetadata, PropertyMetadata } from './metadata';

export class ModelValidationError extends Error {
    constructor(public readonly entityName: string, public readonly problems: string[]) {
        super(`Model '${entityName}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'ModelValidationError';
    }
}

interface CompiledScope {
    tableAlias: string;
    keyPrefix: string;
    nestPathPrefix: string;
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

function describeEntity(metadata: EntityModelMetadata): string {
    return metadata.name ?? metadata.recordType ?? 'unnamed';
}

function toJoinDef(join: JoinMetadata, rootAlias: string): JoinDef {
    const joinDef: JoinDef = {
        toTable: { name: join.table, alias: join.alias },
        fromTable: join.from ?? rootAlias,
        type: join.type ?? 'leftOuter',
    };

    if (typeof join.on === 'string') {
        return omitUndefined({ ...joinDef, on: join.on, params: join.params });
    }

    const joinKeys: JoinKeys[] = Array.isArray(join.on) ? join.on : [join.on];
    return { ...joinDef, constraints: joinKeys.map((keys) => ({ joinKeys: keys })) };
}

function compileScalarField(property: PropertyMetadata, scope: CompiledScope, isKey: boolean): QueryField {
    const queryFieldId = property.column ?? property.name.toLowerCase();
    const recordFieldId = property.recordFieldId ?? (property.recordFieldFollowsColumn ? queryFieldId : undefined);
    const isWritable = recordFieldId !== undefined || property.updateMapping !== undefined;

    return omitUndefined<QueryField>({
        queryFieldId,
        tableAlias: property.tableAlias ?? scope.tableAlias,
        type: property.type ?? (isKey ? 'integer' : 'string'),
        alias: property.alias,
        isPrimary: isKey ? true : undefined,
        select: property.selectByDefault === false ? false : undefined,
        useText: property.useText ? true : undefined,
        transform: property.transform,
        setFirst: property.setFirst ? true : undefined,
        coerce: property.coerce,
        recordFieldId,
        readonly: property.readOnly || !isWritable ? true : undefined,
        updateMapping: property.updateMapping,
        source: property.source,
        meta: property.meta,
        nestPath: scope.nestPathPrefix ? `${scope.nestPathPrefix}.${property.name}` : undefined,
    });
}

function compileNavigationField(navigation: NavigationMetadata, property: PropertyMetadata, scope: CompiledScope): QueryField {
    const field = compileScalarField(property, scope, false);

    if (navigation.kind === 'related') {
        delete field.recordFieldId;
        delete field.updateMapping;
        field.readonly = true;
        return field;
    }

    if (navigation.kind === 'owned') {
        return omitUndefined<QueryField>({
            ...field,
            recordAccess: 'subrecord',
            recordAccessId: navigation.subrecordFieldId,
            subrecordNeedsReload: navigation.clearListFieldId ? true : undefined,
            subrecordListFieldToClear: navigation.clearListFieldId,
        });
    }

    const matchByProperty = navigation.matchByProperty ? navigation.properties.get(navigation.matchByProperty) : undefined;
    const isWritable = field.readonly !== true;
    return omitUndefined<QueryField>({
        ...field,
        cardinality: 'many',
        recordAccess: 'sublist',
        recordAccessId: navigation.sublistId,
        updateMapping: isWritable && !property.updateMapping
            ? omitUndefined({ kind: 'sublist' as const, sublistId: navigation.sublistId as string, fieldId: field.recordFieldId, matchBy: matchByProperty?.recordFieldId })
            : field.updateMapping,
    });
}

function compileRelationship(navigation: NavigationMetadata, relationshipFields: RelationshipFieldMap): EntityRelationship | undefined {
    const fields = { ...relationshipFields, ...(navigation.additionalRelationshipFields ?? {}) };

    if (navigation.kind === 'owned') {
        return omitUndefined({
            kind: 'owned' as const,
            recordAccessId: navigation.subrecordFieldId as string,
            fields,
            reload: navigation.clearListFieldId ? { listFieldToClear: navigation.clearListFieldId } : undefined,
        });
    }

    if (navigation.kind === 'collection') {
        return omitUndefined({
            kind: 'collection' as const,
            recordAccessId: navigation.sublistId as string,
            fields,
            matchField: navigation.matchByProperty,
            lineField: navigation.lineNumberProperty,
        });
    }

    return undefined;
}

function collectValidationProblems(metadata: EntityModelMetadata): string[] {
    const problems: string[] = [];
    const rootAlias = metadata.table?.alias;

    if (!metadata.recordType) {
        problems.push('recordType is required (use @Entity({ recordType }) or toRecord()).');
    }
    if (!metadata.table) {
        problems.push('table is required (use @Entity({ table }) or toTable()).');
    }

    const scalarNames = Array.from(metadata.properties.keys()).filter((name) => !metadata.ignoredProperties.has(name));
    const keyProperty = metadata.keyProperty ?? (scalarNames.includes('id') ? 'id' : undefined);
    if (!keyProperty) {
        problems.push("a key property is required (use @Key(), hasKey(), or a property named 'id').");
    } else if (!scalarNames.includes(keyProperty)) {
        problems.push(`key property '${keyProperty}' is not a declared scalar property.`);
    } else if (metadata.properties.get(keyProperty)?.selectByDefault === false) {
        problems.push(`key property '${keyProperty}' cannot be excluded from the default select.`);
    }

    const joinAliases = new Map<string, string>();
    const registerJoin = (join: JoinMetadata, owner: string) => {
        if (join.alias === rootAlias) {
            problems.push(`join alias '${join.alias}' on ${owner} collides with the root table alias.`);
        } else if (joinAliases.has(join.alias)) {
            problems.push(`join alias '${join.alias}' on ${owner} is already declared on ${joinAliases.get(join.alias)}.`);
        } else {
            joinAliases.set(join.alias, owner);
        }
    };
    for (const join of metadata.joins) {
        registerJoin(join, 'the entity');
    }
    for (const navigation of metadata.navigations.values()) {
        if (navigation.join) {
            registerJoin(navigation.join, `navigation '${navigation.name}'`);
        }
    }

    const knownAliases = new Set<string>([...(rootAlias ? [rootAlias] : []), ...joinAliases.keys()]);
    const seenKeys = new Map<string, string>();
    const registerKey = (key: string, owner: string) => {
        if (seenKeys.has(key)) {
            problems.push(`field key '${key}' from ${owner} collides with ${seenKeys.get(key)}.`);
        } else {
            seenKeys.set(key, owner);
        }
    };

    for (const name of scalarNames) {
        registerKey(name, `property '${name}'`);
        const tableAlias = metadata.properties.get(name)?.tableAlias;
        if (tableAlias !== undefined && !knownAliases.has(tableAlias)) {
            problems.push(`property '${name}' references unknown table alias '${tableAlias}'.`);
        }
    }

    for (const navigation of metadata.navigations.values()) {
        if (metadata.properties.has(navigation.name) && !metadata.ignoredProperties.has(navigation.name)) {
            problems.push(`navigation '${navigation.name}' collides with a scalar property of the same name.`);
        }
        if (navigation.properties.size === 0) {
            problems.push(`navigation '${navigation.name}' declares no properties.`);
        }
        if (!navigation.join && !navigation.sourceAlias) {
            problems.push(`navigation '${navigation.name}' needs a join or a source alias so its columns can be queried.`);
        } else if (navigation.sourceAlias !== undefined && !knownAliases.has(navigation.sourceAlias)) {
            problems.push(`navigation '${navigation.name}' references unknown source alias '${navigation.sourceAlias}'.`);
        }
        if (navigation.kind === 'owned' && !navigation.subrecordFieldId) {
            problems.push(`owned navigation '${navigation.name}' requires a subrecord field id (never inferred).`);
        }
        if (navigation.kind === 'collection' && !navigation.sublistId) {
            problems.push(`collection navigation '${navigation.name}' requires a sublist id (never inferred).`);
        }
        if (navigation.kind === 'collection') {
            for (const [optionName, propertyName] of [['matchBy', navigation.matchByProperty], ['lineNumberProperty', navigation.lineNumberProperty]] as const) {
                if (propertyName !== undefined && !navigation.properties.has(propertyName)) {
                    problems.push(`collection navigation '${navigation.name}' ${optionName} '${propertyName}' is not one of its properties.`);
                }
            }
        }
        if (navigation.kind === 'related') {
            for (const property of navigation.properties.values()) {
                if (property.recordFieldId !== undefined) {
                    problems.push(`related navigation '${navigation.name}' property '${property.name}' cannot declare a record field; related navigations are read-only.`);
                }
            }
        }
        for (const property of navigation.properties.values()) {
            registerKey(`${navigation.name}_${property.name}`, `navigation '${navigation.name}' property '${property.name}'`);
            if (property.tableAlias !== undefined && !knownAliases.has(property.tableAlias)) {
                problems.push(`navigation '${navigation.name}' property '${property.name}' references unknown table alias '${property.tableAlias}'.`);
            }
        }
    }

    return problems;
}

/**
 * Turns authoring-surface metadata into the QueryConfig the runtime consumes.
 * Both decorators and the fluent API produce EntityModelMetadata, so this is the only place a config is derived.
 */
export function compileEntityModel<TResult = unknown>(metadata: EntityModelMetadata): QueryConfig<TResult> {
    const problems = collectValidationProblems(metadata);
    if (problems.length > 0) {
        throw new ModelValidationError(describeEntity(metadata), problems);
    }

    const table = metadata.table as QueryConfig<TResult>['query']['from'];
    const rootScope: CompiledScope = { tableAlias: table.alias, keyPrefix: '', nestPathPrefix: '' };
    const keyProperty = metadata.keyProperty ?? 'id';
    const fields: Record<string, QueryField> = {};
    const relationships: Record<string, EntityRelationship> = {};
    const joins: JoinDef[] = metadata.joins.map((join) => toJoinDef(join, table.alias));

    for (const property of metadata.properties.values()) {
        if (!metadata.ignoredProperties.has(property.name)) {
            fields[property.name] = compileScalarField(property, rootScope, property.name === keyProperty);
        }
    }

    for (const navigation of metadata.navigations.values()) {
        if (navigation.join) {
            joins.push(toJoinDef(navigation.join, table.alias));
        }

        const scope: CompiledScope = {
            tableAlias: navigation.join?.alias ?? navigation.sourceAlias ?? table.alias,
            keyPrefix: `${navigation.name}_`,
            nestPathPrefix: navigation.name,
        };
        const relationshipFields: RelationshipFieldMap = {};

        for (const property of navigation.properties.values()) {
            const key = `${scope.keyPrefix}${property.name}`;
            fields[key] = compileNavigationField(navigation, property, scope);
            relationshipFields[property.name] = key;
        }

        const relationship = compileRelationship(navigation, relationshipFields);
        if (relationship) {
            relationships[navigation.name] = relationship;
        }
    }

    return omitUndefined<QueryConfig<TResult>>({
        recordType: metadata.recordType as string,
        query: omitUndefined({ from: { name: table.name, alias: table.alias }, joins: joins.length > 0 ? joins : undefined }),
        fields,
        relationships: Object.keys(relationships).length > 0 ? relationships : undefined,
        restRecordMetadata: metadata.restRecordMetadata,
        composite: metadata.composite,
        postProcess: metadata.postProcess as QueryConfig<TResult>['postProcess'],
        coerce: metadata.coerce ?? true,
        updaterOptions: metadata.updaterOptions,
    });
}
