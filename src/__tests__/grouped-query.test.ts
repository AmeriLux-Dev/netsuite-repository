import * as NsFormat from 'N/format';
import { RecordSet } from '../context';
import type { Specification } from '../context';
import { query } from '../query';
import { fakeNQuery, fakeNRuntime } from '../testing';
import { customerInvoiceConfig, orderConfig } from './fixtures';
import type { CustomerInvoice } from './fixtures';

// What the grouped reads rest on was checked in a sandbox account on 2026-09-28 (experiments/group-by-probe*.js):
// N/query groups by any column marked groupBy and never groups a plain column for you; it renders a sort on an
// aggregate without the aggregate, and that query fails; run() stops at 5,000 groups; runPaged returns every group once.

const mockParse = NsFormat.parse as unknown as jest.Mock;

const forCustomer = (customerId: number): Specification<CustomerInvoice> => (invoices) => invoices.where('customerId', '=', customerId);
const open = (): Specification<CustomerInvoice> => (invoices) => invoices.where('status', 'IN', ['CustInvc:A', 'A']).where('amountUnpaid', '>', 0);

beforeEach(() => {
    fakeNQuery.reset();
    fakeNRuntime.reset();
    mockParse.mockReset();
});

describe('QueryBuilder.groupBy() – what a grouped read asks N/query for', () => {
    it('selects the group keys and the aggregates, groups by the keys, and sorts by them, with no internal id', () => {
        const description = query(customerInvoiceConfig).groupBy('customerId', 'subsidiaryId').aggregate('COUNT', 'id', 'invoiceCount').describe();

        expect(description).toEqual({
            queryType: 'transaction',
            components: [{ path: 'transactionlines', join: { kind: 'auto', fieldId: 'transactionlines' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }],
            columns: [
                { alias: 'customerId', fieldId: 'entity', groupBy: true },
                { alias: 'subsidiaryId', component: 'transactionlines', fieldId: 'subsidiary', groupBy: true },
                { alias: 'invoiceCount', fieldId: 'id', aggregate: 'COUNT' },
            ],
            condition: { kind: 'field', fieldId: 'type', operator: 'ANY_OF', values: ['CustInvc'] },
            sort: [{ fieldId: 'entity', ascending: true }, { component: 'transactionlines', fieldId: 'subsidiary', ascending: true }],
        });
    });

    it('renders the grouping in describeText() and toSQL()', () => {
        const grouped = query(customerInvoiceConfig).groupBy('customerId', 'subsidiaryId').aggregate('SUM', 'amountUnpaid', 'unpaid');

        expect(grouped.describeText()).toBe([
            'FROM transaction',
            'JOIN auto transactionlines AS transactionlines WHERE transactionlines.mainline IS [true]',
            'SELECT entity AS customerId, transactionlines.subsidiary AS subsidiaryId, SUM(foreignamountunpaid) AS unpaid',
            "WHERE type ANY_OF ['CustInvc']",
            'GROUP BY entity, transactionlines.subsidiary',
            'ORDER BY entity ASC, transactionlines.subsidiary ASC',
        ].join('\n'));
        expect(grouped.toSQL()).toContain('GROUP BY entity, transactionlines.subsidiary');
    });

    it('aggregates a formula under its alias, with the return type its options give', () => {
        const pastDue = 'CASE WHEN {trandate} + NVL(NULLIF({terms.daysuntilnetdue}, 0), 30) < TRUNC(CURRENT_DATE) THEN {foreignamountunpaid} ELSE 0 END';
        const description = query(customerInvoiceConfig).groupBy('customerId').aggregateFormula('SUM', pastDue, 'pastDueAmount', { type: 'FLOAT', fieldType: 'currency' }).describe();

        expect(description.columns).toEqual([
            { alias: 'customerId', fieldId: 'entity', groupBy: true },
            { alias: 'pastDueAmount', formula: pastDue, formulaType: 'FLOAT', aggregate: 'SUM' },
        ]);
        expect(description.components).toEqual([]);
    });

    it('groups by display text, a field of a joined reference, and a formula the query declared', () => {
        const description = query(customerInvoiceConfig)
            .selectFormula("TO_CHAR({trandate}, 'YYYY')", 'tranYear', { type: 'STRING', fieldType: 'string' })
            .groupBy('currencyName', 'customer.companyName', 'tranYear')
            .aggregate('COUNT', 'id', 'invoiceCount')
            .describe();

        expect(description.components).toEqual([{ path: 'customer', join: { kind: 'to', fieldId: 'entity', target: 'customer' }, conditions: [] }]);
        expect(description.columns).toEqual([
            { alias: 'currencyName', fieldId: 'currency', context: 'DISPLAY', groupBy: true },
            { alias: 'customer_companyName', component: 'customer', fieldId: 'companyname', groupBy: true },
            { alias: 'tranYear', formula: "TO_CHAR({trandate}, 'YYYY')", formulaType: 'STRING', groupBy: true },
            { alias: 'invoiceCount', fieldId: 'id', aggregate: 'COUNT' },
        ]);
        expect(description.sort).toEqual([
            { fieldId: 'currency', context: 'DISPLAY', ascending: true },
            { component: 'customer', fieldId: 'companyname', ascending: true },
            { formula: "TO_CHAR({trandate}, 'YYYY')", formulaType: 'STRING', ascending: true },
        ]);
    });

    it("aggregates a sublist's fields, one line a row", () => {
        const description = query(orderConfig).groupBy('id').aggregate('SUM', 'lines.qty', 'quantity').aggregate('COUNT', 'lines.itemId', 'lineCount').describe();

        expect(description.components).toEqual([
            { path: 'lines', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] },
        ]);
        expect(description.columns).toEqual([
            { alias: 'id', fieldId: 'id', groupBy: true },
            { alias: 'quantity', component: 'lines', fieldId: 'quantity', aggregate: 'SUM' },
            { alias: 'lineCount', component: 'lines', fieldId: 'item', aggregate: 'COUNT' },
        ]);
    });

    it('keeps the conditions the query had and joins what they read', () => {
        const description = query(customerInvoiceConfig).where('customer.isInactive', '=', false).groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount').describe();

        expect(description.components).toEqual([{ path: 'customer', join: { kind: 'to', fieldId: 'entity', target: 'customer' }, conditions: [] }]);
        expect(description.condition).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'type', operator: 'ANY_OF', values: ['CustInvc'] },
                { kind: 'field', component: 'customer', fieldId: 'isinactive', operator: 'IS', values: [false] },
            ],
        });
    });

    it('sorts by a group key in N/query, the other keys after it to complete the order', () => {
        const description = query(customerInvoiceConfig).groupBy('customerId', 'subsidiaryId').aggregate('COUNT', 'id', 'invoiceCount').orderByDesc('subsidiaryId').describe();

        expect(description.sort).toEqual([{ component: 'transactionlines', fieldId: 'subsidiary', ascending: false }, { fieldId: 'entity', ascending: true }]);
        expect(description.scriptSort).toBeUndefined();
    });

    it('sorts by an aggregate in script, after every group is read: N/query cannot sort on one', () => {
        const grouped = query(customerInvoiceConfig).groupBy('customerId').aggregate('SUM', 'amountUnpaid', 'unpaid').orderByDesc('unpaid').orderByAsc('customerId');

        expect(grouped.describe().sort).toEqual([{ fieldId: 'entity', ascending: true }]);
        expect(grouped.describe().scriptSort).toEqual([{ path: 'unpaid', ascending: false }, { path: 'customerId', ascending: true }]);
        expect(grouped.describeText()).toContain('SORT IN SCRIPT BY unpaid DESC, customerId ASC');
    });

    it('leaves the query it groups as it was', () => {
        const builder = query(customerInvoiceConfig).select('tranDate');
        builder.groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount');

        expect(builder.describe().columns).toEqual([{ alias: 'id', fieldId: 'id' }, { alias: 'tranDate', fieldId: 'trandate' }]);
    });
});

describe('QueryBuilder.groupBy() – what it refuses, and why', () => {
    const invoices = () => query(customerInvoiceConfig);

    it('needs a key', () => {
        expect(() => (invoices().groupBy as (...keys: string[]) => unknown)()).toThrow("A grouped read of 'invoice' needs at least one key to group by.");
    });

    it('refuses a multi-select as a key: it holds several values', () => {
        expect(() => invoices().groupBy('tagIds' as 'status').describe()).toThrow("'tagIds' of 'invoice' is a multi-select, which holds several values: a grouped read cannot group by it or aggregate it.");
    });

    it('refuses a field of a relation loaded separately, pointing to a formula that reaches it', () => {
        const separately = "'terms' of 'invoice' is loaded separately (load: 'separate'), and a grouped read reads nothing separately";
        expect(() => invoices().groupBy('terms.daysUntilNetDue').describe()).toThrow(`${separately}, so it cannot group by 'terms.daysUntilNetDue'. A formula reaches the field: {terms.daysuntilnetdue}.`);
        expect(() => invoices().groupBy('customerId').aggregate('MAXIMUM', 'terms.daysUntilNetDue', 'termDays').describe()).toThrow(`${separately}, so it cannot aggregate 'terms.daysUntilNetDue'.`);
        expect(() => invoices().where('terms.name', '=', 'Net 30').groupBy('customerId').describe()).toThrow(`${separately}, so it cannot apply a condition on it.`);
    });

    it('refuses to sum, average, or take the median of anything but a number', () => {
        expect(() => invoices().groupBy('customerId').aggregate('SUM', 'tranDate' as 'total', 'x').describe()).toThrow("SUM takes a number, and 'tranDate' of 'invoice' is a date: N/query fails to render it. COUNT, MINIMUM and MAXIMUM take any field.");
        expect(() => invoices().groupBy('customerId').aggregate('AVERAGE_DISTINCT', 'isVoided' as 'total', 'x').describe()).toThrow("AVERAGE_DISTINCT takes a number, and 'isVoided' of 'invoice' is a checkbox");
    });

    it('refuses a sort on anything but a group key or an aggregate', () => {
        expect(() => invoices().orderByAsc('tranDate').groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount').describe()).toThrow(
            "A grouped read of 'invoice' sorts by its group keys and aggregates, and 'tranDate' is neither.",
        );
    });

    it('refuses an alias already used by a key or another aggregate', () => {
        expect(() => invoices().groupBy('customerId').aggregate('COUNT', 'id', 'customerId').describe()).toThrow("Alias 'customerId' is already used by a group key or an aggregate of 'invoice'.");
        expect(() => invoices().groupBy('customer.companyName').aggregate('COUNT', 'id', 'customer').describe()).toThrow("Alias 'customer' is already used by a group key or an aggregate of 'invoice'.");
        expect(() => invoices().groupBy('customerId').aggregate('COUNT', 'id', 'n').aggregate('SUM', 'total', 'n').describe()).toThrow("Alias 'n' is already used");
    });
});

describe('GroupedQuery.list()', () => {
    it('maps each group to its keys at their model paths and its aggregates at their aliases, coerced to their types', () => {
        mockParse.mockImplementation(({ value }: { value: string }) => (value === '9/1/2026' ? new Date(2026, 8, 1) : undefined));
        fakeNQuery.queueRows('transaction', [{ customerId: 7, customer_companyName: 'Acme', invoiceCount: '3', unpaid: '120.5', lastInvoiced: '9/1/2026', anyVoided: 'F' }]);

        const groups = new RecordSet(customerInvoiceConfig)
            .groupBy('customerId', 'customer.companyName')
            .aggregate('COUNT', 'id', 'invoiceCount')
            .aggregate('SUM', 'amountUnpaid', 'unpaid')
            .aggregate('MAXIMUM', 'tranDate', 'lastInvoiced')
            .aggregate('MAXIMUM', 'isVoided', 'anyVoided')
            .list();

        expect(groups).toEqual([{ customerId: 7, customer: { companyName: 'Acme' }, invoiceCount: 3, unpaid: 120.5, lastInvoiced: new Date(2026, 8, 1), anyVoided: false }]);
        expect(fakeNQuery.calls[0].text).toContain('GROUP BY entity, entity.companyname');
    });

    it('coerces a formula aggregate to the field type its options give', () => {
        fakeNQuery.queueRows('transaction', [{ customerId: 7, pastDueAmount: '12.25' }]);

        const [group] = new RecordSet(customerInvoiceConfig).groupBy('customerId').aggregateFormula('SUM', '{foreignamountunpaid}', 'pastDueAmount', { type: 'FLOAT', fieldType: 'currency' }).list();

        expect(group).toEqual({ customerId: 7, pastDueAmount: 12.25 });
    });

    it("reads a key through a sublist as one value per group, not the sublist's array", () => {
        fakeNQuery.queueRows('salesorder', [{ lines_itemId: 5, quantity: 3 }, { lines_itemId: 6, quantity: 1 }]);

        expect(query(orderConfig).groupBy('lines.itemId').aggregate('SUM', 'lines.qty', 'quantity').list()).toEqual([{ lines: { itemId: 5 }, quantity: 3 }, { lines: { itemId: 6 }, quantity: 1 }]);
    });

    it('applies the specifications to what it groups, the way list() does, on a copy: the grouped query can run again', () => {
        fakeNQuery.queueRows('transaction', [], { repeat: true });
        const grouped = new RecordSet(customerInvoiceConfig).groupBy('subsidiaryId').aggregate('COUNT', 'id', 'invoiceCount');

        grouped.list(forCustomer(7), open());
        grouped.list(forCustomer(8));

        expect(fakeNQuery.calls[0].text).toContain("entity ANY_OF [7]");
        expect(fakeNQuery.calls[0].text).toContain("status ANY_OF ['CustInvc:A', 'A']");
        expect(fakeNQuery.calls[0].text).toContain('GROUP BY transactionlines.subsidiary');
        expect(fakeNQuery.calls[1].text).toContain('entity ANY_OF [8]');
        expect(fakeNQuery.calls[1].text).not.toContain('entity ANY_OF [7]');
        expect(grouped.describe().condition).toEqual({ kind: 'field', fieldId: 'type', operator: 'ANY_OF', values: ['CustInvc'] });
    });

    it('never tracks a group, even from a tracked query', () => {
        const invoices = new RecordSet(customerInvoiceConfig);
        fakeNQuery.queueRows('transaction', [{ customerId: 7, invoiceCount: 1 }], { repeat: true });

        const [fromSet] = invoices.groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount').list();
        const [fromQuery] = invoices.query().groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount').list();

        expect(invoices.entry(fromSet as unknown as CustomerInvoice)).toBeUndefined();
        expect(invoices.entry(fromQuery as unknown as CustomerInvoice)).toBeUndefined();
    });

    it('sorts by an aggregate in script: blanks first descending, as NetSuite sorts them, and ties in the order N/query read them', () => {
        fakeNQuery.queueRows('transaction', [{ customerId: 1, unpaid: 5 }, { customerId: 2, unpaid: null }, { customerId: 3, unpaid: 9 }, { customerId: 4, unpaid: 5 }]);

        const groups = query(customerInvoiceConfig).groupBy('customerId').aggregate('SUM', 'amountUnpaid', 'unpaid').orderByDesc('unpaid').list();

        expect(groups.map((group) => group.customerId)).toEqual([2, 3, 1, 4]);
    });

    it('cuts a page window from the groups once they are sorted', () => {
        fakeNQuery.queueRows('transaction', [{ customerId: 1, unpaid: 5 }, { customerId: 2, unpaid: 7 }, { customerId: 3, unpaid: 9 }]);

        const groups = query(customerInvoiceConfig).limit(2).groupBy('customerId').aggregate('SUM', 'amountUnpaid', 'unpaid').orderByDesc('unpaid').list();

        expect(groups.map((group) => group.customerId)).toEqual([3, 2]);
        expect(fakeNQuery.calls[0].execution).toBe('run');
        expect(fakeNQuery.calls[0].description.page).toBeUndefined();
    });
});

describe('GroupedQuery.list() – every group, past the 5,000 N/query answers', () => {
    it('reads on after the last group by its keys, when every key is one a read can compare', () => {
        const groupRows = (firstId: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: firstId + index, lineCount: 2 }));
        fakeNQuery.queueRows('salesorder', groupRows(1, 5000));
        fakeNQuery.queueRows('salesorder', groupRows(5001, 2));

        const groups = query(orderConfig).groupBy('id').aggregate('COUNT', 'lines.itemId', 'lineCount').list();

        expect(groups).toHaveLength(5002);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'run']);
        expect(fakeNQuery.calls[1].text).toContain('id GREATER [5000]');
    });

    it('reads on after a date key with AFTER and ON, the date passed back as NetSuite answered it', () => {
        fakeNQuery.queueRows('transaction', [...Array.from({ length: 4999 }, () => ({ tranDate: '9/1/2026', invoiceCount: 1 })), { tranDate: '9/23/2026', invoiceCount: 1 }]);
        fakeNQuery.queueRows('transaction', []);

        query(customerInvoiceConfig).groupBy('tranDate').aggregate('COUNT', 'id', 'invoiceCount').list();

        expect(fakeNQuery.calls[1].text).toContain("trandate AFTER ['9/23/2026']");
    });

    it('reads every group through runPaged when a key is one no read can compare (a select field)', () => {
        const groupRows = (count: number) => Array.from({ length: count }, (_, index) => ({ customerId: index + 1, invoiceCount: 1 }));
        fakeNQuery.queueRows('transaction', groupRows(5000));
        fakeNQuery.queueRows('transaction', groupRows(5003));

        const groups = query(customerInvoiceConfig).groupBy('customerId').aggregate('COUNT', 'id', 'invoiceCount').list();

        expect(groups).toHaveLength(5003);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'runPaged']);
        expect(fakeNQuery.calls[1].pageSize).toBe(1000);
    });
});
