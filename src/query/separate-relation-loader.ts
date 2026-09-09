import type { ConditionNode, ConditionParamValue, QueryDescription, QueryResultValue, SeparateLoadDescription } from '../types';
import { getValueAtPath, mapRowsToResults, normalizeMappedResultKey } from './result-mapper';
import type { ResultMappingOptions, ResultRow } from './result-mapper';

/** How many parent keys go into one ANY_OF list. */
export const defaultSeparateLoadBatchSize = 500;

export interface SeparateLoadRuntime {
    executeDescription(description: QueryDescription): ResultRow[];
    /** The mapping of one relation's rows into its items, with output paths relative to the relation. */
    mappingOptionsFor(load: SeparateLoadDescription): ResultMappingOptions;
    batchSize: number;
}

/** Distinct parent key values in first-seen order; null and undefined are never keys. */
export function collectDistinctParentKeys(parents: object[], parentKeyPath: string): ConditionParamValue[] {
    const seen = new Set<string>();
    const keys: ConditionParamValue[] = [];
    for (const parent of parents) {
        const value = getValueAtPath(parent, parentKeyPath);
        if (value === null || value === undefined) {
            continue;
        }
        const key = String(value);
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(value as ConditionParamValue);
        }
    }
    return keys;
}

export function batchValues<T>(values: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let index = 0; index < values.length; index += batchSize) {
        batches.push(values.slice(index, index + batchSize));
    }
    return batches;
}

function withBatchCondition(load: SeparateLoadDescription, batch: ConditionParamValue[]): QueryDescription {
    const batchNode: ConditionNode = { kind: 'field', fieldId: load.batchFieldId, operator: 'ANY_OF', values: batch };
    const condition: ConditionNode = load.description.condition ? { kind: 'and', nodes: [batchNode, load.description.condition] } : batchNode;
    return { ...load.description, condition };
}

function readRowValue(row: ResultRow, alias: string): QueryResultValue | undefined {
    const wanted = normalizeMappedResultKey(alias);
    for (const [key, value] of Object.entries(row)) {
        if (normalizeMappedResultKey(key) === wanted) {
            return value;
        }
    }
    return undefined;
}

function groupRowsByParentKey(rows: ResultRow[], parentKeyAlias: string): Map<string, ResultRow[]> {
    const groups = new Map<string, ResultRow[]>();
    for (const row of rows) {
        const key = readRowValue(row, parentKeyAlias);
        if (key === null || key === undefined) {
            continue;
        }
        const group = groups.get(String(key)) ?? [];
        group.push(row);
        groups.set(String(key), group);
    }
    return groups;
}

/**
 * Loads every separately loaded relation of the mapped results and stitches the items into their parents: an
 * array for a sublist (empty when the parent has none), an object or null for a subrecord or reference. Parent
 * keys are queried in batches; nested separate relations are loaded from the items the same way.
 */
export function loadSeparateRelationsIntoResults(parents: object[], loads: SeparateLoadDescription[], runtime: SeparateLoadRuntime): void {
    for (const load of loads) {
        const itemsByParentKey = new Map<string, unknown[]>();
        const mapping = runtime.mappingOptionsFor(load);
        for (const batch of batchValues(collectDistinctParentKeys(parents, load.parentKeyPath), runtime.batchSize)) {
            const rows = runtime.executeDescription(withBatchCondition(load, batch));
            for (const [parentKey, group] of groupRowsByParentKey(rows, load.parentKeyAlias)) {
                const items = load.kind === 'sublist'
                    ? group.flatMap((row) => mapRowsToResults<unknown>([row], mapping))
                    : mapRowsToResults<unknown>(group, mapping);
                itemsByParentKey.set(parentKey, [...(itemsByParentKey.get(parentKey) ?? []), ...items]);
            }
        }

        const loadedItems: object[] = [];
        for (const parent of parents) {
            const key = getValueAtPath(parent, load.parentKeyPath);
            const items = key === null || key === undefined ? [] : itemsByParentKey.get(String(key)) ?? [];
            (parent as Record<string, unknown>)[load.relationship] = load.kind === 'sublist' ? items : items[0] ?? null;
            loadedItems.push(...(items as object[]));
        }

        if (load.description.separateLoads && load.description.separateLoads.length > 0 && loadedItems.length > 0) {
            loadSeparateRelationsIntoResults(loadedItems, load.description.separateLoads, runtime);
        }
    }
}
