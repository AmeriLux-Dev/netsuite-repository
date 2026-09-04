import { Field, RecordType, Reference, Sublist, Subrecord } from '@amerilux/netsuite-repository';

export class Note {
    text!: string;
}

@RecordType('customrecord_child')
export class ChildLine {
    id!: number;
}

@RecordType('customrecord_parent')
export class BadRelations {
    id!: number;
    /** A sublist of a plain class: no line table. */
    notes!: Note[];
    /** The line table comes from the class, but nothing says which column holds the parent. */
    children!: ChildLine[];
    /** A reference without a select field. */
    owner?: BadRelationsOwner;
    /** A subrecord the conventions do not know. */
    detail!: Note;
    @Sublist('item') line!: ChildLine;
    @Subrecord() tags!: Note[];
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
