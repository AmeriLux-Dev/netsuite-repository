import { query } from '../query';
import type { QueryBuilder } from '../query';
import type { QueryConfig } from '../types';
import { fakeNQuery } from '../testing';
import { separateOrderConfig, shipmentConfig } from './fixtures';
import { salesOrderModelConfig, separateLinesSalesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

const filtered: QueryConfig<SalesOrderModel> = { ...salesOrderModelConfig, queryType: 'transaction', rootConditions: [{ fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] }] };

const onDemandCustomer: QueryConfig<SalesOrderModel> = {
    ...salesOrderModelConfig,
    relationships: {
        ...salesOrderModelConfig.relationships,
        customer: { kind: 'reference', fields: { companyName: 'customer_companyName' }, components: ['customer'], selectByDefault: false },
    },
};

beforeEach(() => {
    fakeNQuery.reset();
});

describe('QueryBuilder – include() and exclude()', () => {
    it("drops an excluded relationship's fields and components", () => {
        const description = query(salesOrderModelConfig).exclude('lines', 'shippingAddress').describe();
        expect(description.components.map((component) => component.path)).toEqual(['customer']);
        expect(description.columns.map((column) => column.alias)).toEqual(['id', 'tranId', 'memo', 'customer_companyName']);
    });

    it("keeps an excluded relationship's component when a condition still reads it", () => {
        const description = query(salesOrderModelConfig).exclude('lines').where('lines.quantity', '>', 1).describe();
        expect(description.components.map((component) => component.path)).toEqual(['customer', 'lines', 'shippingAddress']);
        expect(description.columns.map((column) => column.alias)).not.toContain('lines_quantity');
    });

    it('leaves a relationship that is not selected by default out until include() asks for it', () => {
        const withoutCustomer = query(onDemandCustomer).describe();
        expect(withoutCustomer.columns.map((column) => column.alias)).not.toContain('customer_companyName');
        expect(withoutCustomer.components.map((component) => component.path)).toEqual(['lines', 'shippingAddress']);

        const withCustomer = query(onDemandCustomer).include('customer').describe();
        expect(withCustomer.columns.map((column) => column.alias)).toContain('customer_companyName');
        expect(withCustomer.components.map((component) => component.path)).toContain('customer');
    });

    it('lets include() win over a previous exclude() and the reverse', () => {
        expect(query(salesOrderModelConfig).exclude('lines').include('lines').describe().columns.map((column) => column.alias)).toContain('lines_quantity');
        expect(query(salesOrderModelConfig).include('lines').exclude('lines').describe().columns.map((column) => column.alias)).not.toContain('lines_quantity');
    });

    it('rejects unknown relationship names', () => {
        expect(() => query(salesOrderModelConfig).include('ghost' as never)).toThrow("Relationship 'ghost' is not defined in query config for 'salesorder'.");
        expect(() => query(salesOrderModelConfig).exclude('ghost' as never)).toThrow("Relationship 'ghost' is not defined");
    });
});

describe('QueryBuilder – dotted field keys', () => {
    it('accepts dotted paths for nested fields in select, where, and orderBy', () => {
        const description = query(salesOrderModelConfig)
            .select('tranId', 'customer.companyName')
            .where('lines.quantity', '>', 2)
            .orderByDesc('shippingAddress.city')
            .describe();
        expect(description.columns.map((column) => column.alias)).toEqual(['id', 'tranId', 'customer_companyName']);
        expect(description.condition).toEqual({ kind: 'field', component: 'lines', fieldId: 'quantity', operator: 'GREATER', values: [2] });
        expect(description.sort).toEqual([{ component: 'shippingAddress', fieldId: 'city', ascending: false }]);
        expect(description.components.map((component) => component.path)).toEqual(['customer', 'lines', 'shippingAddress']);
    });

    it('still rejects unknown dotted paths', () => {
        expect(() => (query(salesOrderModelConfig) as QueryBuilder<unknown>).where('customer.ghost', '=', 1)).toThrow("Field 'customer.ghost' is not defined in query config for 'salesorder'.");
    });

    it('rejects a field on a component the config does not define', () => {
        const broken: QueryConfig<unknown> = { recordType: 'x', fields: { id: { queryFieldId: 'id', isPrimary: true }, other: { queryFieldId: 'o', component: 'ghost' } } };
        expect(() => query(broken).describe()).toThrow("Component 'ghost' is not defined in query config for 'x'.");
    });
});

describe('QueryBuilder – root conditions', () => {
    it('applies the declared root conditions in front of the query conditions, alone or combined', () => {
        expect(query(filtered).describe()).toEqual(expect.objectContaining({ queryType: 'transaction', condition: { kind: 'field', fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] } }));
        expect(query(filtered).where('memo', '=', 'a').orWhere('memo', '=', 'b').describe().condition).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] },
                { kind: 'or', nodes: [{ kind: 'field', fieldId: 'memo', operator: 'IS', values: ['a'] }, { kind: 'field', fieldId: 'memo', operator: 'IS', values: ['b'] }] },
            ],
        });
        fakeNQuery.queueRows('transaction', [{ count: 3 }]);
        expect(query(filtered).count()).toBe(3);
        expect(fakeNQuery.calls[0].text).toContain("type ANY_OF ['SalesOrd']");
    });
});

describe('QueryBuilder – separately loaded sublists', () => {
    it('plans a second query keyed by the parent ids, with the relation conditions and sorts routed to it', () => {
        const description = query(separateOrderConfig).where('entityId', '=', 7).where('lines.qty', '>', 1).orderByAsc('lines.amount').describe();
        expect(description.components).toEqual([]);
        expect(description.columns.map((column) => column.alias)).toEqual(['id', 'entityId']);
        expect(description.condition).toEqual({ kind: 'field', fieldId: 'entity', operator: 'ANY_OF', values: [7] });
        expect(description.sort).toEqual([]);
        expect(description.separateLoads).toEqual([{
            relationship: 'lines',
            kind: 'sublist',
            parentKeyPath: 'id',
            batchFieldId: 'id',
            batchFieldType: 'key',
            parentKeyAlias: '__parentKey',
            description: {
                queryType: 'salesorder',
                components: [{ path: 'lines', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }],
                columns: [
                    { alias: 'lines_itemId', component: 'lines', fieldId: 'item' },
                    { alias: 'lines_qty', component: 'lines', fieldId: 'quantity' },
                    { alias: 'lines_amount', component: 'lines', fieldId: 'amount' },
                    { alias: '__parentKey', fieldId: 'id' },
                ],
                condition: { kind: 'field', component: 'lines', fieldId: 'quantity', operator: 'GREATER', values: [1] },
                sort: [{ component: 'lines', fieldId: 'amount', ascending: true }],
            },
        }]);
    });

    it('orders the lines by the declared line order when the query declares no sort, and routes grouped conditions', () => {
        const description = query(separateOrderConfig).whereGroup((builder) => builder.where('lines.qty', '>', 1).orWhere('lines.qty', '<', 0)).describe();
        expect(description.condition).toBeUndefined();
        expect(description.separateLoads?.[0].description.sort).toEqual([{ component: 'lines', fieldId: 'linesequencenumber', ascending: true }]);
        expect(description.separateLoads?.[0].description.condition).toEqual({ kind: 'or', nodes: [
            { kind: 'field', component: 'lines', fieldId: 'quantity', operator: 'GREATER', values: [1] },
            { kind: 'field', component: 'lines', fieldId: 'quantity', operator: 'LESS', values: [0] },
        ] });
    });

    it('skips the separate load when the relation is excluded or none of its fields are selected', () => {
        expect(query(separateOrderConfig).exclude('lines').describe().separateLoads).toEqual([]);
        expect(query(separateOrderConfig).select('entityId').describe().separateLoads).toEqual([]);
    });

    it('loads the lines in batches and stitches them into their parents, empty when there are none', () => {
        fakeNQuery.queueRows({ type: 'salesorder', contains: 'entity AS entityId' }, [{ id: 1, entityid: 5 }, { id: 2, entityid: 5 }, { id: 3, entityid: 6 }]);
        fakeNQuery.queueRows({ type: 'salesorder', contains: 'id ANY_OF [1, 2]' }, [
            { __parentkey: 1, lines_itemid: 10, lines_qty: 1, lines_amount: 5 },
            { __parentkey: 2, lines_itemid: 11, lines_qty: 2, lines_amount: 6 },
            { __parentkey: 1, lines_itemid: 12, lines_qty: 3, lines_amount: 7 },
        ]);
        fakeNQuery.queueRows({ type: 'salesorder', contains: 'id ANY_OF [3]' }, []);

        const orders = query(separateOrderConfig, { separateLoadBatchSize: 2 }).executeTyped();

        expect(orders).toEqual([
            { id: 1, entityId: 5, lines: [{ itemId: 10, qty: 1, amount: 5 }, { itemId: 12, qty: 3, amount: 7 }] },
            { id: 2, entityId: 5, lines: [{ itemId: 11, qty: 2, amount: 6 }] },
            { id: 3, entityId: 6, lines: [] },
        ]);
        expect(fakeNQuery.calls).toHaveLength(3);
        expect(fakeNQuery.calls[1].text).toContain('ORDER BY transactionline.transaction.linesequencenumber ASC');
    });

    it('does not query for lines when no parents came back', () => {
        expect(query(separateOrderConfig).executeTyped()).toEqual([]);
        expect(fakeNQuery.calls).toHaveLength(1);
    });

    it('refuses a separate relationship without a primary key or a component', () => {
        const noPrimary: QueryConfig<unknown> = { ...separateOrderConfig, fields: { ...separateOrderConfig.fields, id: { queryFieldId: 'id' } } } as QueryConfig<unknown>;
        expect(() => query(noPrimary).describe()).toThrow("A primary key field is required to load 'lines' separately on 'salesorder'.");
        const noComponent: QueryConfig<unknown> = { ...separateOrderConfig, components: {} } as QueryConfig<unknown>;
        expect(() => query(noComponent).describe()).toThrow("Relationship 'lines' has no component in query config for 'salesorder'.");
    });

    it('pages over parents and loads lines for the page only', () => {
        fakeNQuery.queueRows({ type: 'salesorder', contains: 'shippingaddress' }, [{ id: 9, tranid: 'SO9', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', customer_companyname: 'Acme' }]);
        fakeNQuery.queueRows({ type: 'salesorder', contains: '__parentKey' }, [{ __parentkey: 9, lines_line: 2, lines_itemid: 6, lines_quantity: 1 }]);
        const [order] = query(separateLinesSalesOrderModelConfig).limit(1).executeTyped();
        expect(order.lines).toEqual([{ line: 2, itemId: 6, quantity: 1 }]);
        expect(fakeNQuery.calls[0].execution).toBe('runPaged');
        expect(fakeNQuery.calls[1].text).toContain('transactionline.transaction.mainline IS [false]');
    });
});

describe('QueryBuilder – separately loaded references', () => {
    it('plans the reference query on the target type, rooted at the reference, keyed by the select field', () => {
        const description = query(shipmentConfig).where('carrier.name', 'LIKE', 'Fed%').orderByAsc('carrier.scac.code').describe();
        expect(description.columns.map((column) => column.alias)).toEqual(['id', 'carrierCode']);
        expect(description.separateLoads).toEqual([{
            relationship: 'carrier',
            kind: 'reference',
            parentKeyPath: 'carrierCode',
            batchFieldId: 'custrecord_carrier_code',
            batchFieldType: 'string',
            parentKeyAlias: '__parentKey',
            description: {
                queryType: 'customrecord_carrier',
                components: [{ path: 'carrier.scac', join: { kind: 'auto', fieldId: 'custrecord_carrier_scac' }, conditions: [] }],
                columns: [
                    { alias: 'carrier_id', fieldId: 'id' },
                    { alias: 'carrier_name', fieldId: 'name' },
                    { alias: 'carrier_scac_code', component: 'carrier.scac', fieldId: 'code' },
                    { alias: '__parentKey', fieldId: 'custrecord_carrier_code' },
                ],
                condition: { kind: 'field', fieldId: 'name', operator: 'START_WITH', values: ['Fed'] },
                sort: [{ component: 'carrier.scac', fieldId: 'code', ascending: true }],
            },
        }]);
    });

    it('stitches one object per parent, or null', () => {
        fakeNQuery.queueRows('customrecord_shipment', [{ id: 1, carriercode: 'FDX' }, { id: 2, carriercode: 'UPS' }, { id: 3, carriercode: null }]);
        fakeNQuery.queueRows('customrecord_carrier', [{ __parentkey: 'FDX', carrier_id: 7, carrier_name: 'FedEx', carrier_scac_code: 'FDXG' }]);
        expect(query(shipmentConfig).executeTyped()).toEqual([
            { id: 1, carrierCode: 'FDX', carrier: { id: 7, name: 'FedEx', scac: { code: 'FDXG' } } },
            { id: 2, carrierCode: 'UPS', carrier: null },
            { id: 3, carrierCode: null, carrier: null },
        ]);
        // The carrier code is text, which has no list operator: one IS (text equality) per code.
        expect(fakeNQuery.calls[1].text).toContain("WHERE custrecord_carrier_code IS ['FDX'] OR custrecord_carrier_code IS ['UPS']");
    });

    it('refuses a separate reference without separate load facts', () => {
        const broken = { ...shipmentConfig, components: { ...shipmentConfig.components, carrier: { ...shipmentConfig.components!.carrier, separate: undefined } } } as QueryConfig<unknown>;
        expect(() => query(broken).describe()).toThrow("Reference 'carrier' is loaded separately but declares no separate load in query config for 'customrecord_shipment'.");
    });
});
