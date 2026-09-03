import { RecordUpdater, createRecord, deleteRecord, updateRecord } from '../record-updater';
import * as NsRecord from 'N/record';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig, salesOrderConfig, vendorBillConfig } from './fixtures';
import type { SalesOrder } from './fixtures';
import type { QueryConfig } from '../types';

type LooseSalesOrderPatch = Record<string, unknown>;

const mockCreate = NsRecord.create as unknown as jest.Mock;
const mockDelete = NsRecord.delete as unknown as jest.Mock;
const mockLoad = NsRecord.load as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

// ── create mode: submit() ─────────────────────────────────────────────────────

describe('RecordUpdater.submit() – create mode', () => {
    it('calls record.create and record.save with staged body fields', () => {
        const mockRecord = createMockRecord({ id: 55, save: jest.fn().mockReturnValue(55) });
        mockCreate.mockReturnValue(mockRecord);

        const result = createRecord(customerConfig).set('name', 'Acme').set('email', 'ap@acme.com').submit();

        expect(result).toEqual({ success: true, id: 55, details: expect.objectContaining({ bodyFieldsUpdated: 2 }) });
        expect(mockCreate).toHaveBeenCalledWith({ type: 'customer', isDynamic: false });
        expect(mockRecord.setValue).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'companyname', value: 'Acme' }));
        expect(mockRecord.save).toHaveBeenCalledWith({ enableSourcing: false, ignoreMandatoryFields: true });
        expect(mockLoad).not.toHaveBeenCalled();
    });

    it('saves an empty record when nothing is staged', () => {
        const mockRecord = createMockRecord({ id: 56, save: jest.fn().mockReturnValue(56) });
        mockCreate.mockReturnValue(mockRecord);

        const result = createRecord(customerConfig).submit();

        expect(result.success).toBe(true);
        expect(result.id).toBe(56);
        expect(mockRecord.save).toHaveBeenCalled();
    });

    it('adds sublist lines through setSublistValue', () => {
        const mockRecord = createMockRecord({ id: 57, getLineCount: jest.fn().mockReturnValue(0) });
        mockCreate.mockReturnValue(mockRecord);

        const result = RecordUpdater.for<SalesOrder, LooseSalesOrderPatch>(salesOrderConfig).asCreate().patch({ lines: { add: [{ itemId: 12, qty: 3 }] } }).submit();

        expect(result.success).toBe(true);
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 0, fieldId: 'item', value: 12 });
        expect(mockRecord.setSublistValue).toHaveBeenCalledWith({ sublistId: 'item', line: 0, fieldId: 'quantity', value: 3 });
    });

    it('sets subrecord values without clearing or reloading even when a reload is registered', () => {
        const mockSubrecord = { setValue: jest.fn() };
        const mockRecord = createMockRecord({ id: 58, getValue: jest.fn().mockReturnValue('123'), getSubrecord: jest.fn().mockReturnValue(mockSubrecord) });
        mockCreate.mockReturnValue(mockRecord);

        const result = createRecord(vendorBillConfig)
            .withSubrecordReload({ subrecordFieldId: 'billingaddress', listFieldToClear: 'billaddresslist' })
            .set('billingAddress_addr1', '1 Main')
            .submit();

        expect(result.success).toBe(true);
        expect(mockRecord.getValue).not.toHaveBeenCalled();
        expect(mockLoad).not.toHaveBeenCalled();
        expect(mockRecord.save).toHaveBeenCalledTimes(1);
        expect(mockSubrecord.setValue).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'addr1', value: '1 Main' }));
    });

    it('returns a failed result when NetSuite throws', () => {
        mockCreate.mockImplementation(() => {
            throw new Error('INSUFFICIENT_PERMISSION');
        });

        const result = createRecord(customerConfig).set('name', 'Acme').submit();

        expect(result).toEqual({ success: false, error: 'INSUFFICIENT_PERMISSION' });
    });

    it('reports the mode and rejects id()', () => {
        const updater = createRecord(customerConfig);
        expect(updater.mode).toBe('create');
        expect(updateRecord(customerConfig).mode).toBe('update');
        expect(() => updater.id(1)).toThrow('id() is not applicable when creating a record.');
    });
});

// ── create mode: plan() ───────────────────────────────────────────────────────

describe('RecordUpdater.plan() – create mode', () => {
    it('starts with createRecord and ends with saveRecord', () => {
        const plan = createRecord<SalesOrder, LooseSalesOrderPatch>(salesOrderConfig).set('tranId', 'SO-1').patch({ lines: { add: [{ itemId: 1, qty: 1 }] } }).plan();

        expect(plan.executionMode).toBe('create');
        expect(plan.recordId).toBeUndefined();
        expect(plan.operations[0]).toEqual({ kind: 'createRecord', recordType: 'salesorder', isDynamic: false });
        expect(plan.operations.map((operation) => operation.kind)).toEqual(['createRecord', 'bodyFields', 'sublistAdd', 'saveRecord']);
    });

    it('never plans a subrecord reload', () => {
        const plan = createRecord(vendorBillConfig)
            .withSubrecordReload({ subrecordFieldId: 'billingaddress', listFieldToClear: 'billaddresslist' })
            .set('billingAddress_city', 'Dallas')
            .plan();

        const subrecordOperation = plan.operations.find((operation) => operation.kind === 'subrecord');
        expect(subrecordOperation).toEqual(expect.objectContaining({ kind: 'subrecord', subrecordFieldId: 'billingaddress', reload: undefined }));
        expect(plan.performance).toEqual(expect.objectContaining({
            executionMode: 'create',
            netSuiteRecordCalls: 2,
            recordLoads: 0,
            recordSaves: 1,
            recordCreates: 1,
            submitFieldsCalls: 0,
            conditionalSubrecordReloads: 0,
        }));
        expect(plan.performance.notes).toContain('Uses record.create and record.save.');
    });

    it('is planned as create even when nothing is staged', () => {
        const plan = createRecord(customerConfig).plan();
        expect(plan.executionMode).toBe('create');
        expect(plan.operations.map((operation) => operation.kind)).toEqual(['createRecord', 'saveRecord']);
    });

    it('reports zero creates for update modes', () => {
        expect(updateRecord(customerConfig).id(1).plan().performance.recordCreates).toBe(0);
        expect(updateRecord(customerConfig).id(1).set('name', 'x').plan().performance.recordCreates).toBe(0);
    });
});

// ── create mode: guardrails ───────────────────────────────────────────────────

describe('RecordUpdater.submit() – create mode guardrails', () => {
    it('ignores requireFastPath because a create can never use submitFields', () => {
        const mockRecord = createMockRecord({ id: 60, save: jest.fn().mockReturnValue(60) });
        mockCreate.mockReturnValue(mockRecord);

        const result = createRecord(customerConfig).withOptions({ requireFastPath: true }).set('name', 'Acme').submit();

        expect(result.success).toBe(true);
    });

    it('still enforces maxRecordCalls', () => {
        const result = createRecord(customerConfig).withOptions({ maxRecordCalls: 1 }).set('name', 'Acme').submit();

        expect(result.success).toBe(false);
        expect(result.error).toContain('exceeds maxRecordCalls 1');
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

// ── config-level updater options ──────────────────────────────────────────────

describe('RecordUpdater.for() – config updaterOptions', () => {
    const dynamicConfig: QueryConfig<{ id: number; name: string }> = {
        ...(customerConfig as QueryConfig<any>),
        updaterOptions: { isDynamic: true, enableSourcing: true },
    };

    it('applies config updaterOptions as defaults', () => {
        const plan = createRecord(dynamicConfig).plan();
        expect(plan.operations[0]).toEqual(expect.objectContaining({ kind: 'createRecord', isDynamic: true }));
        expect(plan.operations[plan.operations.length - 1]).toEqual(expect.objectContaining({ kind: 'saveRecord', enableSourcing: true }));
    });

    it('lets withOptions() override config defaults', () => {
        const plan = createRecord(dynamicConfig).withOptions({ isDynamic: false }).plan();
        expect(plan.operations[0]).toEqual(expect.objectContaining({ kind: 'createRecord', isDynamic: false }));
    });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('deleteRecord()', () => {
    it('calls record.delete and returns the deleted id', () => {
        mockDelete.mockReturnValue(9876);

        const result = deleteRecord(customerConfig, 9876);

        expect(result).toEqual({ success: true, id: 9876 });
        expect(mockDelete).toHaveBeenCalledWith({ type: 'customer', id: 9876 });
    });

    it('returns a failed result when NetSuite throws', () => {
        mockDelete.mockImplementation(() => {
            throw new Error('RCRD_DSNT_EXIST');
        });

        const result = deleteRecord(customerConfig, '12');

        expect(result).toEqual({ success: false, id: 12, error: 'RCRD_DSNT_EXIST' });
    });
});

describe('RecordUpdater.delete()', () => {
    it('requires an id', () => {
        expect(updateRecord(customerConfig).delete()).toEqual({ success: false, error: 'Record ID is not set. Call id() before delete().' });
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('deletes the identified record', () => {
        mockDelete.mockReturnValue(4);
        expect(updateRecord(customerConfig).id(4).delete()).toEqual({ success: true, id: 4 });
        expect(mockDelete).toHaveBeenCalledWith({ type: 'customer', id: 4 });
    });
});
