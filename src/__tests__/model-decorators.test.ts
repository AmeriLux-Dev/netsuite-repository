import {
    ExcludeFromDefaultSelect,
    Field,
    InternalId,
    NotMapped,
    ReadOnly,
    RecordType,
    Reference,
    SetFirst,
    Sublist,
    Subrecord,
    Transform,
    getClassOverrides,
    getOwnClassOverrides,
    isModelClass,
    isRecordTypeClass,
    mergeClassOverrides,
    createClassOverrides,
} from '../model';

const upper = (value: unknown) => String(value).toUpperCase();

/** A subrecord shape: plain class, the table comes from the property or the conventions. */
class Address {
    addr1!: string | null;
    @SetFirst() state!: string | null;
}

/** A sublist line: a record type of its own, naming the line table. */
@RecordType('transactionline')
class Line {
    id!: number;
    @Field('item') itemId!: number;
}

abstract class Transaction {
    @InternalId() internalId!: number;
    @Field('tranid') @Transform(upper) tranId!: string;
    @Field({ column: 'status', text: true }) statusText!: string;
    @NotMapped() cachedLabel?: string;
    @Subrecord('shippingaddress', { clearListField: 'shipaddresslist', join: 'leftOuter' }) shippingAddress!: Address;
    @Subrecord({ table: 'customaddress', key: 'nkey' }) billingAddress!: Address;
}

@RecordType('salesorder', {
    setName: 'orders',
    coerce: false,
    discriminator: { column: 'type', value: 'SalesOrd' },
    tables: { salesorder: { key: 'id' } },
    updater: { requireFastPath: true },
    rest: { recordType: 'transaction' },
})
class SalesOrder extends Transaction {
    @Field('shipmethod', { table: 'salesorder', type: 'integer', coerce: false }) shipMethodId!: number | null;
    @ReadOnly() @ExcludeFromDefaultSelect() total!: number;
    @Reference('entityId', { join: 'inner', targetKey: 'externalId' }) customer?: object;
    @Reference({ join: 'inner' }) vendor?: object;
    @Sublist('item', { table: 'transactionline', where: "{alias}.mainline = 'F'", parentColumn: 'transaction', lineKey: { column: 'id', field: 'line' }, join: 'leftOuter' }) lines!: Line[];
    @Sublist({ parentColumn: 'transaction' }) extras!: Line[];
    @Field('tranid') tranId!: string;
}

class Plain {
    value!: string;
}

describe('decorator registry', () => {
    it('records everything @RecordType says about a class, including the updater and REST metadata', () => {
        expect(getOwnClassOverrides(SalesOrder)).toEqual(expect.objectContaining({
            recordType: 'salesorder',
            setName: 'orders',
            coerce: false,
            discriminator: { column: 'type', value: 'SalesOrd' },
            typeTables: { salesorder: { key: 'id' } },
            updaterOptions: { requireFastPath: true },
            restRecordMetadata: { recordType: 'transaction' },
        }));
        expect(getOwnClassOverrides(Line)).toEqual(expect.objectContaining({ recordType: 'transactionline' }));
        expect(getOwnClassOverrides(Transaction)).toEqual(expect.objectContaining({ keyProperty: 'internalId' }));
        expect(getOwnClassOverrides(Transaction)?.recordType).toBeUndefined();
        expect(getOwnClassOverrides(Address)).toEqual(expect.objectContaining({ properties: expect.any(Map) }));
        expect(getOwnClassOverrides(Plain)).toBeUndefined();
    });

    it('records field overrides', () => {
        const properties = getClassOverrides(SalesOrder).properties;
        expect(properties.get('shipMethodId')).toEqual({ name: 'shipMethodId', fieldId: 'shipmethod', table: 'salesorder', type: 'integer', coerce: false });
        expect(properties.get('total')).toEqual({ name: 'total', readOnly: true, selectByDefault: false });
        expect(properties.get('statusText')).toEqual({ name: 'statusText', column: 'status', text: true });
        expect(getClassOverrides(Address).properties.get('state')).toEqual({ name: 'state', setFirst: true });
        expect(getClassOverrides(Transaction).notMapped).toEqual(new Set(['cachedLabel']));
    });

    it('records the relation decorators on the properties that carry them', () => {
        const properties = getClassOverrides(SalesOrder).properties;
        expect(properties.get('customer')).toEqual({ name: 'customer', relationKind: 'reference', selectFieldProperty: 'entityId', joinType: 'inner', targetKeyProperty: 'externalId' });
        expect(properties.get('vendor')).toEqual({ name: 'vendor', relationKind: 'reference', joinType: 'inner' });
        expect(properties.get('lines')).toEqual({ name: 'lines', relationKind: 'sublist', sublistId: 'item', sublistTable: 'transactionline', sublistWhere: "{alias}.mainline = 'F'", parentColumn: 'transaction', lineKey: { column: 'id', field: 'line' }, joinType: 'leftOuter' });
        expect(properties.get('extras')).toEqual({ name: 'extras', relationKind: 'sublist', parentColumn: 'transaction' });
        expect(properties.get('shippingAddress')).toEqual({ name: 'shippingAddress', relationKind: 'subrecord', subrecordFieldId: 'shippingaddress', clearListField: 'shipaddresslist', joinType: 'leftOuter' });
        expect(properties.get('billingAddress')).toEqual({ name: 'billingAddress', relationKind: 'subrecord', subrecordTable: 'customaddress', subrecordKey: 'nkey' });
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
        expect(isModelClass(Address)).toBe(true);
        expect(isModelClass(Plain)).toBe(false);
        expect(isModelClass('SalesOrder')).toBe(false);
        expect(isRecordTypeClass(SalesOrder)).toBe(true);
        expect(isRecordTypeClass(Line)).toBe(true);
        expect(isRecordTypeClass(Address)).toBe(false);
        expect(isRecordTypeClass(Transaction)).toBe(false);
        expect(isRecordTypeClass(null)).toBe(false);
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
