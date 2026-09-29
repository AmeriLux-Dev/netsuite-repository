import { GovernanceLimitError, QueryBuilder, runRowLimit } from '../query';
import { RecordSet } from '../context';
import type { QueryConfig } from '../types';
import { customerConfig, customerInvoiceConfig, orderConfig, separateOrderConfig } from './fixtures';
import { fakeNQuery, fakeNRuntime } from '../testing';

// N/query's run() answers at most 5,000 rows and says nothing when it stops there (probe k2, 2026-09-24): a list read
// on past that picks up after its last row, by the query's sorts and the internal id appended to them.

const customerRow = (id: number, overrides: Record<string, unknown> = {}) => ({ id, name: `C${id}`, email: '', isactive: false, score: 0, ...overrides });
const customerRows = (firstId: number, count: number) => Array.from({ length: count }, (_, index) => customerRow(firstId + index));

const invoiceConfig: QueryConfig<{ id: number; tranDate: string }> = {
    recordType: 'invoice',
    fields: {
        id: { queryFieldId: 'id', type: 'integer', isPrimary: true, recordFieldId: 'id' },
        tranDate: { queryFieldId: 'trandate', type: 'date', recordFieldId: 'trandate' },
    },
};

beforeEach(() => {
    fakeNQuery.reset();
    fakeNRuntime.reset();
});

describe('QueryBuilder – the internal id as the last sort', () => {
    it("appends the internal id after the query's own sorts, so every order is complete", () => {
        expect(QueryBuilder.from(customerConfig).orderByDesc('score').describe().sort).toEqual([
            { fieldId: 'custentity_score', ascending: false },
            { fieldId: 'id', ascending: true },
        ]);
        expect(QueryBuilder.from(customerConfig).describe().sort).toEqual([{ fieldId: 'id', ascending: true }]);
    });

    it('does not sort by the id twice', () => {
        expect(QueryBuilder.from(customerConfig).orderByDesc('id').describe().sort).toEqual([{ fieldId: 'id', ascending: false }]);
    });
});

describe('QueryBuilder.executeTyped() – past the 5,000-row answer', () => {
    it('is the size of the answer N/query gives at most', () => {
        expect(runRowLimit).toBe(5000);
    });

    it('reads on after the last row, by id, while N/query answers 5,000 rows', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNQuery.queueRows('customer', customerRows(5001, 5000));
        fakeNQuery.queueRows('customer', customerRows(10001, 3));

        const customers = QueryBuilder.from(customerConfig).executeTyped();

        expect(customers).toHaveLength(10003);
        expect(customers[10002].id).toBe(10003);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'run', 'run']);
        expect(fakeNQuery.calls[0].description.condition).toBeUndefined();
        expect(fakeNQuery.calls[1].description.condition).toEqual({ kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] });
        expect(fakeNQuery.calls[2].description.condition).toEqual({ kind: 'field', fieldId: 'id', operator: 'GREATER', values: [10000] });
    });

    it("keeps the query's own conditions on every read", () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNQuery.queueRows('customer', []);
        QueryBuilder.from(customerConfig).where('score', '>', 1).executeTyped();
        expect(fakeNQuery.calls[1].description.condition).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'custentity_score', operator: 'GREATER', values: [1] },
                { kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] },
            ],
        });
    });

    // Descending, NetSuite puts blanks first (probe k4), so they are behind the last row already.
    it('reads on after a number sort: a lower number, or the same number and a later id', () => {
        fakeNQuery.queueRows('customer', [...customerRows(1, 4999), customerRow(5000, { score: 7 })]);
        fakeNQuery.queueRows('customer', []);
        QueryBuilder.from(customerConfig).orderByDesc('score').executeTyped();
        expect(fakeNQuery.calls[1].description.condition).toEqual({
            kind: 'or',
            nodes: [
                { kind: 'field', fieldId: 'custentity_score', operator: 'LESS', values: [7] },
                { kind: 'and', nodes: [{ kind: 'field', fieldId: 'custentity_score', operator: 'EQUAL', values: [7] }, { kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] }] },
            ],
        });
    });

    // N/query rejects GREATER on text; NetSuite orders text as UPPER(field), and a formula comparing the upper-cased
    // text picks up exactly where that order left off (probe k3). Ascending, blanks come after every name (probe k4).
    it('reads on after a text sort the way NetSuite orders it, upper-cased, with the blanks after every name', () => {
        fakeNQuery.queueRows('customer', [...customerRows(1, 4999), customerRow(5000, { name: "O'Brien Supply" })]);
        fakeNQuery.queueRows('customer', []);
        QueryBuilder.from(customerConfig).orderBy('name').executeTyped();
        expect(fakeNQuery.calls[1].description.condition).toEqual({
            kind: 'or',
            nodes: [
                { kind: 'formula', formula: "CASE WHEN UPPER({companyname}) > UPPER('O''Brien Supply') THEN 1 ELSE 0 END", type: 'INTEGER', operator: 'EQUAL', values: [1] },
                { kind: 'field', fieldId: 'companyname', operator: 'EMPTY' },
                {
                    kind: 'and',
                    nodes: [
                        { kind: 'formula', formula: "CASE WHEN UPPER({companyname}) = UPPER('O''Brien Supply') THEN 1 ELSE 0 END", type: 'INTEGER', operator: 'EQUAL', values: [1] },
                        { kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] },
                    ],
                },
            ],
        });
    });

    it('reads on from a blank: only the blanks after it by id, when blanks sort last', () => {
        fakeNQuery.queueRows('customer', [...customerRows(1, 4999), customerRow(5000, { name: null })]);
        fakeNQuery.queueRows('customer', []);
        QueryBuilder.from(customerConfig).orderBy('name').executeTyped();
        expect(fakeNQuery.calls[1].description.condition).toEqual({
            kind: 'and',
            nodes: [{ kind: 'field', fieldId: 'companyname', operator: 'EMPTY' }, { kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] }],
        });
    });

    // A date comes back as NetSuite formats it and goes back the same way; AFTER and ON with it read on exactly (probe k5).
    it('reads on after a date sort with AFTER and ON, passing the date back as NetSuite answered it', () => {
        fakeNQuery.queueRows('invoice', [...Array.from({ length: 4999 }, (_, index) => ({ id: index + 1, trandate: '9/1/2026' })), { id: 5000, trandate: '9/23/2026' }]);
        fakeNQuery.queueRows('invoice', []);
        QueryBuilder.from(invoiceConfig).orderBy('tranDate').executeTyped();
        expect(fakeNQuery.calls[1].description.condition).toEqual({
            kind: 'or',
            nodes: [
                { kind: 'field', fieldId: 'trandate', operator: 'AFTER', values: ['9/23/2026'] },
                { kind: 'field', fieldId: 'trandate', operator: 'EMPTY' },
                { kind: 'and', nodes: [{ kind: 'field', fieldId: 'trandate', operator: 'ON', values: ['9/23/2026'] }, { kind: 'field', fieldId: 'id', operator: 'GREATER', values: [5000] }] },
            ],
        });
    });

    // Checkboxes, select fields, datetimes, display text and formulas have no comparison the probes checked, so the
    // rows are read in the query's own order through runPaged, a thousand at a time.
    it('reads a sort it cannot pick up after (a checkbox) through runPaged, past the 5,000-row answer', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNQuery.queueRows('customer', customerRows(1, 5003));

        const customers = QueryBuilder.from(customerConfig).orderBy('isActive').executeTyped();

        expect(customers).toHaveLength(5003);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'runPaged']);
        expect(fakeNQuery.calls[1].pageSize).toBe(1000);
    });

    // Reading on after text compares it in a formula, and a formula reaches a joined record only through a select field
    // that points at one record type ({entity.companyname} is "not found", sandbox 2026-09-28).
    it('reads a text sort on a record joined through a reference through runPaged, past the 5,000-row answer', () => {
        const invoiceRows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1, customer_companyName: `C${index}` }));
        fakeNQuery.queueRows('transaction', invoiceRows(5000));
        fakeNQuery.queueRows('transaction', invoiceRows(5003));

        const invoices = QueryBuilder.from(customerInvoiceConfig).select('customer.companyName').orderBy('customer.companyName').executeTyped();

        expect(invoices).toHaveLength(5003);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'runPaged']);
    });

    // A joined sublist answers a row per line, so an answer can stop inside an order's lines: those queries are read
    // through runPaged too, and the rows grouped into orders once all are in.
    it('reads a joined sublist through runPaged past the 5,000-row answer, and groups the rows into records', () => {
        const lineRows = (orderCount: number) => Array.from({ length: orderCount * 2 }, (_, index) => ({ id: Math.floor(index / 2) + 1, entityid: 7, lines_itemid: index, lines_qty: 1, lines_amount: 1 }));
        fakeNQuery.queueRows('salesorder', lineRows(2500));
        fakeNQuery.queueRows('salesorder', lineRows(2501));

        const orders = QueryBuilder.from(orderConfig).executeTyped();

        expect(orders).toHaveLength(2501);
        expect(fakeNQuery.calls.map((call) => call.execution)).toEqual(['run', 'runPaged']);
    });
});

describe('QueryBuilder – the governance guard', () => {
    // One read cost 10 units (1,000 left, then 990); 105 left before the next leaves 95, under the 100 held back.
    it('stops before a read the script cannot afford, with an error that says how far it got', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNRuntime.queueRemainingUsage(1000, 990, 105);

        let caught: unknown;
        try {
            QueryBuilder.from(customerConfig).executeTyped();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(GovernanceLimitError);
        expect(caught).toMatchObject({ rowsRead: 5000, remainingUsage: 105, readCost: 10, reserve: 100 });
        expect(fakeNQuery.calls).toHaveLength(1);
    });

    it('reads on while the next read leaves the reserve, which the query can set', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNQuery.queueRows('customer', customerRows(5001, 3));
        fakeNRuntime.queueRemainingUsage(1000, 990, 15);
        expect(QueryBuilder.from(customerConfig, { governanceReserve: 0 }).executeTyped()).toHaveLength(5003);
    });
});

describe('QueryBuilder.executeTypedPage()', () => {
    it('answers the first page, with a marker to read on from when more rows follow', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 3));
        const page = QueryBuilder.from(customerConfig).executeTypedPage({ limit: 2 });
        expect(page.items.map((customer) => customer.id)).toEqual([1, 2]);
        expect(page.next).toBe('[2]');
        expect(fakeNQuery.calls[0]).toEqual(expect.objectContaining({ execution: 'run' }));
        expect(fakeNQuery.calls[0].description.condition).toBeUndefined();
    });

    it('picks up after the marker, and answers no marker once the rows run out', () => {
        fakeNQuery.queueRows('customer', customerRows(3, 1));
        const page = QueryBuilder.from(customerConfig).executeTypedPage({ after: '[2]', limit: 2 });
        expect(page).toEqual({ items: [expect.objectContaining({ id: 3 })], next: null });
        expect(fakeNQuery.calls[0].description.condition).toEqual({ kind: 'field', fieldId: 'id', operator: 'GREATER', values: [2] });
    });

    it('reads on past the 5,000-row answer to fill a page larger than it', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNQuery.queueRows('customer', customerRows(5001, 3));
        const page = QueryBuilder.from(customerConfig).executeTypedPage({ limit: 6000 });
        expect(page.items).toHaveLength(5003);
        expect(page.next).toBeNull();
    });

    it('answers a marker when a full answer ends the page exactly, since more may follow', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        expect(QueryBuilder.from(customerConfig).executeTypedPage({ limit: 5000 }).next).toBe('[5000]');
    });

    it("carries every sort's value in the marker, the id last", () => {
        fakeNQuery.queueRows('customer', [customerRow(7, { name: 'Acme' }), customerRow(8, { name: 'Brick' })]);
        expect(QueryBuilder.from(customerConfig).orderBy('name').executeTypedPage({ limit: 1 }).next).toBe('["Acme",7]');
    });

    it('stops early when the script cannot afford another read, answering what it has and where to read on', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 5000));
        fakeNRuntime.queueRemainingUsage(1000, 990, 105);
        const page = QueryBuilder.from(customerConfig).executeTypedPage({ limit: 6000 });
        expect(page.items).toHaveLength(5000);
        expect(page.next).toBe('[5000]');
        expect(fakeNQuery.calls).toHaveLength(1);
    });

    it('rejects a marker that does not belong to the query', () => {
        expect(() => QueryBuilder.from(customerConfig).executeTypedPage({ after: '["Acme",7]', limit: 2 })).toThrow('marker');
        expect(() => QueryBuilder.from(customerConfig).executeTypedPage({ after: 'not json', limit: 2 })).toThrow('marker');
    });

    // A page must read on, so it keeps the formula, which names the joined record by the select field that joins it: a
    // relation named apart from its field reaches the record that way, where its model name reaches nothing.
    it("reads on after a joined record's text by the select field that joins it, not the model's relation name", () => {
        const paymentTermsConfig: QueryConfig<{ id: number; paymentTerms: { name: string } }> = {
            recordType: 'invoice',
            components: { paymentTerms: { path: 'paymentTerms', relationship: 'paymentTerms', load: 'join', join: { kind: 'to', fieldId: 'terms', target: 'term' } } },
            fields: {
                id: { queryFieldId: 'id', type: 'key', isPrimary: true },
                paymentTerms_name: { queryFieldId: 'name', component: 'paymentTerms', type: 'string', nestPath: 'paymentTerms.name' },
            },
            relationships: { paymentTerms: { kind: 'reference', components: ['paymentTerms'], fields: { name: 'paymentTerms_name' } } },
        };
        fakeNQuery.queueRows('invoice', [{ id: 1, paymentTerms_name: 'Net 30' }, { id: 2, paymentTerms_name: 'Net 60' }, { id: 3, paymentTerms_name: 'Net 90' }]);
        fakeNQuery.queueRows('invoice', []);

        const first = QueryBuilder.from(paymentTermsConfig).orderBy('paymentTerms.name').executeTypedPage({ limit: 2 });
        QueryBuilder.from(paymentTermsConfig).orderBy('paymentTerms.name').executeTypedPage({ after: first.next, limit: 2 });

        expect(fakeNQuery.calls[1].text).toContain("formula(CASE WHEN UPPER({terms.name}) > UPPER('Net 60') THEN 1 ELSE 0 END):INTEGER EQUAL [1]");
    });

    it('rejects a sort it cannot pick up after, a joined sublist, and a limit that is not a positive whole number', () => {
        expect(() => QueryBuilder.from(customerConfig).orderBy('isActive').executeTypedPage({ limit: 2 })).toThrow('isActive');
        expect(() => QueryBuilder.from(orderConfig).executeTypedPage({ limit: 2 })).toThrow('lines');
        expect(() => QueryBuilder.from(customerConfig).executeTypedPage({ limit: 0 })).toThrow('limit');
    });
});

describe('RecordSet.listPage()', () => {
    it('reads one page through the specifications', () => {
        fakeNQuery.queueRows('customer', customerRows(1, 3));
        const page = new RecordSet(customerConfig).listPage({ limit: 2 }, (query) => query.where('score', '>', 1));
        expect(page.items).toHaveLength(2);
        expect(page.next).toBe('[2]');
        expect(fakeNQuery.calls[0].description.condition).toEqual({ kind: 'field', fieldId: 'custentity_score', operator: 'GREATER', values: [1] });
    });
});

describe('separately loaded relations – past the 5,000-row answer', () => {
    const isLineQuery = (parentIds: number[]) => (call: { text: string }) => call.text.includes(`id ANY_OF [${parentIds.join(', ')}]`);

    // Five hundred orders a batch can hold more than 5,000 lines between them: a batch whose answer comes back full is
    // split in two and each half read again, so no order loses lines.
    it('splits a batch of parents in two when its answer comes back full', () => {
        fakeNQuery.queueRows('salesorder', [1, 2, 3, 4].map((id) => ({ id, entityid: 7 })));
        fakeNQuery.queueRows(isLineQuery([1, 2, 3, 4]), Array.from({ length: 5000 }, () => ({ __parentkey: 1, lines_itemid: 0, lines_qty: 1, lines_amount: 1 })));
        fakeNQuery.queueRows(isLineQuery([1, 2]), [{ __parentkey: 1, lines_itemid: 11, lines_qty: 1, lines_amount: 1 }, { __parentkey: 2, lines_itemid: 21, lines_qty: 1, lines_amount: 1 }]);
        fakeNQuery.queueRows(isLineQuery([3, 4]), [{ __parentkey: 4, lines_itemid: 41, lines_qty: 1, lines_amount: 1 }]);

        const orders = QueryBuilder.from(separateOrderConfig).executeTyped();

        expect(orders.map((order) => order.lines.map((line) => line.itemId))).toEqual([[11], [21], [], [41]]);
    });

    it('fails when one parent alone has 5,000 related rows, rather than answer some of them', () => {
        fakeNQuery.queueRows('salesorder', [{ id: 1, entityid: 7 }]);
        fakeNQuery.queueRows(isLineQuery([1]), Array.from({ length: 5000 }, () => ({ __parentkey: 1, lines_itemid: 0, lines_qty: 1, lines_amount: 1 })));
        expect(() => QueryBuilder.from(separateOrderConfig).executeTyped()).toThrow('5000');
    });
});
