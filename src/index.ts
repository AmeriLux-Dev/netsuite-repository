export * from './types';
export * from './query';
export * from './field-path';
export * from './record-updater';
export * from './context';
export * from './model';
export * from './coercion';
export * from './tracking';

import type { DeleteResult, RecordGraphPatch, RecordId, RecordUpdaterOptions, UpdateResult } from './types';
import type { RecordUpdater } from './record-updater';
import type { QueryConfigSource } from './model/resolve';
import { createNetSuiteContext } from './context';
import { query } from './query';
import { createRecord, deleteRecord, updateRecord } from './record-updater';

/** Repository-style access to one model without a context, from its generated config. */
export function repository<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>>(source: QueryConfigSource<TResult>) {
    function update(id: RecordId): RecordUpdater<TResult, TUpdate>;
    function update(id: RecordId, patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult;
    function update(id: RecordId, patch?: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): RecordUpdater<TResult, TUpdate> | UpdateResult {
        const updater = updateRecord<TResult, TUpdate>(source).id(id);
        if (options) updater.withOptions(options);
        return patch === undefined ? updater : updater.patch(patch).submit();
    }

    function create(): RecordUpdater<TResult, TUpdate>;
    function create(patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult;
    function create(patch?: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): RecordUpdater<TResult, TUpdate> | UpdateResult {
        const updater = createRecord<TResult, TUpdate>(source);
        if (options) updater.withOptions(options);
        return patch === undefined ? updater : updater.patch(patch).submit();
    }

    return {
        query: () => query(source),
        update,
        create,
        delete: (id: RecordId): DeleteResult => deleteRecord(source, id),
    };
}

export const createContext = createNetSuiteContext;
