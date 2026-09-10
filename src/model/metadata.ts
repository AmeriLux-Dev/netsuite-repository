import type { ComponentCondition, FieldType, QueryField, RecordUpdaterOptions, RelationshipLoad } from '../types';

/** What a property typed as another class is: a reference joined through a select field, a subrecord, or a sublist. */
export type RelationKind = 'reference' | 'subrecord' | 'sublist';

/** How a reference is joined: autoJoin on the select field, or joinTo with the target's query type. */
export type ReferenceJoinKind = 'auto' | 'to';

/**
 * Everything the decorators can say about one property. Every member is an override; what is not declared is
 * derived from the model itself (property names and types) or resolved by N/query at run time. Nothing here is
 * ever filled from a table of NetSuite facts.
 */
export interface PropertyOverrides {
    name: string;
    /** NetSuite record field id; also the N/query field id unless `queryFieldId` is set. */
    fieldId?: string;
    /** N/query field id when it differs from the record field id (transaction `orderstatus` is queried as `status`). */
    queryFieldId?: string;
    type?: FieldType;
    /** Read the display text of a select field (DISPLAY context). */
    text?: boolean;
    coerce?: boolean;
    readOnly?: boolean;
    setFirst?: boolean;
    selectByDefault?: boolean;
    transform?: QueryField['transform'];
    /** Which relation decorator the property carries (@Reference, @Subrecord, @Sublist); the build step checks it against the declared type. */
    relationKind?: RelationKind;
    /** Reference, subrecord, or sublist: how the relation is loaded. */
    load?: RelationshipLoad;
    /** Reference: how it is joined. */
    joinKind?: ReferenceJoinKind;
    /** Reference: property holding the internal id of the referenced record. */
    selectFieldProperty?: string;
    /** Reference: property on the referenced class matched instead of its internal id; always loaded separately. */
    targetKeyProperty?: string;
    /** Subrecord: field id when it is not the lowercased property name. */
    subrecordFieldId?: string;
    /** Subrecord: list field cleared before the subrecord can be edited. */
    clearListField?: string;
    /** Sublist: id when it is not the lowercased property name. */
    sublistId?: string;
    /** Sublist: relationship field for autoJoin instead of joinFrom through the line class's parent id. */
    relationshipFieldId?: string;
    /** Sublist: conditions on the line component that pick the sublist's rows out of the line type. */
    filter?: ComponentCondition[];
    /** Sublist loaded separately: root type of the line query when it is not the owner's query type. */
    separateQueryType?: string;
}

/** Everything the class decorators say about one class, merged along the prototype chain by getClassOverrides(). */
export interface ClassOverrides {
    recordType?: string;
    /** N/query root type when it differs from the record type. */
    queryType?: string;
    /** Conditions applied to every query on the root. */
    rootFilter?: ComponentCondition[];
    setName?: string;
    coerce?: boolean;
    keyProperty?: string;
    /** Line classes: the property holding the parent's internal id. */
    parentKeyProperty?: string;
    updaterOptions?: RecordUpdaterOptions;
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
