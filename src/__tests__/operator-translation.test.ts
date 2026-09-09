import { isNQueryOperatorName, normalizeConditionValue, translateConditionOperator, translateLikePatternToQueryOperator } from '../query';

describe('translateConditionOperator', () => {
    it('translates equality by field type', () => {
        expect(translateConditionOperator('=', 'string', 'a')).toEqual({ operator: 'EQUAL', values: ['a'] });
        expect(translateConditionOperator('=', 'boolean', true)).toEqual({ operator: 'IS', values: [true] });
        expect(translateConditionOperator('=', 'checkbox', 'F')).toEqual({ operator: 'IS', values: [false] });
        const day = new Date(2026, 0, 5);
        expect(translateConditionOperator('=', 'date', day)).toEqual({ operator: 'ON', values: [day] });
        expect(translateConditionOperator('!=', 'string', 'a')).toEqual({ operator: 'EQUAL_NOT', values: ['a'] });
        expect(translateConditionOperator('<>', 'boolean', 'T')).toEqual({ operator: 'IS_NOT', values: [true] });
        expect(translateConditionOperator('!=', 'datetime', day)).toEqual({ operator: 'ON_NOT', values: [day] });
    });

    it('translates order comparisons for numbers and dates', () => {
        const day = new Date(2026, 0, 5);
        expect(translateConditionOperator('>', 'float', 1)).toEqual({ operator: 'GREATER', values: [1] });
        expect(translateConditionOperator('>=', 'integer', 1)).toEqual({ operator: 'GREATER_OR_EQUAL', values: [1] });
        expect(translateConditionOperator('<', undefined, 1)).toEqual({ operator: 'LESS', values: [1] });
        expect(translateConditionOperator('<=', 'currency', 1)).toEqual({ operator: 'LESS_OR_EQUAL', values: [1] });
        expect(translateConditionOperator('>', 'date', day)).toEqual({ operator: 'AFTER', values: [day] });
        expect(translateConditionOperator('>=', 'date', day)).toEqual({ operator: 'ON_OR_AFTER', values: [day] });
        expect(translateConditionOperator('<', 'datetime', day)).toEqual({ operator: 'BEFORE', values: [day] });
        expect(translateConditionOperator('<=', 'datetime', day)).toEqual({ operator: 'ON_OR_BEFORE', values: [day] });
    });

    it('compares select, multiselect, and key fields through ANY_OF', () => {
        expect(translateConditionOperator('=', 'select', 7)).toEqual({ operator: 'ANY_OF', values: [7] });
        expect(translateConditionOperator('!=', 'key', 7)).toEqual({ operator: 'ANY_OF_NOT', values: [7] });
        expect(translateConditionOperator('IN', 'multiselect', [1, 2])).toEqual({ operator: 'ANY_OF', values: [1, 2] });
        expect(translateConditionOperator('NOT IN', 'select', ['A', 'B'])).toEqual({ operator: 'ANY_OF_NOT', values: ['A', 'B'] });
    });

    it('translates membership, null checks, and ranges', () => {
        // N/query has no list operator for text, numbers, dates, or checkboxes: one equality per value, combined.
        expect(translateConditionOperator('IN', 'integer', [1, 2])).toEqual({ operator: 'EQUAL', values: [1, 2], combine: 'or' });
        expect(translateConditionOperator('NOT IN', 'string', ['a'])).toEqual({ operator: 'EQUAL_NOT', values: ['a'], combine: 'and' });
        const day = new Date(2026, 0, 5);
        expect(translateConditionOperator('IN', 'date', [day])).toEqual({ operator: 'ON', values: [day], combine: 'or' });
        expect(translateConditionOperator('NOT IN', 'checkbox', ['T'])).toEqual({ operator: 'IS_NOT', values: [true], combine: 'and' });
        expect(translateConditionOperator('IS NULL', 'string', undefined)).toEqual({ operator: 'EMPTY' });
        expect(translateConditionOperator('IS NOT NULL', 'string', undefined)).toEqual({ operator: 'EMPTY_NOT' });
        expect(translateConditionOperator('BETWEEN', 'float', [1, 9])).toEqual({ operator: 'BETWEEN', values: [1, 9] });
    });

    it('translates LIKE patterns by their wildcards', () => {
        expect(translateConditionOperator('LIKE', 'string', 'Ac%')).toEqual({ operator: 'START_WITH', values: ['Ac'] });
        expect(translateConditionOperator('LIKE', 'string', '%me')).toEqual({ operator: 'ENDWITH', values: ['me'] });
        expect(translateConditionOperator('LIKE', 'string', '%cm%')).toEqual({ operator: 'CONTAIN', values: ['cm'] });
        expect(translateConditionOperator('LIKE', 'string', 'Acme')).toEqual({ operator: 'EQUAL', values: ['Acme'] });
        expect(translateConditionOperator('NOT LIKE', 'string', '%spam%')).toEqual({ operator: 'CONTAIN_NOT', values: ['spam'] });
        expect(translateLikePatternToQueryOperator('%', false)).toEqual({ operator: 'ENDWITH', values: [''] });
    });

    it('rejects LIKE patterns N/query cannot express', () => {
        expect(() => translateConditionOperator('LIKE', 'string', 'A_c')).toThrow("LIKE pattern 'A_c' has no N/query operator; use whereFormula() for it.");
        expect(() => translateConditionOperator('LIKE', 'string', 'A%c%')).toThrow('has no N/query operator');
    });

    it('passes N/query operator names through with normalized values', () => {
        expect(translateConditionOperator('ANY_OF', 'integer', [1, 2])).toEqual({ operator: 'ANY_OF', values: [1, 2] });
        expect(translateConditionOperator('START_WITH', 'string', 'SO')).toEqual({ operator: 'START_WITH', values: ['SO'] });
        expect(translateConditionOperator('IS', 'boolean', 'T')).toEqual({ operator: 'IS', values: [true] });
        expect(translateConditionOperator('EMPTY', 'string', undefined)).toEqual({ operator: 'EMPTY' });
    });

    it('rejects the wrong number of values', () => {
        expect(() => translateConditionOperator('IN', 'integer', [])).toThrow('IN requires at least one value.');
        expect(() => translateConditionOperator('NOT IN', 'integer', undefined)).toThrow('NOT IN requires at least one value.');
        expect(() => translateConditionOperator('BETWEEN', 'integer', [1])).toThrow('BETWEEN requires exactly two values.');
        expect(() => translateConditionOperator('=', 'integer', [1, 2])).toThrow('= takes exactly one value.');
        expect(() => translateConditionOperator('>', 'integer', undefined)).toThrow('> takes exactly one value.');
        expect(() => translateConditionOperator('LIKE', 'string', ['a', 'b'])).toThrow('LIKE takes exactly one value.');
    });
});

describe('normalizeConditionValue', () => {
    it("reads NetSuite's T/F and true/false spellings on checkbox fields only", () => {
        expect(normalizeConditionValue('T', 'boolean')).toBe(true);
        expect(normalizeConditionValue('false', 'checkbox')).toBe(false);
        expect(normalizeConditionValue('T', 'string')).toBe('T');
        expect(normalizeConditionValue('maybe', 'boolean')).toBe('maybe');
        expect(normalizeConditionValue(3, 'boolean')).toBe(3);
    });
});

describe('isNQueryOperatorName', () => {
    it('recognizes the operator names and nothing else', () => {
        expect(isNQueryOperatorName('ANY_OF')).toBe(true);
        expect(isNQueryOperatorName('=')).toBe(false);
        expect(isNQueryOperatorName('any_of')).toBe(false);
    });
});
