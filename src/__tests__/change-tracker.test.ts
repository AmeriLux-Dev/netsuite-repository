
import { ChangeTracker, EntityState } from '../tracking';
import type { QueryConfig } from '../types';
import { customerConfig } from './fixtures';
import { salesOrderModelConfig } from './model-fixtures';

const configs: Record<string, QueryConfig<unknown>> = {
    salesOrders: salesOrderModelConfig as QueryConfig<unknown>,
    customers: customerConfig as QueryConfig<unknown>,
    noKey: { recordType: 'nokey', query: { from: { name: 'x', alias: 'x' } }, fields: { name: { queryFieldId: 'name', tableAlias: 'x' } } },
};

function createTracker(enabled = true): ChangeTracker {
    return new ChangeTracker((setName) => configs[setName], enabled);
}

describe('ChangeTracker.trackQueryResults()', () => {
    it('registers results as Unchanged and resolves identity for repeated keys', () => {
        const tracker = createTracker();
        const first = { id: 1, memo: 'a' };
        const [tracked] = tracker.trackQueryResults('salesOrders', [first]);
        const [again] = tracker.trackQueryResults('salesOrders', [{ id: 1, memo: 'b' }]);

        expect(tracked).toBe(first);
        expect(again).toBe(first);
        expect(tracker.entry(first)?.state).toBe(EntityState.Unchanged);
        expect(tracker.entry(first)?.originalValues).toEqual({ id: 1, memo: 'a' });
        expect(tracker.findTracked('salesOrders', '1')).toBe(first);
    });

    it('leaves entities without a key untracked and does nothing when disabled', () => {
        const tracker = createTracker();
        const [untracked] = tracker.trackQueryResults('salesOrders', [{ memo: 'no id' }]);
        expect(tracker.entry(untracked)).toBeUndefined();

        const disabled = createTracker(false);
        const entity = { id: 5 };
        expect(disabled.trackQueryResults('salesOrders', [entity])).toEqual([entity]);
        expect(disabled.entry(entity)).toBeUndefined();
    });

    it('requires a primary field on the set', () => {
        expect(() => createTracker().trackQueryResults('noKey', [{ name: 'x' }])).toThrow("No primary field is configured for 'nokey', so its entities cannot be tracked.");
    });
});

describe('ChangeTracker.attach(), add(), remove(), detach()', () => {
    it('attaches entities with keys and rejects duplicates and missing keys', () => {
        const tracker = createTracker();
        const entity = { id: 7, memo: 'x' };
        const entry = tracker.attach('salesOrders', entity);

        expect(entry.state).toBe(EntityState.Unchanged);
        expect(entry.key).toBe(7);
        expect(entry.setName).toBe('salesOrders');
        expect(tracker.attach('salesOrders', entity).entity).toBe(entity);
        expect(() => tracker.attach('salesOrders', { id: 7 })).toThrow("Another instance with key '7' is already tracked in 'salesOrders'.");
        expect(() => tracker.attach('salesOrders', { memo: 'x' })).toThrow("Cannot attach an entity to 'salesOrders' without a key value.");
    });

    it('adds new entities, with or without keys, and rejects key conflicts', () => {
        const tracker = createTracker();
        const noKey = { memo: 'new' };
        const withKey = { id: 3, memo: 'preset' };

        expect(tracker.add('salesOrders', noKey).state).toBe(EntityState.Added);
        expect(tracker.add('salesOrders', withKey).key).toBe(3);
        expect(tracker.add('salesOrders', withKey).entity).toBe(withKey);
        expect(() => tracker.add('salesOrders', { id: 3 })).toThrow("Another instance with key '3' is already tracked");
        expect(tracker.entry(noKey)?.originalValues).toBeUndefined();
    });

    it('removes tracked entities, detaches added ones, and accepts bare keys', () => {
        const tracker = createTracker();
        const loaded = { id: 1, memo: 'a' };
        tracker.trackQueryResults('salesOrders', [loaded]);
        const added = { memo: 'b' };
        tracker.add('salesOrders', added);

        expect(tracker.remove('salesOrders', loaded).state).toBe(EntityState.Deleted);
        expect(tracker.entry(loaded)?.originalValues).toEqual({ id: 1, memo: 'a' });

        const detached = tracker.remove('salesOrders', added);
        expect(detached.state).toBe(EntityState.Detached);
        expect(detached.key).toBeUndefined();
        expect(detached.originalValues).toBeUndefined();
        detached.reload();
        expect(tracker.entry(added)).toBeUndefined();

        const byKey = tracker.remove('salesOrders', 42);
        expect(byKey.state).toBe(EntityState.Deleted);
        expect(byKey.key).toBe(42);
        expect(tracker.remove('salesOrders', 1).entity).toBe(loaded);

        tracker.detach(loaded);
        tracker.detach({ id: 99 });
        expect(tracker.findTracked('salesOrders', 1)).toBeUndefined();
        expect(tracker.trackedEntries().map((entry) => entry.key)).toEqual([42]);
    });
});

describe('ChangeTracker entry state', () => {
    it('supports forcing Modified, resetting to Unchanged, detaching, and reload', () => {
        const tracker = createTracker();
        const entity = { id: 1, memo: 'a', tranId: 'SO1' };
        tracker.trackQueryResults('salesOrders', [entity]);
        const entry = tracker.entry(entity)!;

        entry.state = EntityState.Modified;
        expect(tracker.detectChanges().entries[0]).toEqual(expect.objectContaining({ state: EntityState.Modified, patch: { memo: 'a' }, ignoredProperties: ['id', 'tranId'] }));

        entity.memo = 'b';
        entry.state = EntityState.Unchanged;
        expect(tracker.detectChanges().hasChanges).toBe(false);

        entity.memo = 'c';
        entry.reload();
        expect(tracker.detectChanges().hasChanges).toBe(false);

        entry.state = EntityState.Deleted;
        expect(tracker.detectChanges().entries[0].state).toBe(EntityState.Deleted);

        entry.state = EntityState.Detached;
        expect(tracker.entry(entity)).toBeUndefined();
    });
});

describe('ChangeTracker.detectChanges() and acceptChanges()', () => {
    it('reports Added, Modified, and Deleted entries and leaves unchanged entities out', () => {
        const tracker = createTracker();
        const unchanged = { id: 1, memo: 'same' };
        const modified = { id: 2, memo: 'before' };
        const added = { memo: 'new' };
        const emptyAdded = {};
        tracker.trackQueryResults('salesOrders', [unchanged, modified]);
        tracker.add('salesOrders', added);
        tracker.add('salesOrders', emptyAdded);
        tracker.remove('customers', 9);
        modified.memo = 'after';

        const changeSet = tracker.detectChanges();

        expect(changeSet.hasChanges).toBe(true);
        expect(changeSet.entries).toEqual([
            expect.objectContaining({ setName: 'salesOrders', state: EntityState.Modified, key: 2, entity: modified, patch: { memo: 'after' } }),
            expect.objectContaining({ state: EntityState.Added, entity: added, patch: { memo: 'new' } }),
            expect.objectContaining({ state: EntityState.Added, entity: emptyAdded, patch: {} }),
            expect.objectContaining({ setName: 'customers', state: EntityState.Deleted, key: 9 }),
        ]);
        expect(tracker.entry(unchanged)?.state).toBe(EntityState.Unchanged);
        expect(tracker.entry(modified)?.state).toBe(EntityState.Modified);
    });

    it('accepts saved changes: assigns keys, re-snapshots, and detaches deleted entities', () => {
        const tracker = createTracker();
        const modified = { id: 2, memo: 'before' };
        const added: { id?: number; memo: string } = { memo: 'new' };
        const deleted = { id: 3 };
        tracker.trackQueryResults('salesOrders', [modified, deleted]);
        tracker.add('salesOrders', added);
        tracker.remove('salesOrders', deleted);
        modified.memo = 'after';
        tracker.detectChanges();

        tracker.acceptChanges([{ entity: modified }, { entity: added, assignedKey: 55 }, { entity: deleted }, { entity: { id: 100 } }]);

        expect(tracker.entry(modified)?.state).toBe(EntityState.Unchanged);
        expect(tracker.entry(modified)?.originalValues).toEqual({ id: 2, memo: 'after' });
        expect(added.id).toBe(55);
        expect(tracker.findTracked('salesOrders', 55)).toBe(added);
        expect(tracker.entry(added)?.state).toBe(EntityState.Unchanged);
        expect(tracker.entry(deleted)).toBeUndefined();
        expect(tracker.detectChanges().hasChanges).toBe(false);

        tracker.clear();
        expect(tracker.trackedEntries()).toEqual([]);
        expect(tracker.findTracked('salesOrders', 55)).toBeUndefined();
    });
});
