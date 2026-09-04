import type * as NsRecord from 'N/record';

export type QueryParamValue = string | number | boolean | null;
/** A value a where() condition accepts: a parameter value, or a Date the builder binds through TO_DATE. */
export type ConditionParamValue = QueryParamValue | Date;
export type QueryResultValue = string | number | boolean | null;
export type RecordId = string | number;
export type CoercedQueryValue = QueryResultValue | Date;
export type PaginationMode = 'offsetFetch' | 'top';

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
export type JoinType = 'inner' | 'leftOuter' | 'rightOuter';
export type Cardinality = 'one' | 'many';
export type RecordAccess = 'body' | 'subrecord' | 'sublist';
export type RestRecordFieldKind = 'string' | 'integer' | 'float' | 'currency' | 'boolean' | 'date' | 'datetime' | 'select' | 'multiselect' | 'reference' | 'object' | 'subrecord' | 'sublist' | 'unknown';

export type FieldSourceKind = 'recordField' | 'joinedRecordField' | 'subrecordField' | 'sublistField' | 'derived' | 'external';

export interface FieldSourceMapping {
    kind: FieldSourceKind;
    recordType?: string;
    tableAlias?: string;
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

export type QueryOperator =
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

export type RecordFieldValue = NsRecord.FieldValue | ReadonlyArray<string | number> | undefined;

export interface TableRef {
    name: string;
    alias: string;
}

export interface JoinKeys {
    sourceForeignKey: string;
    targetPrimaryKey: string;
    sourceTable?: string;
    targetTable?: string;
}

export interface JoinConstraint {
    joinKeys: JoinKeys;
    joinLinkType?: 'AND' | 'OR';
}

export interface JoinDef {
    toTable: TableRef;
    fromTable: string;
    type: JoinType;
    /** Equality constraints rendered as `source.key = target.key`. Ignored when `on` is set. */
    constraints?: JoinConstraint[];
    /** Raw ON predicate rendered verbatim, e.g. "tl.transaction = txn.id AND tl.mainline = 'F'". */
    on?: string;
    /** Positional parameters for `?` placeholders inside `on`. Bound before WHERE parameters. */
    params?: QueryParamValue[];
}

/** Accepted shapes for a join predicate: raw SQL, one equality pair, or several equality pairs joined with AND. */
export type JoinOn = string | JoinKeys | JoinKeys[];

export interface QueryShape {
    from: TableRef;
    joins?: JoinDef[];
}

export interface QueryField<TRow = unknown> {
    queryFieldId: string;
    tableAlias: string;
    type?: FieldType;
    alias?: string;
    nestPath?: string;
    cardinality?: Cardinality;
    isPrimary?: boolean;
    select?: boolean;
    useText?: boolean;
    /** Rendered verbatim in SELECT instead of `tableAlias.queryFieldId` (computed columns, selectRaw). */
    expression?: string;
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

export type QueryFieldQuerySection<TFieldMeta = unknown> = Pick<QueryField<TFieldMeta>, 'queryFieldId' | 'tableAlias'> & Partial<Omit<QueryField<TFieldMeta>, 'queryFieldId' | 'tableAlias'>>;

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

export interface RestRecordFieldMetadata {
    id: string;
    label?: string;
    description?: string;
    kind?: RestRecordFieldKind;
    format?: string;
    writable?: boolean;
    required?: boolean;
    nullable?: boolean;
    readOnly?: boolean;
    writeOnly?: boolean;
    custom?: boolean;
    enumValues?: Array<string | number | boolean | null>;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    schemaRef?: string;
    targetRecordType?: string;
    itemSchema?: string;
    properties?: Record<string, RestRecordFieldMetadata>;
}

export interface RestRecordOperationMetadata {
    method: string;
    path: string;
    operationId?: string;
    summary?: string;
    parameters?: Array<{ name: string; in?: string; required?: boolean; kind?: RestRecordFieldKind }>;
    requestSchema?: string;
    responseSchemas?: Record<string, string>;
}

export interface RestRecordSubrecordMetadata {
    fieldId: string;
    writable?: boolean;
    clearBeforeUpdateFieldId?: string;
    fields?: Record<string, RestRecordFieldMetadata>;
}

export interface RestRecordSublistMetadata {
    sublistId: string;
    writable?: boolean;
    fields?: Record<string, RestRecordFieldMetadata>;
}

export interface RestRecordOperations {
    create?: boolean;
    read?: boolean;
    update?: boolean;
    delete?: boolean;
}

export interface RestRecordMetadata {
    recordType: string;
    operations?: RestRecordOperations;
    operationMetadata?: Partial<Record<keyof RestRecordOperations, RestRecordOperationMetadata>>;
    fields?: Record<string, RestRecordFieldMetadata>;
    subrecords?: Record<string, RestRecordSubrecordMetadata>;
    sublists?: Record<string, RestRecordSublistMetadata>;
}

export type RelationshipFieldMap = Record<string, string>;

/** Shared by every relationship kind. */
export interface RelationshipBase {
    /** Config field keys by nested property name. */
    fields?: RelationshipFieldMap;
    /** Aliases of the joins that exist only to read this relationship, so a query can drop them when the relationship is excluded. */
    joinAliases?: string[];
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

/** Table-per-hierarchy filter: the column and value that select this record type's rows out of a shared table. */
export interface Discriminator {
    column: string;
    value: string;
}

export interface QueryConfig<TResult, TFieldMeta = unknown> {
    recordType: string;
    query: QueryShape;
    fields: Record<string, QueryField<TFieldMeta>>;
    relationships?: Record<string, EntityRelationship>;
    /** Added to every query as `<root alias>.<column> = <value>` when the record type shares its table with others. */
    discriminator?: Discriminator;
    restRecordMetadata?: RestRecordMetadata;
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

export interface BuiltQuery<TFieldMeta = unknown> {
    sql: string;
    params: QueryParamValue[];
    fieldMap: FieldMap<TFieldMeta>;
}

export interface FieldMapEntry<TFieldMeta = unknown> {
    key: string;
    outputPath: string;
    field: QueryField<TFieldMeta>;
}

export type FieldMap<TFieldMeta = unknown> = Record<string, FieldMapEntry<TFieldMeta>>;

export interface QueryExecution<TResult> {
    data: Record<string, QueryResultValue>[];
    query: BuiltQuery;
}

export type EntitySchema = Record<string, QueryConfig<any, any> | QueryConfigInput<any, any>>;

export interface QueryPageOptions {
    pageSize?: number;
}

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

export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta>;
export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta>;
export function defineQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta> | QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    return normalizeQueryConfig(config);
}

export function normalizeQueryConfig<TResult, TFieldMeta = unknown>(config: QueryConfig<TResult, TFieldMeta> | QueryConfigInput<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    const fields: Record<string, QueryField<TFieldMeta>> = {};
    for (const [key, field] of Object.entries(config.fields)) {
        fields[key] = normalizeQueryField(field);
    }
    return { ...config, fields };
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