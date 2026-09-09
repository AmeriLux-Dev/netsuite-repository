import { RecordSet, NetSuiteContext, createNetSuiteContext } from '../context';
import { RecordUpdater } from '../record-updater';
import { QueryBuilder } from '../query';
import { customerConfig, salesOrderConfig } from './fixtures';
import { fakeNQuery } from '../testing';
import * as NsRecord from 'N/record';

const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;

function queueCustomers(rows: Record<string, unknown>[]) {
    fakeNQuery.queueRows('customer', rows);
}

beforeEach(() => {
    jest.clearAllMocks();
    fakeNQuery.reset();
});

// ── RecordSet ─────────────────────────────────────────────────────────────────

describe('RecordSet.recordType', () => {
    it('returns the config record type', () => {
        const set = new RecordSet(customerConfig);
        expect(set.recordType).toBe('customer');
    });
});

describe('RecordSet.metadata', () => {
    it('returns the normalized query config', () => {
        const set = new RecordSet(customerConfig);
        expect(set.metadata.recordType).toBe('customer');
        expect(set.metadata.queryType).toBe('customer');
        expect(set.metadata.fields).toBeDefined();
    });
});

describe('RecordSet.query()', () => {
    it('returns a QueryBuilder', () => {
        expect(new RecordSet(customerConfig).query()).toBeInstanceOf(QueryBuilder);
    });
});

describe('RecordSet.all()', () => {
    it('returns all typed results', () => {
        queueCustomers([{ id: 1, name: 'Acme', email: '', isactive: false, score: 0 }]);
        const result = new RecordSet(customerConfig).all();
        expect(result[0].name).toBe('Acme');
    });
});

describe('RecordSet.first()', () => {
    it('returns first typed result', () => {
        queueCustomers([{ id: 2, name: 'Beta', email: '', isactive: false, score: 0 }]);
        const result = new RecordSet(customerConfig).first();
        expect(result?.name).toBe('Beta');
    });

    it('returns null when no results', () => {
        expect(new RecordSet(customerConfig).first()).toBeNull();
    });
});

describe('RecordSet.where()', () => {
    it('returns a QueryBuilder with condition applied', () => {
        const builder = new RecordSet(customerConfig).where('id', '=', 1);
        expect(builder).toBeInstanceOf(QueryBuilder);
        expect(builder.describeText()).toContain('WHERE id ANY_OF [1]');
    });
});

describe('RecordSet.find()', () => {
    it('finds a record by primary key', () => {
        queueCustomers([{ id: 5, name: 'Found', email: '', isactive: false, score: 0 }]);
        const result = new RecordSet(customerConfig).find(5);
        expect(result?.name).toBe('Found');
        expect(fakeNQuery.calls[0].text).toContain('WHERE id ANY_OF [5]');
    });

    it('returns null when not found', () => {
        expect(new RecordSet(customerConfig).find(999)).toBeNull();
    });

    it('throws when no primary field is configured', () => {
        const cfg = { ...customerConfig, fields: { name: customerConfig.fields.name } };
        expect(() => new RecordSet(cfg).find(1)).toThrow("No primary field");
    });
});

describe('RecordSet.update()', () => {
    it('returns a RecordUpdater for the given ID', () => {
        const updater = new RecordSet(customerConfig).update(1);
        expect(updater).toBeInstanceOf(RecordUpdater);
    });
});

describe('RecordSet.submit()', () => {
    it('submits a patch and returns the result', () => {
        mockSubmitFields.mockReturnValue(1);
        const result = new RecordSet(customerConfig).submit(1, { name: 'Acme' });
        expect(result.success).toBe(true);
        expect(mockSubmitFields).toHaveBeenCalled();
    });
});

describe('RecordSet.submitPatch()', () => {
    it('submits a graph patch and returns the result', () => {
        mockSubmitFields.mockReturnValue(1);
        const result = new RecordSet(customerConfig).submitPatch(1, { name: 'Acme' });
        expect(result.success).toBe(true);
    });
});

// ── NetSuiteContext ───────────────────────────────────────────────────────────

const schema = { customers: customerConfig, orders: salesOrderConfig };

describe('NetSuiteContext.entities', () => {
    it('exposes RecordSet instances for each schema key', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.entities.customers).toBeInstanceOf(RecordSet);
        expect(ctx.entities.orders).toBeInstanceOf(RecordSet);
    });
});

describe('NetSuiteContext.set()', () => {
    it('returns the correct RecordSet by name', () => {
        const ctx = new NetSuiteContext(schema);
        expect(ctx.set('customers')).toBeInstanceOf(RecordSet);
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
        expect((ctx as any).customers).toBeInstanceOf(RecordSet);
        expect((ctx as any).orders).toBeInstanceOf(RecordSet);
    });

    it('entity properties are non-writable', () => {
        const ctx = createNetSuiteContext(schema);
        expect(() => {
            (ctx as any).customers = null;
        }).toThrow();
    });

    it('can query through the context directly', () => {
        queueCustomers([{ id: 1, name: 'Test', email: '', isactive: false, score: 0 }]);
        const ctx = createNetSuiteContext(schema);
        const result = (ctx as any).customers.all();
        expect(result[0].name).toBe('Test');
    });

    it('set() works on the returned context', () => {
        const ctx = createNetSuiteContext(schema);
        expect(ctx.set('customers').recordType).toBe('customer');
    });
});
