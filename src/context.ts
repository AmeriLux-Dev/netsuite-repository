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

/** A schema maps record set names to anything a model can be resolved from: raw configs or generated configs. */
export type ContextSchema = Record<string, QueryConfigSource<any, any>>;

export interface RecordSetOptions {
    /** Name used by the change tracker; defaults to the record type. */
    name?: string;
    changeTracker?: ChangeTracker;
}

/**
 * A reusable, composable query predicate (the EF specification pattern): a function that narrows a query.
 * Repositories accept any number of them, so `db.salesOrders.list(forCustomer(12), open())` reads as a sentence.
 */
export type Specification<TResult> = (query: QueryBuilder<TResult>) => QueryBuilder<TResult>;

export function applySpecifications<TResult>(builder: QueryBuilder<TResult>, specifications: Specification<TResult>[]): QueryBuilder<TResult> {
    return specifications.reduce((current, specification) => specification(current), builder);
}

/**
 * The record set of one record type on a context: the repository (EF DbSet). Reads go through `query()` or the
 * specification methods, writes through change tracking (`add`, `remove`, mutate, then `context.saveChanges()`)
 * or the explicit updater methods. Generated `<Model>RepositoryBase` classes extend it; subclass those for domain queries.
 */
export class RecordSet<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    private readonly config: QueryConfig<TResult>;
    readonly name: string;
    readonly changeTracker: ChangeTracker;

    constructor(source: QueryConfigSource<TResult>, options: RecordSetOptions = {}) {
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

    /** Every record matching the specifications; every record of the set when there are none. */
    list(...specifications: Specification<TResult>[]): TResult[] {
        return applySpecifications(this.query(), specifications).executeTyped();
    }

    all(): TResult[] {
        return this.list();
    }

    /** The first record matching the specifications. On a model with a sublist every matching row is read so the record comes back whole. */
    first(...specifications: Specification<TResult>[]): TResult | null {
        return this.firstRecord(applySpecifications(this.query(), specifications));
    }

    count(...specifications: Specification<TResult>[]): number {
        return applySpecifications(this.query(), specifications).count();
    }

    exists(...specifications: Specification<TResult>[]): boolean {
        return applySpecifications(this.query(), specifications).exists();
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
        return this.firstRecord(this.query().where(this.getPrimaryFieldKey(), '=', id));
    }

    /** A one-row SQL limit would cut a record with a sublist down to its first line, so those models read every row and keep the first record. */
    private firstRecord(builder: QueryBuilder<TResult>): TResult | null {
        return this.hasSublist() ? builder.executeTyped()[0] ?? null : builder.firstTyped();
    }

    private hasSublist(): boolean {
        return Object.values(this.config.relationships ?? {}).some((relationship) => relationship.kind === 'sublist')
            || Object.values(this.config.fields).some((field) => field.cardinality === 'many');
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

/** A record set class the context can construct in place of the plain RecordSet: a generated base or a subclass of one. */
export type RecordSetConstructor<TResult> = new (source: QueryConfigSource<TResult>, options?: RecordSetOptions) => RecordSet<TResult, any>;

/** Repository classes per set name; any set left out is a plain RecordSet. */
export type RepositoryMap<TSchema extends ContextSchema> = {
    readonly [K in keyof TSchema]?: RecordSetConstructor<QueryConfigSourceResult<TSchema[K]>>;
};

/** Overrides layered over generated defaults: a registered subclass wins, every other set keeps its generated base. */
export type MergeRepositories<TDefaults, TOverrides> = Omit<TDefaults, keyof TOverrides> & TOverrides;

type ResolvedRecordSet<TSchema extends ContextSchema, TRepositories, K extends keyof TSchema> =
    K extends keyof TRepositories
        ? NonNullable<TRepositories[K]> extends new (...args: any[]) => infer TInstance
            ? TInstance
            : RecordSet<QueryConfigSourceResult<TSchema[K]>>
        : RecordSet<QueryConfigSourceResult<TSchema[K]>>;

export type RecordSets<TSchema extends ContextSchema, TRepositories extends RepositoryMap<TSchema> = {}> = {
    readonly [K in keyof TSchema]: ResolvedRecordSet<TSchema, TRepositories, K>;
};

export interface ContextFactoryOptions<TRepositories> extends NetSuiteContextOptions {
    /** Repository classes to construct for the named sets, typed so the context exposes the subclass. */
    repositories?: TRepositories;
}

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

/** The unit of work (EF DbContext): one record set per schema entry, one change tracker, saveChanges(). */
export class NetSuiteContext<TSchema extends ContextSchema, TRepositories extends RepositoryMap<TSchema> = {}> {
    readonly entities: RecordSets<TSchema, TRepositories>;
    readonly options: NetSuiteContextOptions;
    readonly changeTracker: ChangeTracker;

    constructor(private readonly schema: TSchema, options: ContextFactoryOptions<TRepositories> = {}) {
        const { repositories, ...contextOptions } = options;
        this.options = { tracking: true, ...contextOptions };
        this.changeTracker = new ChangeTracker((setName) => this.recordSet(setName).metadata as QueryConfig<unknown>, this.options.tracking !== false);
        this.entities = this.createRecordSets(schema, repositories);
    }

    set<K extends keyof TSchema & string>(name: K): RecordSets<TSchema, TRepositories>[K] {
        return this.recordSet(name) as RecordSets<TSchema, TRepositories>[K];
    }

    has(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.schema, name);
    }

    /** Returns the schema entry as registered: a raw config or a generated config. */
    getConfig<K extends keyof TSchema & string>(name: K): TSchema[K] {
        const config = this.schema[name];
        if (!config) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return config;
    }

    attach<K extends keyof TSchema & string>(setName: K, entity: QueryConfigSourceResult<TSchema[K]> & object): EntityEntry<QueryConfigSourceResult<TSchema[K]> & object> {
        return this.recordSet(setName).attach(entity) as EntityEntry<QueryConfigSourceResult<TSchema[K]> & object>;
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

    /** The set by name, untyped, for the tracker and the save loop. */
    private recordSet(name: string): RecordSet<unknown> {
        const recordSet = (this.entities as unknown as Record<string, RecordSet<unknown> | undefined>)[name];
        if (!recordSet) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return recordSet;
    }

    private orderedChanges(): ChangeSet {
        const changeSet = this.changeTracker.detectChanges();
        const entries = saveOrder.flatMap((state) => changeSet.entries.filter((entry) => entry.state === state));
        return { entries, hasChanges: entries.length > 0 };
    }

    private buildUpdater(entry: ChangeSetEntry): RecordUpdater<unknown, Record<string, unknown>> | undefined {
        const config = this.recordSet(entry.setName).metadata as QueryConfig<unknown>;
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
            const deleted = deleteRecord(this.recordSet(entry.setName).metadata, entry.key);
            return { success: deleted.success, id: deleted.id, error: deleted.error };
        }
        if (entry.state === EntityState.Modified && entry.key === undefined) {
            return { success: false, error: 'Cannot update an entity without a key value.' };
        }
        return (this.buildUpdater(entry) as RecordUpdater<unknown, Record<string, unknown>>).submit();
    }

    private createRecordSets(schema: TSchema, repositories: TRepositories | undefined): RecordSets<TSchema, TRepositories> {
        const sets: Record<string, RecordSet<unknown>> = {};
        const constructors = (repositories ?? {}) as Record<string, RecordSetConstructor<unknown> | undefined>;
        for (const [name, source] of Object.entries(schema)) {
            const Repository = constructors[name] ?? RecordSet;
            sets[name] = new Repository(source, { name, changeTracker: this.changeTracker });
        }
        return sets as unknown as RecordSets<TSchema, TRepositories>;
    }
}

export type NetSuiteContextInstance<TSchema extends ContextSchema, TRepositories extends RepositoryMap<TSchema> = {}> = NetSuiteContext<TSchema, TRepositories> & RecordSets<TSchema, TRepositories>;

/** Builds a context whose record sets are also properties (`db.salesOrders`); `repositories` swaps in subclasses per set. */
export function createNetSuiteContext<TSchema extends ContextSchema, TRepositories extends RepositoryMap<TSchema> = {}>(schema: TSchema, options?: ContextFactoryOptions<TRepositories>): NetSuiteContextInstance<TSchema, TRepositories> {
    const context = new NetSuiteContext<TSchema, TRepositories>(schema, options) as NetSuiteContextInstance<TSchema, TRepositories>;
    for (const [name, recordSet] of Object.entries(context.entities)) {
        Object.defineProperty(context, name, {
            value: recordSet,
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    return context;
}
