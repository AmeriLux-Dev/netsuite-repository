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
            // Sorted fields that are not selected get hidden columns; the DISPLAY status sort reuses statusText.
            { alias: '__sort0', fieldId: 'trandate' },
            { alias: '__sort1', component: 'transactionline.transaction', fieldId: 'linesequencenumber' },
            { alias: '__sort2', formula: '{quantity}', formulaType: 'INTEGER' },
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

    it('sorts on the selected column object when the sorted field is selected, and on a hidden column appended to the query otherwise', () => {
        const { query, described } = compile({
            queryType: 'salesorder',
            components: [{ path: 'lines', join: { kind: 'auto', fieldId: 'transactionlines' }, conditions: [] }],
            columns: [
                { alias: 'id', fieldId: 'id' },
                { alias: 'trandate', fieldId: 'trandate' },
                { alias: 'status', fieldId: 'status', context: 'DISPLAY' },
                { alias: 'lines_id', component: 'lines', fieldId: 'id' },
                { alias: 'total', formula: '{quantity} * {rate}', formulaType: 'FLOAT' },
                { alias: 'count', fieldId: 'id', aggregate: 'COUNT' },
            ],
            sort: [
                { fieldId: 'trandate', ascending: true },
                { fieldId: 'status', context: 'DISPLAY', ascending: true },
                { fieldId: 'status', ascending: true },
                { component: 'lines', fieldId: 'id', ascending: true },
                { fieldId: 'id', ascending: false },
                { formula: '{quantity} * {rate}', formulaType: 'FLOAT', ascending: true },
                { fieldId: 'tranid', ascending: true },
            ],
        });
        const sortColumns = query.sort.map((sort) => sort.column);
        expect(sortColumns[0]).toBe(query.columns[1]);
        expect(sortColumns[1]).toBe(query.columns[2]);
        expect(sortColumns[3]).toBe(query.columns[3]);
        expect(sortColumns[4]).toBe(query.columns[0]); // the plain id, never the COUNT aggregate
        expect(sortColumns[5]).toBe(query.columns[4]);
        // The raw status (only its display text is selected) and tranid are not selected: N/query sorts only on the
        // query's own columns, so each gets a hidden column after the model's, never seen by the mapper.
        expect(sortColumns[2]).toBe(query.columns[6]);
        expect(sortColumns[6]).toBe(query.columns[7]);
        expect(described.columns.slice(6)).toEqual([{ alias: '__sort0', fieldId: 'status' }, { alias: '__sort1', fieldId: 'tranid' }]);
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
