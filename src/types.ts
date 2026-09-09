import type * as NsRecord from 'N/record';

/** A scalar a condition compares against. `null` is never a comparison value: use whereNull() and whereNotNull(). */
export type ConditionScalarValue = string | number | boolean;
/** What a where() condition accepts: a scalar, or a Date for date and datetime fields (N/query takes Dates directly). */
export type ConditionParamValue = ConditionScalarValue | Date;
export type QueryResultValue = string | number | boolean | null;
export type RecordId = string | number;
export type CoercedQueryValue = QueryResultValue | Date;

export type FieldType =
    | 'string'
    | 'integer'
    | 'float'
    | 'currency'
    | 'boolean'
    | 'checkbox'
    | 'date'
    | 'datetime'
    | 'select'
    | 'multiselect'
    | 'key';

export type SortDirection = 'ASC' | 'DESC';
export type Cardinality = 'one' | 'many';
export type RecordAccess = 'body' | 'subrecord' | 'sublist';

export type FieldSourceKind = 'recordField' | 'joinedRecordField' | 'subrecordField' | 'sublistField' | 'derived' | 'external';

export interface FieldSourceMapping {
    kind: FieldSourceKind;
    recordType?: string;
    fieldId?: string;
    path?: string;
    description?: string;
}

export interface BodyFieldUpdateMapping {
    kind: 'body';
    fieldId?: string;
    setFirst?: boolean;
}

export interface OwnedSubrecordFieldUpdateMapping {
    kind: 'ownedSubrecord';
    subrecordFieldId: string;
    fieldId?: string;
    clearBeforeUpdateFieldId?: string;
    setFirst?: boolean;
}

export interface SublistFieldUpdateMapping {
    kind: 'sublist';
    sublistId: string;
    fieldId?: string;
    matchBy?: string;
    setFirst?: boolean;
}

export interface RelatedRecordFieldUpdateMapping {
    kind: 'relatedRecord';
    recordType: string;
    idPath: string;
    fieldId?: string;
    configKey?: string;
}

export interface NonWritableFieldUpdateMapping {
    kind: 'readonly' | 'derived' | 'external';
    reason?: string;
}

export type FieldUpdateMapping =
    | BodyFieldUpdateMapping
    | OwnedSubrecordFieldUpdateMapping
    | SublistFieldUpdateMapping
    | RelatedRecordFieldUpdateMapping
    | NonWritableFieldUpdateMapping;

// ── N/query vocabulary ───────────────────────────────────────────────────────
// Names only. The values come from the N/query module at run time (`query.Operator[name]`), so nothing here has
// to change when NetSuite changes a value.

/** SQL-style operators the builder translates per field type (`LIKE 'x%'` becomes START_WITH, `IN` becomes ANY_OF, ...). */
export type SqlStyleOperator =
    | '='
    | '!='
    | '<>'
    | '>'
    | '>='
    | '<'
    | '<='
    | 'LIKE'
    | 'NOT LIKE'
    | 'IN'
    | 'NOT IN'
    | 'IS NULL'
    | 'IS NOT NULL'
    | 'BETWEEN';

/** The member names of `query.Operator`; accepted anywhere a SQL-style operator is. */
export type NQueryOperatorName =
    | 'AFTER' | 'AFTER_NOT'
    | 'ANY_OF' | 'ANY_OF_NOT'
    | 'BEFORE' | 'BEFORE_NOT'
    | 'BETWEEN' | 'BETWEEN_NOT'
    | 'CONTAIN' | 'CONTAIN_NOT'
    | 'EMPTY' | 'EMPTY_NOT'
    | 'ENDWITH' | 'ENDWITH_NOT'
    | 'EQUAL' | 'EQUAL_NOT'
    | 'EXCLUDE_ALL' | 'EXCLUDE_ANY' | 'EXCLUDE_EXACTLY'
    | 'GREATER' | 'GREATER_NOT'
    | 'GREATER_OR_EQUAL' | 'GREATER_OR_EQUAL_NOT'
    | 'INCLUDE_ALL' | 'INCLUDE_ANY' | 'INCLUDE_EXACTLY'
    | 'IS' | 'IS_NOT'
    | 'LESS' | 'LESS_NOT'
    | 'LESS_OR_EQUAL' | 'LESS_OR_EQUAL_NOT'
    | 'ON' | 'ON_NOT'
    | 'ON_OR_AFTER' | 'ON_OR_AFTER_NOT'
    | 'ON_OR_BEFORE' | 'ON_OR_BEFORE_NOT'
    | 'START_WITH' | 'START_WITH_NOT'
    | 'WITHIN' | 'WITHIN_NOT';

export type QueryOperator = SqlStyleOperator | NQueryOperatorName;

/** The member names of `query.FieldContext`. DISPLAY reads the text of a select field. */
export type FieldContext = 'DISPLAY' | 'RAW' | 'CONVERTED' | 'CURRENCY_CONSOLIDATED' | 'HIERARCHY' | 'HIERARCHY_IDENTIFIER' | 'SIGN_CONSOLIDATED';

/** The member names of `query.ReturnType`, for formula columns and formula conditions. */
export type FormulaReturnType = 'ANY' | 'BOOLEAN' | 'CURRENCY' | 'DATE' | 'DATETIME' | 'DURATION' | 'FLOAT' | 'INTEGER' | 'KEY' | 'RELATIONSHIP' | 'STRING' | 'UNKNOWN';

/** The member names of `query.Aggregate`. */
export type AggregateName = 'AVERAGE' | 'AVERAGE_DISTINCT' | 'COUNT' | 'COUNT_DISTINCT' | 'MAXIMUM' | 'MAXIMUM_DISTINCT' | 'MEDIAN' | 'MINIMUM' | 'MINIMUM_DISTINCT' | 'SUM' | 'SUM_DISTINCT';

// ── relations ────────────────────────────────────────────────────────────────

/**
 * How a relation is loaded. `join` puts it in the parent's query through an N/query join; NetSuite decides whether
 * that join is inner or outer. `separate` runs a second query keyed by the parent ids, so parents always come back
 * (with an empty array or null for the relation), rows never fan out, and a reference can be matched on any field.
 */
export type RelationshipLoad = 'join' | 'separate';

/** How a component is joined to its parent component in N/query terms. */
export interface ComponentJoin {
    /** `auto` = autoJoin({ fieldId }); `to` = joinTo({ fieldId, target }); `from` = joinFrom({ fieldId, source }). */
    kind: 'auto' | 'to' | 'from';
    /** The relationship field: a subrecord or select field on the parent (auto/to), or the child's field pointing at the parent (from). */
    fieldId: string;
    /** joinTo: the query type joined to. */
    target?: string;
    /** joinFrom: the query type whose rows point at this component. */
    source?: string;
}

/** A condition the model declares on a component (a sublist filter such as `mainline IS false`, or a root filter). */
export interface ComponentCondition {
    fieldId: string;
    operator: NQueryOperatorName;
    values?: ConditionParamValue[];
}

/**
 * Facts the separate loader needs for a relation loaded outside the parent query: a reference matched on a target
 * field, or a sublist whose lines are queried from another root than the owner's and matched by internal id.
 */
export interface SeparateLoad {
    /** Root type of the second query. */
    queryType: string;
    /** Config field key on the parent whose values are collected into the ANY_OF list. */
    parentKeyField: string;
    /** N/query field id on the target compared with the collected values. */
    targetKeyFieldId: string;
    /** Type of that field; a select or key field takes ANY_OF, anything else one EQUAL per value. Defaults to `key`. */
    targetKeyFieldType?: FieldType;
}

/** One joined component of a query, keyed by its dotted property path (`lines`, `lines.item`, `customer`). */
export interface QueryComponent {
    path: string;
    /** Path of the parent component; undefined for a component joined to the root. */
    parent?: string;
    /** The depth-1 relationship this component belongs to. */
    relationship: string;
    /** Meaningful on depth-1 components; nested components load with their relationship. */
    load: RelationshipLoad;
    join: ComponentJoin;
    /** Conditions the model declares on the component; always applied. */
    conditions?: ComponentCondition[];
    /** Present on a depth-1 reference component loaded separately. */
    separate?: SeparateLoad;
    /** Sublist: field the separate line query is ordered by when the query declares no sort of its own. */
    lineOrderFieldId?: string;
}

// ── fields ───────────────────────────────────────────────────────────────────

export interface QueryField<TRow = unknown> {
    /** N/query field id on the component. */
    queryFieldId: string;
    /** Component path the field is read from; undefined for the root. */
    component?: string;
    type?: FieldType;
    alias?: string;
    nestPath?: string;
    cardinality?: Cardinality;
    isPrimary?: boolean;
    select?: boolean;
    /** Column context; DISPLAY reads the text of a select field. */
    fieldContext?: FieldContext;
    /** Formula column (selectFormula) rendered instead of a field. */
    formula?: string;
    formulaType?: FormulaReturnType;
    /** Per-field override of read-side type coercion. */
    coerce?: boolean;
    transform?(value: CoercedQueryValue, row: Record<string, QueryResultValue>): unknown;
    recordFieldId?: string;
    readonly?: boolean;
    recordAccess?: RecordAccess;
    recordAccessId?: string;
    setFirst?: boolean;
    subrecordNeedsReload?: boolean;
    subrecordListFieldToClear?: string;
    source?: FieldSourceMapping;
    updateMapping?: FieldUpdateMapping;
    meta?: TRow;
}

export type QueryFieldQuerySection<TFieldMeta = unknown> = Pick<QueryField<TFieldMeta>, 'queryFieldId'> & Partial<Omit<QueryField<TFieldMeta>, 'queryFieldId'>>;

export interface QueryFieldSections<TFieldMeta = unknown> {
    query: QueryFieldQuerySection<TFieldMeta>;
    common?: Partial<QueryField<TFieldMeta>>;
    record?: Partial<QueryField<TFieldMeta>>;
}

export type QueryFieldConfig<TFieldMeta = unknown> = QueryField<TFieldMeta> | QueryFieldSections<TFieldMeta>;

export interface CompositeModelMapping {
    /** Default behavior for properties that do not declare an updateMapping. */
    updateMode?: 'explicit' | 'queryFields';
    /** Optional notes for generated/composed DTO configs. */
    description?: string;
}

export type RelationshipFieldMap = Record<string, string>;

/** Shared by every relationship kind. */
export interface RelationshipBase {
    /** Config field keys by nested property name. */
    fields?: RelationshipFieldMap;
    /** Paths of the components that exist only to read this relationship (`['lines', 'lines.item']`). */
    components?: string[];
    load?: RelationshipLoad;
    /** False when the relationship is joined and selected only after include(). */
    selectByDefault?: boolean;
}

/** A subrecord edited through the parent record (a shipping address, for example). */
export interface SubrecordRelationship extends RelationshipBase {
    kind: 'subrecord';
    recordAccessId: string;
    reload?: {
        listFieldToClear: string;
    };
}

/** Sublist lines edited through the parent record. */
export interface SublistRelationship extends RelationshipBase {
    kind: 'sublist';
    recordAccessId: string;
    /** Nested property whose value identifies a line (matched with findSublistLineWithValue). */
    matchField?: string;
    /** Property holding the NetSuite line index, used by change tracking to identify lines. */
    lineField?: string;
}

/** A referenced record joined for reading only; its fields are never written through the parent. */
export interface ReferenceRelationship extends RelationshipBase {
    kind: 'reference';
}

export type EntityRelationship = SubrecordRelationship | SublistRelationship | ReferenceRelationship;

// ── config ───────────────────────────────────────────────────────────────────

export interface QueryConfig<TResult, TFieldMeta = unknown> {
    /** N/record type, used for writes. */
    recordType: string;
    /** N/query root type, used for reads. Defaults to the record type. */
    queryType?: string;
    /** Conditions the model declares on the root; applied to every query. */
    rootConditions?: ComponentCondition[];
    /** Joined components by path. */
    components?: Record<string, QueryComponent>;
    fields: Record<string, QueryField<TFieldMeta>>;
    relationships?: Record<string, EntityRelationship>;
    composite?: CompositeModelMapping;
    postProcess?: (result: TResult) => TResult;
    /** Coerce query results to the declared field types on read. Defaults to false for hand-written configs. */
    coerce?: boolean;
    /** Default RecordUpdater options applied to every updater created from this config. */
    updaterOptions?: RecordUpdaterOptions;
}

export interface QueryConfigInput<TResult, TFieldMeta = unknown> extends Omit<QueryConfig<TResult, TFieldMeta>, 'fields'> {
    fields: Record<string, QueryFieldConfig<TFieldMeta>>;
}

export type ConfigResult<TConfig> = TConfig extends QueryConfig<infer TResult, any> | QueryConfigInput<infer TResult, any> ? TResult : never;

// ── query description ────────────────────────────────────────────────────────
// The plan a builder produces: what it will ask N/query for, as plain data. It is what tests assert on, what the
// fake N/query records, and what the compiler turns into a Query object.

export interface DescribedComponent {
    path: string;
    parent?: string;
    join: ComponentJoin;
    conditions: ComponentCondition[];
}

export interface DescribedColumn {
    alias: string;
    component?: string;
    fieldId?: string;
    formula?: string;
    formulaType?: FormulaReturnType;
    context?: FieldContext;
    aggregate?: AggregateName;
}

export interface FieldConditionNode {
    kind: 'field';
    component?: string;
    fieldId: string;
    operator: NQueryOperatorName;
    values?: ConditionParamValue[];
}

export interface FormulaConditionNode {
    kind: 'formula';
    formula: string;
    type?: FormulaReturnType;
    operator?: NQueryOperatorName;
    values?: ConditionParamValue[];
}

export interface LogicalConditionNode {
    kind: 'and' | 'or';
    nodes: ConditionNode[];
}

export interface NegatedConditionNode {
    kind: 'not';
    node: ConditionNode;
}

export type ConditionNode = FieldConditionNode | FormulaConditionNode | LogicalConditionNode | NegatedConditionNode;

export interface DescribedSort {
    component?: string;
    fieldId?: string;
    formula?: string;
    formulaType?: FormulaReturnType;
    context?: FieldContext;
    ascending: boolean;
    nullsLast?: boolean;
}

export interface PageWindow {
    offset: number;
    limit?: number;
}

export interface SeparateLoadDescription {
    /** The relationship loaded by this query (`lines`). */
    relationship: string;
    kind: 'subrecord' | 'sublist' | 'reference';
    /** The query that loads one batch; the ANY_OF condition on `batchFieldId` is added per batch at run time. */
    description: QueryDescription;
    /** Output path on the mapped parent whose values are collected into the batch (`id`, or the select field of a reference). */
    parentKeyPath: string;
    /** Root field id of the separate query compared with the collected values. */
    batchFieldId: string;
    /** Type of that field: select and key fields take the batch as ANY_OF, other types as one EQUAL per value. */
    batchFieldType?: FieldType;
    /** Alias of the column in the separate query that carries the value matched back to the parent. */
    parentKeyAlias: string;
}

export interface QueryDescription {
    queryType: string;
    components: DescribedComponent[];
    columns: DescribedColumn[];
    condition?: ConditionNode;
    sort: DescribedSort[];
    page?: PageWindow;
    separateLoads?: SeparateLoadDescription[];
}

export interface FieldMapEntry<TFieldMeta = unknown> {
    key: string;
    outputPath: string;
    field: QueryField<TFieldMeta>;
}

export type FieldMap<TFieldMeta = unknown> = Record<string, FieldMapEntry<TFieldMeta>>;

export interface QueryExecution<TResult> {
    data: Record<string, QueryResultValue>[];
    query: QueryDescription;
}

export type EntitySchema = Record<string, QueryConfig<any, any> | QueryConfigInput<any, any>>;

export interface QueryPageOptions {
    pageSize?: number;
}

// ── writes ───────────────────────────────────────────────────────────────────

export type RecordFieldValue = NsRecord.FieldValue | ReadonlyArray<string | number> | undefined;

export interface RecordUpdaterOptions {
    isDynamic?: boolean;
    enableSourcing?: boolean;
    ignoreMandatoryFields?: boolean;
    requireFastPath?: boolean;
    maxRecordCalls?: number;
    allowLineScans?: boolean;
    allowSubrecordReloads?: boolean;
}

export interface UpdateDetails {
    bodyFieldsUpdated: number;
    subrecordsUpdated: number;
    sublistLinesUpdated: number;
    sublistLinesAdded: number;
    sublistLinesRemoved: number;
}

export interface UpdateResult {
    success: boolean;
    id?: number;
    error?: string;
    details?: UpdateDetails;
}

export interface DeleteResult {
    success: boolean;
    id?: number;
    error?: string;
}

export type UpdatePlanExecutionMode = 'none' | 'submitFields' | 'loadSave' | 'create';

export interface UpdatePlanField {
    key: string;
    fieldId: string;
}

export interface SubmitFieldsUpdatePlanOperation {
    kind: 'submitFields';
    recordType: string;
    recordId?: RecordId;
    fields: UpdatePlanField[];
}

export interface LoadRecordUpdatePlanOperation {
    kind: 'loadRecord';
    recordType: string;
    recordId?: RecordId;
    isDynamic: boolean;
}

export interface CreateRecordUpdatePlanOperation {
    kind: 'createRecord';
    recordType: string;
    isDynamic: boolean;
}

export interface BodyFieldsUpdatePlanOperation {
    kind: 'bodyFields';
    fields: UpdatePlanField[];
}

export interface SubrecordUpdatePlanOperation {
    kind: 'subrecord';
    subrecordFieldId: string;
    fields: UpdatePlanField[];
    reload?: {
        clearFieldId: string;
        conditional: true;
    };
}

export interface SublistUpdatePlanOperation {
    kind: 'sublistUpdate';
    sublistId: string;
    line?: number;
    matchField?: UpdatePlanField & { value: RecordFieldValue };
    fields: UpdatePlanField[];
}

export interface SublistAddPlanOperation {
    kind: 'sublistAdd';
    sublistId: string;
    fields: UpdatePlanField[];
}

export interface SublistRemovePlanOperation {
    kind: 'sublistRemove';
    sublistId: string;
    line: number;
}

export interface SaveRecordUpdatePlanOperation {
    kind: 'saveRecord';
    enableSourcing: boolean;
    ignoreMandatoryFields: boolean;
}

export type UpdatePlanOperation =
    | SubmitFieldsUpdatePlanOperation
    | LoadRecordUpdatePlanOperation
    | CreateRecordUpdatePlanOperation
    | BodyFieldsUpdatePlanOperation
    | SubrecordUpdatePlanOperation
    | SublistUpdatePlanOperation
    | SublistAddPlanOperation
    | SublistRemovePlanOperation
    | SaveRecordUpdatePlanOperation;

export interface UpdatePerformanceEstimate {
    executionMode: UpdatePlanExecutionMode;
    netSuiteRecordCalls: number;
    recordLoads: number;
    recordSaves: number;
    recordCreates: number;
    submitFieldsCalls: number;
    sublistLineScans: number;
    conditionalSubrecordReloads: number;
    notes: string[];
}

export interface UpdatePlan {
    recordType: string;
    recordId?: RecordId;
    executionMode: UpdatePlanExecutionMode;
    pendingCount: number;
    details: UpdateDetails;
    operations: UpdatePlanOperation[];
    performance: UpdatePerformanceEstimate;
}

export interface LineUpdate<TUpdate = Record<string, RecordFieldValue>> {
    line: number;
    updates: Partial<TUpdate> | Record<string, RecordFieldValue>;
}

export interface CollectionLineMatch {
    field: string;
    value: RecordFieldValue;
}

export interface CollectionLinePatch {
    line?: number;
    match?: CollectionLineMatch;
    values?: Record<string, unknown>;
    updates?: Record<string, unknown>;
}

export interface CollectionPatch {
    update?: CollectionLinePatch[];
    add?: Array<Record<string, unknown>>;
    remove?: number[];
}

export type RecordGraphPatch<TUpdate extends object = Record<string, unknown>> = Partial<TUpdate> & Record<string, unknown>;

export interface SubrecordReloadConfig {
    subrecordFieldId: string;
    listFieldToClear: string;
}

// ── normalization ────────────────────────────────────────────────────────────

export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta>;
export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta>;
export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta> | QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    return normalizeQueryConfig(config);
}

/** Flattens sectioned fields and fills the defaults the runtime relies on: the query type and the component map. */
export function normalizeQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta> | QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    const fields: Record<string, QueryField<TFieldMeta>> = {};
    for (const [key, field] of Object.entries(config.fields)) {
        fields[key] = normalizeQueryField(field);
    }
    return { ...config, queryType: config.queryType ?? config.recordType, components: config.components ?? {}, fields };
}

export function normalizeQueryField<TFieldMeta = unknown>(field: QueryFieldConfig<TFieldMeta>): QueryField<TFieldMeta> {
    if (!isQueryFieldSections(field)) return field;
    return {
        ...field.query,
        ...(field.common || {}),
        ...(field.record || {}),
    };
}

function isQueryFieldSections<TFieldMeta>(field: QueryFieldConfig<TFieldMeta>): field is QueryFieldSections<TFieldMeta> {
    return Boolean(field && typeof field === 'object' && 'query' in field && field.query && typeof field.query === 'object');
}
