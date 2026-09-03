import { EntitySet, NetSuiteContext, createNetSuiteContext } from '../context';
import { repository } from '../index';
import { configFromEntity, defineModel } from '../model';
import * as NsRecord from 'N/record';
import * as NsQuery from 'N/query';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig } from './fixtures';
import { DecoratedSalesOrder } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

const mockCreate = NsRecord.create as unknown as jest.Mock;
const mockDelete = NsRecord.delete as unknown as jest.Mock;
const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;

interface Vendor {
    id: number;
    companyName: string;
}

const VendorModel = defineModel<Vendor>((model) => model
    .toRecord('vendor').toTable('vendor', 'v').hasKey('id')
    .property('companyName').hasColumn('companyname').hasRecordField());

beforeEach(() => {
    jest.clearAllMocks();
});

describe('EntitySet – model sources', () => {
    it('accepts a decorated class, a fluent definition, and a raw config', () => {
        expect(new EntitySet(DecoratedSalesOrder).metadata).toBe(configFromEntity(DecoratedSalesOrder));
        expect(new EntitySet(VendorModel).metadata).toBe(VendorModel.compile());
        expect(new EntitySet(customerConfig).recordType).toBe('customer');
    });

    it('creates and deletes records through the set', () => {
        const mockRecord = createMockRecord({ id: 77, save: jest.fn().mockReturnValue(77) });
        mockCreate.mockReturnValue(mockRecord);
        mockDelete.mockReturnValue(77);
        const vendors = new EntitySet<Vendor>(VendorModel);

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
        expect(new EntitySet<Vendor>(VendorModel).createRecord({ companyName: 'Acme' }).id).toBe(78);
        expect(mockRecord.save).toHaveBeenCalledWith(expect.objectContaining({ enableSourcing: false }));
    });
});

describe('createNetSuiteContext() – mixed schema', () => {
    it('types each set from its source and exposes options', () => {
        const db = createNetSuiteContext({ salesOrders: DecoratedSalesOrder, vendors: VendorModel, customers: customerConfig }, { tracking: false });

        expect(db.salesOrders.metadata.query.joins).toHaveLength(3);
        expect(db.set('vendors').recordType).toBe('vendor');
        expect(db.customers.recordType).toBe('customer');
        expect(db.getConfig('salesOrders')).toBe(DecoratedSalesOrder);
        expect(db.options).toEqual({ tracking: false });
        expect(new NetSuiteContext({ vendors: VendorModel }).options).toEqual({ tracking: true });

        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: '5', tranid: 'SO5' }] });
        const order: SalesOrderModel | null = db.salesOrders.find(5);
        expect(order?.id).toBe(5);
        expect(order?.tranId).toBe('SO5');
    });
});

describe('repository() – model sources and create/delete', () => {
    it('works with a decorated class', () => {
        mockDelete.mockReturnValue(3);
        const mockRecord = createMockRecord({ id: 9, save: jest.fn().mockReturnValue(9) });
        mockCreate.mockReturnValue(mockRecord);
        const salesOrders = repository<SalesOrderModel, Record<string, unknown>>(DecoratedSalesOrder);

        expect(salesOrders.query().build().sql).toContain('FROM transaction txn');
        expect(salesOrders.create().mode).toBe('create');
        expect(salesOrders.create({ memo: 'x' }, { ignoreMandatoryFields: false })).toEqual(expect.objectContaining({ success: true, id: 9 }));
        expect(mockRecord.save).toHaveBeenCalledWith(expect.objectContaining({ ignoreMandatoryFields: false }));
        expect(salesOrders.create({ memo: 'y' }).success).toBe(true);
        expect(salesOrders.delete(3)).toEqual({ success: true, id: 3 });
    });
});
