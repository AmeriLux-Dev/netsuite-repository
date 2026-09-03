import { defineModel } from '@amerilux/netsuite-repository';

export interface Task {
    id: number;
    title: string;
    assignedTo: number | null;
    transactionId: number | null;
    dueDate: Date | null;
    completed: boolean;
}

export const TaskModel = defineModel<Task>((model) => model
    .toRecord('task').toTable('task', 't').hasKey('id')
    .property('title').hasRecordField()
    .property('assignedTo').hasColumn('assigned').hasType('key').hasRecordField('assigned')
    .property('transactionId').hasColumn('transaction').hasType('key').hasRecordField('transaction')
    .property('dueDate').hasColumn('duedate').hasRecordField('duedate')
    .property('completed').hasColumn('completeddate').hasType('boolean').isReadOnly());
