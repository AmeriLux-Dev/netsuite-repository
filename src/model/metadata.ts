import type { Discriminator, FieldType, JoinType, QueryField, RecordUpdaterOptions, RestRecordMetadata } from '../types';

/** A table-per-type table that shares the record's internal id (for example `salesorder` next to `transaction`). */
export interface TypeTableOptions {
    /** Column on both sides of the join; defaults to 'id'. */
    key?: string;
}

/** Column and field id pair identifying a sublist line: the SuiteQL column read and the sublist field matched on write. */
export interface LineKey {
    column: string;
    field: string;
}

/** What a property typed as another class is: a reference joined through a select field, a subrecord, or a sublist. */
export type RelationKind = 'reference' | 'subrecord' | 'sublist';

/** Everything the decorators can say about one property. Every member is an override; the build step fills the rest by convention. */
export interface PropertyOverrides {
    name: string;
    /** NetSuite record field id; also the SuiteQL column unless `column` is set. */
    fieldId?: string;
    /** SuiteQL column when it differs from the field id (transaction `status` reads `status` but writes `orderstatus`). */
    column?: string;
    /** Type table the column is read from instead of the record's base table. */
    table?: string;
    type?: FieldType;
    /** Read the display text of a select field (BUILTIN.DF). */
    text?: boolean;
    coerce?: boolean;
    readOnly?: boolean;
    setFirst?: boolean;
    selectByDefault?: boolean;
    transform?: QueryField['transform'];
    /** Which relation decorator the property carries (@Reference, @Subrecord, @Sublist); the build step checks it against the declared type. */
    relationKind?: RelationKind;
    /** Reference, subrecord, or sublist: forces the join type. */
    joinType?: JoinType;
    /** Reference: property holding the internal id of the referenced record. */
    selectFieldProperty?: string;
    /** Reference: property on the referenced class to join on when it is not its internal id (EF principal key). */
    targetKeyProperty?: string;
    /** Subrecord: field id when it is not the lowercased property name. */
    subrecordFieldId?: string;
    /** Subrecord: queryable table and its key column when the conventions do not know them. */
    subrecordTable?: string;
    subrecordKey?: string;
    /** Subrecord: list field cleared before the subrecord can be edited. */
    clearListField?: string;
    /** Sublist: id when it is not known from the line table or the lowercased property name. */
    sublistId?: string;
    /** Sublist: line table when the line class does not name it. */
    sublistTable?: string;
    /** Sublist: extra predicate on the join; `{alias}` stands for the line table alias. */
    sublistWhere?: string;
    /** Sublist: column on the line table holding the parent's internal id. */
    parentColumn?: string;
    lineKey?: LineKey;
}

/** Everything @RecordType can say about one class, merged along the prototype chain by getClassOverrides(). */
export interface ClassOverrides {
    recordType?: string;
    /** Base SuiteQL table; defaults from the conventions for the record type. */
    table?: string;
    setName?: string;
    coerce?: boolean;
    discriminator?: Discriminator;
    /** Type tables fields may read from with @Field({ table }). */
    typeTables?: Record<string, TypeTableOptions>;
    keyProperty?: string;
    updaterOptions?: RecordUpdaterOptions;
    restRecordMetadata?: RestRecordMetadata;
    properties: Map<string, PropertyOverrides>;
    notMapped: Set<string>;
}

export function createClassOverrides(): ClassOverrides {
    return { properties: new Map(), notMapped: new Set() };
}

export function getOrCreatePropertyOverrides(overrides: ClassOverrides, name: string): PropertyOverrides {
    let property = overrides.properties.get(name);
    if (!property) {
        property = { name };
        overrides.properties.set(name, property);
    }
    return property;
}

/** Layers `source` over `target`: scalar members win when set, property overrides merge per property. */
export function mergeClassOverrides(target: ClassOverrides, source: ClassOverrides): ClassOverrides {
    const { properties, notMapped, ...scalars } = source;
    for (const [key, value] of Object.entries(scalars)) {
        if (value !== undefined) {
            (target as unknown as Record<string, unknown>)[key] = value;
        }
    }
    for (const [name, property] of properties) {
        target.properties.set(name, { ...(target.properties.get(name) ?? { name }), ...property });
    }
    notMapped.forEach((name) => target.notMapped.add(name));
    return target;
}
