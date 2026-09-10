import type { DeleteResult, EntityCreate, EntityPatch, QueryConfig, RecordGraphPatch, RecordId, RecordUpdaterOptions, UpdatePlan, UpdateResult } from './types';
import { QueryBuilder, query } from './query';
import type { ConditionValue, FieldPath, FieldValue, OperatorFor } from './field-path';
import { RecordUpdater, createRecord, deleteRecord, updateRecord } from './record-updater';
import { resolveQueryConfig } from './model/resolve';
import type { QueryConfigSource, QueryConfigSourceResult } from './model/resolve';
import { ChangeTracker, EntityState } from './tracking/change-tracker';
import type { ChangeSet, ChangeSetEntry, EntityEntry } from './tracking/change-tracker';
import { applyEntityPatch } from './tracking/apply-patch';

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

// ── plans, results, errors ───────────────────────────────────────────────────

export interface PlannedChange extends ChangeSetEntry {
    /** RecordUpdater plan for Added and Modified entries; computed without NetSuite calls. */
    plan?: UpdatePlan;
}

/** What saveChanges() would do: one entry per entity that has changes, in save order. */
export interface ChangePlan {
    entries: PlannedChange[];
    hasChanges: boolean;
}

export interface PlanChangesOptions {
    /** Plan only these tracked entities; every other pending change is left alone. */
    entities?: object[];
    /** Record updater options for every plan built, layered over the model's defaults. */
    updaterOptions?: RecordUpdaterOptions;
}

export interface SaveChangesOptions extends PlanChangesOptions {
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

/** Options of the record set's one-call writes: `create()`, `update()`, and `delete()`. */
export interface WriteOptions {
    /** Sees the plan before anything is written. Throw to abort with nothing saved; the entity keeps its pending changes. */
    beforeSave?: (plan: ChangePlan) => void;
    /** Record updater options for this write (requireFastPath, maxRecordCalls, ...), layered over the model's defaults. */
    updater?: RecordUpdaterOptions;
}

/** Thrown by `getById()` and `update()` when no record has the id. */
export class RecordNotFoundError extends Error {
    constructor(readonly recordType: string, readonly id: RecordId) {
        super(`No '${recordType}' record has id ${String(id)}.`);
        this.name = 'RecordNotFoundError';
    }
}

/** Thrown by the record set's one-call writes when NetSuite rejects the save; `result` carries every entity's outcome. */
export class SaveChangesError extends Error {
    constructor(readonly result: SaveChangesResult) {
        super(describeSaveFailures(result));
        this.name = 'SaveChangesError';
    }
}

const skippedAfterFailureMessage = 'Skipped because an earlier entity failed to save.';

function describeSaveFailures(result: SaveChangesResult): string {
    const failures = result.results
        .filter((saved) => !saved.result.success && saved.result.error !== skippedAfterFailureMessage)
        .map((saved) => `${saved.setName}${saved.key !== undefined ? ` ${String(saved.key)}` : ''}: ${saved.result.error ?? 'failed'}`);
    return failures.length > 0 ? failures.join('; ') : 'saveChanges() failed.';
}

// ── the save loop ────────────────────────────────────────────────────────────
// Shared by the context (every tracked entity) and the record set's one-call writes (one entity).

const saveOrder: EntityState[] = [EntityState.Added, EntityState.Modified, EntityState.Deleted];

function orderedChanges(changeTracker: ChangeTracker, entities: object[] | undefined): ChangeSet {
    const changeSet = changeTracker.detectChanges();
    const scoped = entities ? changeSet.entries.filter((entry) => entities.includes(entry.entity)) : changeSet.entries;
    const entries = saveOrder.flatMap((state) => scoped.filter((entry) => entry.state === state));
    return { entries, hasChanges: entries.length > 0 };
}

function buildUpdater(changeTracker: ChangeTracker, entry: ChangeSetEntry, updaterOptions: RecordUpdaterOptions | undefined): RecordUpdater<unknown, Record<string, unknown>> | undefined {
    const config = changeTracker.resolveConfig(entry.setName);
    let updater: RecordUpdater<unknown, Record<string, unknown>> | undefined;
    if (entry.state === EntityState.Added) {
        updater = createRecord<unknown, Record<string, unknown>>(config);
    } else if (entry.state === EntityState.Modified) {
        updater = updateRecord<unknown, Record<string, unknown>>(config).id(entry.key as RecordId);
    }
    if (!updater) {
        return undefined;
    }
    if (updaterOptions) {
        updater.withOptions(updaterOptions);
    }
    return updater.patch(entry.patch ?? {});
}

function saveEntry(changeTracker: ChangeTracker, entry: ChangeSetEntry, updaterOptions: RecordUpdaterOptions | undefined): UpdateResult {
    if (entry.state === EntityState.Deleted) {
        if (entry.key === undefined) {
            return { success: false, error: 'Cannot delete an entity without a key value.' };
        }
        const deleted = deleteRecord(changeTracker.resolveConfig(entry.setName), entry.key);
        return { success: deleted.success, id: deleted.id, error: deleted.error };
    }
    if (entry.state === EntityState.Modified && entry.key === undefined) {
        return { success: false, error: 'Cannot update an entity without a key value.' };
    }
    return (buildUpdater(changeTracker, entry, updaterOptions) as RecordUpdater<unknown, Record<string, unknown>>).submit();
}

function planTrackedChanges(changeTracker: ChangeTracker, options: PlanChangesOptions): ChangePlan {
    const changeSet = orderedChanges(changeTracker, options.entities);
    return {
        hasChanges: changeSet.hasChanges,
        entries: changeSet.entries.map((entry) => ({ ...entry, plan: buildUpdater(changeTracker, entry, options.updaterOptions)?.plan() })),
    };
}

function saveTrackedChanges(changeTracker: ChangeTracker, options: SaveChangesOptions): SaveChangesResult {
    const { stopOnFirstFailure = true, acceptChangesOnSuccess = true } = options;
    const changeSet = orderedChanges(changeTracker, options.entities);
    const results: EntitySaveResult[] = [];
    let failed = false;

    for (const entry of changeSet.entries) {
        if (failed && stopOnFirstFailure) {
            results.push({ setName: entry.setName, state: entry.state, key: entry.key, entity: entry.entity, result: { success: false, error: skippedAfterFailureMessage } });
            continue;
        }
        const result = saveEntry(changeTracker, entry, options.updaterOptions);
        results.push({ setName: entry.setName, state: entry.state, key: entry.key, entity: entry.entity, result });
        if (!result.success) {
            failed = true;
        }
    }

    if (acceptChangesOnSuccess) {
        changeTracker.acceptChanges(results.filter((saved) => saved.result.success).map((saved) => ({ entity: saved.entity, assignedKey: saved.state === EntityState.Added ? saved.result.id : undefined })));
    }

    const savedCount = results.filter((saved) => saved.result.success).length;
    const skippedCount = results.filter((saved) => saved.result.error === skippedAfterFailureMessage).length;
    return { success: !failed, savedCount, failedCount: results.length - savedCount - skippedCount, skippedCount, results };
}

// ── the record set ───────────────────────────────────────────────────────────

/**
 * The record set of one record type on a context: the repository (EF DbSet). Reads go through `list`, `first`,
 * `getById`, and `query()`. Writes come in three layers: the one-call `create`, `update`, and `delete`, which go
 * through change tracking and throw on failure; change tracking itself (`add`, `remove`, mutate, then
 * `context.saveChanges()`); and the record updater underneath (`updater`, `submitPatch`, `createRecord`, `deleteRecord`),
 * which returns results instead of throwing. Generated `<Model>RepositoryBase` classes extend it.
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

    // ── reads ──

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

    /** The first record matching the specifications. */
    first(...specifications: Specification<TResult>[]): TResult | null {
        return applySpecifications(this.query(), specifications).firstTyped();
    }

    count(...specifications: Specification<TResult>[]): number {
        return applySpecifications(this.query(), specifications).count();
    }

    exists(...specifications: Specification<TResult>[]): boolean {
        return applySpecifications(this.query(), specifications).exists();
    }

    /** Starts a query with one condition; the operators and the value are typed from the field, as on the query builder. */
    where<TField extends FieldPath<TResult>, TOperator extends OperatorFor<FieldValue<TResult, TField>>>(field: TField, operator: TOperator, value?: ConditionValue<FieldValue<TResult, TField>, TOperator>): QueryBuilder<TResult> {
        return this.untypedQuery().where(field, operator, value as ConditionValue<unknown, TOperator>) as QueryBuilder<TResult>;
    }

    /** Returns the tracked instance when the key is already loaded, otherwise queries NetSuite (EF Find). Null when there is none. */
    find(id: RecordId): TResult | null {
        const tracked = this.changeTracker.findTracked<TResult & object>(this.name, id);
        if (tracked) {
            return tracked;
        }
        return (this.untypedQuery().where(this.getPrimaryFieldKey(), '=', id) as QueryBuilder<TResult>).firstTyped();
    }

    /** The record with the id; throws RecordNotFoundError when there is none. */
    getById(id: RecordId): TResult {
        const entity = this.find(id);
        if (entity === null || entity === undefined) {
            throw new RecordNotFoundError(this.config.recordType, id);
        }
        return entity;
    }

    /** The builder with the model's field typing set aside, for conditions the set states on the model's behalf. */
    private untypedQuery(): QueryBuilder<unknown> {
        return this.query() as QueryBuilder<unknown>;
    }

    // ── one-call writes: change tracking, one entity, throw on failure ──

    /**
     * Creates a record from its values in one call and returns the same object with its new id written back.
     * The object is tracked afterwards; read it back with `getById()` when NetSuite sources values on save.
     */
    create(values: EntityCreate<TResult>, options: WriteOptions = {}): TResult {
        const entity = values as unknown as TResult & object;
        this.add(entity);
        this.saveEntity(entity, options);
        return entity;
    }

    /**
     * Loads the record, applies the patch to the tracked entity, plans, calls `beforeSave`, and saves only that entity.
     * Scalars replace, subrecords merge, sublists take { update, add, remove } by line identity. Returns the entity.
     */
    update(id: RecordId, patch: EntityPatch<TResult>, options: WriteOptions = {}): TResult {
        const entity = this.getById(id) as TResult & object;
        if (!this.changeTracker.entry(entity)) {
            this.attach(entity);
        }
        applyEntityPatch(this.config as QueryConfig<unknown>, entity as Record<string, unknown>, patch as Record<string, unknown>);
        this.saveEntity(entity, options);
        return entity;
    }

    /** Deletes the record in one call; an entity that was only added and never saved is simply forgotten. */
    delete(id: RecordId, options: WriteOptions = {}): void {
        const entry = this.remove(id);
        this.saveEntity(entry.entity, options);
    }

    private saveEntity(entity: object, options: WriteOptions): void {
        const scope = { entities: [entity], updaterOptions: options.updater };
        if (options.beforeSave) {
            options.beforeSave(planTrackedChanges(this.changeTracker, scope));
        }
        const result = saveTrackedChanges(this.changeTracker, scope);
        if (!result.success) {
            throw new SaveChangesError(result);
        }
    }

    // ── change tracking ──

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

    // ── the record updater: results, never throws ──

    /** An updater for the record, to stage values on before `submit()`. */
    updater(id: RecordId): RecordUpdater<TResult, TUpdate> {
        return updateRecord<TResult, TUpdate>(this.config).id(id);
    }

    submit(id: RecordId, values: Partial<TUpdate> | Record<string, unknown>): UpdateResult {
        return this.submitPatch(id, values as RecordGraphPatch<TUpdate>);
    }

    /** Writes a graph patch straight through the updater, without change tracking. */
    submitPatch(id: RecordId, patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult {
        const updater = this.updater(id);
        if (options) {
            updater.withOptions(options);
        }
        return updater.patch(patch).submit();
    }

    /** Creates a record from a graph patch straight through the updater, without change tracking. */
    createRecord(patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult {
        const updater = createRecord<TResult, TUpdate>(this.config);
        if (options) {
            updater.withOptions(options);
        }
        return updater.patch(patch).submit();
    }

    /** Deletes a record and returns the result instead of throwing. */
    deleteRecord(id: RecordId): DeleteResult {
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

// ── the context ──────────────────────────────────────────────────────────────

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

    /** Diffs every tracked entity (or only `options.entities`) and returns what saveChanges() would do, with updater plans and no NetSuite calls. */
    planChanges(options: PlanChangesOptions = {}): ChangePlan {
        return planTrackedChanges(this.changeTracker, options);
    }

    /** Saves Added, then Modified, then Deleted entities through the record updater. Never throws for NetSuite failures. */
    saveChanges(options: SaveChangesOptions = {}): SaveChangesResult {
        return saveTrackedChanges(this.changeTracker, options);
    }

    /** The set by name, untyped, for the tracker and the save loop. */
    private recordSet(name: string): RecordSet<unknown> {
        const recordSet = (this.entities as unknown as Record<string, RecordSet<unknown> | undefined>)[name];
        if (!recordSet) {
            throw new Error(`Entity '${name}' is not registered in this NetSuiteContext.`);
        }
        return recordSet;
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
