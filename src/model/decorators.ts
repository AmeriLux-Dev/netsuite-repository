import type { Discriminator, FieldType, JoinType, QueryField, RecordUpdaterOptions, RestRecordMetadata } from '../types';
import { createClassOverrides, getOrCreatePropertyOverrides, mergeClassOverrides } from './metadata';
import type { ClassOverrides, LineKey, PropertyOverrides, TypeTableOptions } from './metadata';

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
    /** Default record updater options for every write on this record type. */
    updater?: RecordUpdaterOptions;
    /** REST record metadata used by the scaffold and by runtime field lookups outside the model. */
    rest?: RestRecordMetadata;
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

export interface RelationOptions {
    /** Forces the join type. Sublists and subrecords join inner by default; references join left outer. */
    join?: JoinType;
}

export interface ReferenceOptions extends RelationOptions {
    /** Property on the referenced class to join on when it is not its internal id, for example a code column. */
    targetKey?: string;
}

export interface SubrecordOptions extends RelationOptions {
    /** Queryable table and its key column when the conventions and the subrecord class do not know them. */
    table?: string;
    key?: string;
    /** List field cleared before the subrecord can be edited (for example 'shipaddresslist'). */
    clearListField?: string;
}

export interface SublistOptions extends RelationOptions {
    /** Line table when the line class does not name it. */
    table?: string;
    /** Extra predicate on the join; `{alias}` stands for the line table alias. */
    where?: string;
    /** Column on the line table holding the parent's internal id. */
    parentColumn?: string;
    /** Column read and sublist field matched to identify a line. */
    lineKey?: LineKey;
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

// ── class decorator ───────────────────────────────────────────────────────────

/** A queryable record type. The class becomes a record set on the context; sublist line classes name the line table they read from. */
export function RecordType(recordType: string, options: RecordTypeOptions = {}): ClassDecoratorFunction {
    return (target) => {
        const overrides = getOrCreateRegistration(target);
        overrides.recordType = recordType;
        overrides.table = options.table;
        overrides.setName = options.setName;
        overrides.coerce = options.coerce;
        overrides.discriminator = options.discriminator;
        overrides.typeTables = options.tables;
        overrides.updaterOptions = options.updater;
        overrides.restRecordMetadata = options.rest;
    };
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
export function Field(first?: string | FieldOptions, second?: FieldOptions): PropertyDecoratorFunction {
    const { id: fieldId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        if (fieldId !== undefined) property.fieldId = fieldId;
        if (options.column !== undefined) property.column = options.column;
        if (options.table !== undefined) property.table = options.table;
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
        if (options.join !== undefined) property.joinType = options.join;
        if (options.targetKey !== undefined) property.targetKeyProperty = options.targetKey;
    });
}

/** A subrecord: the field id when it is not the lowercased property name, and the table facts the conventions do not know. */
export function Subrecord(fieldId?: string, options?: SubrecordOptions): PropertyDecoratorFunction;
export function Subrecord(options: SubrecordOptions): PropertyDecoratorFunction;
export function Subrecord(first?: string | SubrecordOptions, second?: SubrecordOptions): PropertyDecoratorFunction {
    const { id: fieldId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        property.relationKind = 'subrecord';
        if (fieldId !== undefined) property.subrecordFieldId = fieldId;
        if (options.table !== undefined) property.subrecordTable = options.table;
        if (options.key !== undefined) property.subrecordKey = options.key;
        if (options.clearListField !== undefined) property.clearListField = options.clearListField;
        if (options.join !== undefined) property.joinType = options.join;
    });
}

/** A sublist: the sublist id when it is not known from the line table, and the line table facts the conventions do not know. */
export function Sublist(sublistId?: string, options?: SublistOptions): PropertyDecoratorFunction;
export function Sublist(options: SublistOptions): PropertyDecoratorFunction;
export function Sublist(first?: string | SublistOptions, second?: SublistOptions): PropertyDecoratorFunction {
    const { id: sublistId, options } = splitIdAndOptions(first, second);
    return propertyDecorator((property) => {
        property.relationKind = 'sublist';
        if (sublistId !== undefined) property.sublistId = sublistId;
        if (options.table !== undefined) property.sublistTable = options.table;
        if (options.where !== undefined) property.sublistWhere = options.where;
        if (options.parentColumn !== undefined) property.parentColumn = options.parentColumn;
        if (options.lineKey !== undefined) property.lineKey = options.lineKey;
        if (options.join !== undefined) property.joinType = options.join;
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
