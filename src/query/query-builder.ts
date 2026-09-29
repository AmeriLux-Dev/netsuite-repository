import type * as NsQuery from 'N/query';
import type { ConditionValue, FieldReference, FieldReferenceFor, FieldValue, GroupableFieldPath, GroupKeyValues, OperatorFor, ParamFor, RelationName, TextOperator } from '../field-path';
import { resolveQueryConfig } from '../model/resolve';
import type { QueryConfigSource } from '../model/resolve';
import type {
    AggregateName,
    ConditionNode,
    ConditionParamValue,
    DescribedColumn,
    DescribedComponent,
    DescribedSort,
    FieldMap,
    FieldType,
    FormulaReturnType,
    ListPage,
    ListPageOptions,
    NQueryOperatorName,
    PageWindow,
    QueryComponent,
    QueryConfig,
    QueryDescription,
    QueryExecution,
    QueryField,
    QueryOperator,
    QueryPageOptions,
    QueryResultValue,
    RelationshipLoad,
    SeparateLoadDescription,
    SortDirection,
} from '../types';
import { collectConditionComponents, combineConditions, conditionNodeForTranslation, rerootConditionNode } from './condition-nodes';
import type { LinkedCondition } from './condition-nodes';
import { GroupedQuery, numericAggregateNames, sortGroups } from './grouped-query';
import type { GroupAggregate, GroupedQueryReader, Grouping } from './grouped-query';
import { compileQueryDescriptionToNQuery, sortColumnAliases } from './n-query-compiler';
import { translateConditionOperator } from './operator-translation';
import { renderQueryDescription } from './query-description';
import {
    GovernanceLimitError,
    ReadGovernance,
    buildAfterRowCondition,
    decodeReadOnMarker,
    defaultGovernanceReserve,
    encodeReadOnMarker,
    readKeyValues,
    readOnComparisonFor,
    runRowLimit,
    withAddedCondition,
} from './read-on';
import type { ReadOnKey } from './read-on';
import { buildFieldMap, mapRowsToResults, normalizeMappedResultKey } from './result-mapper';
import type { ResultMappingOptions, ResultRow } from './result-mapper';
import { defaultSeparateLoadBatchSize, loadSeparateRelationsIntoResults } from './separate-relation-loader';

declare const require: <T = unknown>(moduleName: string) => T;

function getNsQuery(): typeof import('N/query') {
    return require<typeof import('N/query')>('N/query');
}

/** The page sizes N/query accepts for runPaged. */
export const minimumPageSize = 5;
export const maximumPageSize = 1000;

/** Alias of the column a separate query adds to carry the parent key back. */
export const parentKeyAlias = '__parentKey';

export interface QueryBuilderOptions<TResult> {
    /** Receives every typed result set (executeTyped, firstTyped) and may substitute instances; used by change tracking. */
    resultObserver?: (results: TResult[]) => TResult[];
    /** How many parent keys one separate-load query asks for at a time. */
    separateLoadBatchSize?: number;
    /**
     * The governance units a read past N/query's 5,000-row answer leaves the script: a list stops with a
     * GovernanceLimitError, and a page stops early, before a read that would dip into them. Defaults to 100.
     */
    governanceReserve?: number;
}

export interface FormulaSelectionOptions {
    /** N/query return type of the formula. */
    type?: FormulaReturnType;
    /** Field type used for read-side coercion and for typing conditions on the alias. */
    fieldType?: FieldType;
    nestPath?: string;
    coerce?: boolean;
    transform?: QueryField['transform'];
}

type SelectableField = [string, QueryField];

interface BuilderCondition extends LinkedCondition {
    /** Set when the condition belongs to a separately loaded relation; it is applied to that relation's query. */
    relationship?: string;
}

interface BuilderSort {
    sort: DescribedSort;
    relationship?: string;
    /** The field key the sort was asked for by, for messages. */
    key: string;
    /** How a read picks up after this sort's value; unset when no probe checked a comparison for its field. */
    readOn?: Pick<ReadOnKey, 'comparison' | 'fieldType' | 'isPrimary' | 'formulaPath' | 'throughReference'>;
}

/** What one execution needs: the description to compile and how to map the rows that come back. */
interface QueryPlan {
    description: QueryDescription;
    mapping: ResultMappingOptions;
    separateMappings: Map<string, ResultMappingOptions>;
    /** The sorts a read picks up after, the internal id last; unset when one of them cannot be compared. */
    readOnKeys?: ReadOnKey[];
    /** The sorts that cannot be compared, or the missing id, for the message listPage() refuses with. */
    readOnObstacle?: string;
}

/** A key of a grouped read: the name it was asked by, the field it resolves to, and where its value lands. */
interface GroupKeyPlan {
    name: string;
    key: string;
    field: QueryField;
    outputPath: string;
}

/** An aggregate of a grouped read: its column, how its value is mapped, and the field it reads, if any. */
interface GroupAggregatePlan {
    alias: string;
    column: DescribedColumn;
    mappingField: QueryField;
    source?: SelectableField;
}

/** A requested sort of a grouped read: on a key (sorted in N/query) or on an aggregate (sorted in script only). */
interface GroupSortPlan {
    key?: GroupKeyPlan;
    path: string;
    ascending: boolean;
}

interface GroupedReadPlan {
    description: QueryDescription;
    mapping: ResultMappingOptions;
    /** The keys a read picks up after, past 5,000 groups; unset when one of them cannot be compared. */
    readOnKeys?: ReadOnKey[];
}

/** What a field that SUM, AVERAGE, and MEDIAN refuse is, for the message: N/query fails to render those over them. */
const nonNumericFieldTypeNames: Partial<Record<FieldType, string>> = {
    date: 'a date',
    datetime: 'a date and time',
    string: 'text',
    boolean: 'a checkbox',
    checkbox: 'a checkbox',
};

/** The field type an aggregate's value is coerced to: a count is an integer, a sum or average a number. */
function aggregateValueType(aggregate: AggregateName, declared: FieldType | undefined): FieldType | undefined {
    if (aggregate === 'COUNT' || aggregate === 'COUNT_DISTINCT') {
        return 'integer';
    }
    return (numericAggregateNames as readonly string[]).includes(aggregate) ? declared ?? 'float' : declared;
}

/**
 * Runs a step against N/query and, when it fails, rethrows with the rendered query appended: NetSuite's message
 * names the problem ("Operator EQUAL is not valid for given search filter") but never the query.
 */
function withQueryInError<T>(description: QueryDescription, step: () => T): T {
    try {
        return step();
    } catch (error) {
        // Not N/query's failure: the guard's, which callers catch by its type.
        if (error instanceof GovernanceLimitError) {
            throw error;
        }
        const failure = error as { name?: string; message?: string } | undefined;
        const message = failure && typeof failure.message === 'string' ? failure.message : String(error);
        const named = failure && typeof failure.name === 'string' && failure.name !== 'Error' ? `${failure.name}: ${message}` : message;
        const wrapped = new Error(`${named}\nQuery:\n${renderQueryDescription(description)}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
    }
}

function omitUndefined<T extends object>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry;
        }
    }
    return result as T;
}

/**
 * The most records a condition can match because it pins the root's internal id: the distinct ids of an `ANY_OF` (or
 * a one-value `EQUAL`) on it, the smallest such count ANDed in, the sum over OR branches that all pin it. Undefined
 * when the condition does not pin the id.
 */
function countRecordsPinnedByCondition(node: ConditionNode, primaryFieldId: string): number | undefined {
    switch (node.kind) {
        case 'field': {
            const pinsId = node.component === undefined && node.fieldId === primaryFieldId && node.values !== undefined
                && (node.operator === 'ANY_OF' || (node.operator === 'EQUAL' && node.values.length === 1));
            return pinsId ? new Set((node.values as ConditionParamValue[]).map(String)).size : undefined;
        }
        case 'and': {
            const counts = node.nodes.map((child) => countRecordsPinnedByCondition(child, primaryFieldId)).filter((count): count is number => count !== undefined);
            return counts.length === 0 ? undefined : Math.min(...counts);
        }
        case 'or': {
            const counts = node.nodes.map((child) => countRecordsPinnedByCondition(child, primaryFieldId));
            return counts.every((count) => count !== undefined) ? (counts as number[]).reduce((total, count) => total + count, 0) : undefined;
        }
        default:
            return undefined;
    }
}

export class QueryBuilder<TResult, TDeclared extends string = never> {
    private readonly config: QueryConfig<TResult>;
    private readonly options: QueryBuilderOptions<TResult>;
    private trackingDisabled = false;
    private selectedKeys: Set<string> | null = null;
    private readonly formulaSelections = new Map<string, QueryField>();
    private readonly conditions: BuilderCondition[] = [];
    private readonly sorts: BuilderSort[] = [];
    private readonly includedRelationships = new Set<string>();
    private readonly excludedRelationships = new Set<string>();
    private limitValue: number | undefined;
    private offsetValue: number | undefined;
    private coerceEnabled: boolean;

    private constructor(config: QueryConfig<TResult>, options: QueryBuilderOptions<TResult> = {}) {
        this.config = config;
        this.options = options;
        this.coerceEnabled = config.coerce ?? false;
    }

    static from<TResult>(config: QueryConfigSource<TResult>, options: QueryBuilderOptions<TResult> = {}): QueryBuilder<TResult> {
        return new QueryBuilder(resolveQueryConfig(config), options);
    }

    // ── projection ────────────────────────────────────────────────────────────

    /** Loads a reference, subrecord, or sublist that is not selected by default (EF Include). */
    include(...relationships: Array<RelationName<TResult>>): this {
        for (const name of relationships) {
            this.assertRelationship(name);
            this.includedRelationships.add(name);
            this.excludedRelationships.delete(name);
        }
        return this;
    }

    /** Leaves a reference, subrecord, or sublist and its joins out of this query. */
    exclude(...relationships: Array<RelationName<TResult>>): this {
        for (const name of relationships) {
            this.assertRelationship(name);
            this.excludedRelationships.add(name);
            this.includedRelationships.delete(name);
        }
        return this;
    }

    /** Results of this query are not registered with the owning context (EF AsNoTracking). */
    asNoTracking(): this {
        this.trackingDisabled = true;
        return this;
    }

    select(...keys: Array<FieldReference<TResult, TDeclared>>): this {
        if (!this.selectedKeys) {
            this.selectedKeys = new Set<string>();
        }
        for (const key of keys) {
            this.selectedKeys.add(this.normalizeFieldKey(String(key)));
        }
        return this;
    }

    selectAll(): this {
        this.selectedKeys = null;
        return this;
    }

    /**
     * Adds a formula column (N/query `{fieldid}` syntax) mapped onto the result under `alias`, usable in where()
     * and orderBy() by that alias. The only way to read a value the model does not declare.
     */
    selectFormula<TAlias extends string>(formula: string, alias: TAlias, options: FormulaSelectionOptions = {}): QueryBuilder<TResult, TDeclared | TAlias> {
        if (this.config.fields[alias] || this.formulaSelections.has(alias)) {
            throw new Error(`Alias '${alias}' is already used by a field in query config for '${this.config.recordType}'.`);
        }
        this.formulaSelections.set(alias, omitUndefined({
            queryFieldId: alias,
            alias,
            formula,
            formulaType: options.type,
            type: options.fieldType,
            nestPath: options.nestPath,
            coerce: options.coerce,
            transform: options.transform,
        }));
        return this;
    }

    // ── conditions ────────────────────────────────────────────────────────────

    /**
     * Adds an AND condition. The operators and the value are typed from the property the field path points at:
     * text takes equality, LIKE, and IN; numbers add order comparisons and BETWEEN; dates take order comparisons
     * and BETWEEN with Date values; a checkbox takes a boolean or 'T'/'F'. Any N/query operator name is accepted
     * too. With `useText` the comparison is made against the display text, so the text operators and string values
     * apply whatever the field. An undefined value skips the condition.
     */
    where<TField extends FieldReference<TResult, TDeclared>, TOperator extends OperatorFor<FieldValue<TResult, TField>>>(field: TField, operator: TOperator, value?: ConditionValue<FieldValue<TResult, TField>, TOperator>, useText?: false): this;
    where<TOperator extends TextOperator>(field: FieldReference<TResult, TDeclared>, operator: TOperator, value: ConditionValue<string, TOperator> | undefined, useText: true): this;
    where(field: FieldReference<TResult, TDeclared>, operator: QueryOperator, value?: ConditionParamValue | ConditionParamValue[], useText = false): this {
        return this.addWhere('AND', String(field), operator, value, useText);
    }

    /** Adds an OR condition; see where() for how the operators and the value are typed. */
    orWhere<TField extends FieldReference<TResult, TDeclared>, TOperator extends OperatorFor<FieldValue<TResult, TField>>>(field: TField, operator: TOperator, value?: ConditionValue<FieldValue<TResult, TField>, TOperator>, useText?: false): this;
    orWhere<TOperator extends TextOperator>(field: FieldReference<TResult, TDeclared>, operator: TOperator, value: ConditionValue<string, TOperator> | undefined, useText: true): this;
    orWhere(field: FieldReference<TResult, TDeclared>, operator: QueryOperator, value?: ConditionParamValue | ConditionParamValue[], useText = false): this {
        return this.addWhere('OR', String(field), operator, value, useText);
    }

    /**
     * Adds an AND condition written as an N/query formula. With no operator the formula is a condition in its own right
     * (`{trandate} + 30 > TRUNC(CURRENT_DATE)`), sent as `CASE WHEN <formula> THEN 1 ELSE 0 END` compared EQUAL 1, the
     * form N/query accepts; with an operator it is a value of the given type compared to `value`. Values written in the
     * formula are part of its text. N/query's formulas have no SYSDATE: write TRUNC(CURRENT_DATE).
     */
    whereFormula(formula: string, type: FormulaReturnType = 'BOOLEAN', operator?: NQueryOperatorName, value?: ConditionParamValue | ConditionParamValue[]): this {
        return this.addFormulaCondition('AND', formula, type, operator, value);
    }

    /** Adds an OR condition written as an N/query formula; see whereFormula(). */
    orWhereFormula(formula: string, type: FormulaReturnType = 'BOOLEAN', operator?: NQueryOperatorName, value?: ConditionParamValue | ConditionParamValue[]): this {
        return this.addFormulaCondition('OR', formula, type, operator, value);
    }

    /** IN over a text or numeric field; skipped when the list is empty or undefined. */
    whereIn<TField extends FieldReferenceFor<TResult, TDeclared, 'IN'>>(field: TField, values: Array<ParamFor<FieldValue<TResult, TField>>> | undefined): this {
        return values && values.length > 0 ? this.addWhere('AND', String(field), 'IN', values) : this;
    }

    /** NOT IN over a text or numeric field; skipped when the list is empty or undefined. */
    whereNotIn<TField extends FieldReferenceFor<TResult, TDeclared, 'NOT IN'>>(field: TField, values: Array<ParamFor<FieldValue<TResult, TField>>> | undefined): this {
        return values && values.length > 0 ? this.addWhere('AND', String(field), 'NOT IN', values) : this;
    }

    whereNull(field: FieldReference<TResult, TDeclared>): this {
        return this.addWhere('AND', String(field), 'IS NULL');
    }

    whereNotNull(field: FieldReference<TResult, TDeclared>): this {
        return this.addWhere('AND', String(field), 'IS NOT NULL');
    }

    /** BETWEEN over a numeric or date field; skipped when either bound is undefined. */
    whereBetween<TField extends FieldReferenceFor<TResult, TDeclared, 'BETWEEN'>>(field: TField, min: ParamFor<FieldValue<TResult, TField>> | undefined, max: ParamFor<FieldValue<TResult, TField>> | undefined): this {
        return min === undefined || max === undefined ? this : this.addWhere('AND', String(field), 'BETWEEN', [min, max]);
    }

    whereGroup(callback: (builder: QueryBuilder<TResult, TDeclared>) => QueryBuilder<TResult, any>): this {
        return this.addWhereGroup('AND', callback);
    }

    orWhereGroup(callback: (builder: QueryBuilder<TResult, TDeclared>) => QueryBuilder<TResult, any>): this {
        return this.addWhereGroup('OR', callback);
    }

    // ── ordering and paging ───────────────────────────────────────────────────

    orderBy(field: FieldReference<TResult, TDeclared>, direction: SortDirection = 'ASC'): this {
        const { key, field: resolved } = this.resolveField(String(field));
        const sort = this.describedSortFor(resolved, direction === 'ASC');
        this.sorts.push(omitUndefined({ sort, relationship: this.separateRelationshipOf(key, resolved), key, readOn: this.readOnFor(resolved) }));
        return this;
    }

    private describedSortFor(field: QueryField, ascending: boolean): DescribedSort {
        return field.formula !== undefined
            ? omitUndefined({ formula: field.formula, formulaType: field.formulaType, ascending })
            : omitUndefined({ component: field.component, fieldId: field.queryFieldId, context: field.fieldContext, ascending });
    }

    /** How a read picks up after a sort on this field: formulas and display text have no comparison a probe checked. */
    private readOnFor(field: QueryField): BuilderSort['readOn'] {
        if (field.formula !== undefined || field.fieldContext === 'DISPLAY') {
            return undefined;
        }
        const fieldType: FieldType | undefined = field.isPrimary ? 'key' : field.type;
        const comparison = readOnComparisonFor(fieldType);
        if (comparison === undefined || fieldType === undefined) {
            return undefined;
        }
        if (comparison !== 'text' || field.component === undefined) {
            return { comparison, fieldType, isPrimary: Boolean(field.isPrimary) };
        }
        // Text reads on through a formula, which names a joined record by the select field that joins it, and cannot
        // name one joined from its lines at all.
        const formulaPath = this.formulaPathOf(field.component);
        return formulaPath === undefined ? undefined : { comparison, fieldType, isPrimary: false, formulaPath, throughReference: this.joinsThroughReference(field.component) };
    }

    /** Whether a component hangs off a reference's select field (joinTo), anywhere between it and the root. */
    private joinsThroughReference(componentPath: string): boolean {
        for (let path: string | undefined = componentPath; path !== undefined; path = this.config.components?.[path]?.parent) {
            if (this.config.components?.[path]?.join.kind === 'to') {
                return true;
            }
        }
        return false;
    }

    orderByAsc(field: FieldReference<TResult, TDeclared>): this {
        return this.orderBy(field, 'ASC');
    }

    orderByDesc(field: FieldReference<TResult, TDeclared>): this {
        return this.orderBy(field, 'DESC');
    }

    limit(count: number): this {
        this.limitValue = Math.max(0, Math.floor(count));
        return this;
    }

    offset(count: number): this {
        this.offsetValue = Math.max(0, Math.floor(count));
        return this;
    }

    page(pageNumber: number, pageSize: number): this {
        const safePage = Math.max(1, Math.floor(pageNumber));
        const safePageSize = Math.max(1, Math.floor(pageSize));
        this.limitValue = safePageSize;
        this.offsetValue = (safePage - 1) * safePageSize;
        return this;
    }

    /** Enables or disables read-side coercion of values to their declared field types for this query. */
    coerce(enabled = true): this {
        this.coerceEnabled = enabled;
        return this;
    }

    // ── grouping ──────────────────────────────────────────────────────────────

    /**
     * Starts a grouped read (SQL GROUP BY) of this query's conditions: `aggregate()` and `aggregateFormula()` add the
     * aggregate columns, `list()` returns every group. A key is a field path whose declared type holds one value,
     * sublist fields included (each line is a row), or an alias this query declared with selectFormula(). The grouped
     * read works on a copy, so this query is left as it was.
     */
    groupBy<TKey extends GroupableFieldPath<TResult> | TDeclared>(...keys: [TKey, ...TKey[]]): GroupedQuery<TResult, GroupKeyValues<TResult, TKey>, TDeclared, TKey> {
        if (keys.length === 0) {
            throw new Error(`A grouped read of '${this.config.recordType}' needs at least one key to group by.`);
        }
        return new GroupedQuery<TResult, GroupKeyValues<TResult, TKey>, TDeclared, TKey>(this.copy().groupedQueryReader(), keys.map(String));
    }

    /** How a grouped query plans and reads through this query; specifications are applied to a copy of it per read. */
    private groupedQueryReader(): GroupedQueryReader<TResult> {
        return {
            describe: (grouping) => this.planGroupedRead(grouping).description,
            toSQL: (grouping) => {
                const { description } = this.planGroupedRead(grouping);
                return withQueryInError(description, () => compileQueryDescriptionToNQuery(description, getNsQuery()).toSuiteQL().query);
            },
            list: (grouping, specifications) => {
                const source = specifications.reduce((current, specification) => specification(current), this.copy() as unknown as QueryBuilder<TResult>);
                return source.readGroups(grouping);
            },
        };
    }

    /** An independent copy of this query: its selection, conditions, sorts, relations, page window, and options. */
    private copy(): QueryBuilder<TResult, TDeclared> {
        const copy = new QueryBuilder<TResult, TDeclared>(this.config, this.options);
        copy.trackingDisabled = this.trackingDisabled;
        copy.selectedKeys = this.selectedKeys ? new Set(this.selectedKeys) : null;
        this.formulaSelections.forEach((field, alias) => copy.formulaSelections.set(alias, field));
        copy.conditions.push(...this.conditions);
        copy.sorts.push(...this.sorts);
        this.includedRelationships.forEach((name) => copy.includedRelationships.add(name));
        this.excludedRelationships.forEach((name) => copy.excludedRelationships.add(name));
        copy.limitValue = this.limitValue;
        copy.offsetValue = this.offsetValue;
        copy.coerceEnabled = this.coerceEnabled;
        return copy;
    }

    /**
     * The plan of a grouped read: the keys as columns marked groupBy, the aggregates, this query's conditions and the
     * model's, and the keys as the query's order: those a sort names first, the rest ascending after them, which is
     * complete since each group has its own keys. N/query sorts on keys only (a sort on an aggregate renders without
     * the aggregate and fails, sandbox 2026-09-28), so a sort that names an aggregate orders the groups in script.
     */
    private planGroupedRead(grouping: Grouping): GroupedReadPlan {
        const keys = Array.from(new Set(grouping.keys)).map((name) => this.resolveGroupKey(name));
        const aggregates = grouping.aggregates.map((aggregate) => this.resolveGroupAggregate(aggregate));
        this.assertGroupAliasesUnique(keys, aggregates);
        for (const condition of this.conditions) {
            if (condition.relationship !== undefined) {
                throw new Error(this.describeSeparateRelationInGroupedRead(condition.relationship, 'apply a condition on it'));
            }
        }

        const requestedSorts: GroupSortPlan[] = [
            ...this.sorts.map((sort) => this.groupSortFor(sort.key, sort.sort.ascending, keys, [])),
            ...grouping.sorts.map((sort) => this.groupSortFor(sort.name, sort.ascending, keys, aggregates)),
        ];
        const keyDirections = new Map<GroupKeyPlan, boolean>();
        for (const sort of requestedSorts) {
            if (sort.key && !keyDirections.has(sort.key)) {
                keyDirections.set(sort.key, sort.ascending);
            }
        }
        for (const key of keys) {
            if (!keyDirections.has(key)) {
                keyDirections.set(key, true);
            }
        }
        const keySorts = Array.from(keyDirections, ([key, ascending]) => ({ key, sort: this.describedSortFor(key.field, ascending) }));

        const keyFields = keys.map((key): SelectableField => [key.key, key.field]);
        const description: QueryDescription = omitUndefined({
            queryType: this.config.queryType ?? this.config.recordType,
            components: this.collectComponents(
                [...keyFields, ...aggregates.flatMap((aggregate) => (aggregate.source ? [aggregate.source] : []))],
                this.conditions.map((condition) => condition.node),
                keySorts.map((entry) => entry.sort),
            ),
            columns: [...keys.map((key) => ({ ...this.toColumn(key.key, key.field), groupBy: true })), ...aggregates.map((aggregate) => aggregate.column)],
            condition: this.combineWithRootConditions(combineConditions(this.conditions)),
            sort: keySorts.map((entry) => entry.sort),
            scriptSort: requestedSorts.some((sort) => sort.key === undefined) ? requestedSorts.map((sort) => ({ path: sort.path, ascending: sort.ascending })) : undefined,
        });

        const readOns = keySorts.map((entry) => this.readOnFor(entry.key.field));
        const aliases = sortColumnAliases(description);
        return {
            description,
            mapping: {
                fieldMap: buildFieldMap([...keyFields, ...aggregates.map((aggregate): SelectableField => [aggregate.alias, aggregate.mappingField])]),
                arrayPaths: [],
                coerceEnabled: this.coerceEnabled,
            },
            readOnKeys: readOns.every((readOn) => readOn !== undefined)
                ? keySorts.map((entry, index) => ({ sort: entry.sort, alias: aliases[index], ...(readOns[index] as NonNullable<BuilderSort['readOn']>) }))
                : undefined,
        };
    }

    private resolveGroupKey(name: string): GroupKeyPlan {
        const { key, field } = this.resolveField(name);
        this.assertReadableInGroupedRead(key, field, `group by '${name}'`);
        return { name, key, field, outputPath: field.nestPath ?? key };
    }

    private resolveGroupAggregate(aggregate: GroupAggregate): GroupAggregatePlan {
        const { alias } = aggregate;
        if (aggregate.field === undefined) {
            return {
                alias,
                column: omitUndefined({ alias, formula: aggregate.formula, formulaType: aggregate.formulaType, aggregate: aggregate.aggregate }),
                mappingField: omitUndefined({ queryFieldId: alias, alias, type: aggregateValueType(aggregate.aggregate, aggregate.fieldType), coerce: aggregate.coerce, transform: aggregate.transform }),
            };
        }
        const { key, field } = this.resolveField(aggregate.field);
        this.assertReadableInGroupedRead(key, field, `aggregate '${aggregate.field}'`);
        // Display text is text, whatever the field's own type.
        const declaredType = field.fieldContext === 'DISPLAY' ? 'string' : field.type;
        const nonNumeric = declaredType === undefined ? undefined : nonNumericFieldTypeNames[declaredType];
        if (nonNumeric !== undefined && (numericAggregateNames as readonly string[]).includes(aggregate.aggregate)) {
            throw new Error(`${aggregate.aggregate} takes a number, and '${aggregate.field}' of '${this.config.recordType}' is ${nonNumeric}: N/query fails to render it. COUNT, MINIMUM and MAXIMUM take any field.`);
        }
        const column: DescribedColumn = field.formula !== undefined
            ? omitUndefined({ alias, formula: field.formula, formulaType: field.formulaType, aggregate: aggregate.aggregate })
            : omitUndefined({ alias, component: field.component, fieldId: field.queryFieldId, context: field.fieldContext, aggregate: aggregate.aggregate });
        return {
            alias,
            column,
            mappingField: omitUndefined({ queryFieldId: alias, alias, type: aggregateValueType(aggregate.aggregate, declaredType), coerce: field.coerce }),
            source: [key, field],
        };
    }

    /** A field a grouped read can read: one value per row, on a relation its own query joins. */
    private assertReadableInGroupedRead(key: string, field: QueryField, purpose: string): void {
        if (field.type === 'multiselect') {
            throw new Error(`'${key}' of '${this.config.recordType}' is a multi-select, which holds several values: a grouped read cannot group by it or aggregate it.`);
        }
        const relationship = this.separateRelationshipOf(key, field);
        if (relationship !== undefined) {
            throw new Error(this.describeSeparateRelationInGroupedRead(relationship, purpose, field));
        }
    }

    private describeSeparateRelationInGroupedRead(relationship: string, purpose: string, field?: QueryField): string {
        const path = field?.component === undefined ? undefined : this.formulaPathOf(field.component);
        const formula = field === undefined || path === undefined ? '' : ` A formula reaches the field: {${path}.${field.queryFieldId}}.`;
        return `'${relationship}' of '${this.config.recordType}' is loaded separately (load: 'separate'), and a grouped read reads nothing separately, so it cannot ${purpose}.${formula}`;
    }

    /** Each group's row holds its keys at their paths and its aggregates at their aliases: no alias may take another's place. */
    private assertGroupAliasesUnique(keys: GroupKeyPlan[], aggregates: GroupAggregatePlan[]): void {
        const taken = new Set<string>();
        for (const key of keys) {
            taken.add(normalizeMappedResultKey(key.field.alias ?? key.key));
            taken.add(normalizeMappedResultKey(key.outputPath.split('.')[0]));
        }
        for (const aggregate of aggregates) {
            const alias = normalizeMappedResultKey(aggregate.alias);
            if (taken.has(alias)) {
                throw new Error(`Alias '${aggregate.alias}' is already used by a group key or an aggregate of '${this.config.recordType}'.`);
            }
            taken.add(alias);
        }
    }

    /** A sort by name: an aggregate's alias, or a key by the name it was grouped by or its field key. */
    private groupSortFor(name: string, ascending: boolean, keys: GroupKeyPlan[], aggregates: GroupAggregatePlan[]): GroupSortPlan {
        const aggregate = aggregates.find((candidate) => candidate.alias === name);
        if (aggregate) {
            return { path: aggregate.alias, ascending };
        }
        const fieldKey = this.normalizeFieldKey(name);
        const key = keys.find((candidate) => candidate.name === name || candidate.key === fieldKey);
        if (!key) {
            throw new Error(`A grouped read of '${this.config.recordType}' sorts by its group keys and aggregates, and '${name}' is neither.`);
        }
        return { key, path: key.outputPath, ascending };
    }

    /** Every group of a grouped read: mapped, sorted in script when a sort names an aggregate, and cut to the page window. */
    private readGroups(grouping: Grouping): Array<Record<string, unknown>> {
        const plan = this.planGroupedRead(grouping);
        const groups = mapRowsToResults<Record<string, unknown>>(this.readEveryRowOf(plan.description, plan.readOnKeys), plan.mapping);
        const sorted = plan.description.scriptSort ? sortGroups(groups, plan.description.scriptSort) : groups;
        if (!this.hasPageWindow()) {
            return sorted;
        }
        const offset = this.offsetValue ?? 0;
        return sorted.slice(offset, this.limitValue === undefined ? undefined : offset + this.limitValue);
    }

    // ── execution ─────────────────────────────────────────────────────────────

    /** What this query asks N/query for, as plain data. */
    describe(): QueryDescription {
        return this.plan(true).description;
    }

    /** The description rendered as stable text, for logs and tests. */
    describeText(): string {
        return renderQueryDescription(this.describe());
    }

    execute(): QueryExecution<TResult> {
        const plan = this.plan(true);
        return { data: this.readRows(plan), query: plan.description };
    }

    executeRaw(): Record<string, QueryResultValue>[] {
        return this.execute().data;
    }

    executeTyped(): TResult[] {
        const fansOut = this.plan(false).mapping.arrayPaths.length > 0;
        // Joined sublists fan rows out, so a row window would cut records short; those queries page over mapped records instead.
        const plan = this.plan(!fansOut);
        return this.buildTypedResults(this.readRows(plan), plan, fansOut && this.hasPageWindow());
    }

    /**
     * One page of the typed results, read across requests: up to `limit` records after the page `after` names, and
     * `next` to name this one. Each page picks up after the last record by its sort values, so a record changed
     * between two pages cannot shift the rest; a page larger than N/query's 5,000-row answer is read on in several.
     * When the script cannot afford another read, the page stops early and `next` says where. Needs every sort to be
     * one a read can compare (the id, numbers, dates, text) and no joined sublist, which answers a row per line.
     */
    executeTypedPage(options: ListPageOptions): ListPage<TResult> {
        const { limit } = options;
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error(`A page needs a limit of at least one record; it was given ${limit}.`);
        }
        const plan = this.plan(false);
        if (plan.mapping.arrayPaths.length > 0) {
            throw new Error(`A page picks up after its last record, and ${plan.mapping.arrayPaths.join(', ')} of '${this.config.recordType}' is a joined sublist that answers a row per line: load it separately (load: 'separate') to page these records.`);
        }
        const keys = plan.readOnKeys;
        if (!keys) {
            throw new Error(`A page picks up after its last record by its sort values, and ${plan.readOnObstacle}: sort by the id, a number, a date or text to page these records.`);
        }

        const governance = new ReadGovernance(this.governanceReserve());
        let afterValues = options.after === undefined || options.after === null ? undefined : decodeReadOnMarker(options.after, keys);
        const rows: ResultRow[] = [];
        let hasMore: boolean;
        for (;;) {
            const description = afterValues === undefined ? plan.description : withAddedCondition(plan.description, buildAfterRowCondition(keys, afterValues));
            const answer = governance.measure(() => this.executeDescription(description));
            const wanted = limit - rows.length;
            rows.push(...answer.slice(0, wanted));
            if (answer.length > wanted) {
                hasMore = true;
                break;
            }
            if (answer.length < runRowLimit) {
                hasMore = false;
                break;
            }
            if (rows.length === limit || governance.shortfall()) {
                hasMore = true;
                break;
            }
            afterValues = readKeyValues(keys, answer[answer.length - 1]);
        }
        return {
            items: this.buildTypedResults(rows, plan, false),
            next: hasMore && rows.length > 0 ? encodeReadOnMarker(readKeyValues(keys, rows[rows.length - 1])) : null,
        };
    }

    /** Rows into typed results: mapped, cut to the page window when rows fanned out, related records loaded, tracked. */
    private buildTypedResults(rows: ResultRow[], plan: QueryPlan, sliceWindow: boolean): TResult[] {
        let results = mapRowsToResults<TResult>(rows, plan.mapping);
        if (sliceWindow) {
            const offset = this.offsetValue ?? 0;
            results = results.slice(offset, this.limitValue === undefined ? undefined : offset + this.limitValue);
        }
        this.loadSeparateRelations(results as unknown as object[], plan);
        const { postProcess } = this.config;
        const finalResults = postProcess ? results.map((row) => postProcess(row) ?? row) : results;
        return this.trackingDisabled || !this.options.resultObserver ? finalResults : this.options.resultObserver(finalResults);
    }

    /** Runs the query through N/query's paging and hands the pages back untouched. */
    executePaged(options: QueryPageOptions = {}): NsQuery.PagedData {
        const query = compileQueryDescriptionToNQuery(this.plan(false).description, getNsQuery());
        return query.runPaged({ pageSize: Math.min(maximumPageSize, Math.max(minimumPageSize, options.pageSize ?? maximumPageSize)) });
    }

    first(): Record<string, QueryResultValue> | null {
        return this.withLimit(1, () => this.executeRaw()[0] ?? null);
    }

    firstTyped(): TResult | null {
        return this.withLimit(1, () => this.executeTyped()[0] ?? null);
    }

    /** Counts records, not rows: with a joined sublist the primary key is counted distinct. */
    count(): number {
        const plan = this.plan(false);
        const primary = this.primaryField();
        if (!primary) {
            throw new Error(`A primary key field is required to count '${this.config.recordType}'.`);
        }
        const description: QueryDescription = {
            ...plan.description,
            columns: [{ alias: 'count', fieldId: primary.field.queryFieldId, aggregate: plan.description.components.length > 0 ? 'COUNT_DISTINCT' : 'COUNT' }],
            sort: [],
            separateLoads: [],
        };
        const rows = this.executeDescription(description);
        return Number(rows[0]?.count ?? 0);
    }

    exists(): boolean {
        return this.withLimit(1, () => this.executeRaw().length > 0);
    }

    /** The SuiteQL NetSuite renders for this query, for debugging. Costs nothing; nothing executes. */
    toSQL(): string {
        const description = this.plan(true).description;
        return withQueryInError(description, () => compileQueryDescriptionToNQuery(description, getNsQuery()).toSuiteQL().query);
    }

    // ── planning ──────────────────────────────────────────────────────────────

    private plan(includePage: boolean): QueryPlan {
        const activeFields = this.collectSelectableFields();
        const separateRelationships = this.activeSeparateRelationships();
        const mainFields = activeFields.filter(([key, field]) => !separateRelationships.has(this.relationshipOf(key, field) ?? ''));
        const mainConditions = this.conditions.filter((condition) => condition.relationship === undefined);
        const mainSorts = this.withPrimaryKeySort(this.sorts.filter((sort) => sort.relationship === undefined));
        const components = this.collectComponents(mainFields, mainConditions.map((condition) => condition.node), mainSorts.map((sort) => sort.sort));

        const columns = mainFields.map(([key, field]) => this.toColumn(key, field));
        if (columns.length === 0) {
            throw new Error('At least one selectable field is required.');
        }

        const separateMappings = new Map<string, ResultMappingOptions>();
        const separateLoads: SeparateLoadDescription[] = [];
        for (const relationship of separateRelationships) {
            const relationFields = activeFields.filter(([key, field]) => this.relationshipOf(key, field) === relationship);
            if (relationFields.length === 0) {
                continue;
            }
            const { load, mapping } = this.planSeparateLoad(relationship, relationFields);
            separateLoads.push(load);
            separateMappings.set(relationship, mapping);
        }

        const description: QueryDescription = omitUndefined({
            queryType: this.config.queryType ?? this.config.recordType,
            components,
            columns,
            condition: this.combineWithRootConditions(combineConditions(mainConditions)),
            sort: mainSorts.map((sort) => sort.sort),
            page: includePage ? this.pageWindow() : undefined,
            separateLoads,
        });

        return {
            description,
            mapping: this.mappingOptions(mainFields, this.primaryAlias()),
            separateMappings,
            ...this.planReadOn(mainSorts, description),
        };
    }

    /**
     * The query's own sorts, then the internal id: a complete order, so a read past N/query's 5,000-row answer can pick
     * up after the last row, and rows that tie on the sorts never change places between reads. Nothing is added when
     * the id is sorted on already.
     */
    private withPrimaryKeySort(sorts: BuilderSort[]): BuilderSort[] {
        const primary = this.primaryField();
        if (!primary || sorts.some((sort) => sort.readOn?.isPrimary)) {
            return sorts;
        }
        const sort: DescribedSort = omitUndefined({ component: primary.field.component, fieldId: primary.field.queryFieldId, ascending: true });
        return [...sorts, { sort, key: primary.key, readOn: { comparison: 'ordered', fieldType: 'key', isPrimary: true } }];
    }

    /** The sorts a read picks up after, up to the internal id, which completes the order; or why there are none. */
    private planReadOn(sorts: BuilderSort[], description: QueryDescription): Pick<QueryPlan, 'readOnKeys' | 'readOnObstacle'> {
        const primaryIndex = sorts.findIndex((sort) => sort.readOn?.isPrimary);
        if (primaryIndex === -1) {
            return { readOnObstacle: `'${this.config.recordType}' declares no internal id to read on by` };
        }
        const keySorts = sorts.slice(0, primaryIndex + 1);
        const uncomparable = keySorts.filter((sort) => sort.readOn === undefined).map((sort) => sort.key);
        if (uncomparable.length > 0) {
            return { readOnObstacle: `'${this.config.recordType}' is sorted by ${uncomparable.join(', ')}, which no read can compare (select fields, checkboxes, datetimes, display text and formulas)` };
        }
        const aliases = sortColumnAliases(description);
        return { readOnKeys: keySorts.map((sort, index) => ({ sort: sort.sort, alias: aliases[index], ...(sort.readOn as NonNullable<BuilderSort['readOn']>) })) };
    }

    private planSeparateLoad(relationship: string, relationFields: SelectableField[]): { load: SeparateLoadDescription; mapping: ResultMappingOptions } {
        const component = this.config.components?.[relationship];
        const kind = this.config.relationships?.[relationship]?.kind as SeparateLoadDescription['kind'];
        if (!component) {
            throw new Error(`Relationship '${relationship}' has no component in query config for '${this.config.recordType}'.`);
        }
        const conditions = this.conditions.filter((condition) => condition.relationship === relationship);
        const sorts = this.sorts.filter((sort) => sort.relationship === relationship).map((sort) => sort.sort);
        const relationComponents = Object.values(this.config.components ?? {}).filter((candidate) => candidate.path === relationship || candidate.path.startsWith(`${relationship}.`));

        if (kind === 'reference') {
            const separate = component.separate;
            if (!separate) {
                throw new Error(`Reference '${relationship}' is loaded separately but declares no separate load in query config for '${this.config.recordType}'.`);
            }
            const parentKeyField = this.config.fields[separate.parentKeyField];
            const reroot = (path: string | undefined): string | undefined => (path === relationship ? undefined : path);
            const nested = relationComponents.filter((candidate) => candidate.path !== relationship);
            const columns = [
                ...relationFields.map(([key, field]) => omitUndefined({ ...this.toColumn(key, field), component: reroot(field.component) })),
                { alias: parentKeyAlias, fieldId: separate.targetKeyFieldId },
            ];
            const description: QueryDescription = omitUndefined({
                queryType: separate.queryType,
                components: this.orderComponents(nested).map((candidate) => omitUndefined({ ...this.toDescribedComponent(candidate), parent: reroot(candidate.parent) })),
                columns,
                condition: combineConditions(conditions.map((condition) => ({ ...condition, node: rerootConditionNode(condition.node, relationship) }))),
                sort: sorts.map((sort) => omitUndefined({ ...sort, component: reroot(sort.component) })),
            });
            return {
                load: { relationship, kind, description, parentKeyPath: parentKeyField.nestPath ?? separate.parentKeyField, batchFieldId: separate.targetKeyFieldId, batchFieldType: separate.targetKeyFieldType ?? 'key', parentKeyAlias },
                mapping: this.relationMappingOptions(relationship, relationFields, kind),
            };
        }

        const primary = this.primaryField();
        if (!primary) {
            throw new Error(`A primary key field is required to load '${relationship}' separately on '${this.config.recordType}'.`);
        }
        // A has-many joined `from` a field on the child (its @ParentId() field) runs on the child's own type when loaded
        // separately: the rows are the items, so the relation's fields, conditions, sorts, and nested components are
        // rerooted at the child, the sublist filter becomes a root condition, and each batch matches the child's parent
        // field against the owners' keys.
        if (component.separate && component.join.kind === 'from') {
            const separate = component.separate;
            const parentKeyField = this.config.fields[separate.parentKeyField] ?? primary.field;
            const reroot = (path: string | undefined): string | undefined => (path === relationship ? undefined : path);
            const nested = relationComponents.filter((candidate) => candidate.path !== relationship);
            const columns = [
                ...relationFields.map(([key, field]) => omitUndefined({ ...this.toColumn(key, field), component: reroot(field.component) })),
                { alias: parentKeyAlias, fieldId: separate.targetKeyFieldId },
            ];
            const filterNodes: ConditionNode[] = (component.conditions ?? []).map((condition) => omitUndefined({ kind: 'field' as const, fieldId: condition.fieldId, operator: condition.operator, values: condition.values }));
            const userCondition = combineConditions(conditions.map((condition) => ({ ...condition, node: rerootConditionNode(condition.node, relationship) })));
            const conditionNodes = [...filterNodes, ...(userCondition ? [userCondition] : [])];
            const defaultSort: DescribedSort[] = component.lineOrderFieldId ? [omitUndefined({ component: reroot(component.lineOrderComponent), fieldId: component.lineOrderFieldId, ascending: true })] : [];
            const description: QueryDescription = omitUndefined({
                queryType: separate.queryType,
                components: this.orderComponents(nested).map((candidate) => omitUndefined({ ...this.toDescribedComponent(candidate), parent: reroot(candidate.parent) })),
                columns,
                condition: conditionNodes.length === 0 ? undefined : conditionNodes.length === 1 ? conditionNodes[0] : { kind: 'and', nodes: conditionNodes },
                sort: (sorts.length > 0 ? sorts : defaultSort).map((sort) => omitUndefined({ ...sort, component: reroot(sort.component) })),
            });
            return {
                load: { relationship, kind, description, parentKeyPath: parentKeyField.nestPath ?? separate.parentKeyField, batchFieldId: separate.targetKeyFieldId, batchFieldType: separate.targetKeyFieldType ?? 'select', parentKeyAlias },
                mapping: this.relationMappingOptions(relationship, relationFields, kind),
            };
        }

        // A sublist may run its own query on another root (a sales order's lines hang off `transaction`); it then matches
        // the owner by internal id and the owner's root conditions do not apply.
        const ownRoot = component.separate;
        const batchFieldId = ownRoot?.targetKeyFieldId ?? primary.field.queryFieldId;
        const columns = [...relationFields.map(([key, field]) => this.toColumn(key, field)), { alias: parentKeyAlias, fieldId: batchFieldId }];
        const defaultSort: DescribedSort[] = component.lineOrderFieldId ? [{ component: component.lineOrderComponent ?? relationship, fieldId: component.lineOrderFieldId, ascending: true }] : [];
        const description: QueryDescription = omitUndefined({
            queryType: ownRoot?.queryType ?? this.config.queryType ?? this.config.recordType,
            components: this.orderComponents(relationComponents).map((candidate) => this.toDescribedComponent(candidate)),
            columns,
            condition: ownRoot ? combineConditions(conditions) : this.combineWithRootConditions(combineConditions(conditions)),
            sort: sorts.length > 0 ? sorts : defaultSort,
        });
        return {
            load: { relationship, kind, description, parentKeyPath: primary.field.nestPath ?? primary.key, batchFieldId, batchFieldType: ownRoot?.targetKeyFieldType ?? 'key', parentKeyAlias },
            mapping: this.relationMappingOptions(relationship, relationFields, kind),
        };
    }

    /** Output paths inside a separately loaded relation are relative to it; a sublist's rows are its items, so nothing groups. */
    private relationMappingOptions(relationship: string, relationFields: SelectableField[], kind: SeparateLoadDescription['kind']): ResultMappingOptions {
        const prefix = `${relationship}.`;
        const relativeFields: SelectableField[] = relationFields.map(([key, field]) => [key, { ...field, nestPath: (field.nestPath ?? key).slice(prefix.length) }]);
        const arrayPaths = kind === 'sublist' ? [] : this.arrayPathsOf(relativeFields);
        return { fieldMap: buildFieldMap(relativeFields), arrayPaths, primaryAlias: arrayPaths.length > 0 ? parentKeyAlias : undefined, coerceEnabled: this.coerceEnabled };
    }

    private mappingOptions(fields: SelectableField[], primaryAlias: string | undefined): ResultMappingOptions {
        return { fieldMap: buildFieldMap(fields), arrayPaths: this.arrayPathsOf(fields), primaryAlias, coerceEnabled: this.coerceEnabled };
    }

    private arrayPathsOf(fields: SelectableField[]): string[] {
        const paths = new Set<string>();
        for (const [key, field] of fields) {
            if (field.cardinality === 'many') {
                paths.add((field.nestPath ?? key).split('.')[0]);
            }
        }
        return Array.from(paths);
    }

    private toColumn(key: string, field: QueryField): DescribedColumn {
        if (field.formula !== undefined) {
            return omitUndefined({ alias: field.alias ?? key, formula: field.formula, formulaType: field.formulaType });
        }
        return omitUndefined({ alias: field.alias ?? key, component: field.component, fieldId: field.queryFieldId, context: field.fieldContext });
    }

    private toDescribedComponent(component: QueryComponent): DescribedComponent {
        return omitUndefined({ path: component.path, parent: component.parent, join: component.join, conditions: component.conditions ?? [] });
    }

    /** The components the main query joins: those a selected column, condition, or sort reads, plus their ancestors. */
    private collectComponents(fields: SelectableField[], conditions: ConditionNode[], sorts: DescribedSort[]): DescribedComponent[] {
        const wanted = new Set<string>();
        for (const [, field] of fields) {
            if (field.component !== undefined) wanted.add(field.component);
        }
        conditions.forEach((node) => collectConditionComponents(node, wanted));
        for (const sort of sorts) {
            if (sort.component !== undefined) wanted.add(sort.component);
        }
        const withAncestors = new Set<string>();
        for (const path of wanted) {
            let current: string | undefined = path;
            while (current !== undefined) {
                withAncestors.add(current);
                const component: QueryComponent | undefined = this.config.components?.[current];
                if (!component) {
                    throw new Error(`Component '${current}' is not defined in query config for '${this.config.recordType}'.`);
                }
                current = component.parent;
            }
        }
        return this.orderComponents(Array.from(withAncestors).map((path) => this.config.components?.[path] as QueryComponent)).map((component) => this.toDescribedComponent(component));
    }

    /**
     * Parents before children. Depth is the length of the parent chain, which the path need not spell: a reference
     * joined from a field read through a relationship (`subsidiary`) hangs off that relationship's component
     * (`transactionlines`), not off the root.
     */
    private orderComponents(components: QueryComponent[]): QueryComponent[] {
        const depthOf = (component: QueryComponent): number => {
            let depth = 0;
            for (let parent = component.parent; parent !== undefined; parent = this.config.components?.[parent]?.parent) {
                depth += 1;
            }
            return depth;
        };
        return [...components].sort((left, right) => depthOf(left) - depthOf(right) || left.path.localeCompare(right.path));
    }

    private combineWithRootConditions(userCondition: ConditionNode | undefined): ConditionNode | undefined {
        const rootNodes: ConditionNode[] = (this.config.rootConditions ?? []).map((condition) => omitUndefined({ kind: 'field' as const, fieldId: condition.fieldId, operator: condition.operator, values: condition.values }));
        const nodes = userCondition ? [...rootNodes, userCondition] : rootNodes;
        return nodes.length === 0 ? undefined : nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
    }

    private pageWindow(): PageWindow | undefined {
        return this.hasPageWindow() ? omitUndefined({ offset: this.offsetValue ?? 0, limit: this.limitValue }) : undefined;
    }

    private hasPageWindow(): boolean {
        return this.limitValue !== undefined || Boolean(this.offsetValue);
    }

    private withLimit<T>(limit: number, run: () => T): T {
        const originalLimit = this.limitValue;
        this.limitValue = limit;
        try {
            return run();
        } finally {
            this.limitValue = originalLimit;
        }
    }

    // ── running ───────────────────────────────────────────────────────────────

    /** The plan's rows: its page window when it has one, otherwise every row, past N/query's 5,000-row answer. */
    private readRows(plan: QueryPlan): ResultRow[] {
        const { page, ...unpaged } = plan.description;
        if (!page) {
            return this.readEveryRow(plan);
        }
        if (this.readsPageWindowInOneRun(plan)) {
            return this.executeDescription(unpaged).slice(page.offset, page.limit === undefined ? undefined : page.offset + page.limit);
        }
        return this.executeDescription(plan.description);
    }

    /**
     * Whether a row window is cut from one run() instead of read through runPaged. When the condition pins the internal
     * id to at most a page's worth of records (find(), getById(), first() on an id), run() answers every row the window
     * can hold for 10 units in one call, where runPaged sizes the result and then fetches it, 20 units in two (probe k1).
     * Only where rows are records: a joined sublist answers a row per line, which the ids do not bound.
     */
    private readsPageWindowInOneRun(plan: QueryPlan): boolean {
        const primary = this.primaryField();
        const { condition } = plan.description;
        if (!primary || primary.field.component !== undefined || condition === undefined || plan.mapping.arrayPaths.length > 0) {
            return false;
        }
        const pinnedRecordCount = countRecordsPinnedByCondition(condition, primary.field.queryFieldId);
        return pinnedRecordCount !== undefined && pinnedRecordCount <= maximumPageSize;
    }

    /**
     * Every row the query matches. One run() answers most queries whole; an answer of 5,000 rows may have stopped
     * short, so the rows after its last one are read the same way until an answer comes back shorter. A query no read
     * can pick up after (a sort no probe compared, a joined sublist's rows, no internal id) is read again through
     * runPaged instead, a thousand rows a fetch.
     */
    private readEveryRow(plan: QueryPlan): ResultRow[] {
        return this.readEveryRowOf(plan.description, plan.mapping.arrayPaths.length > 0 ? undefined : plan.readOnKeys);
    }

    /**
     * Every row of a description: one run() when it answers under 5,000, then read on after `keys`, or through runPaged
     * when there are none or one is text on a record joined through a reference, which a formula may not reach.
     */
    private readEveryRowOf(description: QueryDescription, keys: ReadOnKey[] | undefined): ResultRow[] {
        const governance = new ReadGovernance(this.governanceReserve());
        const firstAnswer = governance.measure(() => this.executeDescription(description));
        if (firstAnswer.length < runRowLimit) {
            return firstAnswer;
        }
        return keys !== undefined && !keys.some((key) => key.throughReference)
            ? this.readOnAfterLastRow(description, keys, firstAnswer, governance)
            : this.readEveryPage(description, governance);
    }

    private readOnAfterLastRow(description: QueryDescription, keys: ReadOnKey[], firstAnswer: ResultRow[], governance: ReadGovernance): ResultRow[] {
        const rows = [...firstAnswer];
        let answer = firstAnswer;
        while (answer.length >= runRowLimit) {
            this.assertAnotherReadAffordable(governance, rows.length);
            const after = buildAfterRowCondition(keys, readKeyValues(keys, answer[answer.length - 1]));
            answer = governance.measure(() => this.executeDescription(withAddedCondition(description, after)));
            rows.push(...answer);
        }
        return rows;
    }

    /** Every row in the query's own order through runPaged, a thousand a fetch. */
    private readEveryPage(description: QueryDescription, governance: ReadGovernance): ResultRow[] {
        return withQueryInError(description, () => {
            const query = compileQueryDescriptionToNQuery(description, getNsQuery());
            const paged = governance.measure(() => query.runPaged({ pageSize: maximumPageSize }));
            const rows: ResultRow[] = [];
            for (const range of paged.pageRanges) {
                this.assertAnotherReadAffordable(governance, rows.length);
                rows.push(...governance.measure(() => paged.fetch({ index: range.index }).data.asMappedResults() as ResultRow[]));
            }
            return rows;
        });
    }

    private assertAnotherReadAffordable(governance: ReadGovernance, rowsRead: number): void {
        const shortfall = governance.shortfall();
        if (shortfall) {
            throw new GovernanceLimitError(
                `Reading '${this.config.recordType}' stopped after ${rowsRead} rows: another read costs about ${shortfall.readCost} units, and ${shortfall.remainingUsage} are left with ${governance.reserve} held back for the script. Narrow the query, or read it a page at a time with listPage().`,
                rowsRead,
                shortfall.remainingUsage,
                shortfall.readCost,
                governance.reserve,
            );
        }
    }

    private governanceReserve(): number {
        return this.options.governanceReserve ?? defaultGovernanceReserve;
    }

    private executeDescription(description: QueryDescription): ResultRow[] {
        return withQueryInError(description, () => {
            const query = compileQueryDescriptionToNQuery(description, getNsQuery());
            if (!description.page) {
                return query.run().asMappedResults() as ResultRow[];
            }
            return this.runPageWindow(query, description.page);
        });
    }

    /** Reads a row window through runPaged: pages are sized to the window, fetched from the first page that overlaps it, and sliced. */
    private runPageWindow(query: NsQuery.Query, page: PageWindow): ResultRow[] {
        const pageSize = Math.min(maximumPageSize, Math.max(minimumPageSize, page.limit ?? maximumPageSize));
        const firstPageIndex = Math.floor(page.offset / pageSize);
        const skip = page.offset - firstPageIndex * pageSize;
        const paged = query.runPaged({ pageSize });
        const rows: ResultRow[] = [];
        for (let index = firstPageIndex; index < paged.pageRanges.length; index += 1) {
            const fetched = paged.fetch({ index });
            rows.push(...(fetched.data.asMappedResults() as ResultRow[]));
            if ((page.limit !== undefined && rows.length >= skip + page.limit) || fetched.isLast) {
                break;
            }
        }
        return rows.slice(skip, page.limit === undefined ? undefined : skip + page.limit);
    }

    private loadSeparateRelations(results: object[], plan: QueryPlan): void {
        const loads = plan.description.separateLoads ?? [];
        if (loads.length === 0 || results.length === 0) {
            return;
        }
        loadSeparateRelationsIntoResults(results, loads, {
            executeDescription: (description) => this.executeDescription(description),
            mappingOptionsFor: (load) => plan.separateMappings.get(load.relationship) as ResultMappingOptions,
            batchSize: this.options.separateLoadBatchSize ?? defaultSeparateLoadBatchSize,
            rowLimit: runRowLimit,
        });
    }

    // ── condition helpers ─────────────────────────────────────────────────────

    private addWhere(link: 'AND' | 'OR', rawField: string, operator: QueryOperator, value?: ConditionParamValue | ConditionParamValue[], useText = false): this {
        if (value === undefined && operator !== 'IS NULL' && operator !== 'IS NOT NULL' && operator !== 'EMPTY' && operator !== 'EMPTY_NOT') {
            return this;
        }
        const { key, field } = this.resolveField(rawField);
        // The internal id is a key whatever the model types it as; display text compares as a string.
        const fieldType = useText || field.fieldContext === 'DISPLAY' ? 'string' : field.isPrimary ? 'key' : field.type;
        // A joined text field is its own display text, and a formula cannot reach every joined record (sandbox 2026-09-28).
        const comparesDisplayText = field.fieldContext === 'DISPLAY' || (useText && !(field.component !== undefined && field.type === 'string'));
        const translated = translateConditionOperator(operator, fieldType, value);
        const node = conditionNodeForTranslation(translated, (translatedOperator, values) => (field.formula !== undefined
            ? omitUndefined({ kind: 'formula' as const, formula: field.formula, type: field.formulaType, operator: translatedOperator, values })
            : comparesDisplayText
                ? this.createDisplayTextConditionNode(field, translatedOperator, values)
                : omitUndefined({ kind: 'field' as const, component: field.component, fieldId: field.queryFieldId, operator: translatedOperator, values })));
        this.conditions.push(omitUndefined({ node, link, relationship: this.separateRelationshipOf(key, field) }));
        return this;
    }

    /** A condition on the display text of a select field: a formula over the field in DISPLAY context. */
    private createDisplayTextConditionNode(field: QueryField, operator: NQueryOperatorName, values: ConditionParamValue[] | undefined): ConditionNode {
        const path = field.component === undefined ? undefined : this.formulaPathOf(field.component);
        if (field.component !== undefined && path === undefined) {
            throw new Error(`The display text of '${field.nestPath ?? field.queryFieldId}' is compared in a formula, and no formula reaches '${field.component}' of '${this.config.recordType}', which is joined from its lines.`);
        }
        const reference = `{${path === undefined ? '' : `${path}.`}${field.queryFieldId}#DISPLAY}`;
        return omitUndefined({ kind: 'formula' as const, formula: reference, type: 'STRING' as const, operator, values });
    }

    /**
     * How a formula names a joined component: the join field ids from the root (`terms`, `transactionlines.item`), not
     * the model's relation names; a formula reaches a joined record through the select field that joins it
     * (sandbox 2026-09-28). Undefined for a component joined from its lines, which no formula names.
     */
    private formulaPathOf(componentPath: string): string | undefined {
        const segments: string[] = [];
        for (let path: string | undefined = componentPath; path !== undefined; path = this.config.components?.[path]?.parent) {
            const component: QueryComponent | undefined = this.config.components?.[path];
            if (!component || component.join.kind === 'from') {
                return undefined;
            }
            segments.unshift(component.join.fieldId);
        }
        return segments.join('.');
    }

    private addFormulaCondition(link: 'AND' | 'OR', formula: string, type: FormulaReturnType, operator: NQueryOperatorName | undefined, value: ConditionParamValue | ConditionParamValue[] | undefined): this {
        // createCondition requires an operator, and a comparison typed BOOLEAN fails to render ("Your formula contains
        // a syntax error"); a CASE over it compared EQUAL 1 runs (sandbox 2026-09-28).
        if (type === 'BOOLEAN' && operator === undefined) {
            this.conditions.push({ node: { kind: 'formula', formula: `CASE WHEN ${formula} THEN 1 ELSE 0 END`, type: 'INTEGER', operator: 'EQUAL', values: [1] }, link });
            return this;
        }
        const values = value === undefined ? undefined : Array.isArray(value) ? value : [value];
        this.conditions.push({ node: omitUndefined({ kind: 'formula' as const, formula, type, operator, values }), link });
        return this;
    }

    private addWhereGroup(link: 'AND' | 'OR', callback: (builder: QueryBuilder<TResult, TDeclared>) => QueryBuilder<TResult, any>): this {
        const child = new QueryBuilder<TResult, TDeclared>(this.config);
        this.formulaSelections.forEach((field, alias) => child.formulaSelections.set(alias, field));
        callback(child);
        if (child.conditions.length === 0) {
            return this;
        }
        const relationships = new Set(child.conditions.map((condition) => condition.relationship));
        const relationship = relationships.size === 1 ? child.conditions[0].relationship : undefined;
        this.conditions.push(omitUndefined({ node: combineConditions(child.conditions) as ConditionNode, link, relationship }));
        return this;
    }

    // ── field resolution ──────────────────────────────────────────────────────

    /** Accepts dotted paths (`customer.companyName`) for the flattened config keys (`customer_companyName`). */
    private normalizeFieldKey(fieldKey: string): string {
        if (this.config.fields[fieldKey] || !fieldKey.includes('.')) {
            return fieldKey;
        }
        const flattened = fieldKey.replace(/\./g, '_');
        return this.config.fields[flattened] ? flattened : fieldKey;
    }

    private resolveField(rawFieldKey: string): { key: string; field: QueryField } {
        const key = this.normalizeFieldKey(rawFieldKey);
        const field = this.config.fields[key] ?? this.formulaSelections.get(key);
        if (!field) {
            throw new Error(`Field '${key}' is not defined in query config for '${this.config.recordType}'.`);
        }
        return { key, field };
    }

    private assertRelationship(name: string): void {
        if (!this.config.relationships?.[name]) {
            throw new Error(`Relationship '${name}' is not defined in query config for '${this.config.recordType}'.`);
        }
    }

    /** True when the relationship's fields and components take part in this query. */
    private isRelationshipActive(name: string): boolean {
        if (this.excludedRelationships.has(name)) {
            return false;
        }
        return this.includedRelationships.has(name) || this.config.relationships?.[name]?.selectByDefault !== false;
    }

    private relationshipOf(key: string, field: QueryField): string | undefined {
        const root = (field.nestPath ?? key).split('.')[0];
        return this.config.relationships?.[root] ? root : undefined;
    }

    private loadOf(relationship: string): RelationshipLoad {
        return this.config.relationships?.[relationship]?.load ?? this.config.components?.[relationship]?.load ?? 'join';
    }

    private separateRelationshipOf(key: string, field: QueryField): string | undefined {
        const relationship = this.relationshipOf(key, field);
        return relationship !== undefined && this.loadOf(relationship) === 'separate' ? relationship : undefined;
    }

    private activeSeparateRelationships(): Set<string> {
        const names = new Set<string>();
        for (const name of Object.keys(this.config.relationships ?? {})) {
            if (this.isRelationshipActive(name) && this.loadOf(name) === 'separate') {
                names.add(name);
            }
        }
        return names;
    }

    private collectSelectableFields(): SelectableField[] {
        const configuredFields = Object.entries(this.config.fields).filter(([key, field]) => {
            if (field.isPrimary) {
                return true;
            }
            const relationship = this.relationshipOf(key, field);
            if (relationship !== undefined && !this.isRelationshipActive(relationship)) {
                return false;
            }
            if (this.selectedKeys) {
                return this.selectedKeys.has(key);
            }
            if (field.select === false) {
                return relationship !== undefined && this.includedRelationships.has(relationship);
            }
            return true;
        });
        return [...configuredFields, ...Array.from(this.formulaSelections.entries())];
    }

    private primaryField(): { key: string; field: QueryField } | undefined {
        for (const [key, field] of Object.entries(this.config.fields)) {
            if (field.isPrimary) {
                return { key, field };
            }
        }
        return undefined;
    }

    private primaryAlias(): string | undefined {
        const primary = this.primaryField();
        return primary ? primary.field.alias ?? primary.key : undefined;
    }
}

export function query<TResult>(config: QueryConfigSource<TResult>, options?: QueryBuilderOptions<TResult>): QueryBuilder<TResult> {
    return QueryBuilder.from(config, options);
}

export function runQuery<TResult>(config: QueryConfigSource<TResult>): TResult[] {
    return query(config).executeTyped();
}
