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

@RecordType('subsidiary')
export class Subsidiary {
    id!: number;
    name!: string;
}

/** Common transaction fields with no record type of their own: a mapping base, and the shape of a transaction reached through a link. */
export abstract class TransactionBase {
    id!: number;
    @Field('tranid') tranId!: string;
    type!: string;
}

@RecordType('invoice')
export class Invoice {
    id!: number;
    /** Read off the main line: N/query inside SuiteScript does not expose a transaction's own subsidiary on its root. */
    @Field('subsidiary', { type: 'select', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) subsidiaryId!: number;
    /** A reference through a field read off the main line joins from that line, not from the root. */
    subsidiary?: Pick<Subsidiary, 'id' | 'name'>;
    /** A second field off the same line shares its join. */
    @Field('department', { type: 'select', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) departmentId!: number | null;
    @Field('location') locationId!: number | null;
    /** A reference by internal id that N/query has no join for: loaded by a second query matching the target's id. */
    @Reference('locationId', { load: 'separate' }) location?: Pick<Warehouse, 'id' | 'name'>;
    @Field('custbody_carrier_code') carrierCode!: string | null;
    /** Matched on the carrier's code rather than its internal id, so it loads by a query of its own. */
    @Reference('carrierCode', { targetKey: 'code' }) carrier?: Pick<Carrier, 'id' | 'name'>;
    /** Loaded by a second query so an invoice with no lines still comes back. */
    @Sublist('item', { load: 'separate', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: InvoiceLine[];
    /** Lines queried from the `transaction` root through its relationship field, matched to the invoice by id. */
    @Sublist('expense', { queryType: 'transaction', relationship: 'transactionlines' }) expenses!: InvoiceLine[];
    /** A subrecord loaded separately too. */
    @Subrecord('billingaddress', { load: 'separate' }) billingAddress?: Address;
    /** A has-many loaded separately runs on the child's record type, batched on the field that points back at the invoice. */
    @Sublist({ load: 'separate' }) shipments!: Shipment[];
    /** Transactions two joins away: the link off `transaction`, then the transaction it points at. The link needs no class. */
    @Sublist({ queryType: 'transaction', relationship: 'nexttransactionlink', filter: [{ fieldId: 'linktype', operator: 'ANY_OF', values: ['OrdBill'] }], through: [{ fieldId: 'nextdoc', target: 'transaction' }] })
    relatedTransactions!: Pick<TransactionBase, 'id' | 'tranId' | 'type'>[];
}

/** References with no id property: the build step adds each one's select field (`subsidiaryId`, `locationId`) as a shadow. */
@RecordType('creditmemo')
export class CreditMemo {
    id!: number;
    /** @Field options on a reference configure its shadow select field, here read off the main line. */
    @Field({ relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] })
    subsidiary?: Pick<Subsidiary, 'id' | 'name'>;
    /** Loaded by a second query batched on the shadow's values. */
    @Reference({ load: 'separate' })
    location?: Pick<Warehouse, 'id' | 'name'>;
}

/** A field read off the main line keeps its own join when another record reaches it through a reference. */
@RecordType('customrecord_invoice_note')
export class InvoiceNote {
    id!: number;
    @Field('custrecord_note_invoice') invoiceId!: number;
    invoice?: Pick<Invoice, 'id' | 'subsidiaryId'>;
}

/** A custom record pointing at the invoice through a list/record field: a has-many keyed by that field. */
@RecordType('customrecord_shipment')
export class Shipment {
    id!: number;
    @ParentId() @Field('custrecord_shipment_invoice') invoiceId!: number;
    @Field('custrecord_shipment_weight') weight!: number | null;
}
