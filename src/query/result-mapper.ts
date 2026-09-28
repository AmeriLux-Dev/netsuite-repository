import { coerceQueryResultValueByFieldType } from '../coercion';
import type { ParsedDateCache } from '../coercion';
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

/** One mapped field, resolved once per read: the alias its value comes back under and the path it lands at. */
interface ResolvedFieldMapping {
    alias: string;
    pathSegments: string[];
    field: QueryField;
}

/**
 * A mapping resolved once per read instead of once per row: the fields of the record itself, and the fields of each
 * array path's items with their paths relative to the item.
 */
interface ResolvedResultMapping {
    recordFields: ResolvedFieldMapping[];
    arrayItems: Array<{ arrayPath: string; fields: ResolvedFieldMapping[] }>;
    coerceEnabled: boolean;
    parsedDates: ParsedDateCache;
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

function splitPath(path: string): string[] {
    return path.split('.').filter(Boolean);
}

function isUnderArrayPath(outputPath: string, arrayPath: string): boolean {
    return outputPath === arrayPath || outputPath.startsWith(`${arrayPath}.`);
}

function resolveResultMapping(options: ResultMappingOptions, parsedDates: ParsedDateCache): ResolvedResultMapping {
    const entries = Object.entries(options.fieldMap);
    return {
        recordFields: entries
            .filter(([, mapping]) => !options.arrayPaths.some((arrayPath) => isUnderArrayPath(mapping.outputPath, arrayPath)))
            .map(([alias, mapping]) => ({ alias, pathSegments: splitPath(mapping.outputPath), field: mapping.field })),
        arrayItems: options.arrayPaths.map((arrayPath) => ({
            arrayPath,
            fields: entries
                .filter(([, mapping]) => isUnderArrayPath(mapping.outputPath, arrayPath))
                .map(([alias, mapping]) => ({
                    alias,
                    pathSegments: splitPath(mapping.outputPath === arrayPath ? mapping.key : mapping.outputPath.slice(arrayPath.length + 1)),
                    field: mapping.field,
                })),
        })),
        coerceEnabled: options.coerceEnabled,
        parsedDates,
    };
}

/**
 * Maps result rows into typed objects, grouping fanned-out sublist rows under their parent when array paths exist.
 * The rows share `parsedDates`, so each date text is parsed once; pass one cache to several calls over the same read.
 */
export function mapRowsToResults<TResult>(rows: ResultRow[], options: ResultMappingOptions, parsedDates: ParsedDateCache = new Map()): TResult[] {
    if (rows.length === 0) {
        return [];
    }
    const mapping = resolveResultMapping(options, parsedDates);
    const normalizedRows = rows.map(normalizeRowKeys);
    if (options.arrayPaths.length > 0 && options.primaryAlias !== undefined) {
        return mapGroupedRows(normalizedRows, mapping, normalizeMappedResultKey(options.primaryAlias));
    }
    return normalizedRows.map((row) => mapRecordRow<TResult>(row, mapping));
}

function mapGroupedRows<TResult>(rows: ResultRow[], mapping: ResolvedResultMapping, primaryAlias: string): TResult[] {
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
    return Array.from(groups.values()).map((groupRows) => mapRowGroup<TResult>(groupRows, mapping));
}

function mapRowGroup<TResult>(rows: ResultRow[], mapping: ResolvedResultMapping): TResult {
    const base = mapRecordRow<Record<string, unknown>>(rows[0], mapping);
    for (const { arrayPath } of mapping.arrayItems) {
        base[arrayPath] = [];
    }
    const seen = new Set<string>();
    for (const row of rows) {
        for (const { arrayPath, fields } of mapping.arrayItems) {
            const item = buildArrayItem(row, fields, mapping);
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

function mapRecordRow<TResult>(row: ResultRow, mapping: ResolvedResultMapping): TResult {
    const output: Record<string, unknown> = {};
    for (const { alias, pathSegments, field } of mapping.recordFields) {
        setValueAtPathSegments(output, pathSegments, transformResultValue(row[alias], row, field, mapping.coerceEnabled, mapping.parsedDates));
    }
    return output as TResult;
}

function buildArrayItem(row: ResultRow, fields: ResolvedFieldMapping[], mapping: ResolvedResultMapping): Record<string, unknown> | null {
    const item: Record<string, unknown> = {};
    let hasValue = false;
    for (const { alias, pathSegments, field } of fields) {
        const value = transformResultValue(row[alias], row, field, mapping.coerceEnabled, mapping.parsedDates);
        if (value !== null && value !== undefined && value !== '') {
            hasValue = true;
        }
        setValueAtPathSegments(item, pathSegments, value);
    }
    return hasValue ? item : null;
}

/** Coerces a raw value to the field's declared type when coercion is on for it, then applies the field's transform. */
export function transformResultValue(value: QueryResultValue, row: ResultRow, field: QueryField, coerceEnabled: boolean, parsedDates?: ParsedDateCache): unknown {
    const shouldCoerce = field.coerce ?? coerceEnabled;
    const coerced = shouldCoerce ? coerceQueryResultValueByFieldType(value ?? null, field.type, parsedDates) : value ?? null;
    return field.transform ? field.transform(coerced, row) : coerced;
}

/** Writes a value at a dotted path, creating intermediate objects. */
export function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
    setValueAtPathSegments(target, splitPath(path), value);
}

function setValueAtPathSegments(target: Record<string, unknown>, parts: string[], value: unknown): void {
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
