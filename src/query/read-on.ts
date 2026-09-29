import type { ConditionNode, ConditionParamValue, DescribedSort, FieldType, QueryDescription, QueryResultValue } from '../types';
import { conditionNodeForTranslation } from './condition-nodes';
import { translateConditionOperator } from './operator-translation';
import { normalizeMappedResultKey } from './result-mapper';
import type { ResultRow } from './result-mapper';

declare const require: <T = unknown>(moduleName: string) => T;

/**
 * Reading a query past N/query's 5,000-row answer. Every query is sorted by its own sorts and then by the internal id,
 * so its order is complete; when an answer comes back full, the next read asks for the rows after its last one, by
 * the values of those sorts. What each comparison may be is what probes k1 to k6 found in a sandbox account on
 * 2026-09-24, reading 17,369 invoices of one customer.
 */

/** The most rows N/query's run() answers; it says nothing when it stops there (probe k2). */
export const runRowLimit = 5000;

/** The governance units a run of reads leaves the script by default, for the caller to act on what it read. */
export const defaultGovernanceReserve = 100;

/**
 * How a read compares a sort's value to pick up after it. `ordered` uses the field's own operators (GREATER, AFTER,
 * EQUAL, ON), which N/query accepts on keys, numbers and dates (probes k2, k5). `text` compares upper-cased in a
 * formula: N/query rejects GREATER on text, NetSuite orders text as UPPER(field), and the formula picks up exactly
 * where that order left off (probe k3).
 */
export type ReadOnComparison = 'ordered' | 'text';

/** A sort a read can pick up after: the sort, the alias its value comes back under, and how it compares. */
export interface ReadOnKey {
    sort: DescribedSort;
    alias: string;
    comparison: ReadOnComparison;
    fieldType: FieldType;
    /** The internal id: never blank. */
    isPrimary: boolean;
    /**
     * A text key on a joined record: how its formula names that record, by the join field ids from the root
     * (`terms`, `transactionlines`). A formula reaches a joined record through its select field, not the model's name.
     */
    formulaPath?: string;
    /**
     * A text key on a record joined through a reference's select field, which a formula may not reach at all (a select
     * field that points at several record types has no formula path: `{entity.companyname}` is "not found", sandbox
     * 2026-09-28). A whole read goes through runPaged rather than read on after it.
     */
    throughReference?: boolean;
}

/**
 * How a sort on a field of this type is compared to read on after it, or undefined when no probe checked a comparison
 * for the type (select, multiselect, checkbox, datetime): those queries are read through runPaged instead.
 */
export function readOnComparisonFor(fieldType: FieldType | undefined): ReadOnComparison | undefined {
    switch (fieldType) {
        case 'key':
        case 'integer':
        case 'float':
        case 'currency':
        case 'date':
            return 'ordered';
        case 'string':
            return 'text';
        default:
            return undefined;
    }
}

/** Where blanks go: NetSuite puts them last ascending and first descending unless the sort says (probe k4). */
export function sortsBlanksLast(sort: DescribedSort): boolean {
    return sort.nullsLast ?? sort.ascending;
}

function isBlank(value: QueryResultValue | undefined): boolean {
    return value === null || value === undefined || value === '';
}

function anyOf(nodes: ConditionNode[]): ConditionNode {
    const flattened = nodes.flatMap((node) => (node.kind === 'or' ? node.nodes : [node]));
    return flattened.length === 1 ? flattened[0] : { kind: 'or', nodes: flattened };
}

function allOf(nodes: ConditionNode[]): ConditionNode {
    const flattened = nodes.flatMap((node) => (node.kind === 'and' ? node.nodes : [node]));
    return flattened.length === 1 ? flattened[0] : { kind: 'and', nodes: flattened };
}

function fieldNode(sort: DescribedSort, operator: 'EMPTY' | 'EMPTY_NOT'): ConditionNode {
    const node: ConditionNode = { kind: 'field', fieldId: sort.fieldId as string, operator };
    return sort.component === undefined ? node : { ...node, component: sort.component };
}

/** `a > b` on text, the way NetSuite orders it: both sides upper-cased, inside a formula N/query accepts. */
function buildTextComparisonNode(key: ReadOnKey, operator: '>' | '<' | '=', value: QueryResultValue): ConditionNode {
    const path = key.formulaPath ?? key.sort.component;
    const reference = `{${path === undefined ? '' : `${path}.`}${key.sort.fieldId}}`;
    const literal = `'${String(value).replace(/'/g, "''")}'`;
    return { kind: 'formula', formula: `CASE WHEN UPPER(${reference}) ${operator} UPPER(${literal}) THEN 1 ELSE 0 END`, type: 'INTEGER', operator: 'EQUAL', values: [1] };
}

function buildOrderedComparisonNode(key: ReadOnKey, operator: '>' | '<' | '=', value: QueryResultValue): ConditionNode {
    return conditionNodeForTranslation(translateConditionOperator(operator, key.fieldType, value as ConditionParamValue), (translatedOperator, values) => {
        const node: ConditionNode = { kind: 'field', fieldId: key.sort.fieldId as string, operator: translatedOperator, values };
        return key.sort.component === undefined ? node : { ...node, component: key.sort.component };
    });
}

function buildComparisonNode(key: ReadOnKey, operator: '>' | '<' | '=', value: QueryResultValue): ConditionNode {
    return key.comparison === 'text' ? buildTextComparisonNode(key, operator, value) : buildOrderedComparisonNode(key, operator, value);
}

/** The rows that share this value for the key: the same value, or a blank for a blank. */
function buildSameValueNode(key: ReadOnKey, value: QueryResultValue): ConditionNode {
    return isBlank(value) ? fieldNode(key.sort, 'EMPTY') : buildComparisonNode(key, '=', value);
}

/** The rows whose value for the key comes after this one in the sort, blanks where NetSuite puts them; undefined when none can. */
function buildLaterValueNode(key: ReadOnKey, value: QueryResultValue): ConditionNode | undefined {
    const blanksLast = !key.isPrimary && sortsBlanksLast(key.sort);
    if (isBlank(value)) {
        return blanksLast || key.isPrimary ? undefined : fieldNode(key.sort, 'EMPTY_NOT');
    }
    const later = buildComparisonNode(key, key.sort.ascending ? '>' : '<', value);
    return blanksLast ? anyOf([later, fieldNode(key.sort, 'EMPTY')]) : later;
}

/**
 * The rows after the one whose key values these are, in the order the keys give: for each key, the rows that share
 * every earlier key's value and come later on this one. The last key is the internal id, so no row is read twice or
 * skipped.
 */
export function buildAfterRowCondition(keys: ReadOnKey[], values: QueryResultValue[]): ConditionNode {
    const terms: ConditionNode[] = [];
    keys.forEach((key, index) => {
        const later = buildLaterValueNode(key, values[index]);
        if (later !== undefined) {
            terms.push(allOf([...keys.slice(0, index).map((earlier, earlierIndex) => buildSameValueNode(earlier, values[earlierIndex])), later]));
        }
    });
    return anyOf(terms);
}

/** The description with one more condition ANDed onto its own. */
export function withAddedCondition(description: QueryDescription, condition: ConditionNode): QueryDescription {
    return { ...description, condition: description.condition === undefined ? condition : { kind: 'and', nodes: [description.condition, condition] } };
}

/** A row's value for each key, read by the alias its column came back under; a missing value is blank. */
export function readKeyValues(keys: ReadOnKey[], row: ResultRow): QueryResultValue[] {
    const valuesByKey = new Map(Object.entries(row).map(([alias, value]) => [normalizeMappedResultKey(alias), value]));
    return keys.map((key) => valuesByKey.get(normalizeMappedResultKey(key.alias)) ?? null);
}

/** The marker a page answers for the page after it: its last row's key values. */
export function encodeReadOnMarker(values: QueryResultValue[]): string {
    return JSON.stringify(values);
}

/** The key values a marker carries, checked against the query it is handed back to. */
export function decodeReadOnMarker(marker: string, keys: ReadOnKey[]): QueryResultValue[] {
    let values: unknown;
    try {
        values = JSON.parse(marker);
    } catch {
        values = undefined;
    }
    if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error(`The page marker '${marker}' does not belong to this query: a marker for it carries ${keys.length} value(s), one per sort (${keys.map((key) => key.alias).join(', ')}).`);
    }
    return values as QueryResultValue[];
}

/** Thrown before a read the script cannot afford, instead of NetSuite ending the script halfway through it. */
export class GovernanceLimitError extends Error {
    constructor(
        message: string,
        readonly rowsRead: number,
        readonly remainingUsage: number,
        readonly readCost: number,
        readonly reserve: number,
    ) {
        super(message);
        this.name = 'GovernanceLimitError';
    }
}

function readRemainingUsage(): number | undefined {
    try {
        const usage = require<{ getCurrentScript(): { getRemainingUsage(): number } }>('N/runtime').getCurrentScript().getRemainingUsage();
        return typeof usage === 'number' ? usage : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The governance a run of reads spends: what the last read cost, and whether another like it would leave the script
 * less than `reserve`. getRemainingUsage costs nothing (probe k6). Where N/runtime answers no usage, as outside
 * SuiteScript, every read is affordable.
 */
export class ReadGovernance {
    private lastReadCost = 0;

    constructor(readonly reserve: number) {}

    measure<T>(read: () => T): T {
        const before = readRemainingUsage();
        const result = read();
        const after = readRemainingUsage();
        if (before !== undefined && after !== undefined) {
            this.lastReadCost = Math.max(0, before - after);
        }
        return result;
    }

    /** What is left and what a read costs, when another read would dip into the reserve; undefined while it would not. */
    shortfall(): { remainingUsage: number; readCost: number } | undefined {
        const remainingUsage = readRemainingUsage();
        if (remainingUsage === undefined || remainingUsage - this.lastReadCost >= this.reserve) {
            return undefined;
        }
        return { remainingUsage, readCost: this.lastReadCost };
    }
}
