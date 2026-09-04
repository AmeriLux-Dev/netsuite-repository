import { createNetSuiteContext } from '../context';
import { EntityState } from '../tracking';
import * as NsQuery from 'N/query';
import * as NsRecord from 'N/record';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig } from './fixtures';
import type { Customer } from './fixtures';
import { salesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;
const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;
const mockLoad = NsRecord.load as unknown as jest.Mock;
const mockCreate = NsRecord.create as unknown as jest.Mock;
const mockDelete = NsRecord.delete as unknown as jest.Mock;

const orderRows = [
    { id: '1', tranid: 'SO1', memo: 'old', customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '0', lines_itemid: '10', lines_quantity: '2', customer_companyname: 'Acme' },
    { id: '1', tranid: 'SO1', memo: 'old', customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '1', lines_itemid: '11', lines_quantity: '1', customer_companyname: 'Acme' },
];

function createContext(tracking = true) {
    return createNetSuiteContext({ salesOrders: salesOrderModelConfig, customers: customerConfig }, { tracking });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => orderRows });
});

describe('NetSuiteContext.saveChanges() – end to end', () => {
    it('loads, tracks, and saves a body-only change through submitFields', () => {
        const db = createContext();
        mockSubmitFields.mockReturnValue(1);
        const order = db.salesOrders.find(1) as SalesOrderModel;

        order.memo = 'approved';
        const result = db.saveChanges();

        expect(result).toEqual(expect.objectContaining({ success: true, savedCount: 1, failedCount: 0, skippedCount: 0 }));
        expect(mockSubmitFields).toHaveBeenCalledWith(expect.objectContaining({ type: 'salesorder', id: 1, values: { memo: 'approved' } }));
        expect(mockLoad).not.toHaveBeenCalled();
        expect(db.entry(order)?.state).toBe(EntityState.Unchanged);
        expect(db.saveChanges().savedCount).toBe(0);
    });

    it('routes line and subrecord changes through load and save', () => {
        const db = createContext();
        const mockSubrecord = { setValue: jest.fn() };
        const mockRecord = createMockRecord({ id: 1, getLineCount: jest.fn().mockReturnValue(2), getSubrecord: jest.fn().mockReturnValue(mockSubrecord) });
        mockLoad.mockReturnValue(mockRecord);
        const order = db.salesOrders.find(1) as SalesOrderModel;

        order.shippingAddress.city = 'Austin';
        order.lines[1].quantity = 9;
        order.lines.push({ line: undefined as unknown as number, itemId: 12, quantity: 3 });

        const result = db.saveChanges();

        expect(result.success).toBe(true);
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 1, fieldId: 'quantity', value: 9 });
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 2, fieldId: 'item', value: 12 });
        expect(mockSubrecord.setValue).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'city', value: 'Austin' }));
        expect(mockRecord.save).toHaveBeenCalled();
    });

    it('creates added entities and assigns their ids, and deletes removed ones', () => {
        const db = createContext();
        mockCreate.mockReturnValue(createMockRecord({ id: 500, save: jest.fn().mockReturnValue(500) }));
        mockDelete.mockReturnValue(7);
        const customer: Partial<Customer> = { name: 'New Co', email: 'new@example.com' };

        db.customers.add(customer as Customer);
        db.customers.remove(7);
        const result = db.saveChanges();

        expect(result.results.map((saved) => saved.state)).toEqual([EntityState.Added, EntityState.Deleted]);
        expect(mockCreate).toHaveBeenCalledWith({ type: 'customer', isDynamic: false });
        expect(mockDelete).toHaveBeenCalledWith({ type: 'customer', id: 7 });
        expect(customer.id).toBe(500);
        expect(db.customers.find(500)).toBe(customer);
        expect(mockRunSuiteQL).not.toHaveBeenCalled();
    });

    it('stops after the first failure by default and keeps failed snapshots for retry', () => {
        const db = createContext();
        mockSubmitFields.mockImplementation(() => {
            throw new Error('LOCKED');
        });
        const order = db.salesOrders.find(1) as SalesOrderModel;
        order.memo = 'x';
        db.customers.remove(9);

        const result = db.saveChanges();

        expect(result).toEqual(expect.objectContaining({ success: false, savedCount: 0, failedCount: 1, skippedCount: 1 }));
        expect(result.results[0].result).toEqual({ success: false, error: 'LOCKED' });
        expect(result.results[1].result.error).toBe('Skipped because an earlier entity failed to save.');
        expect(mockDelete).not.toHaveBeenCalled();
        expect(db.entry(order)?.state).toBe(EntityState.Modified);
        expect(db.entry(order)?.originalValues).toEqual(expect.objectContaining({ memo: 'old' }));
    });

    it('can continue after failures and skip accepting changes', () => {
        const db = createContext();
        mockSubmitFields.mockImplementation(() => {
            throw new Error('LOCKED');
        });
        mockDelete.mockReturnValue(9);
        const order = db.salesOrders.find(1) as SalesOrderModel;
        order.memo = 'x';
        db.customers.remove(9);

        const result = db.saveChanges({ stopOnFirstFailure: false, acceptChangesOnSuccess: false });

        expect(result).toEqual(expect.objectContaining({ success: false, savedCount: 1, failedCount: 1, skippedCount: 0 }));
        expect(mockDelete).toHaveBeenCalled();
        expect(db.changeTracker.trackedEntries().some((entry) => entry.state === EntityState.Deleted)).toBe(true);
    });

    it('reports entities that lost their key', () => {
        const db = createContext();
        const order = db.salesOrders.find(1) as SalesOrderModel;
        (order as { id?: number }).id = undefined;
        order.memo = 'x';
        const keyless = db.customers.remove({ name: 'ghost' } as Customer);
        expect(keyless.state).toBe(EntityState.Deleted);

        const result = db.saveChanges();

        expect(result.results.map((saved) => saved.result.error)).toEqual(['Cannot update an entity without a key value.', 'Skipped because an earlier entity failed to save.']);
    });

    it('refuses to delete an entity without a key', () => {
        const db = createContext();
        db.customers.remove({ name: 'ghost' } as Customer);
        expect(db.saveChanges().results[0].result).toEqual({ success: false, error: 'Cannot delete an entity without a key value.' });
        expect(mockDelete).not.toHaveBeenCalled();
    });
});

describe('NetSuiteContext.planChanges() and tracking options', () => {
    it('plans without calling NetSuite', () => {
        const db = createContext();
        const order = db.salesOrders.find(1) as SalesOrderModel;
        order.memo = 'planned';
        db.customers.add({ name: 'New' } as Customer);
        db.customers.remove(3);

        const plan = db.planChanges();

        expect(plan.hasChanges).toBe(true);
        expect(plan.entries.map((entry) => [entry.state, entry.plan?.executionMode])).toEqual([[EntityState.Added, 'create'], [EntityState.Modified, 'submitFields'], [EntityState.Deleted, undefined]]);
        expect(mockSubmitFields).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
        expect(db.planChanges().hasChanges).toBe(true);
    });

    it('leaves asNoTracking() results and disabled contexts untracked', () => {
        const db = createContext();
        const [untracked] = db.salesOrders.asNoTracking().executeTyped();
        untracked.memo = 'ignored';
        expect(db.entry(untracked)).toBeUndefined();
        expect(db.planChanges().hasChanges).toBe(false);

        const disabled = createContext(false);
        const order = disabled.salesOrders.find(1) as SalesOrderModel;
        order.memo = 'ignored';
        expect(disabled.saveChanges()).toEqual({ success: true, savedCount: 0, failedCount: 0, skippedCount: 0, results: [] });
    });

    it('attaches and detaches entities through the context', () => {
        const db = createContext();
        const order = { id: 42, memo: 'external' } as SalesOrderModel;

        expect(db.attach('salesOrders', order).state).toBe(EntityState.Unchanged);
        expect(db.salesOrders.find(42)).toBe(order);
        expect(db.salesOrders.entry(order)?.key).toBe(42);
        db.detach(order);
        expect(db.entry(order)).toBeUndefined();
        expect(db.salesOrders.attach(order).entity).toBe(order);
    });

    it('gives a standalone RecordSet its own tracker', () => {
        const { RecordSet } = jest.requireActual<typeof import('../context')>('../context');
        const salesOrders = new RecordSet(salesOrderModelConfig);
        const order = salesOrders.find(1) as SalesOrderModel;
        expect(salesOrders.name).toBe('salesorder');
        expect(salesOrders.entry(order)?.state).toBe(EntityState.Unchanged);
    });
});
