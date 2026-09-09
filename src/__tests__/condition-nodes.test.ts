import { collectConditionComponents, combineConditions, conditionNodeForTranslation, rerootConditionNode } from '../query';
import type { ConditionNode, ConditionParamValue, NQueryOperatorName } from '../types';

describe('conditionNodeForTranslation', () => {
    const fieldNode = (operator: NQueryOperatorName, values: ConditionParamValue[] | undefined): ConditionNode => ({ kind: 'field', fieldId: 'x', operator, values });

    it('builds one node for a plain translation and one per value for a combined one', () => {
        expect(conditionNodeForTranslation({ operator: 'ANY_OF', values: [1, 2] }, fieldNode)).toEqual({ kind: 'field', fieldId: 'x', operator: 'ANY_OF', values: [1, 2] });
        expect(conditionNodeForTranslation({ operator: 'EMPTY' }, fieldNode)).toEqual({ kind: 'field', fieldId: 'x', operator: 'EMPTY', values: undefined });
        expect(conditionNodeForTranslation({ operator: 'EQUAL', values: ['a'], combine: 'or' }, fieldNode)).toEqual({ kind: 'field', fieldId: 'x', operator: 'EQUAL', values: ['a'] });
        expect(conditionNodeForTranslation({ operator: 'EQUAL_NOT', values: ['a', 'b'], combine: 'and' }, fieldNode)).toEqual({
            kind: 'and',
            nodes: [{ kind: 'field', fieldId: 'x', operator: 'EQUAL_NOT', values: ['a'] }, { kind: 'field', fieldId: 'x', operator: 'EQUAL_NOT', values: ['b'] }],
        });
    });
});

const a: ConditionNode = { kind: 'field', fieldId: 'a', operator: 'EMPTY' };
const b: ConditionNode = { kind: 'field', component: 'lines', fieldId: 'b', operator: 'EMPTY' };
const c: ConditionNode = { kind: 'field', component: 'lines.item', fieldId: 'c', operator: 'EMPTY' };
const formula: ConditionNode = { kind: 'formula', formula: '{x} > 1' };

describe('combineConditions', () => {
    it('gives AND precedence over OR', () => {
        expect(combineConditions([])).toBeUndefined();
        expect(combineConditions([{ node: a, link: 'AND' }])).toEqual(a);
        expect(combineConditions([{ node: a, link: 'AND' }, { node: b, link: 'AND' }, { node: c, link: 'OR' }, { node: formula, link: 'AND' }])).toEqual({
            kind: 'or',
            nodes: [{ kind: 'and', nodes: [a, b] }, { kind: 'and', nodes: [c, formula] }],
        });
    });
});

describe('collectConditionComponents', () => {
    it('walks every node kind', () => {
        const into = new Set<string>();
        collectConditionComponents({ kind: 'and', nodes: [a, { kind: 'not', node: b }, { kind: 'or', nodes: [c, formula] }] }, into);
        expect(Array.from(into)).toEqual(['lines', 'lines.item']);
    });
});

describe('rerootConditionNode', () => {
    it('drops the relation path from its own component and keeps deeper paths and formulas', () => {
        expect(rerootConditionNode({ kind: 'and', nodes: [{ kind: 'not', node: b }, { kind: 'or', nodes: [c, formula, a] }] }, 'lines')).toEqual({
            kind: 'and',
            nodes: [{ kind: 'not', node: { ...b, component: undefined } }, { kind: 'or', nodes: [c, formula, a] }],
        });
    });
});
