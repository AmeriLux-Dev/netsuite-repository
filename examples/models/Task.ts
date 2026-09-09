import { Field, ReadOnly, RecordType } from '@amerilux/netsuite-repository';

@RecordType('task')
export class Task {
    id!: number;
    title!: string;
    @Field('assigned') assignedTo!: number | null;
    @Field('transaction') transactionId!: number | null;
    @Field('duedate') dueDate!: Date | null;
    /** Read as a checkbox from the completed date field. */
    @Field({ queryFieldId: 'completeddate', type: 'boolean' }) @ReadOnly() completed!: boolean;
}
