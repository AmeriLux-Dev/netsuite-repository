import type {
    FieldType,
    JoinOn,
    JoinType,
    QueryConfig,
    QueryField,
    QueryParamValue,
    RecordUpdaterOptions,
    RelationshipFieldMap,
    RestRecordMetadata,
} from '../types';
import { compileEntityModel } from './compile';
import {
    cloneEntityModelMetadata,
    createEntityModelMetadata,
    getOrCreateNavigationMetadata,
    getOrCreatePropertyMetadata,
} from './metadata';
import type { EntityModelMetadata, JoinMetadata, NavigationKind, PropertyMetadata } from './metadata';

export type EntityClass<T = unknown> = new (...args: never[]) => T;
export type EntityClassThunk<T = unknown> = () => EntityClass<T>;

export interface EntityOptions {
    recordType: string;
    table: string;
    /** Root table alias; defaults to the table name. */
    alias?: string;
    /** Entity set name used by contexts and the build step; derived from the class name when absent. */
    setName?: string;
}

export interface JoinSpec {
    table: string;
    on: JoinOn;
    type?: JoinType;
    from?: string;
    params?: QueryParamValue[];
}

export interface ColumnOptions {
    /** Table alias the column is read from (the root alias or a declared join alias). */
    from?: string;
    type?: FieldType;
    alias?: string;
    useText?: boolean;
}

export interface OwnsOneOptions {
    /** NetSuite subrecord field id, for example 'shippingaddress'. Never inferred. */
    subrecord: string;
    /** List field cleared before the subrecord can be edited, for example 'shipaddresslist'. */
    clearListField?: string;
    join?: JoinSpec & { alias: string };
    /** Alternative to a join: nested columns live on this existing alias. */
    from?: string;
    fields?: RelationshipFieldMap;
}

export interface OwnsManyOptions {
    /** NetSuite sublist id, for example 'item'. Never inferred. */
    sublist: string;
    matchBy?: string;
    lineNumberProperty?: string;
    join?: JoinSpec & { alias: string };
    from?: string;
    fields?: RelationshipFieldMap;
}

export interface RelatedOptions {
    join?: JoinSpec & { alias: string };
    from?: string;
}

interface NavigationRegistration {
    kind: NavigationKind;
    thunk: EntityClassThunk;
    options: OwnsOneOptions | OwnsManyOptions | RelatedOptions;
}

interface DecoratedClassRegistration {
    metadata: EntityModelMetadata;
    navigations: Map<string, NavigationRegistration>;
    hasEntityDecorator: boolean;
}

const decoratedClasses = new WeakMap<Function, DecoratedClassRegistration>();
const compiledEntityConfigs = new WeakMap<Function, QueryConfig<any>>();

type ClassDecoratorFunction = (target: Function) => void;
type PropertyDecoratorFunction = (target: object, propertyKey: string | symbol) => void;

function getOrCreateRegistration(target: Function): DecoratedClassRegistration {
    let registration = decoratedClasses.get(target);
    if (!registration) {
        registration = { metadata: createEntityModelMetadata(), navigations: new Map(), hasEntityDecorator: false };
        decoratedClasses.set(target, registration);
    }
    return registration;
}

function toPropertyName(target: object, propertyKey: string | symbol): string {
    if (typeof propertyKey !== 'string') {
        throw new Error(`Symbol properties cannot be mapped on '${target.constructor.name}'.`);
    }
    return propertyKey;
}

function propertyDecorator(apply: (property: PropertyMetadata, registration: DecoratedClassRegistration) => void): PropertyDecoratorFunction {
    return (target, propertyKey) => {
        const registration = getOrCreateRegistration(target.constructor);
        apply(getOrCreatePropertyMetadata(registration.metadata.properties, toPropertyName(target, propertyKey)), registration);
    };
}

function toJoinMetadata(alias: string, spec: JoinSpec): JoinMetadata {
    return { alias, table: spec.table, on: spec.on, type: spec.type, from: spec.from, params: spec.params };
}

// ── class decorators ──────────────────────────────────────────────────────────

/** Marks a class as a NetSuite entity. Required on root models; nested classes only need property decorators. */
export function Entity(options: EntityOptions): ClassDecoratorFunction {
    return (target) => {
        const registration = getOrCreateRegistration(target);
        registration.hasEntityDecorator = true;
        registration.metadata.name = target.name;
        registration.metadata.setName = options.setName;
        registration.metadata.recordType = options.recordType;
        registration.metadata.table = { name: options.table, alias: options.alias ?? options.table };
    };
}

/** Declares a join available to @Column({ from: alias }) properties. Repeatable; declaration order is preserved. */
export function Join(alias: string, spec: JoinSpec): ClassDecoratorFunction {
    return (target) => {
        // Class decorators run bottom-up, so insert at the front to keep source order.
        getOrCreateRegistration(target).metadata.joins.unshift(toJoinMetadata(alias, spec));
    };
}

export function UpdaterOptions(options: RecordUpdaterOptions): ClassDecoratorFunction {
    return (target) => {
        getOrCreateRegistration(target).metadata.updaterOptions = options;
    };
}

export function Coerce(enabled = true): ClassDecoratorFunction {
    return (target) => {
        getOrCreateRegistration(target).metadata.coerce = enabled;
    };
}

export function RestMetadata(metadata: RestRecordMetadata): ClassDecoratorFunction {
    return (target) => {
        getOrCreateRegistration(target).metadata.restRecordMetadata = metadata;
    };
}

// ── property decorators ───────────────────────────────────────────────────────

/** Marks the primary key. Defaults to the integer type and the lowercased property name as the column. */
export function Key(options: ColumnOptions = {}): PropertyDecoratorFunction {
    return propertyDecorator((property, registration) => {
        registration.metadata.keyProperty = property.name;
        applyColumnOptions(property, undefined, options);
    });
}

/** Maps a property to a SuiteQL column. Without arguments the column is the lowercased property name. */
export function Column(column?: string, options: ColumnOptions = {}): PropertyDecoratorFunction {
    return propertyDecorator((property) => applyColumnOptions(property, column, options));
}

function applyColumnOptions(property: PropertyMetadata, column: string | undefined, options: ColumnOptions): void {
    if (column !== undefined) property.column = column;
    if (options.from !== undefined) property.tableAlias = options.from;
    if (options.type !== undefined) property.type = options.type;
    if (options.alias !== undefined) property.alias = options.alias;
    if (options.useText !== undefined) property.useText = options.useText;
}

/** Makes a property writable through the given NetSuite record field id. Without an argument the id equals the column. */
export function RecordField(fieldId?: string): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        if (fieldId === undefined) {
            property.recordFieldFollowsColumn = true;
        } else {
            property.recordFieldId = fieldId;
        }
    });
}

export function ReadOnly(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.readOnly = true;
    });
}

export function SetFirst(): PropertyDecoratorFunction {
    return propertyDecorator((property) => {
        property.setFirst = true;
    });
}

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
    return propertyDecorator((property, registration) => {
        registration.metadata.ignoredProperties.add(property.name);
    });
}

function navigationDecorator(kind: NavigationKind, thunk: EntityClassThunk, options: NavigationRegistration['options']): PropertyDecoratorFunction {
    return (target, propertyKey) => {
        const registration = getOrCreateRegistration(target.constructor);
        registration.navigations.set(toPropertyName(target, propertyKey), { kind, thunk, options });
    };
}

/** An owned subrecord (for example a shipping address). The nested class carries its own property decorators. */
export function OwnsOne(target: EntityClassThunk, options: OwnsOneOptions): PropertyDecoratorFunction {
    return navigationDecorator('owned', target, options);
}

/** A sublist collection (for example item lines). The nested class carries its own property decorators. */
export function OwnsMany(target: EntityClassThunk, options: OwnsManyOptions): PropertyDecoratorFunction {
    return navigationDecorator('collection', target, options);
}

/** A read-only related lookup joined for querying only. */
export function Related(target: EntityClassThunk, options: RelatedOptions = {}): PropertyDecoratorFunction {
    return navigationDecorator('related', target, options);
}

// ── metadata resolution ───────────────────────────────────────────────────────

function collectPrototypeChain(entityClass: Function): Function[] {
    const chain: Function[] = [];
    let current: unknown = entityClass;
    while (typeof current === 'function' && current !== Function.prototype) {
        chain.unshift(current);
        current = Object.getPrototypeOf(current);
    }
    return chain;
}

function mergeProperties(target: Map<string, PropertyMetadata>, source: Map<string, PropertyMetadata>): void {
    for (const [name, property] of source) {
        target.set(name, { ...(target.get(name) ?? { name }), ...property });
    }
}

/** Reads the property decorators of a nested class, including inherited ones. */
function collectDecoratedProperties(entityClass: Function): { properties: Map<string, PropertyMetadata>; ignored: Set<string> } {
    const properties = new Map<string, PropertyMetadata>();
    const ignored = new Set<string>();
    for (const constructor of collectPrototypeChain(entityClass)) {
        const registration = decoratedClasses.get(constructor);
        if (registration) {
            mergeProperties(properties, registration.metadata.properties);
            registration.metadata.ignoredProperties.forEach((name) => ignored.add(name));
        }
    }
    return { properties, ignored };
}

function resolveNavigation(metadata: EntityModelMetadata, name: string, registration: NavigationRegistration, ownerName: string): void {
    const nestedClass = registration.thunk();
    const nested = collectDecoratedProperties(nestedClass);
    if (nested.properties.size === 0) {
        throw new Error(`Class '${nestedClass.name}' used by '${ownerName}.${name}' declares no decorated properties.`);
    }

    const navigation = getOrCreateNavigationMetadata(metadata, name, registration.kind);
    navigation.properties = new Map();
    for (const [propertyName, property] of nested.properties) {
        if (!nested.ignored.has(propertyName)) {
            navigation.properties.set(propertyName, { ...property });
        }
    }

    const options = registration.options;
    navigation.join = options.join ? toJoinMetadata(options.join.alias, options.join) : undefined;
    navigation.sourceAlias = options.from;

    if (registration.kind === 'owned') {
        const ownedOptions = options as OwnsOneOptions;
        navigation.subrecordFieldId = ownedOptions.subrecord;
        navigation.clearListFieldId = ownedOptions.clearListField;
        navigation.additionalRelationshipFields = ownedOptions.fields;
    } else if (registration.kind === 'collection') {
        const collectionOptions = options as OwnsManyOptions;
        navigation.sublistId = collectionOptions.sublist;
        navigation.matchByProperty = collectionOptions.matchBy;
        navigation.lineNumberProperty = collectionOptions.lineNumberProperty;
        navigation.additionalRelationshipFields = collectionOptions.fields;
    }
}

/**
 * Builds the model metadata for a decorated class, walking base classes first so subclasses inherit and override.
 * Navigation thunks are resolved here, after every class in the module has been defined.
 */
export function resolveDecoratedEntityMetadata(entityClass: Function): EntityModelMetadata {
    const chain = collectPrototypeChain(entityClass);
    const registrations = chain.map((constructor) => decoratedClasses.get(constructor)).filter((registration): registration is DecoratedClassRegistration => Boolean(registration));

    if (!registrations.some((registration) => registration.hasEntityDecorator)) {
        throw new Error(`Class '${entityClass.name}' is not decorated with @Entity.`);
    }

    const metadata = createEntityModelMetadata(entityClass.name);
    const navigationRegistrations = new Map<string, NavigationRegistration>();

    for (const registration of registrations) {
        const source = cloneEntityModelMetadata(registration.metadata);
        metadata.name = source.name ?? metadata.name;
        metadata.setName = source.setName ?? metadata.setName;
        metadata.recordType = source.recordType ?? metadata.recordType;
        metadata.table = source.table ?? metadata.table;
        metadata.keyProperty = source.keyProperty ?? metadata.keyProperty;
        metadata.updaterOptions = source.updaterOptions ?? metadata.updaterOptions;
        metadata.coerce = source.coerce ?? metadata.coerce;
        metadata.restRecordMetadata = source.restRecordMetadata ?? metadata.restRecordMetadata;
        metadata.joins.push(...source.joins);
        mergeProperties(metadata.properties, source.properties);
        source.ignoredProperties.forEach((name) => metadata.ignoredProperties.add(name));
        for (const [name, navigation] of registration.navigations) {
            navigationRegistrations.set(name, navigation);
        }
    }

    for (const [name, registration] of navigationRegistrations) {
        resolveNavigation(metadata, name, registration, entityClass.name);
    }

    return metadata;
}

export function isEntityClass(value: unknown): value is EntityClass {
    return typeof value === 'function' && decoratedClasses.has(value);
}

/** True only for classes carrying @Entity somewhere in their prototype chain (nested classes are excluded). */
export function isRootEntityClass(value: unknown): value is EntityClass {
    return isEntityClass(value) && collectPrototypeChain(value).some((constructor) => decoratedClasses.get(constructor)?.hasEntityDecorator === true);
}

/** Compiles a decorated class into the QueryConfig the runtime consumes. Results are cached per class. */
export function configFromEntity<T>(entityClass: EntityClass<T>): QueryConfig<T> {
    const cached = compiledEntityConfigs.get(entityClass);
    if (cached) {
        return cached as QueryConfig<T>;
    }

    const config = compileEntityModel<T>(resolveDecoratedEntityMetadata(entityClass));
    compiledEntityConfigs.set(entityClass, config);
    return config;
}
