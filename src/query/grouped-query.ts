import type { FieldValue, GroupableFieldPath, NumericFieldPath } from '../field-path';
import type { AggregateName, DescribedScriptSort, FieldType, FormulaReturnType, QueryDescription, QueryField, SortDirection } from '../types';
import type { QueryBuilder } from './query-builder';
import { renderQueryDescription } from './query-description';
import { getValueAtPath } from './result-mapper';

/** The aggregates N/query renders only over a number: over a date, text, or checkbox they fail (sandbox 2026-09-28). */
export type NumericAggregateName = 'SUM' | 'SUM_DISTINCT' | 'AVERAGE' | 'AVERAGE_DISTINCT' | 'MEDIAN';

export const numericAggregateNames: readonly NumericAggregateName[] = ['SUM', 'SUM_DISTINCT', 'AVERAGE', 'AVERAGE_DISTINCT', 'MEDIAN'];

/** The paths an aggregate takes: numbers for SUM, AVERAGE, and MEDIAN; any groupable path for the others. */
export type AggregatePathFor<T, TAggregate extends AggregateName> = TAggregate extends NumericAggregateName ? NumericFieldPath<T> : GroupableFieldPath<T>;

/**
 * What an aggregate answers: a count is a number; a sum, average, or median a number or null (a group whose values are
 * all blank); a minimum or maximum the field's own type or null. An alias the query declared answers `unknown`.
 */
export type AggregateValue<TAggregate extends AggregateName, TValue> = TAggregate extends 'COUNT' | 'COUNT_DISTINCT'
    ? number
    : TAggregate extends NumericAggregateName
        ? number | null
        : unknown extends TValue ? unknown : NonNullable<TValue> | null;

/** The value a declared field type reads as, for a formula aggregate typed by its options. */
export type FieldTypeValue<TFieldType extends FieldType | undefined> = TFieldType extends 'integer' | 'float' | 'currency' | 'key'
    ? number
    : TFieldType extends 'date' | 'datetime'
        ? Date
        : TFieldType extends 'boolean' | 'checkbox'
            ? boolean
            : TFieldType extends 'string'
                ? string
                : TFieldType extends 'select'
                    ? string | number
                    : unknown;

/** What a formula aggregate answers: as AggregateValue, a minimum or maximum typed by the options' field type. */
export type FormulaAggregateValue<TAggregate extends AggregateName, TFieldType extends FieldType | undefined> = TAggregate extends 'COUNT' | 'COUNT_DISTINCT'
    ? number
    : TAggregate extends NumericAggregateName
        ? number | null
        : unknown extends FieldTypeValue<TFieldType> ? unknown : FieldTypeValue<TFieldType> | null;

export interface FormulaAggregateOptions<TFieldType extends FieldType | undefined = FieldType | undefined> {
    /**
     * N/query return type of the formula. A CASE formula typed CURRENCY fails to render (sandbox 2026-09-28): type a
     * sum of amounts FLOAT and give `fieldType: 'currency'`.
     */
    type?: FormulaReturnType;
    /** Field type the aggregate's value is coerced to and typed as; a count is a number whatever it says. */
    fieldType?: TFieldType;
    coerce?: boolean;
    transform?: QueryField['transform'];
}

/** One aggregate column of a grouped read, as the caller asked for it. */
export interface GroupAggregate {
    alias: string;
    aggregate: AggregateName;
    /** A model path or a declared alias; unset for a formula. */
    field?: string;
    formula?: string;
    formulaType?: FormulaReturnType;
    fieldType?: FieldType;
    coerce?: boolean;
    transform?: QueryField['transform'];
}

/** A sort of a grouped read, as the caller asked for it: by a group key or an aggregate alias. */
export interface GroupSort {
    name: string;
    ascending: boolean;
}

/** What a grouped read asks for: its keys, its aggregates, and its sorts. The query builder plans and runs it. */
export interface Grouping {
    keys: string[];
    aggregates: GroupAggregate[];
    sorts: GroupSort[];
}

/** How a grouped query reaches the query builder it was started from. */
export interface GroupedQueryReader<TResult> {
    describe(grouping: Grouping): QueryDescription;
    toSQL(grouping: Grouping): string;
    /** Every group, mapped and sorted, of a copy of the query with the specifications applied. */
    list(grouping: Grouping, specifications: Array<(query: QueryBuilder<TResult>) => QueryBuilder<TResult>>): Array<Record<string, unknown>>;
}

/** Flattens an intersection of row pieces into one object type, for readable results. */
export type GroupRow<TRow> = { [K in keyof TRow]: TRow[K] } & {};

/**
 * A grouped read (SQL `GROUP BY`): the query's conditions, grouped by one or more keys, with aggregate columns under
 * aliases. It selects only its keys and aggregates, loads nothing separately, and tracks nothing. `list()` returns every
 * group, past N/query's 5,000-row answer, sorted by the keys unless a sort says otherwise.
 */
export class GroupedQuery<TResult, TRow, TDeclared extends string = never, TSortable extends string = never> {
    private readonly grouping: Grouping;

    constructor(private readonly reader: GroupedQueryReader<TResult>, keys: string[]) {
        this.grouping = { keys, aggregates: [], sorts: [] };
    }

    /**
     * Adds an aggregate column over a field path, under `alias`. The aggregate is N/query's own name: COUNT and
     * COUNT_DISTINCT take any field; SUM, AVERAGE, MEDIAN and their DISTINCT forms take numbers (an integer's average
     * comes back whole); MINIMUM, MAXIMUM and their DISTINCT forms take any field and answer its type.
     */
    aggregate<TAggregate extends AggregateName, TField extends AggregatePathFor<TResult, TAggregate> | TDeclared, TAlias extends string>(
        aggregate: TAggregate,
        field: TField,
        alias: TAlias,
    ): GroupedQuery<TResult, TRow & { [K in TAlias]: AggregateValue<TAggregate, FieldValue<TResult, TField>> }, TDeclared, TSortable | TAlias> {
        this.grouping.aggregates.push({ alias, aggregate, field: String(field) });
        return this as unknown as GroupedQuery<TResult, TRow & { [K in TAlias]: AggregateValue<TAggregate, FieldValue<TResult, TField>> }, TDeclared, TSortable | TAlias>;
    }

    /**
     * Adds an aggregate column over an N/query formula (`{fieldid}` syntax, `{terms.daysuntilnetdue}` through a select
     * field), under `alias`, typed and coerced as the options say. A formula cannot itself hold an aggregate: to divide
     * one sum by another, aggregate both and divide the results.
     */
    aggregateFormula<TAggregate extends AggregateName, TAlias extends string, TFieldType extends FieldType | undefined = undefined>(
        aggregate: TAggregate,
        formula: string,
        alias: TAlias,
        options: FormulaAggregateOptions<TFieldType> = {},
    ): GroupedQuery<TResult, TRow & { [K in TAlias]: FormulaAggregateValue<TAggregate, TFieldType> }, TDeclared, TSortable | TAlias> {
        this.grouping.aggregates.push({ alias, aggregate, formula, formulaType: options.type, fieldType: options.fieldType, coerce: options.coerce, transform: options.transform });
        return this as unknown as GroupedQuery<TResult, TRow & { [K in TAlias]: FormulaAggregateValue<TAggregate, TFieldType> }, TDeclared, TSortable | TAlias>;
    }

    /**
     * Sorts by a group key or an aggregate alias. Keys sort in N/query; a sort on an aggregate is applied in script once
     * every group is read, since N/query renders it without the aggregate and fails (sandbox 2026-09-28).
     */
    orderBy(name: TSortable, direction: SortDirection = 'ASC'): this {
        this.grouping.sorts.push({ name, ascending: direction === 'ASC' });
        return this;
    }

    orderByAsc(name: TSortable): this {
        return this.orderBy(name, 'ASC');
    }

    orderByDesc(name: TSortable): this {
        return this.orderBy(name, 'DESC');
    }

    /** Every group, past N/query's 5,000-row answer, with the specifications applied the way `RecordSet.list()` applies them. */
    list(...specifications: Array<(query: QueryBuilder<TResult>) => QueryBuilder<TResult>>): Array<GroupRow<TRow>> {
        return this.reader.list(this.grouping, specifications) as Array<GroupRow<TRow>>;
    }

    /** What the grouped read asks N/query for, as plain data. */
    describe(): QueryDescription {
        return this.reader.describe(this.grouping);
    }

    /** The description rendered as stable text, for logs and tests. */
    describeText(): string {
        return renderQueryDescription(this.describe());
    }

    /** The SuiteQL NetSuite renders for the grouped read, for debugging. Nothing executes. */
    toSQL(): string {
        return this.reader.toSQL(this.grouping);
    }
}

function isBlank(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

/**
 * How two groups' values order, the way NetSuite orders them: blanks last ascending and first descending (probe k4),
 * numbers and dates by value, text upper-cased.
 */
function compareGroupValues(left: unknown, right: unknown, ascending: boolean): number {
    if (isBlank(left) || isBlank(right)) {
        if (isBlank(left) && isBlank(right)) {
            return 0;
        }
        return isBlank(left) === ascending ? 1 : -1;
    }
    let order: number;
    if (left instanceof Date && right instanceof Date) {
        order = left.getTime() - right.getTime();
    } else if (typeof left === 'number' && typeof right === 'number') {
        order = left - right;
    } else {
        const leftText = String(left).toUpperCase();
        const rightText = String(right).toUpperCase();
        order = leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    }
    return ascending ? order : -order;
}

/** The groups in the script sort's order; groups that tie keep the order N/query read them in. */
export function sortGroups<TGroup>(groups: TGroup[], sorts: DescribedScriptSort[]): TGroup[] {
    return groups
        .map((group, index) => ({ group, index }))
        .sort((left, right) => {
            for (const sort of sorts) {
                const order = compareGroupValues(getValueAtPath(left.group, sort.path), getValueAtPath(right.group, sort.path), sort.ascending);
                if (order !== 0) {
                    return order;
                }
            }
            return left.index - right.index;
        })
        .map((entry) => entry.group);
}
