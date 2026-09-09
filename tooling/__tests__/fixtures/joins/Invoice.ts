import { Field, InternalId, ParentId, RecordType, Reference, Sublist, Subrecord } from '@amerilux/netsuite-repository';

export class Address {
    city!: string | null;
}

@RecordType('location')
export class Warehouse {
    id!: number;
    name!: string | null;
    /** A subrecord needs nothing declared; N/query resolves its join from the field. */
    mainAddress?: Address;
}

@RecordType('customrecord_carrier')
export class Carrier {
    id!: number;
    name!: string | null;
    @Field('custrecord_carrier_code') code!: string;
}

@RecordType('transactionline')
export class InvoiceLine {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;
    @ParentId() @Field('transaction') transactionId!: number;
    @Field('location') locationId!: number | null;
    /** A reference joined through its select field; the subrecord under it comes along. */
    location?: Pick<Warehouse, 'id' | 'mainAddress'>;
}

@RecordType('invoice')
export class Invoice {
    id!: number;
    @Field('location') locationId!: number | null;
    /** A reference by internal id that N/query has no join for: loaded by a second query matching the target's id. */
    @Reference('locationId', { load: 'separate' }) location?: Pick<Warehouse, 'id' | 'name'>;
    @Field('custbody_carrier_code') carrierCode!: string | null;
    /** Matched on the carrier's code rather than its internal id, so it loads by a query of its own. */
    @Reference('carrierCode', { targetKey: 'code' }) carrier?: Pick<Carrier, 'id' | 'name'>;
    /** Loaded by a second query so an invoice with no lines still comes back. */
    @Sublist('item', { load: 'separate', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: InvoiceLine[];
    /** A subrecord loaded separately too. */
    @Subrecord('billingaddress', { load: 'separate' }) billingAddress?: Address;
}
