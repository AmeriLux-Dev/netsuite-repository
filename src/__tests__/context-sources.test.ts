import { RecordSet, NetSuiteContext, createNetSuiteContext } from '../context';
import { repository } from '../index';
import * as NsRecord from 'N/record';
import { fakeNQuery } from '../testing';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig } from './fixtures';
import { salesOrderModelConfig, vendorModelConfig } from './model-fixtures';
import type { SalesOrderModel, VendorModel } from './model-fixtures';

const mockCreate = NsRecord.create as unknown as jest.Mock;
const mockDelete = NsRecord.delete as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    fakeNQuery.reset();
});

describe('RecordSet – config sources', () => {
    it('accepts a generated config and a sectioned hand-written config', () => {
        expect(Object.keys(new RecordSet(salesOrderModelConfig).metadata.components ?? {})).toHaveLength(3);
        expect(new RecordSet(vendorModelConfig).metadata.recordType).toBe('vendor');
        expect(new RecordSet(customerConfig).recordType).toBe('customer');
    });

    it('creates and deletes records through the set', () => {
        const mockRecord = createMockRecord({ id: 77, save: jest.fn().mockReturnValue(77) });
        mockCreate.mockReturnValue(mockRecord);
        mockDelete.mockReturnValue(77);
        const vendors = new RecordSet<VendorModel>(vendorModelConfig);

        const created = vendors.createRecord({ companyName: 'Acme' }, { enableSourcing: true });
        const staged = vendors.create();
        const deleted = vendors.delete(77);

        expect(created).toEqual(expect.objectContaining({ success: true, id: 77 }));
        expect(mockRecord.save).toHaveBeenCalledWith(expect.objectContaining({ enableSourcing: true }));
        expect(staged.mode).toBe('create');
        expect(deleted).toEqual({ success: true, id: 77 });
        expect(mockDelete).toHaveBeenCalledWith({ type: 'vendor', id: 77 });
    });

    it('creates without options', () => {
        const mockRecord = createMockRecord({ id: 78, save: jest.fn().mockReturnValue(78) });
        mockCreate.mockReturnValue(mockRecord);
        expect(new RecordSet<VendorModel>(vendorModelConfig).createRecord({ companyName: 'Acme' }).id).toBe(78);
        expect(mockRecord.save).toHaveBeenCalledWith(expect.objectContaining({ enableSourcing: false }));
    });
});

describe('createNetSuiteContext() – mixed schema', () => {
    it('types each set from its config and exposes options', () => {
        const db = createNetSuiteContext({ salesOrders: salesOrderModelConfig, vendors: vendorModelConfig, customers: customerConfig }, { tracking: false });

        expect(Object.keys(db.salesOrders.metadata.components ?? {})).toHaveLength(3);
        expect(db.set('vendors').recordType).toBe('vendor');
        expect(db.customers.recordType).toBe('customer');
        expect(db.getConfig('salesOrders')).toBe(salesOrderModelConfig);
        expect(db.options).toEqual({ tracking: false });
        expect(new NetSuiteContext({ vendors: vendorModelConfig }).options).toEqual({ tracking: true });

        fakeNQuery.queueRows('salesorder', [{ id: '5', tranid: 'SO5' }]);
        const order: SalesOrderModel | null = db.salesOrders.find(5);
        expect(order?.id).toBe(5);
        expect(order?.tranId).toBe('SO5');
    });
});

describe('repository() – create/delete', () => {
    it('works with a generated config', () => {
        mockDelete.mockReturnValue(3);
        const mockRecord = createMockRecord({ id: 9, save: jest.fn().mockReturnValue(9) });
        mockCreate.mockReturnValue(mockRecord);
        const salesOrders = repository<SalesOrderModel, Record<string, unknown>>(salesOrderModelConfig);

        expect(salesOrders.query().describeText()).toContain('FROM salesorder');
        expect(salesOrders.create().mode).toBe('create');
        expect(salesOrders.create({ memo: 'x' }, { ignoreMandatoryFields: false })).toEqual(expect.objectContaining({ success: true, id: 9 }));
        expect(mockRecord.save).toHaveBeenCalledWith(expect.objectContaining({ ignoreMandatoryFields: false }));
        expect(salesOrders.create({ memo: 'y' }).success).toBe(true);
        expect(salesOrders.delete(3)).toEqual({ success: true, id: 3 });
    });
});
