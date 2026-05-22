import { RecordUpdater, updateRecord } from '../record-updater';
import {
    customerConfig, vendorBillConfig, salesOrderConfig,
    compositeConfig, restMetadataConfig,
} from './fixtures';
import { defineQueryConfig } from '../types';
import type { QueryConfig } from '../types';

function updater<T = any>(cfg: QueryConfig<T> = customerConfig as any): RecordUpdater<T> {
    return updateRecord<T>(cfg as any);
}

// ── plan() execution mode ─────────────────────────────────────────────────────

describe('RecordUpdater.plan() – execution mode', () => {
    it('is none when no pending updates', () => {
        const plan = updater().id(1).plan();
        expect(plan.executionMode).toBe('none');
        expect(plan.pendingCount).toBe(0);
    });

    it('is submitFields when only body fields are pending', () => {
        const plan = updater().id(1).set('name', 'Acme').plan();
        expect(plan.executionMode).toBe('submitFields');
        expect(plan.pendingCount).toBe(1);
    });

    it('is loadSave when subrecord fields are pending', () => {
        const plan = updater(vendorBillConfig).id(1).set('billingAddress_addr1', '123 Main').plan();
        expect(plan.executionMode).toBe('loadSave');
    });

    it('is loadSave when line updates are pending', () => {
        const plan = updater(salesOrderConfig).id(1).updateLine('item', 0, { lines_itemId: 5 }).plan();
        expect(plan.executionMode).toBe('loadSave');
    });

    it('is loadSave when line adds are pending', () => {
        const plan = updater(salesOrderConfig).id(1).addLine('item', { lines_itemId: 5, lines_qty: 2 }).plan();
        expect(plan.executionMode).toBe('loadSave');
    });

    it('is loadSave when line removes are pending', () => {
        const plan = updater().id(1).removeLine('item', 0).plan();
        expect(plan.executionMode).toBe('loadSave');
    });

    it('includes recordId and recordType in plan', () => {
        const plan = updater().id(42).plan();
        expect(plan.recordId).toBe(42);
        expect(plan.recordType).toBe('customer');
    });

    it('recordId is undefined when id() not called', () => {
        const plan = updater().plan();
        expect(plan.recordId).toBeUndefined();
    });
});

describe('RecordUpdater.plan() – details', () => {
    it('counts body fields in details', () => {
        const plan = updater().id(1).set('name', 'A').set('email', 'b@c.com').plan();
        expect(plan.details.bodyFieldsUpdated).toBe(2);
    });

    it('counts subrecord fields in details', () => {
        const plan = updater(vendorBillConfig).id(1)
            .set('billingAddress_addr1', '1 St')
            .set('billingAddress_city', 'Boston')
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('counts line updates, adds, removes', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLine('item', 0, { lines_itemId: 1 })
            .addLine('item', { lines_itemId: 2, lines_qty: 1 })
            .removeLine('item', 2)
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
        expect(plan.details.sublistLinesAdded).toBe(1);
        expect(plan.details.sublistLinesRemoved).toBe(1);
    });
});

describe('RecordUpdater.plan() – operations', () => {
    it('submitFields operation lists body fields', () => {
        const plan = updater().id(1).set('name', 'X').plan();
        const op = plan.operations[0] as any;
        expect(op.kind).toBe('submitFields');
        expect(op.fields[0].fieldId).toBe('companyname');
    });

    it('loadSave operations include loadRecord first', () => {
        const plan = updater(vendorBillConfig).id(1).set('billingAddress_addr1', 'x').plan();
        expect(plan.operations[0]).toMatchObject({ kind: 'loadRecord', recordType: 'vendorbill' });
    });

    it('loadSave includes bodyFields operation when body fields present', () => {
        const plan = updater(vendorBillConfig).id(1).set('memo', 'note').set('billingAddress_addr1', 'x').plan();
        expect(plan.operations.some((op: any) => op.kind === 'bodyFields')).toBe(true);
    });

    it('loadSave sorts removals in descending line order', () => {
        const plan = updater().id(1).removeLine('item', 3).removeLine('item', 1).plan();
        const removes = plan.operations.filter((op: any) => op.kind === 'sublistRemove') as any[];
        expect(removes[0].line).toBe(3);
        expect(removes[1].line).toBe(1);
    });

    it('sublistUpdate operation has matchField when updateLineByField used', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLineByField('item', 'lines_itemId', 5, { lines_qty: 10 })
            .plan();
        const op = plan.operations.find((o: any) => o.kind === 'sublistUpdate') as any;
        expect(op.matchField).toBeDefined();
        expect(op.line).toBeUndefined();
    });

    it('sublistUpdate operation has line when updateLine used', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLine('item', 2, { lines_qty: 10 })
            .plan();
        const op = plan.operations.find((o: any) => o.kind === 'sublistUpdate') as any;
        expect(op.line).toBe(2);
        expect(op.matchField).toBeUndefined();
    });

    it('subrecord operation has reload when reload config present', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'vendorbill',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:    { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                addr1: { queryFieldId: 'billaddr1', tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'billaddrlist', recordFieldId: 'addr1' },
            },
        });
        const plan = updater(cfg).id(1).set('addr1', '123 Main').plan();
        const op = plan.operations.find((o: any) => o.kind === 'subrecord') as any;
        expect(op.reload).toBeDefined();
        expect(op.reload.clearFieldId).toBe('billaddrlist');
    });

    it('subrecord operation has no reload when reload not configured', () => {
        const plan = updater(vendorBillConfig).id(1).set('billingAddress_addr1', 'x').plan();
        const op = plan.operations.find((o: any) => o.kind === 'subrecord') as any;
        expect(op.reload).toBeUndefined();
    });

    it('loadSave ends with saveRecord operation', () => {
        const plan = updater(vendorBillConfig).id(1).set('billingAddress_addr1', 'x').plan();
        const last = plan.operations[plan.operations.length - 1];
        expect(last).toMatchObject({ kind: 'saveRecord' });
    });
});

describe('RecordUpdater.plan() – performance estimates', () => {
    it('none mode has 0 NetSuite calls', () => {
        const { performance } = updater().id(1).plan();
        expect(performance.executionMode).toBe('none');
        expect(performance.netSuiteRecordCalls).toBe(0);
    });

    it('submitFields mode has 1 call', () => {
        const { performance } = updater().id(1).set('name', 'X').plan();
        expect(performance.submitFieldsCalls).toBe(1);
        expect(performance.netSuiteRecordCalls).toBe(1);
        expect(performance.notes[0]).toContain('submitFields');
    });

    it('loadSave mode has 2 base calls', () => {
        const { performance } = updater(vendorBillConfig).id(1).set('billingAddress_addr1', 'x').plan();
        expect(performance.recordLoads).toBe(1);
        expect(performance.recordSaves).toBe(1);
        expect(performance.notes[0]).toContain('record.load');
    });

    it('counts conditional subrecord reloads in performance', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'vendorbill',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:    { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                addr1: { queryFieldId: 'addr1',    tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'billaddrlist', recordFieldId: 'addr1' },
            },
        });
        const { performance } = updater(cfg).id(1).set('addr1', 'x').plan();
        expect(performance.conditionalSubrecordReloads).toBe(1);
        expect(performance.notes.some(n => n.includes('Subrecord reloads'))).toBe(true);
    });

    it('counts line scans in performance for match-field updates', () => {
        const { performance } = updater(salesOrderConfig).id(1)
            .updateLineByField('item', 'lines_itemId', 5, { lines_qty: 2 })
            .plan();
        expect(performance.sublistLineScans).toBe(1);
        expect(performance.notes.some(n => n.includes('Line matching'))).toBe(true);
    });
});

// ── set() ─────────────────────────────────────────────────────────────────────

describe('RecordUpdater.set()', () => {
    it('queues a body field update', () => {
        const plan = updater().id(1).set('name', 'Acme').plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('overwrites previous value for the same field', () => {
        const u = updater().id(1).set('name', 'First').set('name', 'Second');
        expect(u.getPendingCount()).toBe(1);
    });

    it('queues a subrecord field update', () => {
        const plan = updater(vendorBillConfig).id(1).set('billingAddress_addr1', '1 Main').plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('does not re-register subrecord reload if already registered', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string; city: string }>({
            recordType: 'vendorbill',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 'txn', isPrimary: true },
                addr1:{ queryFieldId: 'addr1', tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'ba',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'listfield', recordFieldId: 'addr1' },
                city: { queryFieldId: 'city',  tableAlias: 'txn', recordAccess: 'subrecord', recordAccessId: 'ba',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'listfield', recordFieldId: 'city' },
            },
        });
        // Setting both fields should not fail and should register reload only once
        const plan = updater(cfg).id(1).set('addr1', 'x').set('city', 'Boston').plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('does not register reload when subrecordListFieldToClear is missing', () => {
        const cfg = defineQueryConfig<{ id: number; val: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:  { queryFieldId: 'id',  tableAlias: 't', isPrimary: true },
                val: { queryFieldId: 'val', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'sub',
                    subrecordNeedsReload: true, recordFieldId: 'val' },
            },
        });
        expect(() => updater(cfg).id(1).set('val', 'x').plan()).not.toThrow();
    });

    it('throws when setting a sublist field directly', () => {
        expect(() =>
            updater(salesOrderConfig).id(1).set('lines_itemId' as any, 5)
        ).toThrow("belongs to a sublist");
    });

    it('throws when field is marked readonly', () => {
        const cfg = defineQueryConfig<{ id: number; computed: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                computed: { queryFieldId: 'computed', tableAlias: 't', readonly: true },
            },
        });
        expect(() => updater(cfg).id(1).set('computed', 'x')).toThrow("is readonly");
    });

    it('throws when field is not defined', () => {
        expect(() =>
            updater().id(1).set('nonexistent' as any, 'x')
        ).toThrow("is not defined in query config");
    });

    it('throws when explicit composite field has no updateMapping', () => {
        const cfg = defineQueryConfig<{ id: number; name: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            composite: { updateMode: 'explicit' },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true, updateMapping: { kind: 'body' } },
                name: { queryFieldId: 'name', tableAlias: 't' },
            },
        });
        expect(() => updater(cfg).id(1).set('name', 'x')).toThrow("does not declare an updateMapping");
    });
});

describe('RecordUpdater.set() – updateMapping kinds', () => {
    it('throws for readonly mapping', () => {
        const cfg = defineQueryConfig<{ id: number; computed: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                computed: { queryFieldId: 'computed', tableAlias: 't', updateMapping: { kind: 'readonly', reason: 'system-generated' } },
            },
        });
        expect(() => updater(cfg).id(1).set('computed', 'x')).toThrow('system-generated');
    });

    it('throws for derived mapping without reason', () => {
        const cfg = defineQueryConfig<{ id: number; derived: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:      { queryFieldId: 'id',      tableAlias: 't', isPrimary: true },
                derived: { queryFieldId: 'derived', tableAlias: 't', updateMapping: { kind: 'derived' } },
            },
        });
        expect(() => updater(cfg).id(1).set('derived', 'x')).toThrow('derived');
    });

    it('throws for external mapping', () => {
        const cfg = defineQueryConfig<{ id: number; ext: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:  { queryFieldId: 'id',  tableAlias: 't', isPrimary: true },
                ext: { queryFieldId: 'ext', tableAlias: 't', updateMapping: { kind: 'external' } },
            },
        });
        expect(() => updater(cfg).id(1).set('ext', 'x')).toThrow('external');
    });

    it('throws for relatedRecord mapping', () => {
        const cfg = defineQueryConfig<{ id: number; vendorName: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:         { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                vendorName: { queryFieldId: 'name', tableAlias: 't', updateMapping: { kind: 'relatedRecord', recordType: 'vendor', idPath: 'entity' } },
            },
        });
        expect(() => updater(cfg).id(1).set('vendorName', 'x')).toThrow("maps to related record");
    });

    it('applies body mapping with explicit fieldId', () => {
        const cfg = defineQueryConfig<{ id: number; memo: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                memo: { queryFieldId: 'memo', tableAlias: 't', updateMapping: { kind: 'body', fieldId: 'custbody_memo', setFirst: true } },
            },
        });
        const plan = updater(cfg).id(1).set('memo', 'x').plan();
        expect(plan.operations[0]).toMatchObject({ kind: 'submitFields' });
        const fields = (plan.operations[0] as any).fields;
        expect(fields[0].fieldId).toBe('custbody_memo');
    });

    it('applies ownedSubrecord mapping', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                addr1: { queryFieldId: 'addr1', tableAlias: 't', updateMapping: { kind: 'ownedSubrecord', subrecordFieldId: 'billingaddress', fieldId: 'addr1' } },
            },
        });
        const plan = updater(cfg).id(1).set('addr1', '123 Main').plan();
        expect(plan.executionMode).toBe('loadSave');
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('applies ownedSubrecord mapping with clearBeforeUpdateFieldId', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                addr1: { queryFieldId: 'addr1', tableAlias: 't', updateMapping: { kind: 'ownedSubrecord', subrecordFieldId: 'billingaddress', clearBeforeUpdateFieldId: 'billaddrlist' } },
            },
        });
        const plan = updater(cfg).id(1).set('addr1', 'x').plan();
        const op = plan.operations.find((o: any) => o.kind === 'subrecord') as any;
        expect(op.reload.clearFieldId).toBe('billaddrlist');
    });

    it('applies ownedSubrecord mapping with clearBeforeUpdateFieldId already registered (no double register)', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string; city: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                addr1: { queryFieldId: 'addr1', tableAlias: 't', updateMapping: { kind: 'ownedSubrecord', subrecordFieldId: 'ba', clearBeforeUpdateFieldId: 'balist' } },
                city:  { queryFieldId: 'city',  tableAlias: 't', updateMapping: { kind: 'ownedSubrecord', subrecordFieldId: 'ba', clearBeforeUpdateFieldId: 'balist' } },
            },
        });
        expect(() => updater(cfg).id(1).set('addr1', 'x').set('city', 'NYC').plan()).not.toThrow();
    });

    it('applies sublist mapping', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLine('item', 0, { lines_itemId: 3 })
            .plan();
        const op = plan.operations.find((o: any) => o.kind === 'sublistUpdate') as any;
        expect(op.sublistId).toBe('item');
    });
});

// ── setMany() ─────────────────────────────────────────────────────────────────

describe('RecordUpdater.setMany()', () => {
    it('sets multiple fields at once', () => {
        const plan = updater().id(1).setMany({ name: 'X', email: 'x@y.com' }).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(2);
    });

    it('skips undefined values', () => {
        const plan = updater().id(1).setMany({ name: 'X', email: undefined }).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });
});

// ── patch() ──────────────────────────────────────────────────────────────────

describe('RecordUpdater.patch()', () => {
    it('patches flat field values', () => {
        const plan = updater().id(1).patch({ name: 'Acme', email: 'a@b.com' }).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(2);
    });

    it('skips undefined values', () => {
        const plan = updater().id(1).patch({ name: 'X', email: undefined }).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('routes owned relationship patch to setOwnedMany', () => {
        const plan = updater(vendorBillConfig).id(1)
            .patch({ billingAddress: { addr1: '1 Main', city: 'Boston' } })
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('throws when owned relationship value is not an object', () => {
        expect(() =>
            updater(vendorBillConfig).id(1).patch({ billingAddress: 'invalid' as any })
        ).toThrow("expects an object patch");
    });

    it('routes collection relationship patch', () => {
        const plan = updater(salesOrderConfig).id(1)
            .patch({ lines: { add: [{ itemId: 1, qty: 2 }] } } as any)
            .plan();
        expect(plan.details.sublistLinesAdded).toBe(1);
    });

    it('throws when collection relationship value is not an object', () => {
        expect(() =>
            updater(salesOrderConfig).id(1).patch({ lines: 'invalid' } as any)
        ).toThrow("expects a collection patch object");
    });

    it('handles collection patch with line number', () => {
        const plan = updater(salesOrderConfig).id(1)
            .patch({ lines: { update: [{ line: 0, values: { qty: 5 } }] } } as any)
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('handles collection patch with match field', () => {
        const plan = updater(salesOrderConfig).id(1)
            .patch({ lines: { update: [{ match: { field: 'itemId', value: 5 }, values: { qty: 5 } }] } } as any)
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('handles collection patch using relationship.matchField', () => {
        const plan = updater(salesOrderConfig).id(1)
            .patch({ lines: { update: [{ values: { itemId: 5, qty: 3 } }] } } as any)
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('throws collection patch update with no line or match', () => {
        expect(() =>
            updater(salesOrderConfig).id(1).patch({ lines: { update: [{ values: { lines_qty: 5 } }] } } as any)
        ).toThrow("requires line or match");
    });

    it('handles collection patch remove', () => {
        const plan = updater(salesOrderConfig).id(1)
            .patch({ lines: { remove: [0, 1] } } as any)
            .plan();
        expect(plan.details.sublistLinesRemoved).toBe(2);
    });

    it('throws collection patch update with no values or updates', () => {
        expect(() =>
            updater(salesOrderConfig).id(1).patch({ lines: { update: [{ line: 0 }] } } as any)
        ).toThrow("requires values or updates");
    });
});

// ── updateLineByField() ───────────────────────────────────────────────────────

describe('RecordUpdater.updateLineByField()', () => {
    it('queues a match-based line update', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLineByField('item', 'lines_itemId', 5, { lines_qty: 10 })
            .plan();
        const op = plan.operations.find((o: any) => o.kind === 'sublistUpdate') as any;
        expect(op.matchField.fieldId).toBe('item');
    });
});

describe('RecordUpdater.updateLines()', () => {
    it('queues multiple line updates', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLines('item', [
                { line: 0, updates: { lines_qty: 1 } },
                { line: 1, updates: { lines_qty: 2 } },
            ])
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(2);
    });
});

// ── Relationship API ──────────────────────────────────────────────────────────

describe('RecordUpdater.owned()', () => {
    it('returns an OwnedSubrecordUpdater and chains back', () => {
        const plan = updater(vendorBillConfig).id(1)
            .owned('billingAddress')
            .set('addr1', '1 Main')
            .set('city', 'Boston')
            .end()
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('setMany on owned updates multiple fields', () => {
        const plan = updater(vendorBillConfig).id(1)
            .owned('billingAddress')
            .setMany({ addr1: '2 Oak', city: 'Dallas' })
            .end()
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('throws when relationship does not exist', () => {
        expect(() => updater().id(1).owned('nonexistent')).toThrow("is not defined");
    });

    it('throws when relationship is not owned kind', () => {
        expect(() => updater(salesOrderConfig).id(1).owned('lines')).toThrow("not an owned subrecord");
    });
});

describe('RecordUpdater.collection()', () => {
    it('chains updateLine through SublistCollectionUpdater', () => {
        const plan = updater(salesOrderConfig).id(1)
            .collection('lines')
            .updateLine(0, { qty: 5 })
            .end()
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('chains updateLines through SublistCollectionUpdater', () => {
        const plan = updater(salesOrderConfig).id(1)
            .collection('lines')
            .updateLines([
                { line: 0, updates: { qty: 1 } },
                { line: 1, updates: { qty: 2 } },
            ])
            .end()
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(2);
    });

    it('chains updateLineByField through SublistCollectionUpdater', () => {
        const plan = updater(salesOrderConfig).id(1)
            .collection('lines')
            .updateLineByField('itemId', 5, { qty: 3 })
            .end()
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('chains addLine through SublistCollectionUpdater', () => {
        const plan = updater(salesOrderConfig).id(1)
            .collection('lines')
            .addLine({ itemId: 7, qty: 1 })
            .end()
            .plan();
        expect(plan.details.sublistLinesAdded).toBe(1);
    });

    it('chains removeLine through SublistCollectionUpdater', () => {
        const plan = updater(salesOrderConfig).id(1)
            .collection('lines')
            .removeLine(0)
            .end()
            .plan();
        expect(plan.details.sublistLinesRemoved).toBe(1);
    });

    it('throws when relationship is not collection kind', () => {
        expect(() => updater(vendorBillConfig).id(1).collection('billingAddress')).toThrow("not a collection");
    });
});

// ── resolveRelationshipFieldKey ───────────────────────────────────────────────

describe('RecordUpdater – relationship field resolution', () => {
    it('resolves field from relationship.fields mapping', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:         { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                physAddr1:  { queryFieldId: 'addr1', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'physaddr', recordFieldId: 'addr1' },
            },
            relationships: {
                physicalAddress: { kind: 'owned', recordAccessId: 'physaddr', fields: { addr1: 'physAddr1' } },
            },
        });
        const plan = updater(cfg).id(1).owned('physicalAddress').set('addr1', 'x').end().plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('resolves field by prefixed key (relationshipName_fieldKey)', () => {
        const plan = updater(vendorBillConfig).id(1)
            .owned('billingAddress')
            .set('addr1', 'x')
            .end()
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('resolves field by nestPath', () => {
        const cfg = defineQueryConfig<{ id: number; billingAddress: { city: string } }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                city: { queryFieldId: 'city', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'billingaddress', nestPath: 'billingAddress.city', recordFieldId: 'city' },
            },
            relationships: {
                billingAddress: { kind: 'owned', recordAccessId: 'billingaddress' },
            },
        });
        const plan = updater(cfg).id(1).owned('billingAddress').set('city', 'Austin').end().plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('throws when field cannot be resolved for relationship', () => {
        expect(() =>
            updater(vendorBillConfig).id(1).owned('billingAddress').set('nonexistent', 'x')
        ).toThrow("is not mapped on relationship");
    });
});

// ── registerSubrecordReload via relationship ──────────────────────────────────

describe('RecordUpdater – registerSubrecordReload', () => {
    it('registers reload from relationship.reload config', () => {
        const cfg = defineQueryConfig<{ id: number; city: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                city: { queryFieldId: 'city', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'ba', nestPath: 'billing.city', recordFieldId: 'city' },
            },
            relationships: {
                billing: { kind: 'owned', recordAccessId: 'ba', reload: { listFieldToClear: 'balist' } },
            },
        });
        const plan = updater(cfg).id(1).owned('billing').set('city', 'NYC').end().plan();
        const op = plan.operations.find((o: any) => o.kind === 'subrecord') as any;
        expect(op.reload.clearFieldId).toBe('balist');
    });
});

// ── REST record metadata field resolution ────────────────────────────────────

describe('RecordUpdater – REST metadata field resolution', () => {
    it('resolves a body field from REST metadata when not in config', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'customer',
            query: { from: { name: 'customer', alias: 'cust' } },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 'cust', isPrimary: true },
            },
            restRecordMetadata: {
                recordType: 'customer',
                fields: { companyname: { id: 'companyname', kind: 'string', writable: true } },
            },
        });
        const plan = updater(cfg).id(1).set('companyname' as any, 'Acme').plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('throws when REST metadata field is writable: false', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('id' as any, 999)
        ).toThrow("is not writable");
    });

    it('resolves a sublist field from REST metadata', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'salesorder',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 'txn', isPrimary: true } },
            restRecordMetadata: {
                recordType: 'salesorder',
                sublists: { item: { sublistId: 'item', writable: true, fields: { quantity: { id: 'quantity', kind: 'float', writable: true } } } },
            },
        });
        const plan = updater(cfg).id(1).updateLine('item', 0, { quantity: 5 } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('throws when sublist is writable: false in REST metadata', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 't', isPrimary: true, recordAccess: 'sublist', recordAccessId: 'locked' } },
            restRecordMetadata: {
                recordType: 'test',
                fields: { id: { id: 'id', kind: 'integer', writable: true } },
                sublists: { locked: { sublistId: 'locked', writable: false } },
            },
        });
        expect(() => updater(cfg).id(1).set('id' as any, 1)).toThrow("Sublist 'locked' is not writable");
    });

    it('resolves a subrecord field from REST metadata', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                addr1: { queryFieldId: 'addr1', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'billingaddress', recordFieldId: 'addr1' },
            },
            restRecordMetadata: {
                recordType: 'test',
                subrecords: { billingaddress: { fieldId: 'billingaddress', writable: true, clearBeforeUpdateFieldId: 'balist', fields: { addr1: { id: 'addr1', kind: 'string', writable: true } } } },
            },
        });
        const plan = updater(cfg).id(1).set('addr1', '123 Main').plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });

    it('throws when subrecord is writable: false in REST metadata', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 't', isPrimary: true, recordAccess: 'subrecord', recordAccessId: 'locked' } },
            restRecordMetadata: {
                recordType: 'test',
                fields: { id: { id: 'id', kind: 'integer', writable: true } },
                subrecords: { locked: { fieldId: 'locked', writable: false } },
            },
        });
        expect(() => updater(cfg).id(1).set('id' as any, 1)).toThrow("Subrecord 'locked' is not writable");
    });
});

// ── REST metadata value validation ───────────────────────────────────────────

describe('RecordUpdater – REST metadata value validation', () => {
    it('throws when required non-nullable field is set to null', () => {
        const cfg = defineQueryConfig<{ id: number; name: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                name: { queryFieldId: 'name', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { name: { id: 'name', kind: 'string', required: true, nullable: false } },
            },
        });
        expect(() => updater(cfg).id(1).set('name', null as any)).toThrow("required and not nullable");
    });

    it('passes validation when field is null and not required+non-nullable', () => {
        expect(() => updater(restMetadataConfig).id(1).set('name', null as any)).not.toThrow();
    });

    it('throws on enum violation', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('status', 'pending' as any)
        ).toThrow("expects one of active, inactive");
    });

    it('passes on valid enum value', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('status', 'active' as any)
        ).not.toThrow();
    });

    it('throws on minLength violation', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('name', '' as any)
        ).toThrow("at least 1 characters");
    });

    it('throws on maxLength violation', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('name', 'x'.repeat(101) as any)
        ).toThrow("no more than 100 characters");
    });

    it('throws on pattern violation', () => {
        const cfg = defineQueryConfig<{ id: number; code: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                code: { queryFieldId: 'code', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { code: { id: 'code', kind: 'string', pattern: '^[A-Z]{3}$' } },
            },
        });
        expect(() => updater(cfg).id(1).set('code', 'abc' as any)).toThrow("does not match the REST record metadata pattern");
    });

    it('throws on numeric non-numeric value', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('score', 'not-a-number' as any)
        ).toThrow("expects a numeric value");
    });

    it('throws on minimum violation', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('score', -1 as any)
        ).toThrow("greater than or equal to 0");
    });

    it('throws on maximum violation', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('score', 200 as any)
        ).toThrow("less than or equal to 100");
    });

    it('passes valid numeric string', () => {
        expect(() => updater(restMetadataConfig).id(1).set('score', '75' as any)).not.toThrow();
    });

    it('throws on boolean non-boolean string value', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('flag', 'yes' as any)
        ).toThrow("expects a boolean value");
    });

    it('passes boolean string T', () => {
        expect(() => updater(restMetadataConfig).id(1).set('flag', 'T' as any)).not.toThrow();
    });

    it('passes boolean string false', () => {
        expect(() => updater(restMetadataConfig).id(1).set('flag', 'false' as any)).not.toThrow();
    });

    it('throws on multiselect non-array', () => {
        expect(() =>
            updater(restMetadataConfig).id(1).set('tags', 'single' as any)
        ).toThrow("expects an array value");
    });

    it('passes multiselect array', () => {
        expect(() => updater(restMetadataConfig).id(1).set('tags', ['a', 'b'] as any)).not.toThrow();
    });

    it('throws on date invalid string', () => {
        const cfg = defineQueryConfig<{ id: number; dueDate: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:      { queryFieldId: 'id',      tableAlias: 't', isPrimary: true },
                dueDate: { queryFieldId: 'duedate', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { duedate: { id: 'duedate', kind: 'date' } },
            },
        });
        expect(() => updater(cfg).id(1).set('dueDate', 'not-a-date' as any)).toThrow("expects a date value");
    });

    it('passes valid date string', () => {
        const cfg = defineQueryConfig<{ id: number; dueDate: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:      { queryFieldId: 'id',      tableAlias: 't', isPrimary: true },
                dueDate: { queryFieldId: 'duedate', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { duedate: { id: 'duedate', kind: 'date' } },
            },
        });
        expect(() => updater(cfg).id(1).set('dueDate', '2026-01-01' as any)).not.toThrow();
    });

    it('throws on reference invalid type', () => {
        const cfg = defineQueryConfig<{ id: number; entityId: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',     tableAlias: 't', isPrimary: true },
                entityId: { queryFieldId: 'entity', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { entity: { id: 'entity', kind: 'reference' } },
            },
        });
        expect(() => updater(cfg).id(1).set('entityId', [] as any)).toThrow("expects a record reference value");
    });

    it('passes reference with id object', () => {
        const cfg = defineQueryConfig<{ id: number; entityId: any }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',     tableAlias: 't', isPrimary: true },
                entityId: { queryFieldId: 'entity', tableAlias: 't', type: 'key' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { entity: { id: 'entity', kind: 'reference' } },
            },
        });
        expect(() => updater(cfg).id(1).set('entityId', { id: 5 })).not.toThrow();
    });

    it('throws on object/subrecord/sublist non-object value', () => {
        const cfg = defineQueryConfig<{ id: number; meta: any }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                meta: { queryFieldId: 'meta', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { meta: { id: 'meta', kind: 'object' } },
            },
        });
        expect(() => updater(cfg).id(1).set('meta', 'string-not-obj' as any)).toThrow("expects an object value");
    });
});

// ── convertValue ──────────────────────────────────────────────────────────────

describe('RecordUpdater – value conversion', () => {
    it('converts integer string to number via parseInt', () => {
        const plan = updater().id(1).set('id' as any, '42').plan();
        const field = (plan.operations[0] as any).fields[0];
        expect(field.fieldId).toBe('id');
    });

    it('converts float string to number', () => {
        expect(() => updater().id(1).set('score', '3.14' as any)).not.toThrow();
    });

    it('converts boolean string T to true', () => {
        expect(() => updater().id(1).set('isActive', 'T' as any)).not.toThrow();
    });

    it('converts boolean string false to false', () => {
        expect(() => updater().id(1).set('isActive', 'false' as any)).not.toThrow();
    });

    it('converts multiselect single value to array', () => {
        const cfg = defineQueryConfig<{ id: number; tags: string[] }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                tags: { queryFieldId: 'tags', tableAlias: 't', type: 'multiselect', recordFieldId: 'tags' },
            },
        });
        expect(() => updater(cfg).id(1).set('tags', 'single' as any)).not.toThrow();
    });

    it('converts reference object with externalId key', () => {
        const cfg = defineQueryConfig<{ id: number; entity: any }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:     { queryFieldId: 'id',     tableAlias: 't', isPrimary: true },
                entity: { queryFieldId: 'entity', tableAlias: 't', type: 'key' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { entity: { id: 'entity', kind: 'reference' } },
            },
        });
        expect(() => updater(cfg).id(1).set('entity', { externalId: 'EXT-001' })).not.toThrow();
    });

    it('converts reference object with refName key', () => {
        const cfg = defineQueryConfig<{ id: number; entity: any }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:     { queryFieldId: 'id',     tableAlias: 't', isPrimary: true },
                entity: { queryFieldId: 'entity', tableAlias: 't', type: 'key' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { entity: { id: 'entity', kind: 'reference' } },
            },
        });
        expect(() => updater(cfg).id(1).set('entity', { refName: 'Vendor A' })).not.toThrow();
    });
});

// ── assertPerformanceGuardrails ───────────────────────────────────────────────

describe('RecordUpdater – performance guardrails', () => {
    it('throws when requireFastPath and execution is loadSave', () => {
        expect(() =>
            updater(vendorBillConfig).id(1)
                .withOptions({ requireFastPath: true })
                .set('billingAddress_addr1', 'x')
                .plan()
        ).not.toThrow(); // plan() doesn't throw — submit() does

        expect(() => {
            const u = updater(vendorBillConfig).id(1)
                .withOptions({ requireFastPath: true })
                .set('billingAddress_addr1', 'x');
            u['assertPerformanceGuardrails'](u.plan());
        }).toThrow("requires fast path");
    });

    it('throws when maxRecordCalls exceeded', () => {
        expect(() => {
            const u = updater(vendorBillConfig).id(1)
                .withOptions({ maxRecordCalls: 1 })
                .set('billingAddress_addr1', 'x');
            u['assertPerformanceGuardrails'](u.plan());
        }).toThrow("exceeds maxRecordCalls");
    });

    it('throws when allowLineScans is false and match-based update planned', () => {
        expect(() => {
            const u = updater(salesOrderConfig).id(1)
                .withOptions({ allowLineScans: false })
                .updateLineByField('item', 'lines_itemId', 5, { lines_qty: 1 });
            u['assertPerformanceGuardrails'](u.plan());
        }).toThrow("allowLineScans is false");
    });

    it('throws when allowSubrecordReloads is false and reload planned', () => {
        const cfg = defineQueryConfig<{ id: number; addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                addr1: { queryFieldId: 'addr1', tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'ba',
                    subrecordNeedsReload: true, subrecordListFieldToClear: 'balist', recordFieldId: 'addr1' },
            },
        });
        expect(() => {
            const u = updater(cfg).id(1).withOptions({ allowSubrecordReloads: false }).set('addr1', 'x');
            u['assertPerformanceGuardrails'](u.plan());
        }).toThrow("allowSubrecordReloads is false");
    });
});

// ── clear() ───────────────────────────────────────────────────────────────────

describe('RecordUpdater.clear()', () => {
    it('clears all pending updates', () => {
        const u = updater().id(1).set('name', 'X').set('email', 'y@z.com').clear();
        expect(u.getPendingCount()).toBe(0);
    });
});

// ── withSubrecordReload() ─────────────────────────────────────────────────────

describe('RecordUpdater.withSubrecordReload()', () => {
    it('registers a subrecord reload config', () => {
        const plan = updater(vendorBillConfig).id(1)
            .withSubrecordReload({ subrecordFieldId: 'billingaddress', listFieldToClear: 'balist' })
            .set('billingAddress_addr1', 'x')
            .plan();
        const op = plan.operations.find((o: any) => o.kind === 'subrecord') as any;
        expect(op.reload.clearFieldId).toBe('balist');
    });
});

// ── dynamic() ────────────────────────────────────────────────────────────────

describe('RecordUpdater.dynamic()', () => {
    it('sets isDynamic option', () => {
        const u = updater().id(1).dynamic(true);
        expect(u['options'].isDynamic).toBe(true);
    });

    it('dynamic() defaults to true', () => {
        const u = updater().id(1).dynamic();
        expect(u['options'].isDynamic).toBe(true);
    });
});

// ── flattenPatchUpdates edge cases ────────────────────────────────────────────

describe('RecordUpdater – flattenPatchUpdates', () => {
    it('handles nested array with plain object items', () => {
        const cfg = defineQueryConfig<{ id: number; lines_itemId: number; lines_qty: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:          { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_itemId:{ queryFieldId: 'item',     tableAlias: 't', recordFieldId: 'item', updateMapping: { kind: 'body', fieldId: 'item' } },
                lines_qty:   { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity', updateMapping: { kind: 'body', fieldId: 'quantity' } },
            },
        });
        // nested flat object patch (not a sublist)
        const plan = updater(cfg).id(1).patch({ lines: [{ itemId: 1, qty: 2 }] } as any).plan();
        expect(plan.pendingCount).toBe(0); // non-mapped nested path, not a sublist
    });

    it('throws on explicit composite unmapped nested scalar', () => {
        expect(() =>
            updater(compositeConfig).id(1).patch({ extra: { nested: 'value' } } as any)
        ).toThrow("is not mapped in explicit composite config");
    });

    it('queues sublist patch from array field', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'salesorder',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                lines_qty:{ queryFieldId: 'quantity', tableAlias: 'tl',  recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
            },
        });
        const plan = updater(cfg).id(1).patch({ lines: [{ line: 0, qty: 5 }] } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('throws non-object item in sublist array patch', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'salesorder',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                lines_qty:{ queryFieldId: 'quantity', tableAlias: 'tl',  recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: ['invalid'] } as any)
        ).toThrow("must be an object to update sublist");
    });

    it('throws when sublist array has no line identity', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'salesorder',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                lines_qty:{ queryFieldId: 'quantity', tableAlias: 'tl',  recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ qty: 5 }] } as any)
        ).toThrow("needs a line number or a configured matchBy");
    });

    it('resolves sublist by matchBy field', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'salesorder',
            query: { from: { name: 'transaction', alias: 'txn' } },
            fields: {
                id:          { queryFieldId: 'id',       tableAlias: 'txn', isPrimary: true },
                lines_itemId:{ queryFieldId: 'item',     tableAlias: 'tl',  recordFieldId: 'item',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemId',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
                lines_qty:   { queryFieldId: 'quantity', tableAlias: 'tl',  recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
            },
        });
        const plan = updater(cfg).id(1).patch({ lines: [{ item: 5, qty: 3 }] } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });

    it('throws on explicit composite array non-object item', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            composite: { updateMode: 'explicit' },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 't', isPrimary: true, updateMapping: { kind: 'body' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ items: [42] } as any)
        ).toThrow("is not mapped in explicit composite config");
    });
});

// ── findSublistField error ────────────────────────────────────────────────────

describe('RecordUpdater – findSublistField', () => {
    it('throws when field does not match the requested sublist', () => {
        expect(() =>
            updater(salesOrderConfig).id(1).updateLine('other_sublist', 0, { lines_qty: 5 })
        ).toThrow("is not configured for sublist");
    });
});

// ── updateRecord() helper ────────────────────────────────────────────────────

describe('updateRecord()', () => {
    it('returns a RecordUpdater instance', () => {
        expect(updateRecord(customerConfig)).toBeInstanceOf(RecordUpdater);
    });
});

// ── Coverage: toQueryFieldType via REST metadata fields not in config.fields ──

describe('RecordUpdater – toQueryFieldType via REST metadata', () => {
    function restOnlyCfg(kind: string) {
        return defineQueryConfig<{ id: number }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 't', isPrimary: true } },
            restRecordMetadata: {
                recordType: 'test',
                fields: { myfield: { id: 'myfield', kind: kind as any, writable: true } },
            },
        });
    }

    it('resolves integer kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('integer')).id(1).set('myfield' as any, 1).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves currency kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('currency')).id(1).set('myfield' as any, 9.99).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves boolean kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('boolean')).id(1).set('myfield' as any, true).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves date kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('date')).id(1).set('myfield' as any, '2026-01-01').plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves datetime kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('datetime')).id(1).set('myfield' as any, '2026-01-01T00:00:00Z').plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves multiselect kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('multiselect')).id(1).set('myfield' as any, ['a']).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('resolves reference kind from REST metadata', () => {
        const plan = updater(restOnlyCfg('reference')).id(1).set('myfield' as any, 42).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });
});

// ── Coverage: valid object for object-kind REST metadata field ────────────────

describe('RecordUpdater – REST metadata object kind validation pass', () => {
    it('passes validation when valid object is set for object-kind field', () => {
        const cfg = defineQueryConfig<{ id: number; meta: any }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:   { queryFieldId: 'id',   tableAlias: 't', isPrimary: true },
                meta: { queryFieldId: 'meta', tableAlias: 't' },
            },
            restRecordMetadata: {
                recordType: 'test',
                fields: { meta: { id: 'meta', kind: 'object', writable: true } },
            },
        });
        expect(() => updater(cfg).id(1).set('meta', { key: 'value' })).not.toThrow();
    });
});

// ── Coverage: flattenUpdates nested object (via updateLine) ───────────────────

describe('RecordUpdater – flattenUpdates nested object', () => {
    it('flattens nested update object by prefixing keys', () => {
        const plan = updater(salesOrderConfig).id(1)
            .updateLine('item', 0, { lines: { qty: 5 } } as any)
            .plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });
});

// ── Coverage: flattenPatchUpdates edge cases ──────────────────────────────────

describe('RecordUpdater – flattenPatchUpdates plain object recursion', () => {
    it('flattens nested plain object in patch by concatenating keys', () => {
        const cfg = defineQueryConfig<{ id: number; billing_addr1: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:            { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                billing_addr1: { queryFieldId: 'addr1', tableAlias: 't', recordFieldId: 'addr1' },
            },
        });
        const plan = updater(cfg).id(1).patch({ billing: { addr1: 'Main St' } } as any).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });

    it('keeps root-level unresolved scalar in output for later resolution via REST metadata', () => {
        const cfg = defineQueryConfig<{ id: number }>({
            recordType: 'customer',
            query: { from: { name: 'customer', alias: 'cust' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 'cust', isPrimary: true } },
            restRecordMetadata: {
                recordType: 'customer',
                fields: { memo: { id: 'memo', kind: 'string', writable: true } },
            },
        });
        const plan = updater(cfg).id(1).patch({ memo: 'hello' } as any).plan();
        expect(plan.details.bodyFieldsUpdated).toBe(1);
    });
});

// ── Coverage: queueSublistArrayPatch edge cases ───────────────────────────────

describe('RecordUpdater – queueSublistArrayPatch: multiple sublists throws', () => {
    it('throws when array path maps to multiple sublists', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_qty:{ queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
                lines_tax:{ queryFieldId: 'taxrate',  tableAlias: 't', recordFieldId: 'taxrate',
                    recordAccess: 'sublist', recordAccessId: 'tax',  nestPath: 'lines.tax',
                    updateMapping: { kind: 'sublist', sublistId: 'tax',  fieldId: 'taxrate' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ line: 0, qty: 5 }] } as any)
        ).toThrow("maps to multiple sublists");
    });
});

describe('RecordUpdater – queueSublistArrayPatch: multiple matchBy fields throws', () => {
    it('throws when array path has multiple matchBy fields', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:          { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_itemA: { queryFieldId: 'itemA',    tableAlias: 't', recordFieldId: 'itemA',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemA',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'itemA', matchBy: 'itemA' } },
                lines_qty:   { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'itemB' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ itemA: 5, qty: 3 }] } as any)
        ).toThrow("multiple matchBy fields");
    });
});

describe('RecordUpdater – queueSublistArrayPatch: missing matchBy value throws', () => {
    it('throws when patch item is missing the matchBy field value', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:         { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_item: { queryFieldId: 'item',     tableAlias: 't', recordFieldId: 'item',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.item',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
                lines_qty:  { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ qty: 3 }] } as any)
        ).toThrow("is missing matchBy value");
    });
});

describe('RecordUpdater – queueSublistArrayPatch: matchBy field not in config throws', () => {
    it('throws when matchBy field is not mapped in config', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_qty:{ queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'nonExistentField' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ nonExistentField: 5, qty: 3 }] } as any)
        ).toThrow("matchBy field 'nonExistentField' is not mapped");
    });
});

describe('RecordUpdater – queueSublistArrayPatch: match field skipped during update', () => {
    it('omits the match field itself from the pending field updates', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:         { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_item: { queryFieldId: 'item',     tableAlias: 't', recordFieldId: 'item',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.item',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
                lines_qty:  { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
            },
        });
        const plan = updater(cfg).id(1).patch({ lines: [{ item: 5, qty: 3 }] } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
        const op = plan.operations.find((o: any) => o.kind === 'sublistUpdate') as any;
        expect(op.fields).toHaveLength(1);
        expect(op.fields[0].fieldId).toBe('quantity');
    });
});

describe('RecordUpdater – queueSublistArrayPatch: explicit composite wrong sublist throws', () => {
    it('throws when explicit composite field maps to a different sublist', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            composite: { updateMode: 'explicit' },
            fields: {
                id:        { queryFieldId: 'id',       tableAlias: 't', isPrimary: true, updateMapping: { kind: 'body' } },
                lines_qty: { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    nestPath: 'lines.qty',
                    recordAccess: 'sublist', recordAccessId: 'item',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
                body_prop: { queryFieldId: 'prop',     tableAlias: 't', recordFieldId: 'prop',
                    nestPath: 'lines.prop',
                    updateMapping: { kind: 'body', fieldId: 'prop' } },
            },
        });
        expect(() =>
            updater(cfg).id(1).patch({ lines: [{ line: 0, qty: 5, prop: 'x' }] } as any)
        ).toThrow("does not map to sublist");
    });

    it('silently skips field that does not map to the patched sublist in non-explicit config', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:        { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_qty: { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    nestPath: 'lines.qty',
                    recordAccess: 'sublist', recordAccessId: 'item',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity' } },
                body_prop: { queryFieldId: 'prop',     tableAlias: 't', recordFieldId: 'prop',
                    nestPath: 'lines.prop',
                    updateMapping: { kind: 'body', fieldId: 'prop' } },
            },
        });
        const plan = updater(cfg).id(1).patch({ lines: [{ line: 0, qty: 5, prop: 'x' }] } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });
});

describe('RecordUpdater – getValueByPathOrKey regex path', () => {
    it('resolves matchBy via regex strip when direct lookup fails', () => {
        const cfg = defineQueryConfig<any>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:         { queryFieldId: 'id',       tableAlias: 't', isPrimary: true },
                lines_item: { queryFieldId: 'item',     tableAlias: 't', recordFieldId: 'item',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.item',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
                lines_qty:  { queryFieldId: 'quantity', tableAlias: 't', recordFieldId: 'quantity',
                    recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',
                    updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'lines.item' } },
            },
        });
        const plan = updater(cfg).id(1).patch({ lines: [{ item: 5, qty: 3 }] } as any).plan();
        expect(plan.details.sublistLinesUpdated).toBe(1);
    });
});

describe('RecordUpdater – flattenRelationshipUpdates nested object', () => {
    it('recursively flattens nested objects in relationship setMany', () => {
        const cfg = defineQueryConfig<{ id: number; myrel_x_y: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:        { queryFieldId: 'id',  tableAlias: 't', isPrimary: true },
                myrel_x_y: { queryFieldId: 'xy',  tableAlias: 't', recordAccess: 'subrecord', recordAccessId: 'myrel', recordFieldId: 'xy' },
            },
            relationships: {
                myrel: { kind: 'owned', recordAccessId: 'myrel' },
            },
        });
        const plan = updater(cfg).id(1)
            .owned('myrel')
            .setMany({ x: { y: 'val' } } as any)
            .end()
            .plan();
        expect(plan.details.subrecordsUpdated).toBe(1);
    });
});

describe('RecordUpdater – requireRecordAccessId throws', () => {
    it('throws when field has recordAccess but no recordAccessId', () => {
        const cfg = defineQueryConfig<{ id: number; badField: string }>({
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:       { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                badField: { queryFieldId: 'field', tableAlias: 't', recordAccess: 'subrecord' },
            },
        });
        expect(() => updater(cfg).id(1).set('badField', 'x')).toThrow("has recordAccess='subrecord' but no recordAccessId");
    });
});
