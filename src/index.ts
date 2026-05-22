export * from './types';
export * from './query';
export * from './record-updater';
export * from './context';

import type { QueryConfig, QueryConfigInput, RecordGraphPatch, RecordId, RecordUpdaterOptions, UpdateResult } from './types';
import type { RecordUpdater } from './record-updater';
import { createNetSuiteContext } from './context';
import { query } from './query';
import { updateRecord } from './record-updater';

export function repository<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>>(config: QueryConfig<TResult> | QueryConfigInput<TResult>) {
    function update(id: RecordId): RecordUpdater<TResult, TUpdate>;
    function update(id: RecordId, patch: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): UpdateResult;
    function update(id: RecordId, patch?: RecordGraphPatch<TUpdate>, options?: RecordUpdaterOptions): RecordUpdater<TResult, TUpdate> | UpdateResult {
        const updater = updateRecord<TResult, TUpdate>(config).id(id);
        if (options) updater.withOptions(options);
        return patch === undefined ? updater : updater.patch(patch).submit();
    }

    return {
        query: () => query(config),
        update,
    };
}

export const createContext = createNetSuiteContext;