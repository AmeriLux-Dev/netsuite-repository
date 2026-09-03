import type { Discriminator, FieldType, JoinType, QueryField, RecordUpdaterOptions, RestRecordMetadata } from '../types';
import { createClassOverrides, getOrCreatePropertyOverrides, mergeClassOverrides } from './metadata';
import type { ClassOverrides, LineKey, ModelClassKind, PropertyOverrides, TypeTableOptions } from './metadata';

export type ModelClass<T = unknown> = new (...args: never[]) => T;

export interface RecordTypeOptions {
    /** Base SuiteQL table when the conventions do not know it. */
    table?: string;
    /** Record set name on the context; derived from the class name when absent. */
    setName?: string;
    coerce?: boolean;
    /** Table-per-hierarchy filter when the conventions do not know it. */
    discriminator?: Discriminator;
    /** Type tables fields may read from with @Field({ table }). */
    tables?: Record<string, TypeTableOptions>;
}

export interface SublistOptions {
    /** Line table when the conventions do not know it. */
    table?: string;
    /** Extra predicate on the join; `{alias}` stands for the line table alias. */
    where?: string;
    /** Column on the line table holding the parent's internal id. */
    parentColumn?: string;
    /** Column read and sublist field matched to identify a line. */
    lineKey?: LineKey;
}

export interface SubrecordClassOptions {
    /** Queryable table and its key column when the conventions do not know them. */
    table?: string;
    key?: string;
}

export interface SubrecordPropertyOptions extends SubrecordClassOptions {
    /** List field cleared before the subrecord can be edited (for example 'shipaddresslist'). */
    clearListField?: string;
    join?: JoinType;
}

export interface FieldOptions {
    /** SuiteQL column when it differs from the field id. */
    column?: string;
    /** Type table the column is read from. */
    table?: string;
    type?: FieldType;
    /** Read the display text of a select field (BUILTIN.DF). Text fields are read-only; declare a second property to write the select field itself. */
    text?: boolean;
    coerce?: boolean;
}

export interface ReferenceOptions {
    join?: JoinType;
    /** Property on the referenced class to join on when it is not its internal id, for example a code column. */
    targetKey?: string;
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

function classDecorator(apply: (overrides: ClassOverrides) => void): ClassDecoratorFunction {
    return (target) => apply(getOrCreateRegistration(target));
}

// ── class decorators ──────────────────────────────────────────────────────────

/** A queryable record type. The class becomes a record set on the context. */
export function RecordType(recordType: string, options: RecordTypeOptions = {}): ClassDecoratorFunction {
    return classDecorator((overrides) => {
        overrides.kind = 'recordType';
        overrides.recordType = recordType;
        overrides.table = options.table;
        overrides.setName = options.setName;
        overrides.coerce = options.coerce;
        overrides.discriminator = options.discriminator;
        overrides.typeTables = options.tables;
    });
}

/** A sublist line class. An array property typed with it becomes the sublist on the parent record. */
export function Sublist(sublistId: string, options: SublistOptions = {}): ClassDecoratorFunction {
    return classDecorator((overrides) => {
        overrides.kind = 'sublist';
        overrides.sublistId = sublistId;
        overrides.sublistTable = options.table;
        overrides.sublistWhere = options.where;
        overrides.parentColumn = options.parentColumn;
        overrides.lineKey = options.lineKey;
    });
}

/**
 * On a class: a subrecord class (optional; any undecorated class used as an object property is one).
 * On a property: the subrecord field id and table when they cannot come from the property name and the conventions.
 */
export function Subrecord(options?: SubrecordClassOptions): ClassDecoratorFunction;
export function Subrecord(fieldId: string, options?: SubrecordPropertyOptions): PropertyDecoratorFunction;
export function Subrecord(options: SubrecordPropertyOptions): PropertyDecoratorFunction;
export function Subrecord(first?: string | SubrecordPropertyOptions, second: SubrecordPropertyOptions = {}): ClassDecoratorFunction | PropertyDecoratorFunction {
    const fieldId = typeof first === 'string' ? first : undefined;
    const options = typeof first === 'string' ? second : first ?? {};
    return (target: object, propertyKey?: string | symbol) => {
        if (propertyKey === undefined) {
            const overrides = getOrCreateRegistration(target as Function);
            overrides.kind = 'subrecord';
            overrides.subrecordTable = options.table;
            overrides.subrecordKey = options.key;
            return;
        }
        const overrides = getOrCreateRegistration(target.constructor);
        const property = getOrCreatePropertyOverrides(overrides, toPropertyName(target, propertyKey));
        if (fieldId !== undefined) property.subrecordFieldId = fieldId;
        if (options.table !== undefined) property.subrecordTable = options.table;
        if (options.key !== undefined) property.subrecordKey = options.key;
        if (options.clearListField !== undefined) property.clearListField = options.clearListField;
        if (options.join !== undefined) property.joinType = options.join;
    };
}

export function UpdaterOptions(options: RecordUpdaterOptions): ClassDecoratorFunction {
    return classDecorator((overrides) => {
        overrides.updaterOptions = options;
    });
}

/** REST record metadata used by the scaffold and by runtime field lookups outside the model. */
export function RestMetadata(metadata: RestRecordMetadata): ClassDecoratorFunction {
    return classDecorator((overrides) => {
        overrides.restRecordMetadata = metadata;
    });
}

// ── property decorators ───────────────────────────────────────────────────────

/** Marks the internal id when it is not the property named `id`. */
export function InternalId(): PropertyDecoratorFunction {
    return propertyDecorator((property, overrides) => {
        overrides.keyProperty = property.name;
    });
}

/** Renames the field or overrides the inferred type. Never required: by convention the field id is the lowercased property name. */
export function Field(fieldId?: string, options?: FieldOptions): PropertyDecoratorFunction;
export function Field(options: FieldOptions): PropertyDecoratorFunction;
export function Field(first?: string | FieldOptions, second: FieldOptions = {}): PropertyDecoratorFunction {
    const fieldId = typeof first === 'string' ? first : undefined;
    const options = typeof first === 'string' ? second : first ?? {};
    return propertyDecorator((property) => {
        if (fieldId !== undefined) property.fieldId = fieldId;
        if (options.column !== undefined) property.column = options.column;
        if (options.table !== undefined) property.table = options.table;
        if (options.type !== undefined) property.type = options.type;
        if (options.text !== undefined) property.text = options.text;
        if (options.coerce !== undefined) property.coerce = options.coerce;
    });
}

/** Forces the join type of a reference, subrecord, or sublist. Every relation joins left outer by default, so it never filters the parent (EF Include). */
export function Join(joinType: JoinType): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.joinType = joinType;
    });
}

/** Excludes the property from writes. */
export function ReadOnly(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.readOnly = true;
    });
}

/** On a reference: names the property holding the referenced internal id when it is not `<reference>Id`. */
export function Reference(selectFieldProperty?: string, options: ReferenceOptions = {}): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        if (selectFieldProperty !== undefined) property.selectFieldProperty = selectFieldProperty;
        if (options.join !== undefined) property.joinType = options.join;
        if (options.targetKey !== undefined) property.targetKeyProperty = options.targetKey;
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

/** The kind declared on the class or inherited from a base; undefined for plain classes. */
export function getClassKind(modelClass: Function): ModelClassKind | undefined {
    return getClassOverrides(modelClass).kind;
}

/** True only for classes carrying @RecordType somewhere in their prototype chain. */
export function isRecordTypeClass(value: unknown): value is ModelClass {
    return typeof value === 'function' && getClassKind(value) === 'recordType';
}
