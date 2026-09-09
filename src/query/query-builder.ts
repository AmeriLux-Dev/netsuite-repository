import type * as NsQuery from 'N/query';
import type { ConditionValue, FieldReference, FieldReferenceFor, FieldValue, OperatorFor, ParamFor, RelationName, TextOperator } from '../field-path';
import { resolveQueryConfig } from '../model/resolve';
import type { QueryConfigSource } from '../model/resolve';
import type {
    ConditionNode,
    ConditionParamValue,
    DescribedColumn,
    DescribedComponent,
    DescribedSort,
    FieldMap,
    FieldType,
    FormulaReturnType,
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
import { compileQueryDescriptionToNQuery } from './n-query-compiler';
import { translateConditionOperator } from './operator-translation';
import { renderQueryDescription } from './query-description';
import { buildFieldMap, mapRowsToResults } from './result-mapper';
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
}

/** What one execution needs: the description to compile and how to map the rows that come back. */
interface QueryPlan {
    description: QueryDescription;
    mapping: ResultMappingOptions;
    separateMappings: Map<string, ResultMappingOptions>;
}

/**
 * Runs a step against N/query and, when it fails, rethrows with the rendered query appended: NetSuite's message
 * names the problem ("Operator EQUAL is not valid for given search filter") but never the query.
 */
function withQueryInError<T>(description: QueryDescription, step: () => T): T {
    try {
        return step();
    } catch (error) {
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

    /** Adds an AND condition written as an N/query formula (`{trandate} > SYSDATE - 30`). Values are part of the formula text. */
    whereFormula(formula: string, type: FormulaReturnType = 'BOOLEAN', operator?: NQueryOperatorName, value?: ConditionParamValue | ConditionParamValue[]): this {
        return this.addFormulaCondition('AND', formula, type, operator, value);
    }

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
        const sort: DescribedSort = resolved.formula !== undefined
            ? omitUndefined({ formula: resolved.formula, formulaType: resolved.formulaType, ascending: direction === 'ASC' })
            : omitUndefined({ component: resolved.component, fieldId: resolved.queryFieldId, context: resolved.fieldContext, ascending: direction === 'ASC' });
        this.sorts.push(omitUndefined({ sort, relationship: this.separateRelationshipOf(key, resolved) }));
        return this;
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
        return { data: this.executeDescription(plan.description), query: plan.description };
    }

    executeRaw(): Record<string, QueryResultValue>[] {
        return this.execute().data;
    }

    executeTyped(): TResult[] {
        const fansOut = this.plan(false).mapping.arrayPaths.length > 0;
        // Joined sublists fan rows out, so a row window would cut records short; those queries page over mapped records instead.
        const plan = this.plan(!fansOut);
        const rows = this.executeDescription(plan.description);
        let results = mapRowsToResults<TResult>(rows, plan.mapping);
        if (fansOut && this.hasPageWindow()) {
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
        const mainSorts = this.sorts.filter((sort) => sort.relationship === undefined);
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
        };
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
        const columns = [...relationFields.map(([key, field]) => this.toColumn(key, field)), { alias: parentKeyAlias, fieldId: primary.field.queryFieldId }];
        const defaultSort: DescribedSort[] = component.lineOrderFieldId ? [{ component: relationship, fieldId: component.lineOrderFieldId, ascending: true }] : [];
        const description: QueryDescription = omitUndefined({
            queryType: this.config.queryType ?? this.config.recordType,
            components: this.orderComponents(relationComponents).map((candidate) => this.toDescribedComponent(candidate)),
            columns,
            condition: this.combineWithRootConditions(combineConditions(conditions)),
            sort: sorts.length > 0 ? sorts : defaultSort,
        });
        return {
            load: { relationship, kind, description, parentKeyPath: primary.field.nestPath ?? primary.key, batchFieldId: primary.field.queryFieldId, batchFieldType: 'key', parentKeyAlias },
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

    private orderComponents(components: QueryComponent[]): QueryComponent[] {
        return [...components].sort((left, right) => left.path.split('.').length - right.path.split('.').length || left.path.localeCompare(right.path));
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
        const translated = translateConditionOperator(operator, fieldType, value);
        const node = conditionNodeForTranslation(translated, (translatedOperator, values) => (field.formula !== undefined
            ? omitUndefined({ kind: 'formula' as const, formula: field.formula, type: field.formulaType, operator: translatedOperator, values })
            : useText || field.fieldContext === 'DISPLAY'
                ? this.createDisplayTextConditionNode(field, translatedOperator, values)
                : omitUndefined({ kind: 'field' as const, component: field.component, fieldId: field.queryFieldId, operator: translatedOperator, values })));
        this.conditions.push(omitUndefined({ node, link, relationship: this.separateRelationshipOf(key, field) }));
        return this;
    }

    /** A condition on the display text of a select field: a formula over the field in DISPLAY context. */
    private createDisplayTextConditionNode(field: QueryField, operator: NQueryOperatorName, values: ConditionParamValue[] | undefined): ConditionNode {
        const reference = `{${field.component ? `${field.component}.` : ''}${field.queryFieldId}#DISPLAY}`;
        return omitUndefined({ kind: 'formula' as const, formula: reference, type: 'STRING' as const, operator, values });
    }

    private addFormulaCondition(link: 'AND' | 'OR', formula: string, type: FormulaReturnType, operator: NQueryOperatorName | undefined, value: ConditionParamValue | ConditionParamValue[] | undefined): this {
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
