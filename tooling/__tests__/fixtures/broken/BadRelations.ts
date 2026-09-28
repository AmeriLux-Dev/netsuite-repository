import { Field, NotMapped, ParentId, RecordType, Reference, Sublist, Subrecord } from '@amerilux/netsuite-repository';

export class Note {
    text!: string;
}

/** A line class that never says which field points at its parent. */
@RecordType('customrecord_child')
export class ChildLine {
    id!: number;
}

/** A child that points back at its parent, for a sublist that hops further with no relationship field to start from. */
@RecordType('customrecord_linked_child')
export class LinkedChild {
    id!: number;
    @ParentId() @Field('custrecord_linked_parent') parentId!: number;
}

@RecordType('customrecord_parent')
export class BadRelations {
    id!: number;
    /** A sublist of a plain class: no line record type. */
    notes!: Note[];
    /** The line class has a record type but no @ParentId(). */
    children!: ChildLine[];
    /** A reference whose select field is declared but not mapped: a declared property is never replaced by a shadow. */
    @NotMapped() ownerId?: number;
    owner?: BadRelationsOwner;
    /** @Field options on a reference whose select field is declared: they belong on that property. */
    @Field('custrecord_manager') managerId!: number;
    @Field('custrecord_manager') manager?: BadRelationsOwner;
    /** A reference to a plain class. */
    @Reference('detailId') detail?: Note;
    @Field('detail') detailId!: number;
    @Sublist('item') line!: ChildLine;
    @Subrecord() tags!: Note[];
    /** @ParentId() on a property that does not map to a field, so the class has no way back to a parent either. */
    @ParentId() ghostParent!: Map<string, string>;
    /** Hops need a relationship field to start from; a line class's parent field is not one. */
    @Sublist({ through: [{ fieldId: 'nextdoc', target: 'transaction' }] }) hopsFromLines!: LinkedChild[];
    /** A hop with no field id. */
    @Sublist({ relationship: 'nexttransactionlink', through: [' '] }) blankHop!: Note[];
}

@RecordType('employee')
export class BadRelationsOwner {
    id!: number;
    parents!: BadRelations[];
    /** A reference naming a select field the class does not declare: only the conventional `parentId` gets a shadow. */
    @Reference('parentKey') parent?: BadRelations;
    /** A query type of its own cannot be joined into the owner's query. */
    @Sublist('lines', { load: 'join', queryType: 'transaction', relationship: 'transactionlines' }) joinedElsewhere!: BadRelations[];
}

@RecordType('customrecord_code_owner')
export class BadTargetKey {
    id!: number;
    @Field('custrecord_code') code!: string;
    @Reference('code', { targetKey: 'ghost' }) owner?: BadRelationsOwner;
    @Reference('code', { targetKey: 'id', load: 'join' }) joined?: BadRelationsOwner;
}
