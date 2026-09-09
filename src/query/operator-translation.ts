import type { ConditionParamValue, FieldType, NQueryOperatorName, QueryOperator, SqlStyleOperator } from '../types';

export interface TranslatedCondition {
    operator: NQueryOperatorName;
    values?: ConditionParamValue[];
    /**
     * Set when N/query has no list operator for the field type: the operator applies to each value on its own and
     * the conditions are combined with `or` (IN) or `and` (NOT IN).
     */
    combine?: 'or' | 'and';
}

const nQueryOperatorNames = new Set<string>([
    'AFTER', 'AFTER_NOT', 'ANY_OF', 'ANY_OF_NOT', 'BEFORE', 'BEFORE_NOT', 'BETWEEN', 'BETWEEN_NOT', 'CONTAIN', 'CONTAIN_NOT',
    'EMPTY', 'EMPTY_NOT', 'ENDWITH', 'ENDWITH_NOT', 'EQUAL', 'EQUAL_NOT', 'EXCLUDE_ALL', 'EXCLUDE_ANY', 'EXCLUDE_EXACTLY',
    'GREATER', 'GREATER_NOT', 'GREATER_OR_EQUAL', 'GREATER_OR_EQUAL_NOT', 'INCLUDE_ALL', 'INCLUDE_ANY', 'INCLUDE_EXACTLY',
    'IS', 'IS_NOT', 'LESS', 'LESS_NOT', 'LESS_OR_EQUAL', 'LESS_OR_EQUAL_NOT', 'ON', 'ON_NOT', 'ON_OR_AFTER', 'ON_OR_AFTER_NOT',
    'ON_OR_BEFORE', 'ON_OR_BEFORE_NOT', 'START_WITH', 'START_WITH_NOT', 'WITHIN', 'WITHIN_NOT',
]);

export function isNQueryOperatorName(operator: string): operator is NQueryOperatorName {
    return nQueryOperatorNames.has(operator);
}

function isDateField(fieldType: FieldType | undefined): boolean {
    return fieldType === 'date' || fieldType === 'datetime';
}

function isBooleanField(fieldType: FieldType | undefined): boolean {
    return fieldType === 'boolean' || fieldType === 'checkbox';
}

/** Select, multiselect, and key fields compare through ANY_OF in N/query; EQUAL is not valid on them. */
export function isSelectLikeField(fieldType: FieldType | undefined): boolean {
    return fieldType === 'select' || fieldType === 'multiselect' || fieldType === 'key';
}

/** A checkbox compares as a boolean; NetSuite's own 'T'/'F' spellings are accepted for it. Everything else binds as given. */
export function normalizeConditionValue(value: ConditionParamValue, fieldType: FieldType | undefined): ConditionParamValue {
    if (isBooleanField(fieldType) && typeof value === 'string') {
        const upper = value.toUpperCase();
        if (upper === 'T' || upper === 'TRUE') return true;
        if (upper === 'F' || upper === 'FALSE') return false;
    }
    return value;
}

function toValueList(value: ConditionParamValue | ConditionParamValue[] | undefined, fieldType: FieldType | undefined): ConditionParamValue[] | undefined {
    if (value === undefined) return undefined;
    return (Array.isArray(value) ? value : [value]).map((member) => normalizeConditionValue(member, fieldType));
}

/**
 * Turns a `LIKE` pattern into the N/query operator that expresses it: a trailing `%` is START_WITH, a leading `%`
 * is ENDWITH, both is CONTAIN, none is EQUAL. Patterns N/query cannot express (`_`, a `%` in the middle) are
 * rejected; a formula condition is the way to write those.
 */
export function translateLikePatternToQueryOperator(pattern: string, negated: boolean): TranslatedCondition {
    const startsWithWildcard = pattern.startsWith('%');
    const endsWithWildcard = pattern.endsWith('%') && pattern.length > 1;
    const inner = pattern.slice(startsWithWildcard ? 1 : 0, endsWithWildcard ? pattern.length - 1 : pattern.length);
    if (inner.includes('%') || inner.includes('_')) {
        throw new Error(`LIKE pattern '${pattern}' has no N/query operator; use whereFormula() for it.`);
    }
    const operator: NQueryOperatorName = startsWithWildcard && endsWithWildcard ? 'CONTAIN' : endsWithWildcard ? 'START_WITH' : startsWithWildcard ? 'ENDWITH' : 'EQUAL';
    return { operator: negated ? `${operator}_NOT` : operator, values: [inner] };
}

function requireSingleValue(operator: string, values: ConditionParamValue[] | undefined): ConditionParamValue[] {
    if (!values || values.length !== 1) {
        throw new Error(`${operator} takes exactly one value.`);
    }
    return values;
}

/**
 * Translates a SQL-style operator and its value into the N/query operator for the field's type: `=` is IS on a
 * checkbox, ON on a date, ANY_OF on a select or key field, and EQUAL otherwise; the order comparisons become
 * BEFORE/AFTER on dates and LESS/GREATER otherwise; `IN` is ANY_OF on a select or key field and one equality per
 * value combined with `or` elsewhere; `IS NULL` is EMPTY; `LIKE` follows its wildcards. An N/query operator name
 * passes through with its values normalized.
 */
export function translateConditionOperator(operator: QueryOperator, fieldType: FieldType | undefined, value: ConditionParamValue | ConditionParamValue[] | undefined): TranslatedCondition {
    // BETWEEN is spelled the same in both vocabularies; the SQL-style path checks it takes exactly two values.
    if (operator !== 'BETWEEN' && isNQueryOperatorName(operator)) {
        const values = toValueList(value, fieldType);
        return values === undefined ? { operator } : { operator, values };
    }
    return translateSqlStyleOperator(operator, fieldType, toValueList(value, fieldType));
}

/** The N/query operator behind `=` for a field type; `IN` on a field with no list operator applies it per value. */
function equalityOperator(fieldType: FieldType | undefined): 'IS' | 'ON' | 'ANY_OF' | 'EQUAL' {
    if (isBooleanField(fieldType)) return 'IS';
    if (isDateField(fieldType)) return 'ON';
    return isSelectLikeField(fieldType) ? 'ANY_OF' : 'EQUAL';
}

function translateSqlStyleOperator(operator: SqlStyleOperator, fieldType: FieldType | undefined, values: ConditionParamValue[] | undefined): TranslatedCondition {
    const dates = isDateField(fieldType);
    switch (operator) {
        case 'IS NULL':
            return { operator: 'EMPTY' };
        case 'IS NOT NULL':
            return { operator: 'EMPTY_NOT' };
        case 'IN':
        case 'NOT IN': {
            if (!values || values.length === 0) {
                throw new Error(`${operator} requires at least one value.`);
            }
            const base = equalityOperator(fieldType);
            if (base === 'ANY_OF') {
                return { operator: operator === 'IN' ? 'ANY_OF' : 'ANY_OF_NOT', values };
            }
            return operator === 'IN' ? { operator: base, values, combine: 'or' } : { operator: `${base}_NOT`, values, combine: 'and' };
        }
        case 'BETWEEN':
            if (!values || values.length !== 2) {
                throw new Error('BETWEEN requires exactly two values.');
            }
            return { operator: 'BETWEEN', values };
        case 'LIKE':
        case 'NOT LIKE':
            return translateLikePatternToQueryOperator(String(requireSingleValue(operator, values)[0]), operator === 'NOT LIKE');
        case '=':
        case '!=':
        case '<>': {
            const single = requireSingleValue(operator, values);
            const base = equalityOperator(fieldType);
            return { operator: operator === '=' ? base : `${base}_NOT`, values: single };
        }
        case '>':
            return { operator: dates ? 'AFTER' : 'GREATER', values: requireSingleValue(operator, values) };
        case '>=':
            return { operator: dates ? 'ON_OR_AFTER' : 'GREATER_OR_EQUAL', values: requireSingleValue(operator, values) };
        case '<':
            return { operator: dates ? 'BEFORE' : 'LESS', values: requireSingleValue(operator, values) };
        default:
            return { operator: dates ? 'ON_OR_BEFORE' : 'LESS_OR_EQUAL', values: requireSingleValue(operator, values) };
    }
}
