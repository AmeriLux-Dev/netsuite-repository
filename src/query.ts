import type * as NsQuery from 'N/query';
import { normalizeQueryConfig } from './types';
import type {
    BuiltQuery,
    FieldMap,
    JoinDef,
    QueryConfig,
    QueryConfigInput,
    QueryExecution,
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

function getNsQuery(): typeof import('N/query') {
    return require<typeof import('N/query')>('N/query');
}

export class QueryBuilder<TResult> {
    private readonly config: QueryConfig<TResult>;
    private selectedKeys: Set<string> | null = null;
    private readonly conditions: ConditionDef[] = [];
    private readonly sorts: SortDef[] = [];
    private limitValue: number | undefined;
    private offsetValue: number | undefined;
    private distinctFlag = false;

    private constructor(config: QueryConfig<TResult>) {
        this.config = config;
    }

    static from<TResult>(config: QueryConfig<TResult> | QueryConfigInput<TResult>): QueryBuilder<TResult> {
        return new QueryBuilder(normalizeQueryConfig(config));
    }

    select(...keys: Array<keyof TResult | string>): this {
        if (!this.selectedKeys) {
            this.selectedKeys = new Set<string>();
        }

        for (const key of keys) {
            this.selectedKeys.add(String(key));
        }

        return this;
    }

    selectAll(): this {
        this.selectedKeys = null;
        return this;
    }

    distinct(): this {
        this.distinctFlag = true;
        return this;
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

    build(): BuiltQuery {
        const fields = this.getFieldsToBuild();
        const fieldMap = this.buildFieldMap(fields);
        const distinct = this.distinctFlag ? 'DISTINCT ' : '';
        const top = this.limitValue === undefined ? '' : `TOP ${(this.offsetValue ?? 0) + this.limitValue} `;

        let sql = `SELECT ${distinct}${top}${this.buildSelectClause(fields)}\nFROM ${this.buildFromClause()}`;
        const whereClause = this.buildWhereClause();
        const orderByClause = this.buildOrderByClause();

        if (whereClause) {
            sql += `\nWHERE ${whereClause}`;
        }

        if (orderByClause) {
            sql += `\nORDER BY ${orderByClause}`;
        }

        return {
            sql,
            params: this.getParams(),
            fieldMap,
        };
    }

    execute(): QueryExecution<TResult> {
        const built = this.build();
        const resultSet = getNsQuery().runSuiteQL({
            query: built.sql,
            params: built.params as Array<string | number | boolean>,
        });
        const rows = resultSet.asMappedResults() as Record<string, QueryResultValue>[];
        const data = this.offsetValue ? rows.slice(this.offsetValue) : rows;

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
        const built = this.build();
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

        return this.config.postProcess ? results.map((row) => this.config.postProcess?.(row) ?? row) : results;
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
        const child = new QueryBuilder(this.config);
        callback(child);

        if (child.conditions.length === 0) {
            return this;
        }

        const expression = child.conditions
            .map((condition, index) => index === 0 ? condition.expression : `${condition.linkType} ${condition.expression}`)
            .join(' ');

        this.conditions.push({
            expression: `(${expression})`,
            params: child.getParams(),
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

    private getFieldsToBuild(): Array<[string, NonNullable<QueryConfig<TResult>['fields'][string]>]> {
        return Object.entries(this.config.fields).filter(([key, field]) => {
            if (field.isPrimary) {
                return true;
            }
            if (field.select === false) {
                return false;
            }
            return !this.selectedKeys || this.selectedKeys.has(key);
        });
    }

    private buildFieldMap(fields: Array<[string, NonNullable<QueryConfig<TResult>['fields'][string]>]>): FieldMap {
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

    private buildSelectClause(fields: Array<[string, NonNullable<QueryConfig<TResult>['fields'][string]>]>): string {
        if (fields.length === 0) {
            throw new Error('At least one selectable field is required.');
        }

        return fields.map(([key, field]) => {
            const alias = field.alias ?? key;
            const expression = `${field.tableAlias}.${field.queryFieldId}`;
            return `${field.useText ? `BUILTIN.DF(${expression})` : expression} AS "${alias}"`;
        }).join(',\n       ');
    }

    private buildFromClause(): string {
        const { from, joins = [] } = this.config.query;
        return [`${from.name} ${from.alias}`, ...joins.map((join) => `${this.joinTypeToSql(join.type)} ${join.toTable.name} ${join.toTable.alias} ON ${this.buildOnClause(join)}`)].join('\n');
    }

    private buildOnClause(join: JoinDef): string {
        return join.constraints.map((constraint, index) => {
            const sourceAlias = constraint.joinKeys.sourceTable ?? join.fromTable;
            const targetAlias = constraint.joinKeys.targetTable ?? join.toTable.alias;
            const expression = `${sourceAlias}.${constraint.joinKeys.sourceForeignKey} = ${targetAlias}.${constraint.joinKeys.targetPrimaryKey}`;
            return index === 0 ? expression : `${constraint.joinLinkType ?? 'AND'} ${expression}`;
        }).join(' ');
    }

    private buildWhereClause(): string {
        return this.conditions.map((condition, index) => index === 0 ? condition.expression : `${condition.linkType} ${condition.expression}`).join(' ');
    }

    private buildOrderByClause(): string {
        return this.sorts.map((sort) => `${sort.expression} ${sort.direction}`).join(', ');
    }

    private resolveFieldExpression(fieldKey: string): string {
        const field = this.config.fields[fieldKey];
        if (!field) {
            throw new Error(`Field '${fieldKey}' is not defined in query config for '${this.config.recordType}'.`);
        }
        return `${field.tableAlias}.${field.queryFieldId}`;
    }

    private getParams(): QueryParamValue[] {
        return this.conditions.flatMap((condition) => condition.params);
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
            const value = this.transformValue(row[alias], row, mapping.field.transform);
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
            const value = this.transformValue(row[alias], row, mapping.field.transform);
            if (value !== null && value !== undefined && value !== '') {
                hasValue = true;
            }
            this.setPath(item, itemPath, value);
        }

        return hasValue ? item : null;
    }

    private transformValue(value: QueryResultValue, row: Record<string, QueryResultValue>, transform?: (value: QueryResultValue, row: Record<string, QueryResultValue>) => unknown): unknown {
        return transform ? transform(value, row) : value;
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

export function query<TResult>(config: QueryConfig<TResult> | QueryConfigInput<TResult>): QueryBuilder<TResult> {
    return QueryBuilder.from(config);
}

export function runQuery<TResult>(config: QueryConfig<TResult> | QueryConfigInput<TResult>): TResult[] {
    return query(config).executeTyped();
}