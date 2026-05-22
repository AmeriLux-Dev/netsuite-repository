import { QueryBuilder, query, runQuery } from '../query';
import { customerConfig, orderConfig } from './fixtures';
import * as NsQuery from 'N/query';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;
const mockRunSuiteQLPaged = NsQuery.runSuiteQLPaged as unknown as jest.Mock;

function mockRows(rows: Record<string, unknown>[]) {
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => rows });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('QueryBuilder.execute()', () => {
    it('passes SQL and params to runSuiteQL', () => {
        mockRows([]);
        const builder = QueryBuilder.from(customerConfig).where('id', '=', 1);
        builder.execute();
        expect(mockRunSuiteQL).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.stringContaining('WHERE'), params: [1] })
        );
    });

    it('slices rows by offset when set', () => {
        mockRows([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const result = QueryBuilder.from(customerConfig).limit(2).offset(1).execute();
        expect(result.data).toHaveLength(2);
        expect(result.data[0]).toMatchObject({ id: 2 });
    });

    it('does not slice when no offset', () => {
        mockRows([{ id: 1 }, { id: 2 }]);
        const result = QueryBuilder.from(customerConfig).execute();
        expect(result.data).toHaveLength(2);
    });
});

describe('QueryBuilder.executeRaw()', () => {
    it('returns raw row records', () => {
        mockRows([{ id: 5, companyname: 'Test' }]);
        const rows = QueryBuilder.from(customerConfig).executeRaw();
        expect(rows[0]).toMatchObject({ id: 5 });
    });
});

describe('QueryBuilder.executeTyped()', () => {
    it('returns mapped typed results', () => {
        mockRows([{ id: 1, name: 'Acme', email: 'a@b.com', isactive: false, score: 10 }]);
        const result = QueryBuilder.from(customerConfig).executeTyped();
        expect(result[0].name).toBe('Acme');
    });
});

describe('QueryBuilder.executePaged()', () => {
    it('calls runSuiteQLPaged with default pageSize 1000', () => {
        mockRunSuiteQLPaged.mockReturnValue({ fetch: jest.fn() });
        QueryBuilder.from(customerConfig).executePaged();
        expect(mockRunSuiteQLPaged).toHaveBeenCalledWith(
            expect.objectContaining({ pageSize: 1000 })
        );
    });

    it('passes custom pageSize', () => {
        mockRunSuiteQLPaged.mockReturnValue({ fetch: jest.fn() });
        QueryBuilder.from(customerConfig).executePaged({ pageSize: 50 });
        expect(mockRunSuiteQLPaged).toHaveBeenCalledWith(
            expect.objectContaining({ pageSize: 50 })
        );
    });
});

describe('QueryBuilder.first()', () => {
    it('returns the first raw row', () => {
        mockRows([{ id: 7 }, { id: 8 }]);
        const result = QueryBuilder.from(customerConfig).first();
        expect(result).toMatchObject({ id: 7 });
    });

    it('returns null when no rows', () => {
        mockRows([]);
        expect(QueryBuilder.from(customerConfig).first()).toBeNull();
    });

    it('restores original limitValue after first()', () => {
        mockRows([{ id: 1 }]);
        const builder = QueryBuilder.from(customerConfig).limit(50);
        builder.first();
        const { sql } = builder.build();
        expect(sql).toContain('TOP 50');
    });
});

describe('QueryBuilder.firstTyped()', () => {
    it('returns first typed result', () => {
        mockRows([{ id: 1, name: 'X', email: '', isactive: false, score: 0 }]);
        const result = QueryBuilder.from(customerConfig).firstTyped();
        expect(result?.name).toBe('X');
    });

    it('returns null when no rows', () => {
        mockRows([]);
        expect(QueryBuilder.from(customerConfig).firstTyped()).toBeNull();
    });

    it('restores original limitValue after firstTyped()', () => {
        mockRows([{ id: 1 }]);
        const builder = QueryBuilder.from(customerConfig).limit(25);
        builder.firstTyped();
        const { sql } = builder.build();
        expect(sql).toContain('TOP 25');
    });
});

describe('QueryBuilder.count()', () => {
    it('returns the count value', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [{ count: 42 }] });
        const count = QueryBuilder.from(customerConfig).count();
        expect(count).toBe(42);
        expect(mockRunSuiteQL).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.stringContaining('COUNT(*)') })
        );
    });

    it('returns 0 when no result row', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [] });
        expect(QueryBuilder.from(customerConfig).count()).toBe(0);
    });

    it('includes WHERE clause in count query', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [{ count: 1 }] });
        QueryBuilder.from(customerConfig).where('id', '=', 1).count();
        const call = mockRunSuiteQL.mock.calls[0][0];
        expect(call.query).toContain('WHERE');
    });
});

describe('QueryBuilder.exists()', () => {
    it('returns true when rows exist', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [{ exists: 1 }] });
        expect(QueryBuilder.from(customerConfig).exists()).toBe(true);
        expect(mockRunSuiteQL).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.stringContaining('TOP 1 1') })
        );
    });

    it('returns false when no rows', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [] });
        expect(QueryBuilder.from(customerConfig).exists()).toBe(false);
    });

    it('includes WHERE clause in exists query', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [] });
        QueryBuilder.from(customerConfig).where('id', '=', 99).exists();
        const call = mockRunSuiteQL.mock.calls[0][0];
        expect(call.query).toContain('WHERE');
    });
});

describe('runQuery()', () => {
    it('executes the config and returns typed results', () => {
        mockRows([{ id: 1, name: 'Z', email: '', isactive: false, score: 0 }]);
        const result = runQuery(customerConfig);
        expect(result[0].name).toBe('Z');
    });
});

// ── Coverage: uncovered branches ───────────────────────────────────────────────

describe('QueryBuilder – postProcess returns undefined', () => {
    it('falls back to original row when postProcess returns undefined', () => {
        mockRows([{ id: 1, name: 'Test', email: '', isactive: false, score: 0 }]);
        const cfg = { ...customerConfig, postProcess: () => undefined };
        const result = QueryBuilder.from(cfg as any).executeTyped();
        expect(result[0]).toMatchObject({ id: 1 });
    });
});

describe('QueryBuilder – cardinality many with no nestPath', () => {
    it('uses field key as array path when cardinality:many has no nestPath', () => {
        const cfg = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                items: { queryFieldId: 'item', tableAlias: 't', cardinality: 'many' as const },
            },
        };
        mockRows([{ id: 1, items: 10 }, { id: 1, items: 20 }]);
        const result = QueryBuilder.from(cfg as any).executeTyped();
        expect(Array.isArray((result[0] as any).items)).toBe(true);
        expect((result[0] as any).items).toHaveLength(2);
    });
});

describe('QueryBuilder – primary field alias used for grouping', () => {
    it('groups rows by the primary field alias', () => {
        const cfg = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',   tableAlias: 't', isPrimary: true, alias: 'recordId' },
                items: { queryFieldId: 'name', tableAlias: 't', cardinality: 'many' as const },
            },
        };
        mockRows([{ recordid: 1, items: 'A' }, { recordid: 1, items: 'B' }]);
        const result = QueryBuilder.from(cfg as any).executeTyped();
        expect(result).toHaveLength(1);
    });
});
