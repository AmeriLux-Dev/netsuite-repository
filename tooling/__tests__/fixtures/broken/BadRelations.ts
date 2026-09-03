import { Field, RecordType, Reference, Sublist } from '@amerilux/netsuite-repository';

export class Note {
    text!: string;
}

@Sublist('recmachcustrecord_child')
export class ChildLine {
    id!: number;
}

@RecordType('customrecord_parent')
export class BadRelations {
    id!: number;
    notes!: Note[];
    children!: ChildLine[];
    owner?: BadRelationsOwner;
    detail!: Note;
    line!: ChildLine;
}

@RecordType('employee')
export class BadRelationsOwner {
    id!: number;
    parents!: BadRelations[];
    parent?: BadRelations;
}

@RecordType('customrecord_code_owner')
export class BadTargetKey {
    id!: number;
    @Field('custrecord_code') code!: string;
    @Reference('code', { targetKey: 'ghost' }) owner?: BadRelationsOwner;
}
