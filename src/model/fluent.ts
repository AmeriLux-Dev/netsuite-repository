import type {
    CompositeModelMapping,
    FieldType,
    FieldUpdateMapping,
    QueryConfig,
    QueryField,
    RecordUpdaterOptions,
    RelationshipFieldMap,
    RestRecordMetadata,
} from '../types';
import { compileEntityModel } from './compile';
import { resolveDecoratedEntityMetadata } from './decorators';
import type { EntityClass, JoinSpec } from './decorators';
import {
    cloneEntityModelMetadata,
    createEntityModelMetadata,
    getOrCreateNavigationMetadata,
    getOrCreatePropertyMetadata,
} from './metadata';
import type { EntityModelMetadata, NavigationMetadata, PropertyMetadata } from './metadata';

export type PropertyName<T> = keyof T & string;
export type ElementOf<T> = T extends ReadonlyArray<infer TElement> ? TElement : never;

interface PropertyScope<T> {
    property<K extends PropertyName<T>>(name: K): PropertyBuilder<T, K, this>;
}

/** Configures one scalar property. `end()` returns to the owning builder; `property()` jumps to a sibling. */
export class PropertyBuilder<T, K extends PropertyName<T>, TParent extends PropertyScope<T>> {
    constructor(private readonly propertyMetadata: PropertyMetadata, private readonly parent: TParent) {}

    hasColumn(column: string, tableAlias?: string): this {
        this.propertyMetadata.column = column;
        if (tableAlias !== undefined) {
            this.propertyMetadata.tableAlias = tableAlias;
        }
        return this;
    }

    fromAlias(tableAlias: string): this {
        this.propertyMetadata.tableAlias = tableAlias;
        return this;
    }

    hasAlias(resultAlias: string): this {
        this.propertyMetadata.alias = resultAlias;
        return this;
    }

    hasType(type: FieldType): this {
        this.propertyMetadata.type = type;
        return this;
    }

    /** Opts the property into writes. Without an argument the record field id equals the column. */
    hasRecordField(fieldId?: string): this {
        if (fieldId === undefined) {
            this.propertyMetadata.recordFieldFollowsColumn = true;
        } else {
            this.propertyMetadata.recordFieldId = fieldId;
        }
        return this;
    }

    isReadOnly(): this {
        this.propertyMetadata.readOnly = true;
        return this;
    }

    setFirst(): this {
        this.propertyMetadata.setFirst = true;
        return this;
    }

    useText(): this {
        this.propertyMetadata.useText = true;
        return this;
    }

    excludeFromDefaultSelect(): this {
        this.propertyMetadata.selectByDefault = false;
        return this;
    }

    coerce(enabled: boolean): this {
        this.propertyMetadata.coerce = enabled;
        return this;
    }

    transform(transform: NonNullable<QueryField['transform']>): this {
        this.propertyMetadata.transform = transform;
        return this;
    }

    hasUpdateMapping(mapping: FieldUpdateMapping): this {
        this.propertyMetadata.updateMapping = mapping;
        return this;
    }

    property<K2 extends PropertyName<T>>(name: K2): PropertyBuilder<T, K2, TParent> {
        return this.parent.property(name);
    }

    end(): TParent {
        return this.parent;
    }
}

/** Shared surface for owned, collection, and related navigations. */
export class NavigationBuilder<TNested> implements PropertyScope<TNested> {
    constructor(protected readonly navigation: NavigationMetadata) {}

    viaJoin(alias: string, spec: JoinSpec): this {
        this.navigation.join = { alias, table: spec.table, on: spec.on, type: spec.type, from: spec.from, params: spec.params };
        return this;
    }

    /** Nested columns live on an existing alias instead of their own join. */
    fromAlias(alias: string): this {
        this.navigation.sourceAlias = alias;
        return this;
    }

    withRelationshipFields(fields: RelationshipFieldMap): this {
        this.navigation.additionalRelationshipFields = { ...(this.navigation.additionalRelationshipFields ?? {}), ...fields };
        return this;
    }

    property<K extends PropertyName<TNested>>(name: K): PropertyBuilder<TNested, K, this> {
        return new PropertyBuilder<TNested, K, this>(getOrCreatePropertyMetadata(this.navigation.properties, name), this);
    }
}

export class OwnedNavigationBuilder<TNested> extends NavigationBuilder<TNested> {
    /** NetSuite subrecord field id, never inferred. */
    toSubrecord(subrecordFieldId: string): this {
        this.navigation.subrecordFieldId = subrecordFieldId;
        return this;
    }

    clearListField(listFieldId: string): this {
        this.navigation.clearListFieldId = listFieldId;
        return this;
    }
}

export class CollectionNavigationBuilder<TLine> extends NavigationBuilder<TLine> {
    /** NetSuite sublist id, never inferred. */
    toSublist(sublistId: string): this {
        this.navigation.sublistId = sublistId;
        return this;
    }

    matchBy<K extends PropertyName<TLine>>(property: K): this {
        this.navigation.matchByProperty = property;
        return this;
    }

    lineNumberProperty<K extends PropertyName<TLine>>(property: K): this {
        this.navigation.lineNumberProperty = property;
        return this;
    }
}

export class RelatedNavigationBuilder<TNested> extends NavigationBuilder<TNested> {}

/** Fluent configuration for one entity. Writes the same metadata the decorators produce. */
export class EntityTypeBuilder<T> implements PropertyScope<T> {
    constructor(readonly metadata: EntityModelMetadata) {}

    toRecord(recordType: string): this {
        this.metadata.recordType = recordType;
        return this;
    }

    toTable(name: string, alias: string = name): this {
        this.metadata.table = { name, alias };
        return this;
    }

    hasSetName(setName: string): this {
        this.metadata.setName = setName;
        return this;
    }

    hasKey<K extends PropertyName<T>>(property: K): this {
        this.metadata.keyProperty = property;
        getOrCreatePropertyMetadata(this.metadata.properties, property);
        return this;
    }

    property<K extends PropertyName<T>>(name: K): PropertyBuilder<T, K, this> {
        return new PropertyBuilder<T, K, this>(getOrCreatePropertyMetadata(this.metadata.properties, name), this);
    }

    ignore<K extends PropertyName<T>>(name: K): this {
        this.metadata.ignoredProperties.add(name);
        return this;
    }

    hasJoin(alias: string, spec: JoinSpec): this {
        const existingIndex = this.metadata.joins.findIndex((join) => join.alias === alias);
        const join = { alias, table: spec.table, on: spec.on, type: spec.type, from: spec.from, params: spec.params };
        if (existingIndex >= 0) {
            this.metadata.joins[existingIndex] = join;
        } else {
            this.metadata.joins.push(join);
        }
        return this;
    }

    ownsOne<K extends PropertyName<T>>(name: K, configure: (builder: OwnedNavigationBuilder<NonNullable<T[K]>>) => void): this {
        configure(new OwnedNavigationBuilder<NonNullable<T[K]>>(getOrCreateNavigationMetadata(this.metadata, name, 'owned')));
        return this;
    }

    ownsMany<K extends PropertyName<T>>(name: K, configure: (builder: CollectionNavigationBuilder<ElementOf<NonNullable<T[K]>>>) => void): this {
        configure(new CollectionNavigationBuilder<ElementOf<NonNullable<T[K]>>>(getOrCreateNavigationMetadata(this.metadata, name, 'collection')));
        return this;
    }

    hasRelated<K extends PropertyName<T>>(name: K, configure: (builder: RelatedNavigationBuilder<NonNullable<T[K]>>) => void): this {
        configure(new RelatedNavigationBuilder<NonNullable<T[K]>>(getOrCreateNavigationMetadata(this.metadata, name, 'related')));
        return this;
    }

    updaterOptions(options: RecordUpdaterOptions): this {
        this.metadata.updaterOptions = { ...(this.metadata.updaterOptions ?? {}), ...options };
        return this;
    }

    coerce(enabled: boolean): this {
        this.metadata.coerce = enabled;
        return this;
    }

    hasRestMetadata(metadata: RestRecordMetadata): this {
        this.metadata.restRecordMetadata = metadata;
        return this;
    }

    hasComposite(mapping: CompositeModelMapping): this {
        this.metadata.composite = mapping;
        return this;
    }

    postProcess(callback: (result: T) => T): this {
        this.metadata.postProcess = callback as (result: unknown) => unknown;
        return this;
    }
}

export type EntityModelConfigure<T> = (builder: EntityTypeBuilder<T>) => void;

/** A reusable, composable model description produced by defineModel() or extendModel(). */
export interface EntityModelDefinition<T> {
    readonly kind: 'entityModel';
    /** Builds fresh metadata by replaying every configure step. */
    buildMetadata(): EntityModelMetadata;
    /** Compiles to the runtime QueryConfig. Cached after the first call. */
    compile(): QueryConfig<T>;
    /** Phantom member so the result type can be inferred from a definition value. */
    readonly __result?: T;
}

function createDefinition<T>(seed: () => EntityModelMetadata, steps: EntityModelConfigure<T>[]): EntityModelDefinition<T> {
    let compiled: QueryConfig<T> | undefined;
    const definition: EntityModelDefinition<T> = {
        kind: 'entityModel',
        buildMetadata() {
            const metadata = seed();
            const builder = new EntityTypeBuilder<T>(metadata);
            for (const step of steps) {
                step(builder);
            }
            return metadata;
        },
        compile() {
            if (!compiled) {
                compiled = compileEntityModel<T>(definition.buildMetadata());
            }
            return compiled;
        },
    };
    return definition;
}

const definitionSteps = new WeakMap<EntityModelDefinition<any>, { seed: () => EntityModelMetadata; steps: EntityModelConfigure<any>[] }>();

function registerDefinition<T>(seed: () => EntityModelMetadata, steps: EntityModelConfigure<T>[]): EntityModelDefinition<T> {
    const definition = createDefinition(seed, steps);
    definitionSteps.set(definition, { seed, steps });
    return definition;
}

/** Describes a model with the fluent API against a hand-written interface. */
export function defineModel<T>(configure: EntityModelConfigure<T>): EntityModelDefinition<T> {
    return registerDefinition<T>(() => createEntityModelMetadata(), [configure]);
}

/** Layers additional fluent configuration over a decorated class. Fluent calls override the decorators. */
export function modelFromEntity<T>(entityClass: EntityClass<T>, configure?: EntityModelConfigure<T>): EntityModelDefinition<T> {
    return registerDefinition<T>(() => cloneEntityModelMetadata(resolveDecoratedEntityMetadata(entityClass)), configure ? [configure] : []);
}

/** Creates a new definition that replays the base steps and then the override. The base is untouched. */
export function extendModel<T>(base: EntityModelDefinition<T>, configure: EntityModelConfigure<T>): EntityModelDefinition<T> {
    const registration = definitionSteps.get(base);
    if (!registration) {
        throw new Error('extendModel() requires a definition created by defineModel(), modelFromEntity(), or extendModel().');
    }
    return registerDefinition<T>(registration.seed, [...registration.steps, configure]);
}

export function isEntityModelDefinition(value: unknown): value is EntityModelDefinition<unknown> {
    return Boolean(value) && typeof value === 'object' && (value as { kind?: unknown }).kind === 'entityModel' && typeof (value as { compile?: unknown }).compile === 'function';
}
