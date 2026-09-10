/**
 * An in-memory stand-in for the N/query object model, for tests that run outside NetSuite. It implements the
 * members the runtime uses (create, joins, columns, conditions, sorts, run, runPaged, toSuiteQL, the enums),
 * records every query it is asked to run as a QueryDescription plus its rendered text, and answers with rows
 * queued per query. Map `N/query` to the module-level `fakeNQuery` in jest and assert on `fakeNQuery.calls`.
 */
import { renderQueryDescription } from '../query/query-description';
import type { AggregateName, ConditionNode, ConditionParamValue, DescribedColumn, DescribedComponent, DescribedSort, FieldContext, FormulaReturnType, NQueryOperatorName, QueryDescription } from '../types';

export type FakeRow = Record<string, unknown>;

export interface FakeQueryCall {
    type: string;
    description: QueryDescription;
    text: string;
    execution: 'run' | 'runPaged' | 'toSuiteQL';
    pageSize?: number;
}

export interface FakeQueryCallMatch {
    /** Root query type. */
    type?: string;
    /** A joined component path (relationship field ids joined with dots, `transactionlines.item`). */
    component?: string;
    /** A substring of the rendered text. */
    contains?: string;
}

export type FakeQueryMatcher = string | FakeQueryCallMatch | ((call: FakeQueryCall) => boolean);

interface QueuedRows {
    matcher: FakeQueryMatcher;
    rows: FakeRow[];
    repeat: boolean;
    consumed: boolean;
}

export interface QueueRowsOptions {
    /** Answer every matching query instead of only the next one. */
    repeat?: boolean;
}

/** The enums the runtime reads by name. Values equal names here; the real module's values never matter to tests. */
function identityEnum<TName extends string>(names: readonly TName[]): Record<TName, TName> {
    const result = {} as Record<TName, TName>;
    for (const name of names) {
        result[name] = name;
    }
    return result;
}

const operatorNames = [
    'AFTER', 'AFTER_NOT', 'ANY_OF', 'ANY_OF_NOT', 'BEFORE', 'BEFORE_NOT', 'BETWEEN', 'BETWEEN_NOT', 'CONTAIN', 'CONTAIN_NOT',
    'EMPTY', 'EMPTY_NOT', 'ENDWITH', 'ENDWITH_NOT', 'EQUAL', 'EQUAL_NOT', 'EXCLUDE_ALL', 'EXCLUDE_ANY', 'EXCLUDE_EXACTLY',
    'GREATER', 'GREATER_NOT', 'GREATER_OR_EQUAL', 'GREATER_OR_EQUAL_NOT', 'INCLUDE_ALL', 'INCLUDE_ANY', 'INCLUDE_EXACTLY',
    'IS', 'IS_NOT', 'LESS', 'LESS_NOT', 'LESS_OR_EQUAL', 'LESS_OR_EQUAL_NOT', 'ON', 'ON_NOT', 'ON_OR_AFTER', 'ON_OR_AFTER_NOT',
    'ON_OR_BEFORE', 'ON_OR_BEFORE_NOT', 'START_WITH', 'START_WITH_NOT', 'WITHIN', 'WITHIN_NOT',
] as const satisfies readonly NQueryOperatorName[];
const fieldContextNames = ['DISPLAY', 'RAW', 'CONVERTED', 'CURRENCY_CONSOLIDATED', 'HIERARCHY', 'HIERARCHY_IDENTIFIER', 'SIGN_CONSOLIDATED'] as const satisfies readonly FieldContext[];
const returnTypeNames = ['ANY', 'BOOLEAN', 'CURRENCY', 'DATE', 'DATETIME', 'DURATION', 'FLOAT', 'INTEGER', 'KEY', 'RELATIONSHIP', 'STRING', 'UNKNOWN'] as const satisfies readonly FormulaReturnType[];
const aggregateNames = ['AVERAGE', 'AVERAGE_DISTINCT', 'COUNT', 'COUNT_DISTINCT', 'MAXIMUM', 'MAXIMUM_DISTINCT', 'MEDIAN', 'MINIMUM', 'MINIMUM_DISTINCT', 'SUM', 'SUM_DISTINCT'] as const satisfies readonly AggregateName[];

export interface FakeColumnOptions {
    fieldId?: string;
    formula?: string;
    type?: string;
    alias?: string;
    aggregate?: string;
    groupBy?: boolean;
    context?: string | { name: string };
}

export interface FakeConditionOptions {
    fieldId?: string;
    formula?: string;
    type?: string;
    operator?: string;
    values?: ConditionParamValue[];
    aggregate?: string;
}

export interface FakeSortOptions {
    column: FakeColumn;
    ascending?: boolean;
    nullsLast?: boolean;
    caseSensitive?: boolean;
    locale?: string;
}

export class FakeColumn {
    constructor(readonly component: FakeComponent, readonly options: FakeColumnOptions) {}

    get fieldId(): string | undefined { return this.options.fieldId; }
    get formula(): string | undefined { return this.options.formula; }
    get alias(): string | undefined { return this.options.alias; }
    get aggregate(): string | undefined { return this.options.aggregate; }
    get type(): string | undefined { return this.options.type; }
    get context(): FakeColumnOptions['context'] { return this.options.context; }
}

export class FakeCondition {
    constructor(
        readonly component: FakeComponent | undefined,
        readonly options: FakeConditionOptions,
        readonly children: FakeCondition[] = [],
        readonly logic: 'and' | 'or' | 'not' | undefined = undefined,
    ) {}

    get fieldId(): string | undefined { return this.options.fieldId; }
    get operator(): string | undefined { return this.options.operator; }
    get values(): ConditionParamValue[] | undefined { return this.options.values; }
    get formula(): string | undefined { return this.options.formula; }
    get type(): string | undefined { return this.options.type; }
}

export class FakeSort {
    ascending: boolean;
    nullsLast: boolean | undefined;
    caseSensitive: boolean | undefined;
    locale: string | undefined;

    constructor(readonly column: FakeColumn, options: FakeSortOptions) {
        this.ascending = options.ascending ?? true;
        this.nullsLast = options.nullsLast;
        this.caseSensitive = options.caseSensitive;
        this.locale = options.locale;
    }
}

export class FakeComponent {
    readonly child: Record<string, FakeComponent> = {};
    private readonly usedRelationships = new Set<string>();

    constructor(
        readonly query: FakeQuery,
        readonly type: string,
        /** Dotted relationship path from the root; empty for the root. */
        readonly path: string,
        readonly parent: FakeComponent | undefined,
        readonly joinSpec: DescribedComponent['join'] | undefined,
    ) {}

    get source(): string | null { return this.joinSpec?.source ?? null; }
    get target(): string | null { return this.joinSpec?.target ?? null; }

    autoJoin(options: { fieldId: string }): FakeComponent {
        return this.joinChild(options.fieldId, { kind: 'auto', fieldId: options.fieldId });
    }

    join(options: { fieldId: string }): FakeComponent {
        return this.autoJoin(options);
    }

    joinTo(options: { fieldId: string; target: string }): FakeComponent {
        return this.joinChild(options.fieldId, { kind: 'to', fieldId: options.fieldId, target: options.target });
    }

    joinFrom(options: { fieldId: string; source: string }): FakeComponent {
        return this.joinChild(`${options.source}.${options.fieldId}`, { kind: 'from', fieldId: options.fieldId, source: options.source });
    }

    private joinChild(relationship: string, join: DescribedComponent['join']): FakeComponent {
        if (this.usedRelationships.has(relationship)) {
            throw new Error(`RELATIONSHIP_ALREADY_USED: '${relationship}' is already joined on '${this.path || this.type}'.`);
        }
        this.usedRelationships.add(relationship);
        const child = new FakeComponent(this.query, relationship, this.path ? `${this.path}.${relationship}` : relationship, this, join);
        this.child[relationship] = child;
        this.query.registerComponent(child);
        return child;
    }

    createColumn(options: FakeColumnOptions): FakeColumn {
        if (options.fieldId === undefined && options.formula === undefined) {
            throw new Error('NEITHER_ARGUMENT_DEFINED: a column needs a fieldId or a formula.');
        }
        return new FakeColumn(this, options);
    }

    createCondition(options: FakeConditionOptions): FakeCondition {
        if (options.fieldId === undefined && options.formula === undefined) {
            throw new Error('MISSING_REQD_ARGUMENT: a condition needs a fieldId or a formula.');
        }
        return new FakeCondition(this, options);
    }

    createSort(options: FakeSortOptions): FakeSort {
        return new FakeSort(options.column, options);
    }
}

export class FakeResultSet {
    readonly types: string[] = [];

    constructor(private readonly rows: FakeRow[], readonly columns: FakeColumn[]) {}

    get results(): Array<{ values: unknown[]; asMap(): FakeRow }> {
        return this.rows.map((row) => ({ values: Object.values(row), asMap: () => row }));
    }

    asMappedResults<T = FakeRow>(): T[] {
        return this.rows as T[];
    }

    iterator(): { each(callback: (result: { value: { values: unknown[]; asMap(): FakeRow } }) => boolean): void } {
        const results = this.results;
        return { each: (callback) => { for (const value of results) { if (!callback({ value })) break; } } };
    }
}

export interface FakePage {
    data: FakeResultSet;
    isFirst: boolean;
    isLast: boolean;
    pageRange: { index: number; size: number };
    pagedData: FakePagedData;
}

export class FakePagedData {
    readonly count: number;
    readonly pageRanges: Array<{ index: number; size: number }>;

    constructor(private readonly rows: FakeRow[], readonly pageSize: number, private readonly columns: FakeColumn[]) {
        this.count = rows.length;
        this.pageRanges = [];
        for (let index = 0; index * pageSize < rows.length; index += 1) {
            this.pageRanges.push({ index, size: Math.min(pageSize, rows.length - index * pageSize) });
        }
    }

    fetch(options: { index: number }): FakePage {
        const range = this.pageRanges[options.index];
        if (!range) {
            throw new Error(`INVALID_PAGE_INDEX: page ${options.index} does not exist (${this.pageRanges.length} page(s)).`);
        }
        const start = options.index * this.pageSize;
        return {
            data: new FakeResultSet(this.rows.slice(start, start + this.pageSize), this.columns),
            isFirst: options.index === 0,
            isLast: options.index === this.pageRanges.length - 1,
            pageRange: range,
            pagedData: this,
        };
    }

    iterator(): { each(callback: (page: { value: FakePage }) => boolean): void } {
        return { each: (callback) => { for (const range of this.pageRanges) { if (!callback({ value: this.fetch({ index: range.index }) })) break; } } };
    }
}

export class FakeQuery {
    readonly root: FakeComponent;
    readonly components: FakeComponent[] = [];
    columns: FakeColumn[] = [];
    condition: FakeCondition | undefined;
    sort: FakeSort[] = [];
    readonly id = null;
    readonly name = null;

    constructor(readonly type: string, private readonly module: FakeNQueryModule) {
        this.root = new FakeComponent(this, type, '', undefined, undefined);
    }

    get child(): Record<string, FakeComponent> { return this.root.child; }

    registerComponent(component: FakeComponent): void {
        this.components.push(component);
    }

    autoJoin(options: { fieldId: string }): FakeComponent { return this.root.autoJoin(options); }
    join(options: { fieldId: string }): FakeComponent { return this.root.join(options); }
    joinTo(options: { fieldId: string; target: string }): FakeComponent { return this.root.joinTo(options); }
    joinFrom(options: { fieldId: string; source: string }): FakeComponent { return this.root.joinFrom(options); }
    createColumn(options: FakeColumnOptions): FakeColumn { return this.root.createColumn(options); }
    createCondition(options: FakeConditionOptions): FakeCondition { return this.root.createCondition(options); }
    createSort(options: FakeSortOptions): FakeSort { return this.root.createSort(options); }

    and(...conditions: FakeCondition[]): FakeCondition { return new FakeCondition(undefined, {}, conditions, 'and'); }
    or(...conditions: FakeCondition[]): FakeCondition { return new FakeCondition(undefined, {}, conditions, 'or'); }
    not(condition: FakeCondition): FakeCondition { return new FakeCondition(undefined, {}, [condition], 'not'); }

    run(): FakeResultSet {
        return new FakeResultSet(this.module.answer(this, 'run'), this.columns);
    }

    runPaged(options: { pageSize: number }): FakePagedData {
        return new FakePagedData(this.module.answer(this, 'runPaged', options.pageSize), options.pageSize, this.columns);
    }

    toSuiteQL(): { query: string; params: unknown[]; columns: FakeColumn[]; type: string; run: () => FakeResultSet; runPaged: (options: { pageSize: number }) => FakePagedData } {
        const call = this.module.record(this, 'toSuiteQL');
        return { query: call.text, params: [], columns: this.columns, type: this.type, run: () => this.run(), runPaged: (options) => this.runPaged(options) };
    }

    toString(): string { return `FakeQuery(${this.type})`; }
    toJSON(): object { return describeFakeQuery(this); }
}

function componentPath(component: FakeComponent | undefined): string | undefined {
    return component && component.path ? component.path : undefined;
}

function describeColumn(column: FakeColumn): DescribedColumn {
    const context = typeof column.context === 'object' ? column.context.name : column.context;
    const described: DescribedColumn = { alias: column.alias ?? column.fieldId ?? column.formula ?? '' };
    const path = componentPath(column.component);
    if (path !== undefined) described.component = path;
    if (column.formula !== undefined) {
        described.formula = column.formula;
        if (column.type !== undefined) described.formulaType = column.type as FormulaReturnType;
    } else {
        described.fieldId = column.fieldId;
    }
    if (context !== undefined) described.context = context as FieldContext;
    if (column.aggregate !== undefined) described.aggregate = column.aggregate as AggregateName;
    return described;
}

function describeCondition(condition: FakeCondition): ConditionNode {
    if (condition.logic === 'not') {
        return { kind: 'not', node: describeCondition(condition.children[0]) };
    }
    if (condition.logic) {
        return { kind: condition.logic, nodes: condition.children.map(describeCondition) };
    }
    if (condition.formula !== undefined) {
        const node: ConditionNode = { kind: 'formula', formula: condition.formula };
        if (condition.type !== undefined) node.type = condition.type as FormulaReturnType;
        if (condition.operator !== undefined) node.operator = condition.operator as NQueryOperatorName;
        if (condition.values !== undefined) node.values = condition.values;
        return node;
    }
    const node: ConditionNode = { kind: 'field', fieldId: condition.fieldId as string, operator: condition.operator as NQueryOperatorName };
    const path = componentPath(condition.component);
    if (path !== undefined) node.component = path;
    if (condition.values !== undefined) node.values = condition.values;
    return node;
}

function describeSort(sort: FakeSort): DescribedSort {
    const column = describeColumn(sort.column);
    const described: DescribedSort = { ascending: sort.ascending };
    if (column.component !== undefined) described.component = column.component;
    if (column.formula !== undefined) {
        described.formula = column.formula;
        if (column.formulaType !== undefined) described.formulaType = column.formulaType;
    } else {
        described.fieldId = column.fieldId;
    }
    if (column.context !== undefined) described.context = column.context;
    if (sort.nullsLast !== undefined) described.nullsLast = sort.nullsLast;
    return described;
}

/** The query a fake was built into, in the same shape the runtime's describe() produces. Component paths are relationship field ids. */
export function describeFakeQuery(query: FakeQuery): QueryDescription {
    const components: DescribedComponent[] = query.components.map((component) => {
        const described: DescribedComponent = { path: component.path, join: component.joinSpec as DescribedComponent['join'], conditions: [] };
        const parent = componentPath(component.parent);
        if (parent !== undefined) described.parent = parent;
        return described;
    });
    const description: QueryDescription = { queryType: query.type, components, columns: query.columns.map(describeColumn), sort: query.sort.map(describeSort) };
    if (query.condition) description.condition = describeCondition(query.condition);
    return description;
}

function matchesQueryCall(call: FakeQueryCall, matcher: FakeQueryMatcher): boolean {
    if (typeof matcher === 'function') return matcher(call);
    if (typeof matcher === 'string') return call.type === matcher || call.text.includes(matcher);
    if (matcher.type !== undefined && call.type !== matcher.type) return false;
    if (matcher.component !== undefined && !call.description.components.some((component) => component.path === matcher.component)) return false;
    if (matcher.contains !== undefined && !call.text.includes(matcher.contains)) return false;
    return true;
}

export class FakeNQueryModule {
    readonly Operator = identityEnum(operatorNames);
    readonly FieldContext = identityEnum(fieldContextNames);
    readonly ReturnType = identityEnum(returnTypeNames);
    readonly Aggregate = identityEnum(aggregateNames);
    /** Every query run, paged, or rendered, oldest first. */
    readonly calls: FakeQueryCall[] = [];
    private readonly queue: QueuedRows[] = [];

    create(options: { type: string }): FakeQuery {
        return new FakeQuery(options.type, this);
    }

    /** Queues rows for the next query that matches; each queued set answers one query unless it repeats. Unmatched queries get no rows. */
    queueRows(matcher: FakeQueryMatcher, rows: FakeRow[], options: QueueRowsOptions = {}): void {
        this.queue.push({ matcher, rows, repeat: options.repeat ?? false, consumed: false });
    }

    reset(): void {
        this.queue.length = 0;
        this.calls.length = 0;
    }

    record(query: FakeQuery, execution: FakeQueryCall['execution'], pageSize?: number): FakeQueryCall {
        const description = describeFakeQuery(query);
        const call: FakeQueryCall = { type: query.type, description, text: renderQueryDescription(description), execution };
        if (pageSize !== undefined) call.pageSize = pageSize;
        this.calls.push(call);
        return call;
    }

    answer(query: FakeQuery, execution: 'run' | 'runPaged', pageSize?: number): FakeRow[] {
        const call = this.record(query, execution, pageSize);
        const queued = this.queue.find((entry) => !entry.consumed && matchesQueryCall(call, entry.matcher));
        if (!queued) {
            return [];
        }
        queued.consumed = !queued.repeat;
        return queued.rows;
    }
}

export function createFakeNQueryModule(): FakeNQueryModule {
    return new FakeNQueryModule();
}

/** The instance to map `N/query` to in tests. */
export const fakeNQuery = createFakeNQueryModule();
