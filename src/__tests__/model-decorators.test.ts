import {
    ExcludeFromDefaultSelect,
    Field,
    InternalId,
    NotMapped,
    ParentId,
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

/** A subrecord shape: a plain class; N/query resolves its table and key from the field it hangs off. */
class Address {
    addr1!: string | null;
    @SetFirst() state!: string | null;
}

/** A sublist line: a record type of its own, naming the field that points at its parent. */
@RecordType('transactionline')
class Line {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;
    @ParentId() @Field('transaction') transactionId!: number;
    @Field('item') itemId!: number;
}

abstract class Transaction {
    @InternalId() internalId!: number;
    @Field('tranid') @Transform(upper) tranId!: string;
    @Field('orderstatus', { queryFieldId: 'status' }) status!: string;
    @Field({ queryFieldId: 'status', text: true }) statusText!: string;
    @NotMapped() cachedLabel?: string;
    @Subrecord('shippingaddress', { clearListField: 'shipaddresslist', load: 'separate' }) shippingAddress!: Address;
    @Subrecord({ clearListField: 'billaddresslist' }) billingAddress!: Address;
}

@RecordType('salesorder', {
    queryType: 'transaction',
    filter: [{ fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] }],
    setName: 'orders',
    coerce: false,
    updater: { requireFastPath: true },
})
class SalesOrder extends Transaction {
    @Field('shipmethod', { type: 'integer', coerce: false }) shipMethodId!: number | null;
    @ReadOnly() @ExcludeFromDefaultSelect() total!: number;
    @Reference('entityId', { join: 'to', targetKey: 'externalId' }) customer?: object;
    @Reference({ load: 'separate' }) vendor?: object;
    @Sublist('item', { filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }], load: 'join' }) lines!: Line[];
    @Sublist({ relationship: 'transactionlines' }) extras!: Line[];
    @Field('tranid') tranId!: string;
}

class Plain {
    value!: string;
}

describe('decorator registry', () => {
    it('records everything @RecordType says about a class', () => {
        expect(getOwnClassOverrides(SalesOrder)).toEqual(expect.objectContaining({
            recordType: 'salesorder',
            queryType: 'transaction',
            rootFilter: [{ fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] }],
            setName: 'orders',
            coerce: false,
            updaterOptions: { requireFastPath: true },
        }));
        expect(getOwnClassOverrides(Line)).toEqual(expect.objectContaining({ recordType: 'transactionline', keyProperty: 'id', parentKeyProperty: 'transactionId' }));
        expect(getOwnClassOverrides(Transaction)).toEqual(expect.objectContaining({ keyProperty: 'internalId' }));
        expect(getOwnClassOverrides(Transaction)?.recordType).toBeUndefined();
        expect(getOwnClassOverrides(Address)).toEqual(expect.objectContaining({ properties: expect.any(Map) }));
        expect(getOwnClassOverrides(Plain)).toBeUndefined();
    });

    it('records field overrides', () => {
        const properties = getClassOverrides(SalesOrder).properties;
        expect(properties.get('shipMethodId')).toEqual({ name: 'shipMethodId', fieldId: 'shipmethod', type: 'integer', coerce: false });
        expect(properties.get('total')).toEqual({ name: 'total', readOnly: true, selectByDefault: false });
        expect(properties.get('status')).toEqual({ name: 'status', fieldId: 'orderstatus', queryFieldId: 'status' });
        expect(properties.get('statusText')).toEqual({ name: 'statusText', queryFieldId: 'status', text: true });
        expect(getClassOverrides(Line).properties.get('id')).toEqual({ name: 'id', fieldId: 'line', queryFieldId: 'id' });
        expect(getClassOverrides(Address).properties.get('state')).toEqual({ name: 'state', setFirst: true });
        expect(getClassOverrides(Transaction).notMapped).toEqual(new Set(['cachedLabel']));
    });

    it('records the relation decorators on the properties that carry them', () => {
        const properties = getClassOverrides(SalesOrder).properties;
        expect(properties.get('customer')).toEqual({ name: 'customer', relationKind: 'reference', selectFieldProperty: 'entityId', joinKind: 'to', targetKeyProperty: 'externalId' });
        expect(properties.get('vendor')).toEqual({ name: 'vendor', relationKind: 'reference', load: 'separate' });
        expect(properties.get('lines')).toEqual({ name: 'lines', relationKind: 'sublist', sublistId: 'item', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }], load: 'join' });
        expect(properties.get('extras')).toEqual({ name: 'extras', relationKind: 'sublist', relationshipFieldId: 'transactionlines' });
        expect(properties.get('shippingAddress')).toEqual({ name: 'shippingAddress', relationKind: 'subrecord', subrecordFieldId: 'shippingaddress', clearListField: 'shipaddresslist', load: 'separate' });
        expect(properties.get('billingAddress')).toEqual({ name: 'billingAddress', relationKind: 'subrecord', clearListField: 'billaddresslist' });
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
