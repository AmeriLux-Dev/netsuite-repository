import { normalizeQueryConfig } from './types';
import type { QueryConfig, QueryConfigInput, QueryOperator, QueryParamValue, ConfigResult, EntitySchema, RecordGraphPatch, RecordId, UpdateResult } from './types';
import { QueryBuilder, query } from './query';
import { RecordUpdater, updateRecord } from './record-updater';

export class EntitySet<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    private readonly config: QueryConfig<TResult>;

    constructor(config: QueryConfig<TResult> | QueryConfigInput<TResult>) {
        this.config = normalizeQueryConfig(config);
    }

    get recordType(): string {
        return this.config.recordType;
    }

    get metadata(): QueryConfig<TResult> {
        return this.config;
    }

    query(): QueryBuilder<TResult> {
        return query(this.config);
    }

    all(): TResult[] {
        return this.query().executeTyped();
    }

    first(): TResult | null {
        return this.query().firstTyped();
    }

    where(field: keyof TResult | string, operator: QueryOperator, value?: QueryParamValue | QueryParamValue[]): QueryBuilder<TResult> {
        return this.query().where(field, operator, value);
    }

    find(id: RecordId): TResult | null {
        return this.query().where(this.getPrimaryFieldKey(), '=', id).firstTyped();
    }

    update(id: RecordId): RecordUpdater<TResult, TUpdate> {
        return updateRecord<TResult, TUpdate>(this.config).id(id);
    }

    submit(id: RecordId, values: Partial<TUpdate> | Record<string, unknown>): UpdateResult {
        return this.submitPatch(id, values as RecordGraphPatch<TUpdate>);
    }

    submitPatch(id: RecordId, patch: RecordGraphPatch<TUpdate>): UpdateResult {
        return this.update(id).patch(patch).submit();
    }

    private getPrimaryFieldKey(): string {
        for (const [key, field] of Object.entries(this.config.fields)) {
            if (field.isPrimary) {
                return key;
            }
        }
        throw new Error(`No primary field is configured for '${this.config.recordType}'.`);
    }
}

export type EntitySets<TSchema extends EntitySchema> = {
    readonly [K in keyof TSchema]: EntitySet<ConfigResult<TSchema[K]>>;
};

export class NetSuiteContext<TSchema extends EntitySchema> {
    readonly entities: EntitySets<TSchema>;

    constructor(private readonly schema: TSchema) {
        this.entities = this.createEntitySets(schema);
    }

    set<K extends keyof TSchema & string>(name: K): EntitySet<ConfigResult<TSchema[K]>> {
        const entitySet = this.entities[name];
        if (!entitySet) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return entitySet;
    }

    has(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.schema, name);
    }

    getConfig<K extends keyof TSchema & string>(name: K): TSchema[K] {
        const config = this.schema[name];
        if (!config) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return config;
    }

    private createEntitySets(schema: TSchema): EntitySets<TSchema> {
        const sets: Partial<EntitySets<TSchema>> = {};
        for (const [name, config] of Object.entries(schema)) {
            sets[name as keyof TSchema] = new EntitySet(config) as EntitySets<TSchema>[keyof TSchema];
        }
        return sets as EntitySets<TSchema>;
    }
}

export type NetSuiteContextInstance<TSchema extends EntitySchema> = NetSuiteContext<TSchema> & EntitySets<TSchema>;

export function createNetSuiteContext<TSchema extends EntitySchema>(schema: TSchema): NetSuiteContextInstance<TSchema> {
    const context = new NetSuiteContext(schema) as NetSuiteContextInstance<TSchema>;
    for (const [name, entitySet] of Object.entries(context.entities)) {
        Object.defineProperty(context, name, {
            value: entitySet,
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    return context;
}