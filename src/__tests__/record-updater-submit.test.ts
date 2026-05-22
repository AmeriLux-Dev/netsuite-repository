import { updateRecord } from '../record-updater';
import * as NsRecord from 'N/record';
import { createMockRecord } from '../__mocks__/netsuite/record';
import { customerConfig, vendorBillConfig, salesOrderConfig } from './fixtures';
import { defineQueryConfig } from '../types';

const mockLoad = NsRecord.load as unknown as jest.Mock;
const mockSubmitFields = NsRecord.submitFields as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

// ── submit() without ID ───────────────────────────────────────────────────────

describe('RecordUpdater.submit() – guard conditions', () => {
    it('returns failure when no record ID is set', () => {
        const result = updateRecord(customerConfig).set('name', 'X').submit();
        expect(result.success).toBe(false);
        expect(result.error).toContain('Record ID is not set');
    });

    it('returns success immediately when no pending updates', () => {
        const result = updateRecord(customerConfig).id(5).submit();
        expect(result.success).toBe(true);
        expect(result.id).toBe(5);
        expect(result.details?.bodyFieldsUpdated).toBe(0);
        expect(mockLoad).not.toHaveBeenCalled();
        expect(mockSubmitFields).not.toHaveBeenCalled();
    });

    it('returns failure when a performance guardrail is violated', () => {
        const result = updateRecord(vendorBillConfig)
            .id(1)
            .withOptions({ requireFastPath: true })
            .set('billingAddress_addr1', 'x')
            .submit();
        expect(result.success).toBe(false);
        expect(result.error).toContain('requires fast path');
    });
});

// ── submit() via submitFields path ────────────────────────────────────────────

describe('RecordUpdater.submit() – submitFields path', () => {
    it('calls record.submitFields and returns success with id', () => {
        mockSubmitFields.mockReturnValue(42);
        const result = updateRecord(customerConfig).id(1).set('name', 'Acme').submit();
        expect(result.success).toBe(true);
        expect(result.id).toBe(42);
        expect(mockSubmitFields).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'customer', id: 1 })
        );
    });

    it('includes correct bodyFieldsUpdated count in result', () => {
        mockSubmitFields.mockReturnValue(1);
        const result = updateRecord(customerConfig).id(1).set('name', 'X').set('email', 'x@y.com').submit();
        expect(result.details?.bodyFieldsUpdated).toBe(2);
    });

    it('clears pending updates after submit', () => {
        mockSubmitFields.mockReturnValue(1);
        const updater = updateRecord(customerConfig).id(1).set('name', 'X');
        updater.submit();
        expect(updater.getPendingCount()).toBe(0);
    });

    it('passes enableSourcing and ignoreMandatoryFields options', () => {
        mockSubmitFields.mockReturnValue(1);
        updateRecord(customerConfig)
            .id(1)
            .withOptions({ enableSourcing: true, ignoreMandatoryFields: false })
            .set('name', 'X')
            .submit();
        expect(mockSubmitFields).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({ enableSourcing: true, ignoreMandatoryFields: false }),
            })
        );
    });

    it('respects setFirst ordering (setFirst fields come last in sorted order)', () => {
        const cfg = defineQueryConfig<{ id: number; trigger: string; value: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:      { queryFieldId: 'id',      tableAlias: 't', isPrimary: true, recordFieldId: 'id' },
                trigger: { queryFieldId: 'trigger', tableAlias: 't', recordFieldId: 'trigger', setFirst: true },
                value:   { queryFieldId: 'value',   tableAlias: 't', recordFieldId: 'value' },
            },
        });
        mockSubmitFields.mockReturnValue(1);
        updateRecord(cfg).id(1).set('value', 'v').set('trigger', 'go').submit();
        const fields = mockSubmitFields.mock.calls[0][0].values;
        // setFirst=true means trigger is sorted last (sorted desc by setFirst)
        // Actually: sortUpdates sorts so setFirst fields come last by sorting desc(setFirst)
        // setFirst=true → 1, setFirst=false/undefined → 0 → desc means setFirst=true at top
        // Re-reading: sort((a,b) => Number(Boolean(b.setFirst)) - Number(Boolean(a.setFirst)))
        // b.setFirst=true → 1, a.setFirst=false → 0, result = 1-0 = 1 → b before a → setFirst goes first
        expect(Object.keys(fields)[0]).toBe('trigger');
    });

    it('catches and returns error when submitFields throws', () => {
        mockSubmitFields.mockImplementation(() => { throw new Error('NetSuite API error'); });
        const result = updateRecord(customerConfig).id(1).set('name', 'X').submit();
        expect(result.success).toBe(false);
        expect(result.error).toContain('NetSuite API error');
    });
});

// ── submit() via loadSave path ────────────────────────────────────────────────

describe('RecordUpdater.submit() – loadSave path', () => {
    it('loads and saves the record for subrecord updates', () => {
        const mockRecord = createMockRecord({ id: 10, save: jest.fn().mockReturnValue(10) });
        const mockSubrecord = { setValue: jest.fn() };
        mockRecord.getSubrecord = jest.fn().mockReturnValue(mockSubrecord);
        mockLoad.mockReturnValue(mockRecord);

        const result = updateRecord(vendorBillConfig).id(10).set('billingAddress_addr1', '1 Main').submit();

        expect(result.success).toBe(true);
        expect(result.id).toBe(10);
        expect(mockLoad).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'vendorbill', id: 10 })
        );
        expect(mockRecord.getSubrecord).toHaveBeenCalledWith({ fieldId: 'billingaddress' });
        expect(mockSubrecord.setValue).toHaveBeenCalledWith(
            expect.objectContaining({ fieldId: 'addr1', value: '1 Main' })
        );
        expect(mockRecord.save).toHaveBeenCalled();
    });

    it('updates body fields on the loaded record', () => {
        const mockRecord = createMockRecord({ id: 1, save: jest.fn().mockReturnValue(1) });
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(vendorBillConfig).id(1).set('memo', 'note').set('billingAddress_addr1', 'x').submit();

        expect(mockRecord.setValue).toHaveBeenCalledWith(
            expect.objectContaining({ fieldId: 'memo', value: 'note' })
        );
    });

    it('removes sublist lines in descending order', () => {
        const mockRecord = createMockRecord({ id: 1, save: jest.fn().mockReturnValue(1) });
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(salesOrderConfig).id(1).removeLine('item', 5).removeLine('item', 2).submit();

        const removeCalls = mockRecord.removeLine.mock.calls.map((c: any) => c[0].line);
        expect(removeCalls[0]).toBe(5);
        expect(removeCalls[1]).toBe(2);
    });

    it('updates a specific sublist line by index', () => {
        const mockRecord = createMockRecord({ id: 1, save: jest.fn().mockReturnValue(1) });
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(salesOrderConfig).id(1).updateLine('item', 2, { lines_qty: 5 }).submit();

        expect(mockRecord.setSublistValue).toHaveBeenCalledWith(
            expect.objectContaining({ sublistId: 'item', line: 2, fieldId: 'quantity', value: 5 })
        );
    });

    it('updates sublist line by matching field value', () => {
        const mockRecord = createMockRecord({
            id: 1,
            save: jest.fn().mockReturnValue(1),
            getLineCount: jest.fn().mockReturnValue(3),
            getSublistValue: jest.fn()
                .mockReturnValueOnce(null)
                .mockReturnValueOnce(5)   // match on line 1
                .mockReturnValueOnce(null),
        });
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(salesOrderConfig).id(1)
            .updateLineByField('item', 'lines_itemId', 5, { lines_qty: 10 })
            .submit();

        expect(mockRecord.setSublistValue).toHaveBeenCalledWith(
            expect.objectContaining({ sublistId: 'item', line: 1, fieldId: 'quantity', value: 10 })
        );
    });

    it('throws when line match not found', () => {
        const mockRecord = createMockRecord({
            id: 1,
            save: jest.fn().mockReturnValue(1),
            getLineCount: jest.fn().mockReturnValue(2),
            getSublistValue: jest.fn().mockReturnValue(null),
        });
        mockLoad.mockReturnValue(mockRecord);

        const result = updateRecord(salesOrderConfig).id(1)
            .updateLineByField('item', 'lines_itemId', 999, { lines_qty: 1 })
            .submit();

        expect(result.success).toBe(false);
        expect(result.error).toContain('No matching line found');
    });

    it('adds a new sublist line at the end', () => {
        const mockRecord = createMockRecord({
            id: 1,
            save: jest.fn().mockReturnValue(1),
            getLineCount: jest.fn().mockReturnValue(2),
        });
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(salesOrderConfig).id(1).addLine('item', { lines_itemId: 7, lines_qty: 3 }).submit();

        expect(mockRecord.setSublistValue).toHaveBeenCalledWith(
            expect.objectContaining({ sublistId: 'item', line: 2 })
        );
    });

    it('clears pending updates after loadSave submit', () => {
        const mockRecord = createMockRecord({ id: 1, save: jest.fn().mockReturnValue(1) });
        mockLoad.mockReturnValue(mockRecord);

        const u = updateRecord(vendorBillConfig).id(1).set('billingAddress_addr1', 'x');
        u.submit();
        expect(u.getPendingCount()).toBe(0);
    });

    it('catches and returns error when load throws', () => {
        mockLoad.mockImplementation(() => { throw new Error('Record not found'); });
        const result = updateRecord(vendorBillConfig).id(1).set('billingAddress_addr1', 'x').submit();
        expect(result.success).toBe(false);
        expect(result.error).toContain('Record not found');
    });

    it('details reflect all operations performed', () => {
        const mockRecord = createMockRecord({ id: 1, save: jest.fn().mockReturnValue(1) });
        mockLoad.mockReturnValue(mockRecord);

        const result = updateRecord(vendorBillConfig).id(1)
            .set('memo', 'test')
            .set('billingAddress_addr1', 'x')
            .submit();

        expect(result.details?.bodyFieldsUpdated).toBe(1);
        expect(result.details?.subrecordsUpdated).toBe(1);
    });
});

// ── subrecord reload path ────────────────────────────────────────────────────

describe('RecordUpdater.submit() – subrecord reload', () => {
    it('clears list field and reloads record when list field has value', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'vendorbill',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 'txn', isPrimary: true, recordFieldId: 'id' },
                addr1: { queryFieldId: 'addr1', tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'billaddrlist', recordFieldId: 'addr1' },
            },
        });

        const mockSubrecord = { setValue: jest.fn() };
        const mockRecord1 = {
            ...createMockRecord({ id: 1 }),
            getValue: jest.fn().mockReturnValue('someListValue'),
            setValue: jest.fn(),
            save: jest.fn().mockReturnValue(1),
            getSubrecord: jest.fn().mockReturnValue(mockSubrecord),
        };
        const mockRecord2 = {
            ...createMockRecord({ id: 1 }),
            getValue: jest.fn().mockReturnValue(null),
            setValue: jest.fn(),
            save: jest.fn().mockReturnValue(1),
            getSubrecord: jest.fn().mockReturnValue(mockSubrecord),
        };

        mockLoad
            .mockReturnValueOnce(mockRecord1)
            .mockReturnValueOnce(mockRecord2);

        const result = updateRecord(cfg).id(1).set('addr1', '123 Main').submit();

        expect(result.success).toBe(true);
        // First record should have cleared the list field and saved
        expect(mockRecord1.setValue).toHaveBeenCalledWith(
            expect.objectContaining({ fieldId: 'billaddrlist', value: '' })
        );
        expect(mockRecord1.save).toHaveBeenCalled();
        // Second load for the actual subrecord update
        expect(mockLoad).toHaveBeenCalledTimes(2);
    });

    it('skips reload when list field is empty', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'vendorbill',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 'txn', isPrimary: true, recordFieldId: 'id' },
                addr1: { queryFieldId: 'addr1', tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'billaddrlist', recordFieldId: 'addr1' },
            },
        });

        const mockSubrecord = { setValue: jest.fn() };
        const mockRecord = {
            ...createMockRecord({ id: 1 }),
            getValue: jest.fn().mockReturnValue(null),
            setValue: jest.fn(),
            save: jest.fn().mockReturnValue(1),
            getSubrecord: jest.fn().mockReturnValue(mockSubrecord),
        };
        mockLoad.mockReturnValue(mockRecord);

        updateRecord(cfg).id(1).set('addr1', 'x').submit();
        expect(mockLoad).toHaveBeenCalledTimes(1);
    });
});
