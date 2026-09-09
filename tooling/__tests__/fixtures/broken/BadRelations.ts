import { Field, ParentId, RecordType, Reference, Sublist, Subrecord } from '@amerilux/netsuite-repository';

export class Note {
    text!: string;
}

/** A line class that never says which field points at its parent. */
@RecordType('customrecord_child')
export class ChildLine {
    id!: number;
}

@RecordType('customrecord_parent')
export class BadRelations {
    id!: number;
    /** A sublist of a plain class: no line record type. */
    notes!: Note[];
    /** The line class has a record type but no @ParentId(). */
    children!: ChildLine[];
    /** A reference without a select field. */
    owner?: BadRelationsOwner;
    /** A reference to a plain class. */
    @Reference('detailId') detail?: Note;
    @Field('detail') detailId!: number;
    @Sublist('item') line!: ChildLine;
    @Subrecord() tags!: Note[];
    /** @ParentId() on a property that does not map to a field, so the class has no way back to a parent either. */
    @ParentId() ghostParent!: Map<string, string>;
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
    @Reference('code', { targetKey: 'id', load: 'join' }) joined?: BadRelationsOwner;
}
