import type { QueryConfig, RecordGraphPatch, RecordId } from '../types';
import { cloneEntitySnapshot } from './deep-clone';
import { buildAddedEntityPatch, diffTrackedEntity } from './diff';

export enum EntityState {
    Detached = 'Detached',
    Unchanged = 'Unchanged',
    Added = 'Added',
    Modified = 'Modified',
    Deleted = 'Deleted',
}

/** EF-style view of one tracked entity. Setting `state` to Modified forces every writable value to be written. */
export interface EntityEntry<T extends object = object> {
    readonly entity: T;
    readonly setName: string;
    readonly key: RecordId | undefined;
    state: EntityState;
    readonly originalValues: T | undefined;
    /** Re-snapshots the entity from its current values so it counts as unchanged. */
    reload(): void;
}

export interface ChangeSetEntry {
    setName: string;
    state: EntityState;
    key?: RecordId;
    entity: object;
    /** Graph patch for Added and Modified entries. */
    patch?: RecordGraphPatch;
    /** Changed properties that cannot be written. */
    ignoredProperties: string[];
}

export interface ChangeSet {
    entries: ChangeSetEntry[];
    hasChanges: boolean;
}

export interface AcceptedChange {
    entity: object;
    /** Id assigned by NetSuite for an Added entity. */
    assignedKey?: RecordId;
}

interface TrackedEntry {
    setName: string;
    entity: Record<string, unknown>;
    state: EntityState;
    snapshot?: Record<string, unknown>;
    /** Set when a caller forced the Modified state so every writable value is written. */
    forceFullWrite: boolean;
}

function keyPropertyOf(config: QueryConfig<unknown>): string {
    for (const [key, field] of Object.entries(config.fields)) {
        if (field.isPrimary) {
            return key;
        }
    }
    throw new Error(`No primary field is configured for '${config.recordType}', so its entities cannot be tracked.`);
}

function keyOf(entity: Record<string, unknown>, keyProperty: string): RecordId | undefined {
    const value = entity[keyProperty];
    return typeof value === 'number' || (typeof value === 'string' && value !== '') ? value : undefined;
}

/**
 * Identity map plus snapshots for entities loaded through a context.
 * Entries are held strongly (ES2019 has no WeakRef and a WeakMap cannot be iterated), so contexts should live for one script execution.
 */
export class ChangeTracker {
    private readonly entries = new Map<object, TrackedEntry>();
    private readonly identity = new Map<string, Map<string, object>>();

    constructor(private readonly resolveConfig: (setName: string) => QueryConfig<unknown>, readonly enabled = true) {}

    /** Registers query results; a result whose key is already tracked is replaced by the tracked instance (identity resolution). */
    trackQueryResults<T extends object>(setName: string, results: T[]): T[] {
        if (!this.enabled) {
            return results;
        }
        const keyProperty = keyPropertyOf(this.resolveConfig(setName));
        return results.map((result) => {
            const key = keyOf(result as Record<string, unknown>, keyProperty);
            if (key === undefined) {
                return result;
            }
            const existing = this.findTracked<T>(setName, key);
            if (existing) {
                return existing;
            }
            this.register(setName, result as Record<string, unknown>, EntityState.Unchanged, key);
            return result;
        });
    }

    attach<T extends object>(setName: string, entity: T): EntityEntry<T> {
        const key = keyOf(entity as Record<string, unknown>, keyPropertyOf(this.resolveConfig(setName)));
        if (key === undefined) {
            throw new Error(`Cannot attach an entity to '${setName}' without a key value.`);
        }
        const existing = this.findTracked(setName, key);
        if (existing && existing !== entity) {
            throw new Error(`Another instance with key '${String(key)}' is already tracked in '${setName}'.`);
        }
        this.register(setName, entity as Record<string, unknown>, EntityState.Unchanged, key);
        return this.entry(entity) as EntityEntry<T>;
    }

    add<T extends object>(setName: string, entity: T): EntityEntry<T> {
        const key = keyOf(entity as Record<string, unknown>, keyPropertyOf(this.resolveConfig(setName)));
        if (key !== undefined && this.findTracked(setName, key) && this.findTracked(setName, key) !== entity) {
            throw new Error(`Another instance with key '${String(key)}' is already tracked in '${setName}'.`);
        }
        this.register(setName, entity as Record<string, unknown>, EntityState.Added, key);
        return this.entry(entity) as EntityEntry<T>;
    }

    /** Marks an entity (or a bare key) for deletion. Removing an Added entity simply detaches it. */
    remove<T extends object>(setName: string, entityOrKey: T | RecordId): EntityEntry<T> {
        const keyProperty = keyPropertyOf(this.resolveConfig(setName));
        const entity = (typeof entityOrKey === 'object' ? entityOrKey : this.findTracked(setName, entityOrKey) ?? { [keyProperty]: entityOrKey }) as Record<string, unknown>;
        const tracked = this.entries.get(entity);

        if (tracked?.state === EntityState.Added) {
            this.detach(entity);
            return this.detachedEntry(setName, entity as unknown as T, keyOf(entity, keyProperty));
        }

        this.register(setName, entity, EntityState.Deleted, keyOf(entity, keyProperty), tracked?.snapshot);
        return this.entry(entity as unknown as T) as EntityEntry<T>;
    }

    detach(entity: object): void {
        const tracked = this.entries.get(entity);
        if (!tracked) {
            return;
        }
        this.entries.delete(entity);
        const key = keyOf(tracked.entity, keyPropertyOf(this.resolveConfig(tracked.setName)));
        if (key !== undefined) {
            this.identity.get(tracked.setName)?.delete(String(key));
        }
    }

    entry<T extends object>(entity: T): EntityEntry<T> | undefined {
        const tracked = this.entries.get(entity);
        if (!tracked) {
            return undefined;
        }
        const tracker = this;
        return {
            entity,
            setName: tracked.setName,
            get key() {
                return keyOf(tracked.entity, keyPropertyOf(tracker.resolveConfig(tracked.setName)));
            },
            get state() {
                return tracked.state;
            },
            set state(state: EntityState) {
                tracker.setState(tracked, state);
            },
            get originalValues() {
                return tracked.snapshot as T | undefined;
            },
            reload() {
                tracked.snapshot = cloneEntitySnapshot(tracked.entity);
                tracked.state = EntityState.Unchanged;
                tracked.forceFullWrite = false;
            },
        };
    }

    findTracked<T extends object>(setName: string, key: RecordId): T | undefined {
        return this.identity.get(setName)?.get(String(key)) as T | undefined;
    }

    trackedEntries(): EntityEntry[] {
        return Array.from(this.entries.keys()).map((entity) => this.entry(entity) as EntityEntry);
    }

    /** Diffs every tracked entity against its snapshot and updates states to Modified where values changed. */
    detectChanges(): ChangeSet {
        const changeSet: ChangeSetEntry[] = [];

        for (const tracked of this.entries.values()) {
            const config = this.resolveConfig(tracked.setName);
            const key = keyOf(tracked.entity, keyPropertyOf(config));

            if (tracked.state === EntityState.Deleted) {
                changeSet.push({ setName: tracked.setName, state: tracked.state, key, entity: tracked.entity, ignoredProperties: [] });
                continue;
            }

            if (tracked.state === EntityState.Added) {
                const diff = buildAddedEntityPatch(config, tracked.entity);
                changeSet.push({ setName: tracked.setName, state: tracked.state, key, entity: tracked.entity, patch: diff.patch ?? {}, ignoredProperties: diff.ignoredProperties });
                continue;
            }

            const diff = tracked.forceFullWrite
                ? buildAddedEntityPatch(config, tracked.entity)
                : diffTrackedEntity(config, tracked.snapshot ?? {}, tracked.entity);
            if (diff.patch) {
                tracked.state = EntityState.Modified;
                changeSet.push({ setName: tracked.setName, state: EntityState.Modified, key, entity: tracked.entity, patch: diff.patch, ignoredProperties: diff.ignoredProperties });
            } else {
                tracked.state = EntityState.Unchanged;
            }
        }

        return { entries: changeSet, hasChanges: changeSet.length > 0 };
    }

    /** Re-snapshots saved entities: Added becomes Unchanged with its new key, Modified becomes Unchanged, Deleted is detached. */
    acceptChanges(accepted: AcceptedChange[]): void {
        for (const change of accepted) {
            const tracked = this.entries.get(change.entity);
            if (!tracked) {
                continue;
            }
            if (tracked.state === EntityState.Deleted) {
                this.detach(change.entity);
                continue;
            }
            const keyProperty = keyPropertyOf(this.resolveConfig(tracked.setName));
            if (change.assignedKey !== undefined) {
                tracked.entity[keyProperty] = change.assignedKey;
            }
            const key = keyOf(tracked.entity, keyProperty);
            if (key !== undefined) {
                this.indexIdentity(tracked.setName, key, change.entity);
            }
            tracked.snapshot = cloneEntitySnapshot(tracked.entity);
            tracked.state = EntityState.Unchanged;
            tracked.forceFullWrite = false;
        }
    }

    clear(): void {
        this.entries.clear();
        this.identity.clear();
    }

    private register(setName: string, entity: Record<string, unknown>, state: EntityState, key: RecordId | undefined, snapshot?: Record<string, unknown>): void {
        const existing = this.entries.get(entity);
        const tracked: TrackedEntry = existing ?? { setName, entity, state, forceFullWrite: false };
        tracked.setName = setName;
        tracked.state = state;
        tracked.forceFullWrite = false;
        tracked.snapshot = state === EntityState.Added ? undefined : snapshot ?? (state === EntityState.Unchanged ? cloneEntitySnapshot(entity) : tracked.snapshot);
        this.entries.set(entity, tracked);
        if (key !== undefined) {
            this.indexIdentity(setName, key, entity);
        }
    }

    private indexIdentity(setName: string, key: RecordId, entity: object): void {
        let bySet = this.identity.get(setName);
        if (!bySet) {
            bySet = new Map();
            this.identity.set(setName, bySet);
        }
        bySet.set(String(key), entity);
    }

    private setState(tracked: TrackedEntry, state: EntityState): void {
        switch (state) {
            case EntityState.Detached:
                this.detach(tracked.entity);
                return;
            case EntityState.Modified:
                tracked.state = EntityState.Modified;
                tracked.forceFullWrite = true;
                return;
            case EntityState.Unchanged:
                tracked.snapshot = cloneEntitySnapshot(tracked.entity);
                tracked.state = EntityState.Unchanged;
                tracked.forceFullWrite = false;
                return;
            default:
                tracked.state = state;
                tracked.forceFullWrite = false;
        }
    }

    private detachedEntry<T extends object>(setName: string, entity: T, key: RecordId | undefined): EntityEntry<T> {
        return {
            entity,
            setName,
            key,
            state: EntityState.Detached,
            originalValues: undefined,
            reload: () => undefined,
        };
    }
}
