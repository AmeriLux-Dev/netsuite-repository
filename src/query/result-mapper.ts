import { coerceQueryResultValueByFieldType } from '../coercion';
import type { FieldMap, QueryField, QueryResultValue } from '../types';

export type ResultRow = Record<string, QueryResultValue>;

export interface ResultMappingOptions {
    fieldMap: FieldMap;
    /** Output paths whose fields fan out one row per element (`lines`); rows are grouped by the primary alias into arrays. */
    arrayPaths: string[];
    /** Alias of the primary key column; rows are grouped by it when array paths exist. */
    primaryAlias?: string;
    coerceEnabled: boolean;
}

/** N/query keys mapped results by alias; the mapper compares aliases case-insensitively so casing differences never matter. */
export function normalizeMappedResultKey(key: string): string {
    return key.toLowerCase();
}

function normalizeRowKeys(row: ResultRow): ResultRow {
    const normalized: ResultRow = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[normalizeMappedResultKey(key)] = value;
    }
    return normalized;
}

/** Builds the alias → output path map for the fields a query selects. Keys are normalized aliases. */
export function buildFieldMap(fields: Array<[string, QueryField]>): FieldMap {
    const map: FieldMap = {};
    for (const [key, field] of fields) {
        map[normalizeMappedResultKey(field.alias ?? key)] = { key, outputPath: field.nestPath ?? key, field };
    }
    return map;
}

/** Maps result rows into typed objects, grouping fanned-out sublist rows under their parent when array paths exist. */
export function mapRowsToResults<TResult>(rows: ResultRow[], options: ResultMappingOptions): TResult[] {
    if (rows.length === 0) {
        return [];
    }
    const normalizedRows = rows.map(normalizeRowKeys);
    if (options.arrayPaths.length > 0 && options.primaryAlias !== undefined) {
        return mapGroupedRows(normalizedRows, options, normalizeMappedResultKey(options.primaryAlias));
    }
    return normalizedRows.map((row) => mapSingleRow<TResult>(row, options));
}

function mapGroupedRows<TResult>(rows: ResultRow[], options: ResultMappingOptions, primaryAlias: string): TResult[] {
    const groups = new Map<QueryResultValue, ResultRow[]>();
    for (const row of rows) {
        const id = row[primaryAlias];
        if (id === undefined || id === null) {
            continue;
        }
        const group = groups.get(id) ?? [];
        group.push(row);
        groups.set(id, group);
    }
    return Array.from(groups.values()).map((groupRows) => mapRowGroup<TResult>(groupRows, options));
}

function mapRowGroup<TResult>(rows: ResultRow[], options: ResultMappingOptions): TResult {
    const base = mapSingleRow<Record<string, unknown>>(rows[0], options);
    for (const arrayPath of options.arrayPaths) {
        base[arrayPath] = [];
    }
    const seen = new Set<string>();
    for (const row of rows) {
        for (const arrayPath of options.arrayPaths) {
            const item = buildArrayItem(row, options, arrayPath);
            if (!item) {
                continue;
            }
            const key = `${arrayPath}:${JSON.stringify(item)}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            (base[arrayPath] as unknown[]).push(item);
        }
    }
    return base as TResult;
}

function mapSingleRow<TResult>(row: ResultRow, options: ResultMappingOptions): TResult {
    const output: Record<string, unknown> = {};
    for (const [alias, mapping] of Object.entries(options.fieldMap)) {
        const path = mapping.outputPath;
        if (options.arrayPaths.some((arrayPath) => path === arrayPath || path.startsWith(`${arrayPath}.`))) {
            continue;
        }
        setValueAtPath(output, path, transformResultValue(row[alias], row, mapping.field, options.coerceEnabled));
    }
    return output as TResult;
}

function buildArrayItem(row: ResultRow, options: ResultMappingOptions, arrayPath: string): Record<string, unknown> | null {
    const item: Record<string, unknown> = {};
    let hasValue = false;
    for (const [alias, mapping] of Object.entries(options.fieldMap)) {
        const path = mapping.outputPath;
        if (path !== arrayPath && !path.startsWith(`${arrayPath}.`)) {
            continue;
        }
        const itemPath = path === arrayPath ? mapping.key : path.slice(arrayPath.length + 1);
        const value = transformResultValue(row[alias], row, mapping.field, options.coerceEnabled);
        if (value !== null && value !== undefined && value !== '') {
            hasValue = true;
        }
        setValueAtPath(item, itemPath, value);
    }
    return hasValue ? item : null;
}

/** Coerces a raw value to the field's declared type when coercion is on for it, then applies the field's transform. */
export function transformResultValue(value: QueryResultValue, row: ResultRow, field: QueryField, coerceEnabled: boolean): unknown {
    const shouldCoerce = field.coerce ?? coerceEnabled;
    const coerced = shouldCoerce ? coerceQueryResultValueByFieldType(value ?? null, field.type) : value ?? null;
    return field.transform ? field.transform(coerced, row) : coerced;
}

/** Writes a value at a dotted path, creating intermediate objects. */
export function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
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

/** Reads a value at a dotted path; undefined when any segment is missing. */
export function getValueAtPath(source: unknown, path: string): unknown {
    let cursor: unknown = source;
    for (const part of path.split('.')) {
        if (!cursor || typeof cursor !== 'object') {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
}
