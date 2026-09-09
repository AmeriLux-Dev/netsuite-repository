import { compileQueryDescriptionToNQuery, resolveNQueryEnumValue } from '../query';
import { createFakeNQueryModule, describeFakeQuery } from '../testing';
import type { FakeQuery } from '../testing';
import type { NQueryModule } from '../query';
import type { QueryDescription } from '../types';

function compile(description: QueryDescription) {
    const nsQuery = createFakeNQueryModule();
    const query = compileQueryDescriptionToNQuery(description, nsQuery as unknown as NQueryModule) as unknown as FakeQuery;
    return { query, described: describeFakeQuery(query), text: query.toSuiteQL().query, nsQuery };
}

describe('compileQueryDescriptionToNQuery', () => {
    it('joins components parent-first by kind, creates aliased columns with contexts, and sorts', () => {
        const { described, text } = compile({
            queryType: 'salesorder',
            components: [
                { path: 'shippingAddress', join: { kind: 'auto', fieldId: 'shippingaddress' }, conditions: [] },
                { path: 'lines', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] },
                { path: 'lines.item', parent: 'lines', join: { kind: 'to', fieldId: 'item', target: 'item' }, conditions: [] },
            ],
            columns: [
                { alias: 'id', fieldId: 'id' },
                { alias: 'statusText', fieldId: 'status', context: 'DISPLAY' },
                { alias: 'lines_item_name', component: 'lines.item', fieldId: 'itemid' },
                { alias: 'lineTotal', formula: '{lines.quantity} * {lines.rate}', formulaType: 'FLOAT' },
                { alias: 'count', fieldId: 'id', aggregate: 'COUNT' },
            ],
            sort: [
                { fieldId: 'trandate', ascending: false, nullsLast: true },
                { component: 'lines', fieldId: 'linesequencenumber', ascending: true },
                { formula: '{quantity}', formulaType: 'INTEGER', ascending: true },
                { fieldId: 'status', context: 'DISPLAY', ascending: true },
            ],
        });
        expect(described.components).toEqual([
            { path: 'shippingaddress', join: { kind: 'auto', fieldId: 'shippingaddress' }, conditions: [] },
            { path: 'transactionline.transaction', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [] },
            { path: 'transactionline.transaction.item', parent: 'transactionline.transaction', join: { kind: 'to', fieldId: 'item', target: 'item' }, conditions: [] },
        ]);
        expect(described.columns).toEqual([
            { alias: 'id', fieldId: 'id' },
            { alias: 'statusText', fieldId: 'status', context: 'DISPLAY' },
            { alias: 'lines_item_name', component: 'transactionline.transaction.item', fieldId: 'itemid' },
            { alias: 'lineTotal', formula: '{lines.quantity} * {lines.rate}', formulaType: 'FLOAT' },
            { alias: 'count', fieldId: 'id', aggregate: 'COUNT' },
        ]);
        expect(described.condition).toEqual({ kind: 'field', component: 'transactionline.transaction', fieldId: 'mainline', operator: 'IS', values: [false] });
        expect(described.sort).toEqual([
            { fieldId: 'trandate', ascending: false, nullsLast: true },
            { component: 'transactionline.transaction', fieldId: 'linesequencenumber', ascending: true },
            { formula: '{quantity}', formulaType: 'INTEGER', ascending: true },
            { fieldId: 'status', context: 'DISPLAY', ascending: true },
        ]);
        expect(text).toContain('WHERE transactionline.transaction.mainline IS [false]');
    });

    it('ANDs component conditions in front of the query condition and compiles and/or/not and formulas', () => {
        const { described } = compile({
            queryType: 'salesorder',
            components: [{ path: 'lines', join: { kind: 'auto', fieldId: 'transactionlines' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }],
            columns: [{ alias: 'id', fieldId: 'id' }],
            condition: {
                kind: 'or',
                nodes: [
                    { kind: 'and', nodes: [{ kind: 'field', fieldId: 'entity', operator: 'EQUAL', values: [1] }] },
                    { kind: 'not', node: { kind: 'field', component: 'lines', fieldId: 'quantity', operator: 'GREATER', values: [0] } },
                    { kind: 'formula', formula: '{status#DISPLAY}', type: 'STRING', operator: 'EQUAL', values: ['x'] },
                    { kind: 'formula', formula: '{id} > 0' },
                ],
            },
            sort: [],
        });
        expect(described.condition).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', component: 'transactionlines', fieldId: 'mainline', operator: 'IS', values: [false] },
                { kind: 'or', nodes: [
                    { kind: 'field', fieldId: 'entity', operator: 'EQUAL', values: [1] },
                    { kind: 'not', node: { kind: 'field', component: 'transactionlines', fieldId: 'quantity', operator: 'GREATER', values: [0] } },
                    { kind: 'formula', formula: '{status#DISPLAY}', type: 'STRING', operator: 'EQUAL', values: ['x'] },
                    { kind: 'formula', formula: '{id} > 0' },
                ] },
            ],
        });
    });

    it('leaves the condition empty when nothing filters', () => {
        const { query } = compile({ queryType: 'customer', components: [], columns: [{ alias: 'id', fieldId: 'id' }], sort: [] });
        expect(query.condition).toBeUndefined();
    });

    it('rejects a column on a component that was not joined', () => {
        expect(() => compile({ queryType: 'customer', components: [], columns: [{ alias: 'x', component: 'ghost', fieldId: 'x' }], sort: [] })).toThrow("Component 'ghost' is not joined in the query for 'customer'.");
    });

    it('reads enum values off the module by name and rejects unknown names', () => {
        const nsQuery = createFakeNQueryModule();
        expect(resolveNQueryEnumValue(nsQuery.Operator, 'ANY_OF', 'Operator')).toBe('ANY_OF');
        expect(() => resolveNQueryEnumValue(nsQuery.Operator, 'LIKE', 'Operator')).toThrow("N/query has no Operator named 'LIKE'.");
    });
});
