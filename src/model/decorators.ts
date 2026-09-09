import type { ComponentCondition, FieldType, QueryField, RecordUpdaterOptions, RelationshipLoad } from '../types';
import { createClassOverrides, getOrCreatePropertyOverrides, mergeClassOverrides } from './metadata';
import type { ClassOverrides, PropertyOverrides, ReferenceJoinKind } from './metadata';

export type ModelClass<T = unknown> = new (...args: never[]) => T;

export interface RecordTypeOptions {
    /** N/query root type when it is not the record type. */
    queryType?: string;
    /** Conditions applied to every query on this record type. */
    filter?: ComponentCondition[];
    /** Record set name on the context; derived from the class name when absent. */
    setName?: string;
    coerce?: boolean;
    /** Default record updater options for every write on this record type. */
    updater?: RecordUpdaterOptions;
}

export interface FieldOptions {
    /** N/query field id when it differs from the record field id. */
    queryFieldId?: string;
    /**
     * Overrides the type inferred from the property. Declare `select` on a list/record field with no reference: N/query
     * compares select and key fields through ANY_OF and rejects EQUAL on them.
     */
    type?: FieldType;
    /** Read the display text of a select field. Text fields are read-only; declare a second property to write the select field itself. */
    text?: boolean;
    coerce?: boolean;
}

export interface RelationOptions {
    /** `join` (default) reads the relation in the parent's query; `separate` runs a second query keyed by the parent ids. */
    load?: RelationshipLoad;
}

export interface ReferenceOptions extends RelationOptions {
    /**
     * Property on the referenced class to match when it is not its internal id. Such a reference always loads separately.
     * Without it, `load: 'separate'` matches the target's internal id by a second query, for references N/query has no join for.
     */
    targetKey?: string;
    /** How the reference is joined: `auto` (autoJoin on the select field) or `to` (joinTo with the target's query type). */
    join?: ReferenceJoinKind;
}

export interface SubrecordOptions extends RelationOptions {
    /** List field cleared before the subrecord can be edited (for example 'shipaddresslist'). */
    clearListField?: string;
}

export interface SublistOptions extends RelationOptions {
    /** Conditions on the line component that pick this sublist's rows out of the line type. */
    filter?: ComponentCondition[];
    /** Relationship field for autoJoin, instead of joinFrom through the line class's @ParentId() field. */
    relationship?: string;
}

type ClassDecoratorFunction = (target: Function) => void;
type PropertyDecoratorFunction = (target: object, propertyKey: string | symbol) => void;

const registry = new WeakMap<Function, ClassOverrides>();

function getOrCreateRegistration(target: Function): ClassOverrides {
    let overrides = registry.get(target);
    if (!overrides) {
        overrides = createClassOverrides();
        registry.set(target, overrides);
    }
    return overrides;
}

function toPropertyName(target: object, propertyKey: string | symbol): string {
    if (typeof propertyKey !== 'string') {
        throw new Error(`Symbol properties cannot be mapped on '${target.constructor.name}'.`);
    }
    return propertyKey;
}

function propertyDecorator(apply: (property: PropertyOverrides, overrides: ClassOverrides) => void): PropertyDecoratorFunction {
    return (target, propertyKey) => {
        const overrides = getOrCreateRegistration(target.constructor);
        apply(getOrCreatePropertyOverrides(overrides, toPropertyName(target, propertyKey)), overrides);
    };
}

/** Splits the `(id?, options?)` and `(options)` call shapes the relation decorators share. */
function splitIdAndOptions<TOptions extends object>(first: string | TOptions | undefined, second: TOptions | undefined): { id: string | undefined; options: TOptions } {
    return typeof first === 'string'
        ? { id: first, options: second ?? ({} as TOptions) }
        : { id: undefined, options: first ?? ({} as TOptions) };
}

function applyRelationOptions(property: PropertyOverrides, options: RelationOptions): void {
    if (options.load !== undefined) property.load = options.load;
}

// ── class decorator ───────────────────────────────────────────────────────────

/** A queryable record type. The class becomes a record set on the context, queried through N/query as the same type. */
export function RecordType(recordType: string, options: RecordTypeOptions = {}): ClassDecoratorFunction {
    return (target) => {
        const overrides = getOrCreateRegistration(target);
        overrides.recordType = recordType;
        overrides.queryType = options.queryType;
        overrides.rootFilter = options.filter;
        overrides.setName = options.setName;
        overrides.coerce = options.coerce;
        overrides.updaterOptions = options.updater;
    };
}

// ── property decorators ───────────────────────────────────────────────────────

/** Marks the internal id when it is not the property named `id`. */
export function InternalId(): PropertyDecoratorFunction {
    return propertyDecorator((property, overrides) => {
        overrides.keyProperty = property.name;
    });
}

/** On a line class: marks the property holding the parent record's internal id. Its field is what the sublist join goes through. */
export function ParentId(): PropertyDecoratorFunction {
    return propertyDecorator((property, overrides) => {
        overrides.parentKeyProperty = property.name;
    });
}

/** Renames the field or overrides the inferred type. Never required: by convention the field id is the lowercased property name. */
export function Field(fieldId?: string, options?: FieldOptions): PropertyDecoratorFunction;
export function Field(options: FieldOptions): PropertyDecoratorFunction;
export function Field(first?: string | FieldOptions, second?: FieldOptions): PropertyDecoratorFunction {
    const { id: fieldId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        if (fieldId !== undefined) property.fieldId = fieldId;
        if (options.queryFieldId !== undefined) property.queryFieldId = options.queryFieldId;
        if (options.type !== undefined) property.type = options.type;
        if (options.text !== undefined) property.text = options.text;
        if (options.coerce !== undefined) property.coerce = options.coerce;
    });
}

/** Excludes the property from writes. */
export function ReadOnly(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.readOnly = true;
    });
}

/** A reference to another record: names the property holding the referenced internal id when it is not `<reference>Id`. */
export function Reference(selectFieldProperty?: string, options?: ReferenceOptions): PropertyDecoratorFunction;
export function Reference(options: ReferenceOptions): PropertyDecoratorFunction;
export function Reference(first?: string | ReferenceOptions, second?: ReferenceOptions): PropertyDecoratorFunction {
    const { id: selectFieldProperty, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        property.relationKind = 'reference';
        if (selectFieldProperty !== undefined) property.selectFieldProperty = selectFieldProperty;
        if (options.targetKey !== undefined) property.targetKeyProperty = options.targetKey;
        if (options.join !== undefined) property.joinKind = options.join;
        applyRelationOptions(property, options);
    });
}

/** A subrecord: the field id when it is not the lowercased property name. N/query resolves the join from the field. */
export function Subrecord(fieldId?: string, options?: SubrecordOptions): PropertyDecoratorFunction;
export function Subrecord(options: SubrecordOptions): PropertyDecoratorFunction;
export function Subrecord(first?: string | SubrecordOptions, second?: SubrecordOptions): PropertyDecoratorFunction {
    const { id: fieldId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        property.relationKind = 'subrecord';
        if (fieldId !== undefined) property.subrecordFieldId = fieldId;
        if (options.clearListField !== undefined) property.clearListField = options.clearListField;
        applyRelationOptions(property, options);
    });
}

/** A sublist: the sublist id when it is not the lowercased property name, and the conditions that pick its lines. */
export function Sublist(sublistId?: string, options?: SublistOptions): PropertyDecoratorFunction;
export function Sublist(options: SublistOptions): PropertyDecoratorFunction;
export function Sublist(first?: string | SublistOptions, second?: SublistOptions): PropertyDecoratorFunction {
    const { id: sublistId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        property.relationKind = 'sublist';
        if (sublistId !== undefined) property.sublistId = sublistId;
        if (options.filter !== undefined) property.filter = options.filter;
        if (options.relationship !== undefined) property.relationshipFieldId = options.relationship;
        applyRelationOptions(property, options);
    });
}

export function SetFirst(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.setFirst = true;
    });
}

/** Leaves the property (or the whole reference, subrecord, or sublist) out of the default select; include() brings it back per query. */
export function ExcludeFromDefaultSelect(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.selectByDefault = false;
    });
}

export function Transform(transform: NonNullable<QueryField['transform']>): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.transform = transform;
    });
}

/** Excludes a property from the model entirely. */
export function NotMapped(): PropertyDecoratorFunction {
    return propertyDecorator((property, overrides) => {
        overrides.notMapped.add(property.name);
    });
}

// ── registry access (used by the build step) ─────────────────────────────────

function collectPrototypeChain(modelClass: Function): Function[] {
    const chain: Function[] = [];
    let current: unknown = modelClass;
    while (typeof current === 'function' && current !== Function.prototype) {
        chain.unshift(current);
        current = Object.getPrototypeOf(current);
    }
    return chain;
}

/** The overrides registered on exactly this class, ignoring base classes. */
export function getOwnClassOverrides(modelClass: Function): ClassOverrides | undefined {
    return registry.get(modelClass);
}

/** The overrides of a class merged over those of its base classes, base first. */
export function getClassOverrides(modelClass: Function): ClassOverrides {
    const merged = createClassOverrides();
    for (const constructor of collectPrototypeChain(modelClass)) {
        const own = registry.get(constructor);
        if (own) {
            mergeClassOverrides(merged, own);
        }
    }
    return merged;
}

/** True when the class or one of its bases carries a model decorator. */
export function isModelClass(value: unknown): value is ModelClass {
    return typeof value === 'function' && collectPrototypeChain(value).some((constructor) => registry.has(constructor));
}

/** True only for classes carrying @RecordType somewhere in their prototype chain. */
export function isRecordTypeClass(value: unknown): value is ModelClass {
    return typeof value === 'function' && getClassOverrides(value).recordType !== undefined;
}
