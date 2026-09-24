import { Field, RecordType } from '@amerilux/netsuite-repository';

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
