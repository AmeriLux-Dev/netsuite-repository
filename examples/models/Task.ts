import { Field, ReadOnly, RecordType } from '@amerilux/netsuite-repository';

@RecordType('task')
export class Task {
    id!: number;
    title!: string;
    @Field('assigned') assignedTo!: number | null;
    @Field('transaction') transactionId!: number | null;
    @Field('duedate') dueDate!: Date | null;
    @Field({ column: 'completeddate', type: 'boolean' }) @ReadOnly() completed!: boolean;
}
