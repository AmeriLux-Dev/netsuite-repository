import type * as NsRecord from 'N/record';

export type QueryParamValue = string | number | boolean | null;
export type QueryResultValue = string | number | boolean | null;
export type RecordId = string | number;

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
    constraints: JoinConstraint[];
}

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
    transform?: (value: QueryResultValue, row: Record<string, QueryResultValue>) => unknown;
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

export interface OwnedSubrecordRelationship {
    kind: 'owned';
    recordAccessId: string;
    fields?: RelationshipFieldMap;
    reload?: {
        listFieldToClear: string;
    };
}

export interface SublistRelationship {
    kind: 'collection';
    recordAccessId: string;
    fields?: RelationshipFieldMap;
    matchField?: string;
}

export type EntityRelationship = OwnedSubrecordRelationship | SublistRelationship;

export interface QueryConfig<TResult, TFieldMeta = unknown> {
    recordType: string;
    query: QueryShape;
    fields: Record<string, QueryField<TFieldMeta>>;
    relationships?: Record<string, EntityRelationship>;
    restRecordMetadata?: RestRecordMetadata;
    composite?: CompositeModelMapping;
    postProcess?: (result: TResult) => TResult;
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

export type UpdatePlanExecutionMode = 'none' | 'submitFields' | 'loadSave';

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

export type RecordGraphPatch<TUpdate extends Record<string, unknown> = Record<string, unknown>> = Partial<TUpdate> & Record<string, unknown>;

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