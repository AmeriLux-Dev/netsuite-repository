import type {
    CompositeModelMapping,
    FieldSourceMapping,
    FieldType,
    FieldUpdateMapping,
    JoinOn,
    JoinType,
    QueryField,
    QueryParamValue,
    RecordUpdaterOptions,
    RelationshipFieldMap,
    RestRecordMetadata,
    TableRef,
} from '../types';

/** A join declared on an entity or on a navigation property. */
export interface JoinMetadata {
    alias: string;
    table: string;
    /** Defaults to 'leftOuter' so optional nested data never filters the root rows. */
    type?: JoinType;
    /** Alias the equality keys are read from; defaults to the root table alias. */
    from?: string;
    on: JoinOn;
    params?: QueryParamValue[];
}

/** Everything an authoring surface can say about one scalar property. */
export interface PropertyMetadata {
    name: string;
    /** SuiteQL column; defaults to the lowercased property name. */
    column?: string;
    /** Table alias the column is read from; defaults to the owning scope (root table or navigation join). */
    tableAlias?: string;
    /** SQL result alias; defaults to the flattened field key. */
    alias?: string;
    /** Defaults to 'string', or 'integer' for the key property. */
    type?: FieldType;
    /** NetSuite record field id. Never inferred: absent means the property is read-only. */
    recordFieldId?: string;
    /** Explicit opt-in to write through the record field whose id equals the query column. */
    recordFieldFollowsColumn?: boolean;
    readOnly?: boolean;
    setFirst?: boolean;
    useText?: boolean;
    selectByDefault?: boolean;
    coerce?: boolean;
    transform?: QueryField['transform'];
    updateMapping?: FieldUpdateMapping;
    source?: FieldSourceMapping;
    meta?: unknown;
}

export type NavigationKind = 'owned' | 'collection' | 'related';

/** An owned subrecord, a sublist collection, or a read-only related lookup. */
export interface NavigationMetadata {
    name: string;
    kind: NavigationKind;
    /** Owned only: NetSuite subrecord field id (never inferred). */
    subrecordFieldId?: string;
    /** Owned only: list field cleared before the subrecord can be edited (for example 'shipaddresslist'). */
    clearListFieldId?: string;
    /** Collection only: NetSuite sublist id (never inferred). */
    sublistId?: string;
    /** Collection only: nested property used to match existing lines. */
    matchByProperty?: string;
    /** Collection only: nested property holding the NetSuite line index. */
    lineNumberProperty?: string;
    /** Join that makes the nested columns queryable. */
    join?: JoinMetadata;
    /** Alternative to a join: the nested columns live on an existing alias (for example billing fields on the transaction row). */
    sourceAlias?: string;
    properties: Map<string, PropertyMetadata>;
    /** Extra relationship field mappings merged under the inferred ones. */
    additionalRelationshipFields?: RelationshipFieldMap;
}

export interface EntityModelMetadata {
    /** Display name used in diagnostics: the class name or the record type. */
    name?: string;
    /** Explicit entity set name (for example 'salesOrders'); the build step derives one when absent. */
    setName?: string;
    recordType?: string;
    table?: TableRef;
    keyProperty?: string;
    properties: Map<string, PropertyMetadata>;
    ignoredProperties: Set<string>;
    joins: JoinMetadata[];
    navigations: Map<string, NavigationMetadata>;
    updaterOptions?: RecordUpdaterOptions;
    coerce?: boolean;
    restRecordMetadata?: RestRecordMetadata;
    composite?: CompositeModelMapping;
    postProcess?: (result: unknown) => unknown;
}

export function createEntityModelMetadata(name?: string): EntityModelMetadata {
    return {
        name,
        properties: new Map(),
        ignoredProperties: new Set(),
        joins: [],
        navigations: new Map(),
    };
}

export function getOrCreatePropertyMetadata(properties: Map<string, PropertyMetadata>, name: string): PropertyMetadata {
    let property = properties.get(name);
    if (!property) {
        property = { name };
        properties.set(name, property);
    }
    return property;
}

export function getOrCreateNavigationMetadata(metadata: EntityModelMetadata, name: string, kind: NavigationKind): NavigationMetadata {
    let navigation = metadata.navigations.get(name);
    if (!navigation) {
        navigation = { name, kind, properties: new Map() };
        metadata.navigations.set(name, navigation);
    } else {
        navigation.kind = kind;
    }
    return navigation;
}

function clonePropertyMap(properties: Map<string, PropertyMetadata>): Map<string, PropertyMetadata> {
    return new Map(Array.from(properties.entries()).map(([name, property]) => [name, { ...property }]));
}

/** Deep-enough copy so a derived model can be changed without touching its base. */
export function cloneEntityModelMetadata(metadata: EntityModelMetadata): EntityModelMetadata {
    return {
        ...metadata,
        properties: clonePropertyMap(metadata.properties),
        ignoredProperties: new Set(metadata.ignoredProperties),
        joins: metadata.joins.map((join) => ({ ...join })),
        navigations: new Map(Array.from(metadata.navigations.entries()).map(([name, navigation]) => [name, {
            ...navigation,
            join: navigation.join ? { ...navigation.join } : undefined,
            properties: clonePropertyMap(navigation.properties),
            additionalRelationshipFields: navigation.additionalRelationshipFields ? { ...navigation.additionalRelationshipFields } : undefined,
        }])),
    };
}
