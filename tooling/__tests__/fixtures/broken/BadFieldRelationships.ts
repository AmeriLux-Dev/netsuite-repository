import { Field, RecordType, Reference } from '@amerilux/netsuite-repository';

@RecordType('invoice')
export class FilterWithoutRelationship {
    id!: number;
    /** A filter with no relationship to read the field through. */
    @Field('subsidiary', { filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) subsidiaryId!: number;
}

@RecordType('invoice')
export class ConflictingRelationshipFilters {
    id!: number;
    /** Two fields through one relationship with different filters: N/query joins a relationship once per component. */
    @Field('department', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) departmentId!: number;
    @Field('location', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) locationId!: number;
}

@RecordType('subsidiary')
export class Subsidiary {
    id!: number;
    name!: string;
}

@RecordType('invoice')
export class JoinedThroughMainLine {
    id!: number;
    @Field('subsidiary', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) subsidiaryId!: number;
    /** Forced to join off the main line: N/query has no join from the line to the subsidiary. */
    @Reference('subsidiaryId', { load: 'join' }) subsidiary?: Pick<Subsidiary, 'id' | 'name'>;
}

@RecordType('invoice')
export class MainLineSubsidiaryInvoice {
    id!: number;
    @Field('subsidiary', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] }) subsidiaryId!: number;
    /** Loads separately, which is fine on its own. */
    subsidiary?: Pick<Subsidiary, 'id' | 'name'>;
}

@RecordType('customrecord_invoice_note')
export class NoteOnMainLineSubsidiaryInvoice {
    id!: number;
    @Field('custrecord_note_invoice') invoiceId!: number;
    /** Brings the invoice's subsidiary in, inside a joined reference, where it cannot load separately. */
    invoice?: Pick<MainLineSubsidiaryInvoice, 'id' | 'subsidiary'>;
}
