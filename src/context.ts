import type { DeleteResult, QueryConfig, QueryOperator, QueryParamValue, RecordGraphPatch, RecordId, RecordUpdaterOptions, UpdatePlan, UpdateResult } from './types';
import { QueryBuilder, query } from './query';
import { RecordUpdater, createRecord, deleteRecord, updateRecord } from './record-updater';
import { resolveQueryConfig } from './model/resolve';
import type { QueryConfigSource, QueryConfigSourceResult } from './model/resolve';
import { ChangeTracker, EntityState } from './tracking/change-tracker';
import type { ChangeSet, ChangeSetEntry, EntityEntry } from './tracking/change-tracker';

export interface NetSuiteContextOptions {
    /** When false, queries never register entities and saveChanges() has nothing to save. Defaults to true. */
    tracking?: boolean;
}

/** A schema maps entity set names to anything a model can be resolved from: raw configs, decorated classes, or fluent definitions. */
export type ContextSchema = Record<string, QueryConfigSource<any, any>>;

export interface EntitySetOptions {
    /** Name used by the change tracker; defaults to the record type. */
    name?: string;
    changeTracker?: ChangeTracker;
}

export class EntitySet<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    private readonly config: QueryConfig<TResult>;
    readonly name: string;
    readonly changeTracker: ChangeTracker;

    constructor(source: QueryConfigSource<TResult>, options: EntitySetOptions = {}) {
        this.config = resolveQueryConfig(source);
        this.name = options.name ?? this.config.recordType;
        this.changeTracker = options.changeTracker ?? new ChangeTracker(() => this.config as QueryConfig<unknown>);
    }

    get recordType(): string {
        return this.config.recordType;
    }

    get metadata(): QueryConfig<TResult> {
        return this.config;
    }

    /** A tracked query: typed results are registered with the change tracker. */
    query(): QueryBuilder<TResult> {
        return query(this.config, { resultObserver: (results) => this.changeTracker.trackQueryResults(this.name, results as unknown as object[]) as unknown as TResult[] });
    }

    /** A query whose results are never tracked (EF AsNoTracking). Prefer it for reporting reads. */
    asNoTracking(): QueryBuilder<TResult> {
        return this.query().asNoTracking();
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

    /** Returns the tracked instance when the key is already loaded, otherwise queries NetSuite (EF Find). */
    find(id: RecordId): TResult | null {
        const tracked = this.changeTracker.findTracked<TResult & object>(this.name, id);
        if (tracked) {
            return tracked;
        }
        return this.query().where(this.getPrimaryFieldKey(), '=', id).firstTyped();
    }

    /** Starts tracking an existing entity as Unchanged. */
    attach(entity: TResult & object): EntityEntry<TResult & object> {
        return this.changeTracker.attach(this.name, entity);
    }

    /** Tracks a new entity; saveChanges() creates it. */
    add(entity: TResult & object): EntityEntry<TResult & object> {
        return this.changeTracker.add(this.name, entity);
    }

    /** Marks an entity or key for deletion; saveChanges() deletes it. */
    remove(entityOrId: (TResult & object) | RecordId): EntityEntry<TResult & object> {
        return this.changeTracker.remove(this.name, entityOrId);
    }

    entry(entity: TResult & object): EntityEntry<TResult & object> | undefined {
        return this.changeTracker.entry(entity);
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

    /** A create-mode updater: stage values, then submit() calls record.create and record.save. */
    create(): RecordUpdater<TResult, TUpdate> {
        return createRecord<TResult, TUpdate>(this.config);
    }

    /** Creates a record from a graph patch in one call. */
    createRecord(patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult {
        const updater = this.create();
        if (options) {
            updater.withOptions(options);
        }
        return updater.patch(patch).submit();
    }

    delete(id: RecordId): DeleteResult {
        return deleteRecord(this.config, id);
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

export type EntitySets<TSchema extends ContextSchema> = {
    readonly [K in keyof TSchema]: EntitySet<QueryConfigSourceResult<TSchema[K]>>;
};

export interface SaveChangesOptions {
    /** Skip the remaining entities after the first failure. Defaults to true. */
    stopOnFirstFailure?: boolean;
    /** Re-snapshot entities that saved successfully. Defaults to true. */
    acceptChangesOnSuccess?: boolean;
}

export interface EntitySaveResult {
    setName: string;
    state: EntityState;
    key?: RecordId;
    entity: object;
    result: UpdateResult;
}

export interface SaveChangesResult {
    success: boolean;
    savedCount: number;
    failedCount: number;
    skippedCount: number;
    results: EntitySaveResult[];
}

export interface PlannedChange extends ChangeSetEntry {
    /** RecordUpdater plan for Added and Modified entries; computed without NetSuite calls. */
    plan?: UpdatePlan;
}

const saveOrder: EntityState[] = [EntityState.Added, EntityState.Modified, EntityState.Deleted];

export class NetSuiteContext<TSchema extends ContextSchema> {
    readonly entities: EntitySets<TSchema>;
    readonly options: NetSuiteContextOptions;
    readonly changeTracker: ChangeTracker;

    constructor(private readonly schema: TSchema, options: NetSuiteContextOptions = {}) {
        this.options = { tracking: true, ...options };
        this.changeTracker = new ChangeTracker((setName) => this.set(setName as keyof TSchema & string).metadata as QueryConfig<unknown>, this.options.tracking !== false);
        this.entities = this.createEntitySets(schema);
    }

    set<K extends keyof TSchema & string>(name: K): EntitySet<QueryConfigSourceResult<TSchema[K]>> {
        const entitySet = this.entities[name];
        if (!entitySet) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return entitySet;
    }

    has(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.schema, name);
    }

    /** Returns the schema entry as registered: a raw config, a decorated class, or a fluent definition. */
    getConfig<K extends keyof TSchema & string>(name: K): TSchema[K] {
        const config = this.schema[name];
        if (!config) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return config;
    }

    attach<K extends keyof TSchema & string>(setName: K, entity: QueryConfigSourceResult<TSchema[K]> & object): EntityEntry<QueryConfigSourceResult<TSchema[K]> & object> {
        return this.set(setName).attach(entity);
    }

    entry<T extends object>(entity: T): EntityEntry<T> | undefined {
        return this.changeTracker.entry(entity);
    }

    detach(entity: object): void {
        this.changeTracker.detach(entity);
    }

    /** Diffs every tracked entity and returns what saveChanges() would do, with updater plans and no NetSuite calls. */
    planChanges(): { entries: PlannedChange[]; hasChanges: boolean } {
        const changeSet = this.orderedChanges();
        return {
            hasChanges: changeSet.hasChanges,
            entries: changeSet.entries.map((entry) => ({ ...entry, plan: this.buildUpdater(entry)?.plan() })),
        };
    }

    /** Saves Added, then Modified, then Deleted entities through the record updater. Never throws for NetSuite failures. */
    saveChanges(options: SaveChangesOptions = {}): SaveChangesResult {
        const { stopOnFirstFailure = true, acceptChangesOnSuccess = true } = options;
        const changeSet = this.orderedChanges();
        const results: EntitySaveResult[] = [];
        let failed = false;

        for (const entry of changeSet.entries) {
            if (failed && stopOnFirstFailure) {
                results.push({ setName: entry.setName, state: entry.state, key: entry.key, entity: entry.entity, result: { success: false, error: 'Skipped because an earlier entity failed to save.' } });
                continue;
            }
            const result = this.saveEntry(entry);
            results.push({ setName: entry.setName, state: entry.state, key: entry.key, entity: entry.entity, result });
            if (!result.success) {
                failed = true;
            }
        }

        if (acceptChangesOnSuccess) {
            this.changeTracker.acceptChanges(results.filter((saved) => saved.result.success).map((saved) => ({ entity: saved.entity, assignedKey: saved.state === EntityState.Added ? saved.result.id : undefined })));
        }

        const savedCount = results.filter((saved) => saved.result.success).length;
        const skippedCount = results.filter((saved) => saved.result.error === 'Skipped because an earlier entity failed to save.').length;
        return { success: !failed, savedCount, failedCount: results.length - savedCount - skippedCount, skippedCount, results };
    }

    private orderedChanges(): ChangeSet {
        const changeSet = this.changeTracker.detectChanges();
        const entries = saveOrder.flatMap((state) => changeSet.entries.filter((entry) => entry.state === state));
        return { entries, hasChanges: entries.length > 0 };
    }

    private buildUpdater(entry: ChangeSetEntry): RecordUpdater<unknown, Record<string, unknown>> | undefined {
        const config = this.set(entry.setName as keyof TSchema & string).metadata as QueryConfig<unknown>;
        if (entry.state === EntityState.Added) {
            return createRecord<unknown, Record<string, unknown>>(config).patch(entry.patch ?? {});
        }
        if (entry.state === EntityState.Modified) {
            return updateRecord<unknown, Record<string, unknown>>(config).id(entry.key as RecordId).patch(entry.patch ?? {});
        }
        return undefined;
    }

    private saveEntry(entry: ChangeSetEntry): UpdateResult {
        if (entry.state === EntityState.Deleted) {
            if (entry.key === undefined) {
                return { success: false, error: 'Cannot delete an entity without a key value.' };
            }
            const deleted = deleteRecord(this.set(entry.setName as keyof TSchema & string).metadata, entry.key);
            return { success: deleted.success, id: deleted.id, error: deleted.error };
        }
        if (entry.state === EntityState.Modified && entry.key === undefined) {
            return { success: false, error: 'Cannot update an entity without a key value.' };
        }
        return (this.buildUpdater(entry) as RecordUpdater<unknown, Record<string, unknown>>).submit();
    }

    private createEntitySets(schema: TSchema): EntitySets<TSchema> {
        const sets: Partial<EntitySets<TSchema>> = {};
        for (const [name, source] of Object.entries(schema)) {
            sets[name as keyof TSchema] = new EntitySet(source, { name, changeTracker: this.changeTracker }) as EntitySets<TSchema>[keyof TSchema];
        }
        return sets as EntitySets<TSchema>;
    }
}

export type NetSuiteContextInstance<TSchema extends ContextSchema> = NetSuiteContext<TSchema> & EntitySets<TSchema>;

export function createNetSuiteContext<TSchema extends ContextSchema>(schema: TSchema, options?: NetSuiteContextOptions): NetSuiteContextInstance<TSchema> {
    const context = new NetSuiteContext(schema, options) as NetSuiteContextInstance<TSchema>;
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
