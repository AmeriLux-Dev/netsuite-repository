import {
    ExcludeFromDefaultSelect,
    Field,
    InternalId,
    Join,
    NotMapped,
    ReadOnly,
    RecordType,
    Reference,
    RestMetadata,
    SetFirst,
    Sublist,
    Subrecord,
    Transform,
    UpdaterOptions,
    getClassKind,
    getClassOverrides,
    getOwnClassOverrides,
    isModelClass,
    isRecordTypeClass,
    mergeClassOverrides,
    createClassOverrides,
} from '../model';

const upper = (value: unknown) => String(value).toUpperCase();

@Subrecord({ table: 'customaddress', key: 'nkey' })
class Address {
    addr1!: string | null;
    @SetFirst() state!: string | null;
}

@Sublist('item', { table: 'transactionline', where: "{alias}.mainline = 'F'", parentColumn: 'transaction', lineKey: { column: 'id', field: 'line' } })
class Line {
    id!: number;
    @Field('item') itemId!: number;
}

@UpdaterOptions({ requireFastPath: true })
@RestMetadata({ recordType: 'transaction' })
abstract class Transaction {
    @InternalId() internalId!: number;
    @Field('tranid') @Transform(upper) tranId!: string;
    @Field({ column: 'status', text: true }) statusText!: string;
    @NotMapped() cachedLabel?: string;
    @Subrecord('shippingaddress', { clearListField: 'shipaddresslist', join: 'inner' }) shippingAddress!: Address;
}

@RecordType('salesorder', { setName: 'orders', coerce: false, discriminator: { column: 'type', value: 'SalesOrd' }, tables: { salesorder: { key: 'id' } } })
class SalesOrder extends Transaction {
    @Field('shipmethod', { table: 'salesorder', type: 'integer', coerce: false }) shipMethodId!: number | null;
    @ReadOnly() @ExcludeFromDefaultSelect() total!: number;
    @Reference('entityId', { join: 'inner', targetKey: 'externalId' }) customer?: object;
    @Join('inner') lines!: Line[];
    @Field('tranid') tranId!: string;
}

class Plain {
    value!: string;
}

describe('decorator registry', () => {
    it('records class-level overrides for record types, sublists, and subrecords', () => {
        expect(getOwnClassOverrides(SalesOrder)).toEqual(expect.objectContaining({ kind: 'recordType', recordType: 'salesorder', setName: 'orders', coerce: false, discriminator: { column: 'type', value: 'SalesOrd' }, typeTables: { salesorder: { key: 'id' } } }));
        expect(getOwnClassOverrides(Line)).toEqual(expect.objectContaining({ kind: 'sublist', sublistId: 'item', sublistTable: 'transactionline', sublistWhere: "{alias}.mainline = 'F'", parentColumn: 'transaction', lineKey: { column: 'id', field: 'line' } }));
        expect(getOwnClassOverrides(Address)).toEqual(expect.objectContaining({ kind: 'subrecord', subrecordTable: 'customaddress', subrecordKey: 'nkey' }));
        expect(getOwnClassOverrides(Transaction)).toEqual(expect.objectContaining({ updaterOptions: { requireFastPath: true }, restRecordMetadata: { recordType: 'transaction' }, keyProperty: 'internalId' }));
        expect(getOwnClassOverrides(Plain)).toBeUndefined();
    });

    it('records property overrides', () => {
        const properties = getClassOverrides(SalesOrder).properties;
        expect(properties.get('shipMethodId')).toEqual({ name: 'shipMethodId', fieldId: 'shipmethod', table: 'salesorder', type: 'integer', coerce: false });
        expect(properties.get('total')).toEqual({ name: 'total', readOnly: true, selectByDefault: false });
        expect(properties.get('customer')).toEqual({ name: 'customer', selectFieldProperty: 'entityId', joinType: 'inner', targetKeyProperty: 'externalId' });
        expect(properties.get('lines')).toEqual({ name: 'lines', joinType: 'inner' });
        expect(properties.get('statusText')).toEqual({ name: 'statusText', column: 'status', text: true });
        expect(properties.get('shippingAddress')).toEqual({ name: 'shippingAddress', subrecordFieldId: 'shippingaddress', clearListField: 'shipaddresslist', joinType: 'inner' });
        expect(getClassOverrides(Address).properties.get('state')).toEqual({ name: 'state', setFirst: true });
        expect(getClassOverrides(Transaction).notMapped).toEqual(new Set(['cachedLabel']));
    });

    it('merges base-class overrides under the derived class, letting the derived class win per property', () => {
        const merged = getClassOverrides(SalesOrder);
        expect(merged.keyProperty).toBe('internalId');
        expect(merged.updaterOptions).toEqual({ requireFastPath: true });
        expect(merged.properties.get('tranId')).toEqual({ name: 'tranId', fieldId: 'tranid', transform: upper });
        expect(merged.notMapped).toEqual(new Set(['cachedLabel']));
        expect(getOwnClassOverrides(SalesOrder)?.properties.get('tranId')).toEqual({ name: 'tranId', fieldId: 'tranid' });
    });

    it('classifies classes', () => {
        expect(isModelClass(SalesOrder)).toBe(true);
        expect(isModelClass(Transaction)).toBe(true);
        expect(isModelClass(Plain)).toBe(false);
        expect(isModelClass('SalesOrder')).toBe(false);
        expect(isRecordTypeClass(SalesOrder)).toBe(true);
        expect(isRecordTypeClass(Line)).toBe(false);
        expect(isRecordTypeClass(null)).toBe(false);
        expect(getClassKind(Address)).toBe('subrecord');
        expect(getClassKind(Plain)).toBeUndefined();
    });

    it('rejects symbol property keys', () => {
        const key = Symbol('hidden');
        expect(() => {
            class Broken {
                @Field() [key]!: string;
            }
            return Broken;
        }).toThrow("Symbol properties cannot be mapped on 'Broken'.");
    });

    it('merges override objects without losing untouched members', () => {
        const target = createClassOverrides();
        target.recordType = 'customer';
        target.properties.set('name', { name: 'name', fieldId: 'companyname' });
        const source = createClassOverrides();
        source.coerce = false;
        source.properties.set('name', { name: 'name', readOnly: true });
        source.notMapped.add('cache');

        mergeClassOverrides(target, source);

        expect(target.recordType).toBe('customer');
        expect(target.coerce).toBe(false);
        expect(target.properties.get('name')).toEqual({ name: 'name', fieldId: 'companyname', readOnly: true });
        expect(target.notMapped).toEqual(new Set(['cache']));
    });
});
