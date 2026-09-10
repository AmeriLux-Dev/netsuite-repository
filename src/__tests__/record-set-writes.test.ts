import { RecordNotFoundError, RecordSet, SaveChangesError, createNetSuiteContext } from '../context';
import type { ChangePlan } from '../context';
import { EntityState } from '../tracking';
import * as NsRecord from 'N/record';
import { fakeNQuery } from '../testing';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig } from './fixtures';
import type { Customer } from './fixtures';
import { salesOrderModelConfig, vendorModelConfig } from './model-fixtures';
import type { SalesOrderModel, VendorModel } from './model-fixtures';

const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;
const mockLoad = NsRecord.load as unknown as jest.Mock;
const mockCreate = NsRecord.create as unknown as jest.Mock;
const mockDelete = NsRecord.delete as unknown as jest.Mock;

const orderRows = [
    { id: '1', tranid: 'SO1', memo: 'old', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '0', lines_itemid: '10', lines_quantity: '2', customer_companyname: 'Acme' },
    { id: '1', tranid: 'SO1', memo: 'old', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '1', lines_itemid: '11', lines_quantity: '1', customer_companyname: 'Acme' },
];

function createContext(tracking = true) {
    return createNetSuiteContext({ salesOrders: salesOrderModelConfig, customers: customerConfig, vendors: vendorModelConfig }, { tracking });
}

beforeEach(() => {
    jest.clearAllMocks();
    fakeNQuery.reset();
    fakeNQuery.queueRows('salesorder', orderRows, { repeat: true });
});

describe('RecordSet.getById()', () => {
    it('returns the record and throws RecordNotFoundError when there is none', () => {
        const db = createContext();
        expect(db.salesOrders.getById(1).tranId).toBe('SO1');

        fakeNQuery.reset();
        fakeNQuery.queueRows('vendor', []);
        expect(() => db.vendors.getById(404)).toThrow(RecordNotFoundError);
        try {
            db.vendors.getById(404);
        } catch (error) {
            expect(error).toMatchObject({ name: 'RecordNotFoundError', recordType: 'vendor', id: 404, message: "No 'vendor' record has id 404." });
        }
    });
});

describe('RecordSet.update()', () => {
    it('applies the patch, writes body fields with submitFields, and returns the tracked entity', () => {
        const db = createContext();
        mockSubmitFields.mockReturnValue(1);

        const order = db.salesOrders.update(1, { memo: 'approved', tranId: undefined });

        expect(order.memo).toBe('approved');
        expect(order).toBe(db.salesOrders.find(1));
        expect(mockSubmitFields).toHaveBeenCalledWith(expect.objectContaining({ type: 'salesorder', id: 1, values: { memo: 'approved' } }));
        expect(mockLoad).not.toHaveBeenCalled();
        expect(db.entry(order)?.state).toBe(EntityState.Unchanged);
    });

    it('merges subrecords and patches lines by identity through load and save', () => {
        const db = createContext();
        const mockSubrecord = { setValue: jest.fn() };
        const mockRecord = createMockRecord({ id: 1, getLineCount: jest.fn().mockReturnValue(2), getSubrecord: jest.fn().mockReturnValue(mockSubrecord) });
        mockLoad.mockReturnValue(mockRecord);

        const order = db.salesOrders.update(1, {
            shippingAddress: { city: 'Austin' },
            lines: { update: [{ line: 1, quantity: 9 }], add: [{ itemId: 12, quantity: 3 }] },
        });

        expect(order.shippingAddress).toEqual({ addr1: '1 Main', city: 'Austin' });
        expect(mockSubrecord.setValue).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'city', value: 'Austin' }));
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 1, fieldId: 'quantity', value: 9 });
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 2, fieldId: 'item', value: 12 });
        expect(mockRecord.save).toHaveBeenCalledTimes(1);
    });

    it('hands the plan to beforeSave and writes nothing when the hook throws', () => {
        const db = createContext();
        const plans: ChangePlan[] = [];

        expect(() => db.salesOrders.update(1, { memo: 'x' }, {
            beforeSave: (plan) => {
                plans.push(plan);
                throw new Error('too expensive');
            },
        })).toThrow('too expensive');

        expect(plans).toHaveLength(1);
        expect(plans[0].hasChanges).toBe(true);
        expect(plans[0].entries.map((entry) => [entry.state, entry.plan?.executionMode, entry.patch])).toEqual([[EntityState.Modified, 'submitFields', { memo: 'x' }]]);
        expect(mockSubmitFields).not.toHaveBeenCalled();
        expect(db.entry(db.salesOrders.find(1) as object)?.state).toBe(EntityState.Modified);
    });

    it('calls beforeSave with an empty plan and writes nothing when the patch changes nothing', () => {
        const db = createContext();
        const beforeSave = jest.fn();

        db.salesOrders.update(1, { memo: 'old', shippingAddress: { city: 'Dallas' } }, { beforeSave });

        expect(beforeSave).toHaveBeenCalledWith({ entries: [], hasChanges: false });
        expect(mockSubmitFields).not.toHaveBeenCalled();
        expect(mockLoad).not.toHaveBeenCalled();
    });

    it('saves only its own entity and leaves other pending changes for saveChanges()', () => {
        const db = createContext();
        mockSubmitFields.mockReturnValue(1);
        db.customers.remove(9);

        db.salesOrders.update(1, { memo: 'x' });

        expect(mockSubmitFields).toHaveBeenCalledTimes(1);
        expect(mockDelete).not.toHaveBeenCalled();
        expect(db.planChanges().entries.map((entry) => [entry.setName, entry.state])).toEqual([['customers', EntityState.Deleted]]);
    });

    it('throws SaveChangesError carrying the results when NetSuite rejects the save', () => {
        const db = createContext();
        mockSubmitFields.mockImplementation(() => {
            throw new Error('LOCKED');
        });

        let thrown: unknown;
        try {
            db.salesOrders.update(1, { memo: 'x' });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(SaveChangesError);
        expect((thrown as SaveChangesError).message).toBe('salesOrders 1: LOCKED');
        expect((thrown as SaveChangesError).result.results[0].result).toEqual({ success: false, error: 'LOCKED' });
        expect(db.entry(db.salesOrders.find(1) as object)?.state).toBe(EntityState.Modified);
    });

    it('passes updater options through, so requireFastPath rejects a load-and-save plan', () => {
        const db = createContext();

        expect(() => db.salesOrders.update(1, { shippingAddress: { city: 'Austin' } }, { updater: { requireFastPath: true } })).toThrow(SaveChangesError);
        expect(mockLoad).not.toHaveBeenCalled();
    });

    it('rejects a patch the model cannot take before anything is tracked as changed', () => {
        const db = createContext();
        expect(() => db.salesOrders.update(1, { customer: { companyName: 'Other' } } as never)).toThrow("Reference 'salesorder.customer' is read-only");
        expect(db.planChanges().hasChanges).toBe(false);
    });

    it('works on a context that does not track query results, by attaching the record first', () => {
        const db = createContext(false);
        mockSubmitFields.mockReturnValue(1);

        const order = db.salesOrders.update(1, { memo: 'approved' });

        expect(mockSubmitFields).toHaveBeenCalledWith(expect.objectContaining({ id: 1, values: { memo: 'approved' } }));
        expect(db.entry(order)?.state).toBe(EntityState.Unchanged);
    });

    it('works on a record set without a context', () => {
        mockSubmitFields.mockReturnValue(1);
        const orders = new RecordSet<SalesOrderModel>(salesOrderModelConfig);

        const order = orders.update(1, { memo: 'standalone' });

        expect(order.memo).toBe('standalone');
        expect(mockSubmitFields).toHaveBeenCalledTimes(1);
    });
});

describe('RecordSet.create()', () => {
    it('creates the record, writes the id back onto the values object, and tracks it', () => {
        const db = createContext();
        mockCreate.mockReturnValue(createMockRecord({ id: 500, save: jest.fn().mockReturnValue(500) }));
        const values: Partial<Customer> = { name: 'New Co', email: 'new@example.com' };

        const customer = db.customers.create(values);

        expect(customer).toBe(values);
        expect(customer.id).toBe(500);
        expect(mockCreate).toHaveBeenCalledWith({ type: 'customer', isDynamic: false });
        expect(db.customers.find(500)).toBe(customer);
        expect(db.entry(customer)?.state).toBe(EntityState.Unchanged);
        expect(fakeNQuery.calls).toHaveLength(0);
    });

    it('shows the create plan to beforeSave and throws SaveChangesError on failure', () => {
        const db = createContext();
        mockCreate.mockImplementation(() => {
            throw new Error('INSUFFICIENT_PERMISSION');
        });
        const beforeSave = jest.fn();

        expect(() => db.vendors.create({ companyName: 'Acme' }, { beforeSave })).toThrow('vendors: INSUFFICIENT_PERMISSION');
        expect(beforeSave.mock.calls[0][0].entries.map((entry: { state: EntityState; plan?: { executionMode: string } }) => [entry.state, entry.plan?.executionMode])).toEqual([[EntityState.Added, 'create']]);
    });
});

describe('RecordSet.delete()', () => {
    it('deletes by id and forgets the entity', () => {
        const db = createContext();
        mockDelete.mockReturnValue(7);

        db.customers.delete(7);

        expect(mockDelete).toHaveBeenCalledWith({ type: 'customer', id: 7 });
        expect(db.changeTracker.trackedEntries()).toHaveLength(0);
    });

    it('deletes a loaded entity and throws SaveChangesError when NetSuite refuses', () => {
        const db = createContext();
        const order = db.salesOrders.getById(1);
        mockDelete.mockImplementation(() => {
            throw new Error('DEP_RECORD_EXISTS');
        });

        expect(() => db.salesOrders.delete(1)).toThrow('salesOrders 1: DEP_RECORD_EXISTS');
        expect(db.entry(order)?.state).toBe(EntityState.Deleted);
    });

    it('forgets an entity that was only added and never saved, without calling NetSuite', () => {
        const db = createContext();
        const vendor: VendorModel = { id: 55, companyName: 'Draft' };
        db.vendors.add(vendor);

        db.vendors.delete(55);

        expect(mockDelete).not.toHaveBeenCalled();
        expect(db.entry(vendor)).toBeUndefined();
    });
});

describe('NetSuiteContext.planChanges() and saveChanges() scoped to entities', () => {
    it('plans and saves only the given entities', () => {
        const db = createContext();
        mockSubmitFields.mockReturnValue(1);
        const order = db.salesOrders.find(1) as SalesOrderModel;
        order.memo = 'x';
        db.customers.remove(9);

        expect(db.planChanges({ entities: [order] }).entries.map((entry) => entry.setName)).toEqual(['salesOrders']);
        const result = db.saveChanges({ entities: [order] });

        expect(result).toEqual(expect.objectContaining({ success: true, savedCount: 1 }));
        expect(mockDelete).not.toHaveBeenCalled();
        expect(db.planChanges().entries.map((entry) => entry.setName)).toEqual(['customers']);
    });

    it('layers updater options over the model defaults for every plan', () => {
        const db = createContext();
        const order = db.salesOrders.find(1) as SalesOrderModel;
        order.shippingAddress.city = 'Austin';

        const result = db.saveChanges({ updaterOptions: { requireFastPath: true } });

        expect(result.success).toBe(false);
        expect(result.results[0].result.error).toContain('fast path');
        expect(mockLoad).not.toHaveBeenCalled();
    });
});
