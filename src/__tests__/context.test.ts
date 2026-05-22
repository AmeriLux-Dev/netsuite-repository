import { EntitySet, NetSuiteContext, createNetSuiteContext } from '../context';
import { RecordUpdater } from '../record-updater';
import { QueryBuilder } from '../query';
import { customerConfig, salesOrderConfig } from './fixtures';
import * as NsQuery from 'N/query';
import * as NsRecord from 'N/record';
import { createMockRecord } from '../__mocks__/netsuite/record';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;
const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;

function mockRows(rows: Record<string, unknown>[]) {
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => rows });
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ── EntitySet ─────────────────────────────────────────────────────────────────

describe('EntitySet.recordType', () => {
    it('returns the config record type', () => {
        const set = new EntitySet(customerConfig);
        expect(set.recordType).toBe('customer');
    });
});

describe('EntitySet.metadata', () => {
    it('returns the normalized query config', () => {
        const set = new EntitySet(customerConfig);
        expect(set.metadata.recordType).toBe('customer');
        expect(set.metadata.fields).toBeDefined();
    });
});

describe('EntitySet.query()', () => {
    it('returns a QueryBuilder', () => {
        expect(new EntitySet(customerConfig).query()).toBeInstanceOf(QueryBuilder);
    });
});

describe('EntitySet.all()', () => {
    it('returns all typed results', () => {
        mockRows([{ id: 1, name: 'Acme', email: '', isactive: false, score: 0 }]);
        const result = new EntitySet(customerConfig).all();
        expect(result[0].name).toBe('Acme');
    });
});

describe('EntitySet.first()', () => {
    it('returns first typed result', () => {
        mockRows([{ id: 2, name: 'Beta', email: '', isactive: false, score: 0 }]);
        const result = new EntitySet(customerConfig).first();
        expect(result?.name).toBe('Beta');
    });

    it('returns null when no results', () => {
        mockRows([]);
        expect(new EntitySet(customerConfig).first()).toBeNull();
    });
});

describe('EntitySet.where()', () => {
    it('returns a QueryBuilder with condition applied', () => {
        const builder = new EntitySet(customerConfig).where('id', '=', 1);
        expect(builder).toBeInstanceOf(QueryBuilder);
        const { sql } = builder.build();
        expect(sql).toContain('WHERE');
    });
});

describe('EntitySet.find()', () => {
    it('finds a record by primary key', () => {
        mockRows([{ id: 5, name: 'Found', email: '', isactive: false, score: 0 }]);
        const result = new EntitySet(customerConfig).find(5);
        expect(result?.name).toBe('Found');
    });

    it('returns null when not found', () => {
        mockRows([]);
        expect(new EntitySet(customerConfig).find(999)).toBeNull();
    });

    it('throws when no primary field is configured', () => {
        const cfg = { ...customerConfig, fields: { name: customerConfig.fields.name } };
        expect(() => new EntitySet(cfg).find(1)).toThrow("No primary field");
    });
});

describe('EntitySet.update()', () => {
    it('returns a RecordUpdater for the given ID', () => {
        const updater = new EntitySet(customerConfig).update(1);
        expect(updater).toBeInstanceOf(RecordUpdater);
    });
});

describe('EntitySet.submit()', () => {
    it('submits a patch and returns the result', () => {
        mockSubmitFields.mockReturnValue(1);
        const result = new EntitySet(customerConfig).submit(1, { name: 'Acme' });
        expect(result.success).toBe(true);
        expect(mockSubmitFields).toHaveBeenCalled();
    });
});

describe('EntitySet.submitPatch()', () => {
    it('submits a graph patch and returns the result', () => {
        mockSubmitFields.mockReturnValue(1);
        const result = new EntitySet(customerConfig).submitPatch(1, { name: 'Acme' });
        expect(result.success).toBe(true);
    });
});

// ── NetSuiteContext ───────────────────────────────────────────────────────────

const schema = { customers: customerConfig, orders: salesOrderConfig };

describe('NetSuiteContext.entities', () => {
    it('exposes EntitySet instances for each schema key', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.entities.customers).toBeInstanceOf(EntitySet);
        expect(ctx.entities.orders).toBeInstanceOf(EntitySet);
    });
});

describe('NetSuiteContext.set()', () => {
    it('returns the correct EntitySet by name', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.set('customers')).toBeInstanceOf(EntitySet);
        expect(ctx.set('customers').recordType).toBe('customer');
    });

    it('throws when entity name is not registered', () => {
        const ctx = new NetSuiteContext(schema);
        expect(() => ctx.set('nonexistent' as any)).toThrow("Entity 'nonexistent' is not registered");
    });
});

describe('NetSuiteContext.has()', () => {
    it('returns true for registered entities', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.has('customers')).toBe(true);
    });

    it('returns false for unregistered entities', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.has('nonexistent')).toBe(false);
    });
});

describe('NetSuiteContext.getConfig()', () => {
    it('returns the raw config for a registered entity', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.getConfig('customers')).toBe(customerConfig);
    });

    it('throws when entity is not registered', () => {
        const ctx = new NetSuiteContext(schema);
        expect(() => ctx.getConfig('nonexistent' as any)).toThrow("Entity 'nonexistent' is not registered");
    });
});

// ── createNetSuiteContext ─────────────────────────────────────────────────────

describe('createNetSuiteContext()', () => {
    it('returns a context with entity properties directly accessible', () => {
        const ctx = createNetSuiteContext(schema);
        expect((ctx as any).customers).toBeInstanceOf(EntitySet);
        expect((ctx as any).orders).toBeInstanceOf(EntitySet);
    });

    it('entity properties are non-writable', () => {
        const ctx = createNetSuiteContext(schema);
        expect(() => {
            (ctx as any).customers = null;
        }).toThrow();
    });

    it('can query through the context directly', () => {
        mockRows([{ id: 1, name: 'Test', email: '', isactive: false, score: 0 }]);
        const ctx = createNetSuiteContext(schema);
        const result = (ctx as any).customers.all();
        expect(result[0].name).toBe('Test');
    });

    it('set() works on the returned context', () => {
        const ctx = createNetSuiteContext(schema);
        expect(ctx.set('customers').recordType).toBe('customer');
    });
});
