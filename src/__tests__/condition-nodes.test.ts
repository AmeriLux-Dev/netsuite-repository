import { collectConditionComponents, combineConditions, rerootConditionNode } from '../query';
import type { ConditionNode } from '../types';

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
