import type { EntityRelationship, JoinDef, QueryConfig, QueryField, QueryParamValue, RelationshipFieldMap } from '../../src/types';
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

/** Where a set of fields is read from: the alias of its table plus the type tables reachable from it. */
interface Scope {
    alias: string;
    keyColumn: string;
    typeTables: Record<string, { key?: string }> | undefined;
    typeTableAliases: Map<string, string>;
}

class AliasRegistry {
    private readonly used = new Set<string>();

    claim(candidate: string): string {
        let alias = candidate;
        let suffix = 2;
        while (this.used.has(alias)) {
            alias = `${candidate}_${suffix++}`;
        }
        this.used.add(alias);
        return alias;
    }
}

/** Turns a resolved record type into the QueryConfig the runtime consumes. */
export function compileModel(model: ResolvedClass): QueryConfig<unknown> {
    const problems: string[] = [];
    if (!model.recordType) problems.push('a record type is required (@RecordType).');
    if (!model.table) problems.push(`no SuiteQL table is known for record type '${model.recordType}'; declare it with @RecordType('${model.recordType}', { table }).`);
    if (!model.fields.some((field) => field.name === model.keyProperty)) problems.push(`internal id property '${model.keyProperty}' is not declared.`);
    if (problems.length > 0) {
        throw new ModelValidationError(model.className, problems);
    }

    const aliases = new AliasRegistry();
    const rootAlias = aliases.claim(model.table as string);
    const joins: JoinDef[] = [];
    const fields: Record<string, QueryField> = {};
    const relationships: Record<string, EntityRelationship> = {};
    const keyField = model.fields.find((field) => field.name === model.keyProperty) as ResolvedField;

    const registerField = (key: string, field: QueryField) => {
        if (fields[key]) {
            throw new ModelValidationError(model.className, [`field key '${key}' is produced twice; rename one of the properties.`]);
        }
        fields[key] = omitUndefined(field);
    };

    /** Joins a type table on demand and returns its alias. */
    const typeTableAlias = (scope: Scope, table: string, joinedAliases?: string[]): string => {
        const existing = scope.typeTableAliases.get(table);
        if (existing) {
            return existing;
        }
        const key = scope.typeTables?.[table]?.key ?? 'id';
        const alias = aliases.claim(scope.alias === table ? `${table}_type` : table);
        joins.push({ toTable: { name: table, alias }, fromTable: scope.alias, type: 'inner', constraints: [{ joinKeys: { sourceForeignKey: scope.keyColumn, targetPrimaryKey: key } }] });
        scope.typeTableAliases.set(table, alias);
        joinedAliases?.push(alias);
        return alias;
    };

    const rootScope: Scope = { alias: rootAlias, keyColumn: keyField.column, typeTables: model.typeTables, typeTableAliases: new Map() };

    for (const field of model.fields) {
        const isKey = field.name === model.keyProperty;
        registerField(field.name, {
            queryFieldId: field.column,
            tableAlias: field.table ? typeTableAlias(rootScope, field.table) : rootAlias,
            type: field.type,
            isPrimary: isKey ? true : undefined,
            select: field.selectByDefault === false ? false : undefined,
            useText: field.text ? true : undefined,
            transform: field.transform,
            setFirst: field.setFirst ? true : undefined,
            coerce: field.coerce,
            recordFieldId: field.fieldId,
            readonly: field.fieldId === undefined ? true : undefined,
        });
    }

    interface RelationContext {
        path: string[];
        parentScope: Scope;
        /** The depth-1 relation this belongs to; its kind decides how fields are written. */
        root: ResolvedRelation;
        rootAliases: string[];
        rootFields: RelationshipFieldMap;
        insideSublist: boolean;
    }

    function compileRelation(relation: ResolvedRelation, context: RelationContext): void {
        const path = [...context.path, relation.name];
        const alias = aliases.claim(path.join('_'));
        context.rootAliases.push(alias);
        const parentAlias = context.parentScope.alias;
        let on: string;
        let params: QueryParamValue[] | undefined;

        if (relation.kind === 'reference') {
            const sourceAlias = relation.selectFieldTable ? typeTableAlias(context.parentScope, relation.selectFieldTable, context.rootAliases) : parentAlias;
            on = `${alias}.${relation.targetKeyColumn} = ${sourceAlias}.${relation.selectFieldColumn}`;
            if (relation.targetDiscriminator) {
                on += ` AND ${alias}.${relation.targetDiscriminator.column} = ?`;
                params = [relation.targetDiscriminator.value];
            }
            joins.push(omitUndefined({ toTable: { name: relation.targetTable as string, alias }, fromTable: parentAlias, type: relation.joinType, on, params }));
        } else if (relation.kind === 'subrecord') {
            on = `${alias}.${relation.subrecordKey} = ${parentAlias}.${relation.subrecordFieldId}`;
            joins.push({ toTable: { name: relation.subrecordTable as string, alias }, fromTable: parentAlias, type: relation.joinType, on });
        } else {
            on = `${alias}.${relation.parentColumn} = ${parentAlias}.${context.parentScope.keyColumn}`;
            if (relation.where) {
                on += ` AND ${relation.where.replace(/\{alias\}/g, alias)}`;
            }
            joins.push({ toTable: { name: relation.sublistTable as string, alias }, fromTable: parentAlias, type: relation.joinType, on });
        }

        const scope: Scope = {
            alias,
            keyColumn: relation.kind === 'sublist' ? (relation.lineKey?.column ?? 'id') : (relation.targetKeyColumn ?? 'id'),
            typeTables: relation.targetTypeTables,
            typeTableAliases: new Map(),
        };
        const insideSublist = context.insideSublist || relation.kind === 'sublist';
        const isDirect = context.path.length === 0;
        const rootKind = context.root.kind;

        for (const field of relation.fields) {
            const key = `${path.join('_')}_${field.name}`;
            const nestedPath = `${path.slice(1).join('.')}${path.length > 1 ? '.' : ''}${field.name}`;
            context.rootFields[nestedPath] = key;
            const tableAlias = field.table ? typeTableAlias(scope, field.table, context.rootAliases) : alias;
            const common: QueryField = {
                queryFieldId: field.column,
                tableAlias,
                type: field.type,
                nestPath: `${path.join('.')}.${field.name}`,
                cardinality: insideSublist ? 'many' : undefined,
                select: field.selectByDefault === false ? false : undefined,
                useText: field.text ? true : undefined,
                transform: field.transform,
                coerce: field.coerce,
                setFirst: field.setFirst ? true : undefined,
            };

            if (!isDirect || rootKind === 'reference') {
                registerField(key, { ...common, readonly: true });
                continue;
            }

            if (rootKind === 'subrecord') {
                registerField(key, {
                    ...common,
                    recordFieldId: field.fieldId,
                    readonly: field.fieldId === undefined ? true : undefined,
                    recordAccess: 'subrecord',
                    recordAccessId: relation.subrecordFieldId,
                    subrecordNeedsReload: relation.clearListField ? true : undefined,
                    subrecordListFieldToClear: relation.clearListField,
                });
                continue;
            }

            const isLineKey = field.name === relation.lineKeyProperty;
            const fieldId = isLineKey ? relation.lineKey?.field : field.fieldId;
            registerField(key, {
                ...common,
                recordFieldId: fieldId,
                readonly: fieldId === undefined ? true : undefined,
                recordAccess: 'sublist',
                recordAccessId: relation.sublistId,
                updateMapping: fieldId === undefined ? undefined : { kind: 'sublist', sublistId: relation.sublistId as string, fieldId, matchBy: relation.lineKey?.field },
            });
        }

        for (const nested of relation.relations) {
            compileRelation(nested, { ...context, path, parentScope: scope, insideSublist });
        }
    }

    for (const relation of model.relations) {
        const rootAliases: string[] = [];
        const rootFields: RelationshipFieldMap = {};
        compileRelation(relation, { path: [], parentScope: rootScope, root: relation, rootAliases, rootFields, insideSublist: false });
        const base = omitUndefined({ fields: rootFields, joinAliases: rootAliases, selectByDefault: relation.selectByDefault === false ? false : undefined });
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
        query: omitUndefined({ from: { name: model.table as string, alias: rootAlias }, joins: joins.length > 0 ? joins : undefined }),
        fields,
        relationships: Object.keys(relationships).length > 0 ? relationships : undefined,
        discriminator: model.discriminator,
        restRecordMetadata: model.restRecordMetadata,
        coerce: model.coerce ?? true,
        updaterOptions: model.updaterOptions,
    });
}
