import { QueryBuilder, query, runQuery } from '../query';
import { customerConfig, orderConfig } from './fixtures';
import { fakeNQuery } from '../testing';

const customers = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `C${index + 1}`, email: '', isactive: false, score: 0 }));

beforeEach(() => {
    fakeNQuery.reset();
});

describe('QueryBuilder.execute()', () => {
    it('runs the query and returns the rows with the description', () => {
        fakeNQuery.queueRows('customer', customers.slice(0, 2));
        const result = QueryBuilder.from(customerConfig).where('id', '=', 1).execute();
        expect(result.data).toHaveLength(2);
        expect(result.query.condition).toEqual({ kind: 'field', fieldId: 'id', operator: 'EQUAL', values: [1] });
        expect(fakeNQuery.calls[0]).toEqual(expect.objectContaining({ type: 'customer', execution: 'run' }));
        expect(fakeNQuery.calls[0].text).toContain('WHERE id EQUAL [1]');
    });

    it('reads a row window through runPaged with pages sized to the window', () => {
        fakeNQuery.queueRows('customer', customers);
        const result = QueryBuilder.from(customerConfig).limit(2).execute();
        expect(result.data.map((row) => row.id)).toEqual([1, 2]);
        expect(fakeNQuery.calls[0]).toEqual(expect.objectContaining({ execution: 'runPaged', pageSize: 5 }));
    });

    it('starts at the page that overlaps the offset and slices the remainder', () => {
        fakeNQuery.queueRows('customer', customers);
        expect(QueryBuilder.from(customerConfig).offset(7).limit(3).executeRaw().map((row) => row.id)).toEqual([8, 9, 10]);
        fakeNQuery.queueRows('customer', customers);
        expect(QueryBuilder.from(customerConfig).offset(1).limit(2).executeRaw().map((row) => row.id)).toEqual([2, 3]);
    });

    it('reads to the last page when only an offset is given, and nothing when the window is past the data', () => {
        fakeNQuery.queueRows('customer', customers);
        expect(QueryBuilder.from(customerConfig).offset(6).executeRaw().map((row) => row.id)).toEqual([7, 8, 9, 10]);
        expect(fakeNQuery.calls[0].pageSize).toBe(1000);
        fakeNQuery.queueRows('customer', customers.slice(0, 3));
        expect(QueryBuilder.from(customerConfig).offset(20).limit(5).executeRaw()).toEqual([]);
        fakeNQuery.queueRows('customer', customers);
        expect(QueryBuilder.from(customerConfig).limit(0).executeRaw()).toEqual([]);
    });

    it('clamps the page size to what N/query accepts', () => {
        fakeNQuery.queueRows('customer', customers);
        QueryBuilder.from(customerConfig).limit(5000).executeRaw();
        expect(fakeNQuery.calls[0].pageSize).toBe(1000);
    });
});

describe('QueryBuilder.executeTyped()', () => {
    it('returns mapped typed results', () => {
        fakeNQuery.queueRows('customer', [{ id: 1, name: 'Acme', email: 'a@b.com', isactive: false, score: 10 }]);
        const result = QueryBuilder.from(customerConfig).executeTyped();
        expect(result[0].name).toBe('Acme');
    });

    it('pages over records, not rows, when a joined sublist fans the rows out', () => {
        fakeNQuery.queueRows('salesorder', [
            { id: 1, entityid: 5, lines_itemid: 10, lines_qty: 1, lines_amount: 5 },
            { id: 1, entityid: 5, lines_itemid: 11, lines_qty: 2, lines_amount: 6 },
            { id: 2, entityid: 5, lines_itemid: 12, lines_qty: 3, lines_amount: 7 },
        ]);
        const result = QueryBuilder.from(orderConfig).offset(1).limit(1).executeTyped();
        expect(result).toEqual([{ id: 2, entityId: 5, lines: [{ itemId: 12, qty: 3, amount: 7 }] }]);
        expect(fakeNQuery.calls[0].execution).toBe('run');
    });

    it('falls back to the original row when postProcess returns undefined', () => {
        fakeNQuery.queueRows('customer', [{ id: 1, name: 'Test', email: '', isactive: false, score: 0 }]);
        const result = QueryBuilder.from({ ...customerConfig, postProcess: () => undefined } as any).executeTyped();
        expect(result[0]).toMatchObject({ id: 1 });
    });

    it('uses the field key as the array path when a cardinality: many field has no nestPath', () => {
        const cfg = { recordType: 'test', fields: { id: { queryFieldId: 'id', isPrimary: true }, items: { queryFieldId: 'item', cardinality: 'many' as const } } };
        fakeNQuery.queueRows('test', [{ id: 1, items: 10 }, { id: 1, items: 20 }]);
        const result = QueryBuilder.from(cfg as any).executeTyped();
        expect((result[0] as any).items).toEqual([{ items: 10 }, { items: 20 }]);
    });

    it('groups rows by the primary field alias', () => {
        const cfg = { recordType: 'test', fields: { id: { queryFieldId: 'id', isPrimary: true, alias: 'recordId' }, items: { queryFieldId: 'name', cardinality: 'many' as const } } };
        fakeNQuery.queueRows('test', [{ recordid: 1, items: 'A' }, { recordid: 1, items: 'B' }]);
        expect(QueryBuilder.from(cfg as any).executeTyped()).toHaveLength(1);
    });
});

describe('QueryBuilder.executePaged()', () => {
    it('hands back N/query pages with the default page size', () => {
        fakeNQuery.queueRows('customer', customers);
        const paged = QueryBuilder.from(customerConfig).executePaged();
        expect(paged.count).toBe(10);
        expect(fakeNQuery.calls[0].pageSize).toBe(1000);
    });

    it('passes a custom page size, clamped', () => {
        QueryBuilder.from(customerConfig).executePaged({ pageSize: 50 });
        QueryBuilder.from(customerConfig).executePaged({ pageSize: 1 });
        expect(fakeNQuery.calls.map((call) => call.pageSize)).toEqual([50, 5]);
    });
});

describe('QueryBuilder.first() and firstTyped()', () => {
    it('return the first row or record and restore the builder afterwards', () => {
        fakeNQuery.queueRows('customer', customers.slice(6, 8));
        const builder = QueryBuilder.from(customerConfig).limit(50);
        expect(builder.first()).toMatchObject({ id: 7 });
        expect(fakeNQuery.calls[0].pageSize).toBe(5);
        expect(builder.describe().page).toEqual({ offset: 0, limit: 50 });

        fakeNQuery.queueRows('customer', [{ id: 1, name: 'X', email: '', isactive: false, score: 0 }]);
        expect(QueryBuilder.from(customerConfig).firstTyped()?.name).toBe('X');
        expect(QueryBuilder.from(customerConfig).first()).toBeNull();
        expect(QueryBuilder.from(customerConfig).firstTyped()).toBeNull();
    });
});

describe('QueryBuilder.count()', () => {
    it('counts records with COUNT, or COUNT_DISTINCT when a component is joined', () => {
        fakeNQuery.queueRows('customer', [{ count: 42 }]);
        expect(QueryBuilder.from(customerConfig).where('id', '=', 1).count()).toBe(42);
        expect(fakeNQuery.calls[0].text).toContain('SELECT COUNT(id) AS count');
        expect(fakeNQuery.calls[0].text).toContain('WHERE id EQUAL [1]');

        fakeNQuery.queueRows('salesorder', [{ count: '3' }]);
        expect(QueryBuilder.from(orderConfig).count()).toBe(3);
        expect(fakeNQuery.calls[1].text).toContain('SELECT COUNT_DISTINCT(id) AS count');
    });

    it('returns 0 when no row comes back and refuses configs without a primary key', () => {
        expect(QueryBuilder.from(customerConfig).count()).toBe(0);
        expect(() => QueryBuilder.from({ recordType: 'x', fields: { name: { queryFieldId: 'name' } } }).count()).toThrow("A primary key field is required to count 'x'.");
    });
});

describe('QueryBuilder.exists()', () => {
    it('asks for one row and reports whether it came back', () => {
        fakeNQuery.queueRows('customer', [{ id: 1 }]);
        expect(QueryBuilder.from(customerConfig).where('id', '=', 99).exists()).toBe(true);
        expect(fakeNQuery.calls[0]).toEqual(expect.objectContaining({ execution: 'runPaged', pageSize: 5 }));
        expect(fakeNQuery.calls[0].text).toContain('WHERE id EQUAL [99]');
        expect(QueryBuilder.from(customerConfig).exists()).toBe(false);
    });
});

describe('QueryBuilder.toSQL()', () => {
    it('renders through N/query without executing', () => {
        const sql = QueryBuilder.from(customerConfig).where('name', '=', "O'Brien").toSQL();
        expect(sql).toContain("companyname EQUAL ['O'Brien']");
        expect(fakeNQuery.calls[0].execution).toBe('toSuiteQL');
    });
});

describe('runQuery() and query()', () => {
    it('execute the config and return typed results', () => {
        fakeNQuery.queueRows('customer', [{ id: 1, name: 'Z', email: '', isactive: false, score: 0 }]);
        expect(runQuery(customerConfig)[0].name).toBe('Z');
        expect(query(customerConfig)).toBeInstanceOf(QueryBuilder);
    });
});
