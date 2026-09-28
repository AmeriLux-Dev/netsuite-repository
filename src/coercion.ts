import type { CoercedQueryValue, FieldType, QueryResultValue } from './types';

declare const require: <T = unknown>(moduleName: string) => T;

function getNsFormat(): typeof import('N/format') {
    return require<typeof import('N/format')>('N/format');
}

const numericFieldTypes = new Set<FieldType>(['integer', 'float', 'currency', 'key']);
const booleanFieldTypes = new Set<FieldType>(['boolean', 'checkbox']);
const dateFieldTypes = new Set<FieldType>(['date', 'datetime']);

/**
 * The dates one read has parsed, by format type and text: the time N/format answered, or null when it could not parse
 * the text. A read's dates repeat (every line of an order carries its date), so each text goes through N/format once
 * and every other row gets its own Date with the same time.
 */
export type ParsedDateCache = Map<string, number | null>;

/**
 * Coerces a raw SuiteQL value to the JavaScript type implied by the declared field type.
 * Values that cannot be coerced are returned unchanged so a bad row never throws during mapping.
 * `parsedDates` lets the rows of one read share their date parses; without it every date is parsed.
 */
export function coerceQueryResultValueByFieldType(value: QueryResultValue, type: FieldType | undefined, parsedDates?: ParsedDateCache): CoercedQueryValue {
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
        return coerceDateValue(value, type === 'datetime' ? 'DATETIME' : 'DATE', parsedDates);
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

function coerceDateValue(value: QueryResultValue, formatType: 'DATE' | 'DATETIME', parsedDates: ParsedDateCache | undefined): CoercedQueryValue {
    if (typeof value !== 'string' || value.trim() === '') {
        return value;
    }

    const cacheKey = `${formatType}:${value}`;
    const cachedTime = parsedDates?.get(cacheKey);
    if (cachedTime !== undefined) {
        return cachedTime === null ? value : new Date(cachedTime);
    }

    const parsed = parseDateWithNsFormat(value, formatType);
    parsedDates?.set(cacheKey, parsed === undefined ? null : parsed.getTime());
    return parsed ?? value;
}

/** The date N/format reads in the text, or undefined when N/format is unavailable, throws, or answers no valid date. */
function parseDateWithNsFormat(value: string, formatType: 'DATE' | 'DATETIME'): Date | undefined {
    try {
        const format = getNsFormat();
        const parsed = format.parse({ value, type: format.Type[formatType] });
        if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    } catch {
        // N/format is unavailable or rejected the value; the caller keeps the raw string.
    }
    return undefined;
}
