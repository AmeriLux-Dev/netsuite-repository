import type { CoercedQueryValue, FieldType, QueryResultValue } from './types';

declare const require: <T = unknown>(moduleName: string) => T;

function getNsFormat(): typeof import('N/format') {
    return require<typeof import('N/format')>('N/format');
}

const numericFieldTypes = new Set<FieldType>(['integer', 'float', 'currency', 'key']);
const booleanFieldTypes = new Set<FieldType>(['boolean', 'checkbox']);
const dateFieldTypes = new Set<FieldType>(['date', 'datetime']);

/**
 * Coerces a raw SuiteQL value to the JavaScript type implied by the declared field type.
 * Values that cannot be coerced are returned unchanged so a bad row never throws during mapping.
 */
export function coerceQueryResultValueByFieldType(value: QueryResultValue, type: FieldType | undefined): CoercedQueryValue {
    if (value === null || value === undefined || type === undefined) {
        return value ?? null;
    }

    if (numericFieldTypes.has(type)) {
        return coerceNumericValue(value);
    }

    if (booleanFieldTypes.has(type)) {
        return coerceBooleanValue(value);
    }

    if (dateFieldTypes.has(type)) {
        return coerceDateValue(value, type === 'datetime' ? 'DATETIME' : 'DATE');
    }

    return value;
}

function coerceNumericValue(value: QueryResultValue): QueryResultValue {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
            return Number(trimmed);
        }
    }
    return value;
}

function coerceBooleanValue(value: QueryResultValue): QueryResultValue {
    if (typeof value === 'string') {
        const normalized = value.trim().toUpperCase();
        if (normalized === 'T' || normalized === 'TRUE') {
            return true;
        }
        if (normalized === 'F' || normalized === 'FALSE') {
            return false;
        }
    }
    return value;
}

function coerceDateValue(value: QueryResultValue, formatType: 'DATE' | 'DATETIME'): CoercedQueryValue {
    if (typeof value !== 'string' || value.trim() === '') {
        return value;
    }

    try {
        const format = getNsFormat();
        const parsed = format.parse({ value, type: format.Type[formatType] });
        if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    } catch {
        // N/format is unavailable or rejected the value; fall through to the raw string.
    }

    return value;
}
