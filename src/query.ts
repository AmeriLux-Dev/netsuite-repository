import type * as NsQuery from 'N/query';
import { coerceQueryResultValueByFieldType } from './coercion';
import { resolveQueryConfig } from './model/resolve';
import type { QueryConfigSource } from './model/resolve';
import type {
    BuiltQuery,
    FieldMap,
    FieldType,
    JoinDef,
    JoinKeys,
    JoinOn,
    JoinType,
    PaginationMode,
    QueryConfig,
    QueryExecution,
    QueryField,
    QueryOperator,
    QueryPageOptions,
    QueryParamValue,
    QueryResultValue,
    SortDirection,
} from './types';

declare const require: <T = unknown>(moduleName: string) => T;

interface ConditionDef {
    expression: string;
    params: QueryParamValue[];
    linkType: 'AND' | 'OR';
}

interface SortDef {
    expression: string;
    direction: SortDirection;
}

export interface DynamicJoinOptions {
    /** Join type; defaults to 'inner' for join() and is fixed by innerJoin()/leftJoin()/rightJoin(). */
    type?: JoinType;
    /** Alias of the table the equality keys are read from; defaults to the root table alias. */
    from?: string;
    /** Positional parameters for `?` placeholders in a raw predicate. */
    params?: QueryParamValue[];
}

export interface QueryBuilderOptions<TResult> {
    /** Receives every typed result set (executeTyped, firstTyped) and may substitute instances; used by change tracking. */
    resultObserver?: (results: TResult[]) => TResult[];
}

export interface RawSelectionOptions {
    type?: FieldType;
    nestPath?: string;
    coerce?: boolean;
    transform?: QueryField['transform'];
}

type SelectableField = [string, QueryField];

function getNsQuery(): typeof import('N/query') {
    return require<typeof import('N/query')>('N/query');
}

function countPlaceholders(sql: string): number {
    return (sql.match(/\?/g) ?? []).length;
}

export class QueryBuilder<TResult> {
    private readonly config: QueryConfig<TResult>;
    private readonly inheritedJoinAliases: string[];
    private readonly options: QueryBuilderOptions<TResult>;
    private trackingDisabled = false;
    private selectedKeys: Set<string> | null = null;
    private readonly rawSelections = new Map<string, QueryField>();
    private readonly conditions: ConditionDef[] = [];
    private readonly sorts: SortDef[] = [];
    private readonly dynamicJoins: JoinDef[] = [];
    private readonly includedRelationships = new Set<string>();
    private readonly excludedRelationships = new Set<string>();
    private limitValue: number | undefined;
    private offsetValue: number | undefined;
    private distinctFlag = false;
    private paginationMode: PaginationMode = 'offsetFetch';
    private coerceEnabled: boolean;

    private constructor(config: QueryConfig<TResult>, inheritedJoinAliases: string[] = [], options: QueryBuilderOptions<TResult> = {}) {
        this.config = config;
        this.inheritedJoinAliases = inheritedJoinAliases;
        this.options = options;
        this.coerceEnabled = config.coerce ?? false;
    }

    static from<TResult>(config: QueryConfigSource<TResult>, options: QueryBuilderOptions<TResult> = {}): QueryBuilder<TResult> {
        return new QueryBuilder(resolveQueryConfig(config), [], options);
    }

    /** Loads a reference, subrecord, or sublist that is not selected by default (EF Include). */
    include(...relationships: string[]): this {
        for (const name of relationships) {
            this.assertRelationship(name);
            this.includedRelationships.add(name);
            this.excludedRelationships.delete(name);
        }
        return this;
    }

    /** Leaves a reference, subrecord, or sublist and its joins out of this query. */
    exclude(...relationships: string[]): this {
        for (const name of relationships) {
            this.assertRelationship(name);
            this.excludedRelationships.add(name);
            this.includedRelationships.delete(name);
        }
        return this;
    }

    /** Results of this query are not registered with the owning context (EF AsNoTracking). */
    asNoTracking(): this {
        this.trackingDisabled = true;
        return this;
    }

    select(...keys: Array<keyof TResult | string>): this {
        if (!this.selectedKeys) {
            this.selectedKeys = new Set<string>();
        }

        for (const key of keys) {
            this.selectedKeys.add(this.normalizeFieldKey(String(key)));
        }

        return this;
    }

    selectAll(): this {
        this.selectedKeys = null;
        return this;
    }

    /**
     * Adds a computed column rendered verbatim, mapped onto the result under `alias`.
     * Usable in orderBy() and where() by its alias.
     */
    selectRaw(expression: string, alias: string, options: RawSelectionOptions = {}): this {
        if (this.config.fields[alias] || this.rawSelections.has(alias)) {
            throw new Error(`Alias '${alias}' is already used by a field in query config for '${this.config.recordType}'.`);
        }

        this.rawSelections.set(alias, {
            queryFieldId: alias,
            tableAlias: '',
            expression,
            alias,
            type: options.type,
            nestPath: options.nestPath,
            coerce: options.coerce,
            transform: options.transform,
        });
        return this;
    }

    distinct(): this {
        this.distinctFlag = true;
        return this;
    }

    /** Adds a join for this query only. Config joins are rendered first. */
    join(table: string, alias: string, on: JoinOn, options: DynamicJoinOptions = {}): this {
        this.assertJoinAliasAvailable(alias);
        this.dynamicJoins.push(this.toJoinDef(table, alias, on, options));
        return this;
    }

    innerJoin(table: string, alias: string, on: JoinOn, options: Omit<DynamicJoinOptions, 'type'> = {}): this {
        return this.join(table, alias, on, { ...options, type: 'inner' });
    }

    leftJoin(table: string, alias: string, on: JoinOn, options: Omit<DynamicJoinOptions, 'type'> = {}): this {
        return this.join(table, alias, on, { ...options, type: 'leftOuter' });
    }

    rightJoin(table: string, alias: string, on: JoinOn, options: Omit<DynamicJoinOptions, 'type'> = {}): this {
        return this.join(table, alias, on, { ...options, type: 'rightOuter' });
    }

    where(field: keyof TResult | string, operator: QueryOperator, value?: QueryParamValue | QueryParamValue[], useText = false): this {
        return this.addWhere('AND', field, operator, value, useText);
    }

    orWhere(field: keyof TResult | string, operator: QueryOperator, value?: QueryParamValue | QueryParamValue[], useText = false): this {
        return this.addWhere('OR', field, operator, value, useText);
    }

    whereRaw(sql: string, ...params: QueryParamValue[]): this {
        this.conditions.push({ expression: sql, params, linkType: 'AND' });
        return this;
    }

    orWhereRaw(sql: string, ...params: QueryParamValue[]): this {
        this.conditions.push({ expression: sql, params, linkType: 'OR' });
        return this;
    }

    whereIn(field: keyof TResult | string, values: QueryParamValue[] | undefined): this {
        return values && values.length > 0 ? this.where(field, 'IN', values) : this;
    }

    whereNotIn(field: keyof TResult | string, values: QueryParamValue[] | undefined): this {
        return values && values.length > 0 ? this.where(field, 'NOT IN', values) : this;
    }

    whereNull(field: keyof TResult | string): this {
        return this.where(field, 'IS NULL');
    }

    whereNotNull(field: keyof TResult | string): this {
        return this.where(field, 'IS NOT NULL');
    }

    whereBetween(field: keyof TResult | string, min: QueryParamValue | undefined, max: QueryParamValue | undefined): this {
        return min === undefined || max === undefined ? this : this.where(field, 'BETWEEN', [min, max]);
    }

    whereGroup(callback: (builder: QueryBuilder<TResult>) => QueryBuilder<TResult>): this {
        return this.addWhereGroup('AND', callback);
    }

    orWhereGroup(callback: (builder: QueryBuilder<TResult>) => QueryBuilder<TResult>): this {
        return this.addWhereGroup('OR', callback);
    }

    orderBy(field: keyof TResult | string, direction: SortDirection = 'ASC'): this {
        this.sorts.push({ expression: this.resolveFieldExpression(String(field)), direction });
        return this;
    }

    orderByAsc(field: keyof TResult | string): this {
        return this.orderBy(field, 'ASC');
    }

    orderByDesc(field: keyof TResult | string): this {
        return this.orderBy(field, 'DESC');
    }

    limit(count: number): this {
        this.limitValue = Math.max(0, Math.floor(count));
        return this;
    }

    offset(count: number): this {
        this.offsetValue = Math.max(0, Math.floor(count));
        return this;
    }

    page(pageNumber: number, pageSize: number): this {
        const safePage = Math.max(1, Math.floor(pageNumber));
        const safePageSize = Math.max(1, Math.floor(pageSize));
        this.limitValue = safePageSize;
        this.offsetValue = (safePage - 1) * safePageSize;
        return this;
    }

    /**
     * 'offsetFetch' (default) emits OFFSET ... ROWS FETCH NEXT ... ROWS ONLY.
     * 'top' emits TOP offset+limit and discards the offset rows client-side, which is the legacy behavior.
     */
    pagination(mode: PaginationMode): this {
        this.paginationMode = mode;
        return this;
    }

    /** Enables or disables read-side coercion of values to their declared field types for this query. */
    coerce(enabled = true): this {
        this.coerceEnabled = enabled;
        return this;
    }

    build(): BuiltQuery {
        return this.buildSelectQuery(true);
    }

    execute(): QueryExecution<TResult> {
        const built = this.build();
        const resultSet = getNsQuery().runSuiteQL({
            query: built.sql,
            params: built.params as Array<string | number | boolean>,
        });
        const rows = resultSet.asMappedResults() as Record<string, QueryResultValue>[];
        const data = this.paginationMode === 'top' && this.offsetValue ? rows.slice(this.offsetValue) : rows;

        return { data, query: built };
    }

    executeRaw(): Record<string, QueryResultValue>[] {
        return this.execute().data;
    }

    executeTyped(): TResult[] {
        const result = this.execute();
        return this.mapResults(result.data, result.query.fieldMap);
    }

    executePaged(options: QueryPageOptions = {}): NsQuery.PagedData {
        const built = this.buildSelectQuery(false);
        return getNsQuery().runSuiteQLPaged({
            query: built.sql,
            params: built.params as Array<string | number | boolean>,
            pageSize: options.pageSize ?? 1000,
        });
    }

    first(): Record<string, QueryResultValue> | null {
        const originalLimit = this.limitValue;
        this.limitValue = 1;
        const rows = this.executeRaw();
        this.limitValue = originalLimit;
        return rows[0] ?? null;
    }

    firstTyped(): TResult | null {
        const originalLimit = this.limitValue;
        this.limitValue = 1;
        const rows = this.executeTyped();
        this.limitValue = originalLimit;
        return rows[0] ?? null;
    }

    count(): number {
        const whereClause = this.buildWhereClause();
        let sql = `SELECT COUNT(*) AS "count"\nFROM ${this.buildFromClause()}`;
        if (whereClause) {
            sql += `\nWHERE ${whereClause}`;
        }

        const resultSet = getNsQuery().runSuiteQL({ query: sql, params: this.getParams() as Array<string | number | boolean> });
        const rows = resultSet.asMappedResults() as Array<{ count?: QueryResultValue }>;
        return Number(rows[0]?.count ?? 0);
    }

    exists(): boolean {
        const whereClause = this.buildWhereClause();
        let sql = `SELECT TOP 1 1 AS "exists"\nFROM ${this.buildFromClause()}`;
        if (whereClause) {
            sql += `\nWHERE ${whereClause}`;
        }

        return getNsQuery().runSuiteQL({ query: sql, params: this.getParams() as Array<string | number | boolean> }).asMappedResults().length > 0;
    }

    toSQL(): string {
        const built = this.build();
        let index = 0;
        return built.sql.replace(/\?/g, () => this.formatParam(built.params[index++]));
    }

    mapResults(rows: Record<string, QueryResultValue>[], fieldMap: FieldMap): TResult[] {
        if (rows.length === 0) {
            return [];
        }

        const arrayPaths = this.getArrayPaths();
        const primaryField = this.getPrimaryField();
        const results = arrayPaths.length > 0 && primaryField
            ? this.mapGroupedRows(rows, fieldMap, arrayPaths, primaryField.key.toLowerCase())
            : rows.map((row) => this.mapSingleRow(row, fieldMap, arrayPaths));

        const { postProcess } = this.config;
        const finalResults = postProcess ? results.map((row) => postProcess(row) ?? row) : results;
        return this.trackingDisabled || !this.options.resultObserver ? finalResults : this.options.resultObserver(finalResults);
    }

    private buildSelectQuery(includePagination: boolean): BuiltQuery {
        const fields = this.getFieldsToBuild();
        const fieldMap = this.buildFieldMap(fields);
        const distinct = this.distinctFlag ? 'DISTINCT ' : '';
        const useTop = includePagination && this.paginationMode === 'top' && this.limitValue !== undefined;
        const top = useTop ? `TOP ${(this.offsetValue ?? 0) + (this.limitValue as number)} ` : '';

        let sql = `SELECT ${distinct}${top}${this.buildSelectClause(fields)}\nFROM ${this.buildFromClause()}`;
        const whereClause = this.buildWhereClause();
        const orderByClause = this.buildOrderByClause();

        if (whereClause) {
            sql += `\nWHERE ${whereClause}`;
        }

        if (orderByClause) {
            sql += `\nORDER BY ${orderByClause}`;
        }

        if (includePagination && this.paginationMode === 'offsetFetch') {
            sql += this.buildOffsetFetchClause();
        }

        return {
            sql,
            params: this.getParams(),
            fieldMap,
        };
    }

    private buildOffsetFetchClause(): string {
        if (this.limitValue === undefined && !this.offsetValue) {
            return '';
        }

        let clause = `\nOFFSET ${this.offsetValue ?? 0} ROWS`;
        if (this.limitValue !== undefined) {
            clause += ` FETCH NEXT ${this.limitValue} ROWS ONLY`;
        }
        return clause;
    }

    private addWhere(linkType: 'AND' | 'OR', field: keyof TResult | string, operator: QueryOperator, value?: QueryParamValue | QueryParamValue[], useText = false): this {
        if (value === undefined && operator !== 'IS NULL' && operator !== 'IS NOT NULL') {
            return this;
        }

        const rawExpression = this.resolveFieldExpression(String(field));
        const expression = useText ? `BUILTIN.DF(${rawExpression})` : rawExpression;
        this.conditions.push({ ...this.buildCondition(expression, operator, value), linkType });
        return this;
    }

    private addWhereGroup(linkType: 'AND' | 'OR', callback: (builder: QueryBuilder<TResult>) => QueryBuilder<TResult>): this {
        const child = new QueryBuilder(this.config, this.getKnownAliases());
        callback(child);

        if (child.conditions.length === 0) {
            return this;
        }

        const expression = child.conditions
            .map((condition, index) => index === 0 ? condition.expression : `${condition.linkType} ${condition.expression}`)
            .join(' ');

        this.conditions.push({
            expression: `(${expression})`,
            params: child.conditions.flatMap((condition) => condition.params),
            linkType,
        });
        return this;
    }

    private buildCondition(expression: string, operator: QueryOperator, value?: QueryParamValue | QueryParamValue[]): Omit<ConditionDef, 'linkType'> {
        if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
            return { expression: `${expression} ${operator}`, params: [] };
        }

        if (operator === 'BETWEEN') {
            if (!Array.isArray(value) || value.length !== 2) {
                throw new Error('BETWEEN requires exactly two values.');
            }
            return { expression: `${expression} BETWEEN ? AND ?`, params: value };
        }

        if (operator === 'IN' || operator === 'NOT IN') {
            if (!Array.isArray(value) || value.length === 0) {
                throw new Error(`${operator} requires at least one value.`);
            }
            return { expression: `${expression} ${operator} (${value.map(() => '?').join(', ')})`, params: value };
        }

        if (Array.isArray(value)) {
            throw new Error(`${operator} does not accept an array value.`);
        }

        return { expression: `${expression} ${operator} ?`, params: [value ?? null] };
    }

    private toJoinDef(table: string, alias: string, on: JoinOn, options: DynamicJoinOptions): JoinDef {
        const joinDef: JoinDef = {
            toTable: { name: table, alias },
            fromTable: options.from ?? this.config.query.from.alias,
            type: options.type ?? 'inner',
        };

        if (typeof on === 'string') {
            const placeholderCount = countPlaceholders(on);
            const parameterCount = options.params?.length ?? 0;
            if (placeholderCount !== parameterCount) {
                throw new Error(`Join '${alias}' declares ${placeholderCount} placeholder(s) but received ${parameterCount} parameter(s).`);
            }
            return { ...joinDef, on, params: options.params };
        }

        if (options.params && options.params.length > 0) {
            throw new Error(`Join '${alias}' only accepts parameters with a raw predicate.`);
        }

        const joinKeys: JoinKeys[] = Array.isArray(on) ? on : [on];
        if (joinKeys.length === 0) {
            throw new Error(`Join '${alias}' requires at least one key pair.`);
        }

        return { ...joinDef, constraints: joinKeys.map((keys) => ({ joinKeys: keys })) };
    }

    private assertJoinAliasAvailable(alias: string): void {
        if (this.getKnownAliases().includes(alias)) {
            throw new Error(`Join alias '${alias}' is already used in the query for '${this.config.recordType}'.`);
        }
    }

    private getKnownAliases(): string[] {
        return [
            this.config.query.from.alias,
            ...(this.config.query.joins ?? []).map((join) => join.toTable.alias),
            ...this.inheritedJoinAliases,
            ...this.dynamicJoins.map((join) => join.toTable.alias),
        ];
    }

    private getFieldsToBuild(): SelectableField[] {
        const configuredFields = Object.entries(this.config.fields).filter(([key, field]) => {
            if (field.isPrimary) {
                return true;
            }
            const relationship = this.relationshipOf(key, field);
            if (relationship !== undefined && !this.isRelationshipActive(relationship)) {
                return false;
            }
            if (this.selectedKeys) {
                return this.selectedKeys.has(key);
            }
            if (field.select === false) {
                return relationship !== undefined && this.includedRelationships.has(relationship);
            }
            return true;
        });
        return [...configuredFields, ...Array.from(this.rawSelections.entries())];
    }

    private buildFieldMap(fields: SelectableField[]): FieldMap {
        const map: FieldMap = {};
        for (const [key, field] of fields) {
            const alias = (field.alias ?? key).toLowerCase();
            map[alias] = {
                key,
                outputPath: field.nestPath ?? key,
                field,
            };
        }
        return map;
    }

    private buildSelectClause(fields: SelectableField[]): string {
        if (fields.length === 0) {
            throw new Error('At least one selectable field is required.');
        }

        return fields.map(([key, field]) => {
            const alias = field.alias ?? key;
            const expression = field.expression ?? `${field.tableAlias}.${field.queryFieldId}`;
            return `${field.useText ? `BUILTIN.DF(${expression})` : expression} AS "${alias}"`;
        }).join(',\n       ');
    }

    private getAllJoins(): JoinDef[] {
        const inactiveAliases = new Set<string>();
        for (const [name, relationship] of Object.entries(this.config.relationships ?? {})) {
            if (!this.isRelationshipActive(name)) {
                (relationship.joinAliases ?? []).forEach((alias) => inactiveAliases.add(alias));
            }
        }
        const referencedSql = [
            ...this.conditions.map((condition) => condition.expression),
            ...this.sorts.map((sort) => sort.expression),
            ...Array.from(this.rawSelections.values()).map((selection) => selection.expression ?? ''),
        ].join('\n');
        const configuredJoins = (this.config.query.joins ?? []).filter((join) => !inactiveAliases.has(join.toTable.alias) || referencedSql.includes(`${join.toTable.alias}.`));
        return [...configuredJoins, ...this.dynamicJoins];
    }

    private buildFromClause(): string {
        const { from } = this.config.query;
        return [`${from.name} ${from.alias}`, ...this.getAllJoins().map((join) => `${this.joinTypeToSql(join.type)} ${join.toTable.name} ${join.toTable.alias} ON ${this.buildOnClause(join)}`)].join('\n');
    }

    private buildOnClause(join: JoinDef): string {
        if (join.on !== undefined) {
            return join.on;
        }

        const constraints = join.constraints ?? [];
        if (constraints.length === 0) {
            throw new Error(`Join '${join.toTable.alias}' requires an on predicate or at least one constraint.`);
        }

        return constraints.map((constraint, index) => {
            const sourceAlias = constraint.joinKeys.sourceTable ?? join.fromTable;
            const targetAlias = constraint.joinKeys.targetTable ?? join.toTable.alias;
            const expression = `${sourceAlias}.${constraint.joinKeys.sourceForeignKey} = ${targetAlias}.${constraint.joinKeys.targetPrimaryKey}`;
            return index === 0 ? expression : `${constraint.joinLinkType ?? 'AND'} ${expression}`;
        }).join(' ');
    }

    private buildWhereClause(): string {
        const userClause = this.conditions.map((condition, index) => index === 0 ? condition.expression : `${condition.linkType} ${condition.expression}`).join(' ');
        const { discriminator } = this.config;
        if (!discriminator) {
            return userClause;
        }
        const discriminatorClause = `${this.config.query.from.alias}.${discriminator.column} = ?`;
        return userClause ? `${discriminatorClause} AND (${userClause})` : discriminatorClause;
    }

    private buildOrderByClause(): string {
        return this.sorts.map((sort) => `${sort.expression} ${sort.direction}`).join(', ');
    }

    /** Accepts dotted paths (`customer.companyName`) for the flattened config keys (`customer_companyName`). */
    private normalizeFieldKey(fieldKey: string): string {
        if (this.config.fields[fieldKey] || !fieldKey.includes('.')) {
            return fieldKey;
        }
        const flattened = fieldKey.replace(/\./g, '_');
        return this.config.fields[flattened] ? flattened : fieldKey;
    }

    private assertRelationship(name: string): void {
        if (!this.config.relationships?.[name]) {
            throw new Error(`Relationship '${name}' is not defined in query config for '${this.config.recordType}'.`);
        }
    }

    /** True when the relationship's fields and joins take part in this query. */
    private isRelationshipActive(name: string): boolean {
        if (this.excludedRelationships.has(name)) {
            return false;
        }
        return this.includedRelationships.has(name) || this.config.relationships?.[name]?.selectByDefault !== false;
    }

    private relationshipOf(key: string, field: QueryField): string | undefined {
        const root = (field.nestPath ?? key).split('.')[0];
        return this.config.relationships?.[root] ? root : undefined;
    }

    private resolveFieldExpression(rawFieldKey: string): string {
        const fieldKey = this.normalizeFieldKey(rawFieldKey);
        const field = this.config.fields[fieldKey];
        if (field) {
            return field.expression ?? `${field.tableAlias}.${field.queryFieldId}`;
        }

        const rawSelection = this.rawSelections.get(fieldKey);
        if (rawSelection) {
            return rawSelection.expression as string;
        }

        const separatorIndex = fieldKey.indexOf('.');
        if (separatorIndex > 0 && this.getKnownAliases().includes(fieldKey.slice(0, separatorIndex))) {
            return fieldKey;
        }

        throw new Error(`Field '${fieldKey}' is not defined in query config for '${this.config.recordType}'.`);
    }

    private getParams(): QueryParamValue[] {
        const joinParams = this.getAllJoins().flatMap((join) => join.params ?? []);
        const discriminatorParams = this.config.discriminator ? [this.config.discriminator.value] : [];
        return [...joinParams, ...discriminatorParams, ...this.conditions.flatMap((condition) => condition.params)];
    }

    private getArrayPaths(): string[] {
        const paths = new Set<string>();
        for (const [key, field] of Object.entries(this.config.fields)) {
            if (field.cardinality === 'many') {
                const path = field.nestPath ?? key;
                paths.add(path.split('.')[0]);
            }
        }
        return Array.from(paths);
    }

    private getPrimaryField(): { key: string } | null {
        for (const [key, field] of Object.entries(this.config.fields)) {
            if (field.isPrimary) {
                return { key: field.alias ?? key };
            }
        }
        return null;
    }

    private mapGroupedRows(rows: Record<string, QueryResultValue>[], fieldMap: FieldMap, arrayPaths: string[], primaryAlias: string): TResult[] {
        const groups = new Map<QueryResultValue, Record<string, QueryResultValue>[]>();
        for (const row of rows) {
            const id = row[primaryAlias];
            if (id === undefined || id === null) {
                continue;
            }
            const group = groups.get(id) ?? [];
            group.push(row);
            groups.set(id, group);
        }
        return Array.from(groups.values()).map((groupRows) => this.mapRowGroup(groupRows, fieldMap, arrayPaths));
    }

    private mapRowGroup(rows: Record<string, QueryResultValue>[], fieldMap: FieldMap, arrayPaths: string[]): TResult {
        const base = this.mapSingleRow(rows[0], fieldMap, arrayPaths) as Record<string, unknown>;

        for (const arrayPath of arrayPaths) {
            base[arrayPath] = [];
        }

        const seen = new Set<string>();
        for (const row of rows) {
            for (const arrayPath of arrayPaths) {
                const item = this.buildArrayItem(row, fieldMap, arrayPath);
                if (!item || Object.keys(item).length === 0) {
                    continue;
                }
                const key = JSON.stringify(item);
                if (seen.has(`${arrayPath}:${key}`)) {
                    continue;
                }
                seen.add(`${arrayPath}:${key}`);
                (base[arrayPath] as unknown[]).push(item);
            }
        }

        return base as TResult;
    }

    private mapSingleRow(row: Record<string, QueryResultValue>, fieldMap: FieldMap, arrayPaths: string[]): TResult {
        const output: Record<string, unknown> = {};
        for (const [alias, mapping] of Object.entries(fieldMap)) {
            const path = mapping.outputPath;
            const value = this.transformValue(row[alias], row, mapping.field);
            if (arrayPaths.some((arrayPath) => path === arrayPath || path.startsWith(`${arrayPath}.`))) {
                continue;
            }
            this.setPath(output, path, value);
        }
        return output as TResult;
    }

    private buildArrayItem(row: Record<string, QueryResultValue>, fieldMap: FieldMap, arrayPath: string): Record<string, unknown> | null {
        const item: Record<string, unknown> = {};
        let hasValue = false;

        for (const [alias, mapping] of Object.entries(fieldMap)) {
            const path = mapping.outputPath;
            if (path !== arrayPath && !path.startsWith(`${arrayPath}.`)) {
                continue;
            }

            const itemPath = path === arrayPath ? mapping.key : path.slice(arrayPath.length + 1);
            const value = this.transformValue(row[alias], row, mapping.field);
            if (value !== null && value !== undefined && value !== '') {
                hasValue = true;
            }
            this.setPath(item, itemPath, value);
        }

        return hasValue ? item : null;
    }

    private transformValue(value: QueryResultValue, row: Record<string, QueryResultValue>, field: QueryField): unknown {
        const shouldCoerce = field.coerce ?? this.coerceEnabled;
        const coerced = shouldCoerce ? coerceQueryResultValueByFieldType(value, field.type) : value;
        return field.transform ? field.transform(coerced, row) : coerced;
    }

    private setPath(target: Record<string, unknown>, path: string, value: unknown): void {
        const parts = path.split('.').filter(Boolean);
        let cursor = target;

        for (let index = 0; index < parts.length - 1; index++) {
            const part = parts[index];
            const next = cursor[part];
            if (!next || typeof next !== 'object' || Array.isArray(next)) {
                cursor[part] = {};
            }
            cursor = cursor[part] as Record<string, unknown>;
        }

        cursor[parts[parts.length - 1]] = value;
    }

    private joinTypeToSql(type: JoinDef['type']): string {
        if (type === 'leftOuter') {
            return 'LEFT OUTER JOIN';
        }
        if (type === 'rightOuter') {
            return 'RIGHT OUTER JOIN';
        }
        return 'INNER JOIN';
    }

    private formatParam(value: QueryParamValue): string {
        if (value === null) {
            return 'NULL';
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        return `'${value.replace(/'/g, "''")}'`;
    }
}

export function query<TResult>(config: QueryConfigSource<TResult>, options?: QueryBuilderOptions<TResult>): QueryBuilder<TResult> {
    return QueryBuilder.from(config, options);
}

export function runQuery<TResult>(config: QueryConfigSource<TResult>): TResult[] {
    return query(config).executeTyped();
}
