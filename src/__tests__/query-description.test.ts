import { renderConditionNode, renderDate, renderQueryDescription } from '../query';
import type { QueryDescription } from '../types';

const description: QueryDescription = {
    queryType: 'salesorder',
    components: [
        { path: 'shippingAddress', join: { kind: 'auto', fieldId: 'shippingaddress' }, conditions: [] },
        { path: 'lines', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] },
        { path: 'lines.item', parent: 'lines', join: { kind: 'to', fieldId: 'item', target: 'item' }, conditions: [] },
    ],
    columns: [
        { alias: 'id', fieldId: 'id' },
        { alias: 'status', fieldId: 'status', context: 'DISPLAY' },
        { alias: 'lines_item_name', component: 'lines.item', fieldId: 'itemid' },
        { alias: 'total', formula: '{quantity} * {rate}', formulaType: 'FLOAT' },
        { alias: 'count', fieldId: 'id', aggregate: 'COUNT_DISTINCT' },
    ],
    condition: {
        kind: 'and',
        nodes: [
            { kind: 'field', fieldId: 'entity', operator: 'EQUAL', values: [2430] },
            { kind: 'or', nodes: [
                { kind: 'field', component: 'lines.item', fieldId: 'itemtype', operator: 'ANY_OF', values: ['InvtPart', 'Assembly'] },
                { kind: 'not', node: { kind: 'formula', formula: '{trandate} > SYSDATE - 30', type: 'BOOLEAN' } },
            ] },
            { kind: 'formula', formula: '{status#DISPLAY}', type: 'STRING', operator: 'EQUAL', values: ['Pending Fulfillment'] },
            { kind: 'field', fieldId: 'trandate', operator: 'ON_OR_AFTER', values: [new Date(2026, 0, 5)] },
            { kind: 'field', fieldId: 'otherrefnum', operator: 'EMPTY' },
        ],
    },
    sort: [
        { fieldId: 'trandate', ascending: true },
        { component: 'lines', fieldId: 'linesequencenumber', ascending: false, nullsLast: true },
        { formula: '{quantity} * {rate}', ascending: true, nullsLast: false },
        { fieldId: 'status', context: 'DISPLAY', ascending: false },
    ],
    page: { offset: 20, limit: 10 },
    separateLoads: [{
        relationship: 'carrier', kind: 'reference', parentKeyPath: 'carrierCode', batchFieldId: 'custrecord_carrier_code', parentKeyAlias: '__parentKey',
        description: { queryType: 'customrecord_carrier', components: [], columns: [{ alias: 'carrier_name', fieldId: 'name' }, { alias: '__parentKey', fieldId: 'custrecord_carrier_code' }], sort: [] },
    }],
};

describe('renderQueryDescription', () => {
    it('renders one clause per line with relation paths as the model names them', () => {
        expect(renderQueryDescription(description)).toBe([
            'FROM salesorder',
            'JOIN auto shippingaddress AS shippingAddress',
            'JOIN from transactionline.transaction AS lines WHERE lines.mainline IS [false]',
            'JOIN to item ON item AS lines.item',
            'SELECT id AS id, status#DISPLAY AS status, lines.item.itemid AS lines_item_name, formula({quantity} * {rate}):FLOAT AS total, COUNT_DISTINCT(id) AS count',
            "WHERE entity EQUAL [2430] AND (lines.item.itemtype ANY_OF ['InvtPart', 'Assembly'] OR NOT (formula({trandate} > SYSDATE - 30):BOOLEAN)) AND formula({status#DISPLAY}):STRING EQUAL ['Pending Fulfillment'] AND trandate ON_OR_AFTER [2026-01-05] AND otherrefnum EMPTY",
            'ORDER BY trandate ASC, lines.linesequencenumber DESC NULLS LAST, formula({quantity} * {rate}) ASC NULLS FIRST, status#DISPLAY DESC',
            'PAGE offset 20 limit 10',
            'SEPARATE carrier BY custrecord_carrier_code:',
            '    FROM customrecord_carrier',
            '    SELECT name AS carrier_name, custrecord_carrier_code AS __parentKey',
        ].join('\n'));
    });

    it('renders a minimal description and an unlimited page window', () => {
        expect(renderQueryDescription({ queryType: 'customer', components: [], columns: [{ alias: 'id', fieldId: 'id' }], sort: [], page: { offset: 5 } })).toBe('FROM customer\nSELECT id AS id\nPAGE offset 5');
    });
});

describe('renderConditionNode', () => {
    it('parenthesizes nested groups but not the top level', () => {
        expect(renderConditionNode({ kind: 'and', nodes: [{ kind: 'field', fieldId: 'a', operator: 'EMPTY' }, { kind: 'field', fieldId: 'b', operator: 'EMPTY' }] })).toBe('(a EMPTY AND b EMPTY)');
        expect(renderConditionNode({ kind: 'and', nodes: [{ kind: 'field', fieldId: 'a', operator: 'EMPTY' }] }, true)).toBe('a EMPTY');
    });
});

describe('renderDate', () => {
    it('shows the local date, and the time only when it is not midnight', () => {
        expect(renderDate(new Date(2026, 11, 31))).toBe('2026-12-31');
        expect(renderDate(new Date(2026, 0, 5, 8, 5, 9))).toBe('2026-01-05 08:05:09');
    });
});
