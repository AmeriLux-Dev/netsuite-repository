import type * as NsRecord from 'N/record';
import { normalizeQueryConfig } from './types';
import type {
    CollectionLinePatch,
    CollectionPatch,
    EntityRelationship,
    LineUpdate,
    OwnedSubrecordRelationship,
    QueryConfig,
    QueryConfigInput,
    QueryField,
    RecordFieldValue,
    RecordGraphPatch,
    RecordId,
    RecordUpdaterOptions,
    RestRecordFieldKind,
    RestRecordFieldMetadata,
    SublistRelationship,
    SubrecordReloadConfig,
    UpdateDetails,
    UpdatePerformanceEstimate,
    UpdatePlan,
    UpdatePlanField,
    UpdatePlanOperation,
    UpdateResult,
} from './types';

declare const require: <T = unknown>(moduleName: string) => T;

interface PendingFieldUpdate {
    key: string;
    recordFieldId: string;
    value: NsRecord.FieldValue;
    field: QueryField;
}

interface PendingLineUpdate {
    sublistId: string;
    line: number;
    matchField?: { fieldId: string; value: NsRecord.FieldValue };
    fields: PendingFieldUpdate[];
}

interface PendingLineAdd {
    sublistId: string;
    fields: PendingFieldUpdate[];
}

interface PendingLineRemove {
    sublistId: string;
    line: number;
}

type EditableRecord = NsRecord.Record & { id?: number };

function getNsRecord(): typeof import('N/record') {
    return require<typeof import('N/record')>('N/record');
}

function emptyDetails(): UpdateDetails {
    return {
        bodyFieldsUpdated: 0,
        subrecordsUpdated: 0,
        sublistLinesUpdated: 0,
        sublistLinesAdded: 0,
        sublistLinesRemoved: 0,
    };
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toQueryFieldType(kind: RestRecordFieldKind | undefined): QueryField['type'] {
    switch (kind) {
        case 'integer':
            return 'integer';
        case 'float':
            return 'float';
        case 'currency':
            return 'currency';
        case 'boolean':
            return 'boolean';
        case 'date':
            return 'date';
        case 'datetime':
            return 'datetime';
        case 'multiselect':
            return 'multiselect';
        case 'reference':
            return 'key';
        default:
            return 'string';
    }
}

export class OwnedSubrecordUpdater<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    constructor(
        private readonly parent: RecordUpdater<TResult, TUpdate>,
        private readonly relationshipName: string,
        private readonly relationship: OwnedSubrecordRelationship,
    ) {}

    set(fieldKey: string, value: RecordFieldValue): this {
        this.parent.setOwnedField(this.relationshipName, this.relationship, fieldKey, value);
        return this;
    }

    setMany(updates: Record<string, unknown>): this {
        this.parent.setOwnedMany(this.relationshipName, this.relationship, updates);
        return this;
    }

    end(): RecordUpdater<TResult, TUpdate> {
        return this.parent;
    }
}

export class SublistCollectionUpdater<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    constructor(
        private readonly parent: RecordUpdater<TResult, TUpdate>,
        private readonly relationshipName: string,
        private readonly relationship: SublistRelationship,
    ) {}

    updateLine(line: number, updates: Record<string, unknown>): this {
        this.parent.updateCollectionLine(this.relationshipName, this.relationship, line, updates);
        return this;
    }

    updateLineByField(matchFieldKey: string, matchValue: RecordFieldValue, updates: Record<string, unknown>): this {
        this.parent.updateCollectionLineByField(this.relationshipName, this.relationship, matchFieldKey, matchValue, updates);
        return this;
    }

    updateLines(lineUpdates: Array<LineUpdate<Record<string, unknown>>>): this {
        for (const lineUpdate of lineUpdates) {
            this.updateLine(lineUpdate.line, lineUpdate.updates);
        }
        return this;
    }

    addLine(values: Record<string, unknown>): this {
        this.parent.addCollectionLine(this.relationshipName, this.relationship, values);
        return this;
    }

    removeLine(line: number): this {
        this.parent.removeLine(this.relationship.recordAccessId, line);
        return this;
    }

    end(): RecordUpdater<TResult, TUpdate> {
        return this.parent;
    }
}

export class RecordUpdater<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>> {
    private readonly config: QueryConfig<TResult>;
    private recordId: RecordId | null = null;
    private options: Required<RecordUpdaterOptions> = {
        isDynamic: false,
        enableSourcing: false,
        ignoreMandatoryFields: true,
        requireFastPath: false,
        maxRecordCalls: Number.POSITIVE_INFINITY,
        allowLineScans: true,
        allowSubrecordReloads: true,
    };
    private readonly bodyFields = new Map<string, PendingFieldUpdate>();
    private readonly subrecordFields = new Map<string, Map<string, PendingFieldUpdate>>();
    private readonly subrecordReloads = new Map<string, SubrecordReloadConfig>();
    private lineUpdates: PendingLineUpdate[] = [];
    private lineAdds: PendingLineAdd[] = [];
    private lineRemoves: PendingLineRemove[] = [];

    private constructor(config: QueryConfig<TResult>) {
        this.config = config;
    }

    static for<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>>(config: QueryConfig<TResult> | QueryConfigInput<TResult>): RecordUpdater<TResult, TUpdate> {
        return new RecordUpdater<TResult, TUpdate>(normalizeQueryConfig(config));
    }

    id(recordId: RecordId): this {
        this.recordId = recordId;
        return this;
    }

    dynamic(enabled = true): this {
        this.options.isDynamic = enabled;
        return this;
    }

    withOptions(options: RecordUpdaterOptions): this {
        this.options = { ...this.options, ...options };
        return this;
    }

    withSubrecordReload(config: SubrecordReloadConfig): this {
        this.subrecordReloads.set(config.subrecordFieldId, config);
        return this;
    }

    owned(name: string): OwnedSubrecordUpdater<TResult, TUpdate> {
        const relationship = this.getOwnedRelationship(name);
        return new OwnedSubrecordUpdater(this, name, relationship);
    }

    collection(name: string): SublistCollectionUpdater<TResult, TUpdate> {
        const relationship = this.getCollectionRelationship(name);
        return new SublistCollectionUpdater(this, name, relationship);
    }

    set<K extends keyof TUpdate & string>(fieldKey: K, value: TUpdate[K] | RecordFieldValue): this;
    set(fieldKey: string, value: RecordFieldValue): this;
    set(fieldKey: string, value: unknown): this {
        const field = this.resolveWritableField(fieldKey);
        const access = field.recordAccess ?? 'body';

        if (access === 'sublist') {
            throw new Error(`Field '${fieldKey}' belongs to a sublist. Use updateLine() or addLine().`);
        }

        const update = this.toPendingUpdate(fieldKey, field, value);
        if (access === 'body') {
            this.bodyFields.set(fieldKey, update);
            return this;
        }

        const subrecordId = this.requireRecordAccessId(fieldKey, field, 'subrecord');
        const updates = this.subrecordFields.get(subrecordId) ?? new Map<string, PendingFieldUpdate>();
        updates.set(fieldKey, update);
        this.subrecordFields.set(subrecordId, updates);

        if (field.subrecordNeedsReload && field.subrecordListFieldToClear && !this.subrecordReloads.has(subrecordId)) {
            this.subrecordReloads.set(subrecordId, {
                subrecordFieldId: subrecordId,
                listFieldToClear: field.subrecordListFieldToClear,
            });
        }
        return this;
    }

    setMany(updates: Partial<TUpdate> | Record<string, unknown>): this {
        for (const [key, value] of Object.entries(this.flattenPatchUpdates(updates))) {
            if (value !== undefined) {
                this.set(key, value as RecordFieldValue);
            }
        }
        return this;
    }

    patch(updates: RecordGraphPatch<TUpdate>): this {
        const fieldUpdates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined) {
                continue;
            }

            const relationship = this.config.relationships?.[key];
            if (relationship) {
                this.patchRelationship(key, relationship, value);
                continue;
            }

            Object.assign(fieldUpdates, this.flattenPatchUpdates({ [key]: value }));
        }

        for (const [key, value] of Object.entries(fieldUpdates)) {
            if (value !== undefined) {
                this.set(key, value as RecordFieldValue);
            }
        }
        return this;
    }

    updateLine(sublistId: string, line: number, updates: Partial<TUpdate> | Record<string, unknown>): this {
        this.lineUpdates.push({ sublistId, line, fields: this.resolveLineFields(sublistId, updates) });
        return this;
    }

    updateLineByField(sublistId: string, matchFieldKey: string, matchValue: RecordFieldValue, updates: Partial<TUpdate> | Record<string, unknown>): this {
        const matchField = this.findSublistField(sublistId, matchFieldKey);
        this.lineUpdates.push({
            sublistId,
            line: -1,
            matchField: {
                fieldId: matchField.recordFieldId ?? matchField.queryFieldId,
                value: this.convertValue(matchValue, matchField),
            },
            fields: this.resolveLineFields(sublistId, updates),
        });
        return this;
    }

    updateLines(sublistId: string, lineUpdates: Array<LineUpdate<TUpdate>>): this {
        for (const lineUpdate of lineUpdates) {
            this.updateLine(sublistId, lineUpdate.line, lineUpdate.updates);
        }
        return this;
    }

    addLine(sublistId: string, values: Partial<TUpdate> | Record<string, unknown>): this {
        this.lineAdds.push({ sublistId, fields: this.resolveLineFields(sublistId, values) });
        return this;
    }

    removeLine(sublistId: string, line: number): this {
        this.lineRemoves.push({ sublistId, line });
        return this;
    }

    setOwnedField(relationshipName: string, relationship: OwnedSubrecordRelationship, fieldKey: string, value: unknown): this {
        const configFieldKey = this.resolveRelationshipFieldKey(relationshipName, relationship, fieldKey);
        const field = this.resolveWritableField(configFieldKey);
        const update = this.toPendingUpdate(configFieldKey, field, value);
        const updates = this.subrecordFields.get(relationship.recordAccessId) ?? new Map<string, PendingFieldUpdate>();
        updates.set(configFieldKey, update);
        this.subrecordFields.set(relationship.recordAccessId, updates);
        this.registerSubrecordReload(relationship.recordAccessId, relationship, field);
        return this;
    }

    setOwnedMany(relationshipName: string, relationship: OwnedSubrecordRelationship, updates: Record<string, unknown>): this {
        for (const [fieldKey, value] of Object.entries(this.flattenRelationshipUpdates(updates))) {
            if (value !== undefined) {
                this.setOwnedField(relationshipName, relationship, fieldKey, value);
            }
        }
        return this;
    }

    updateCollectionLine(relationshipName: string, relationship: SublistRelationship, line: number, updates: Record<string, unknown>): this {
        this.lineUpdates.push({ sublistId: relationship.recordAccessId, line, fields: this.resolveCollectionFields(relationshipName, relationship, updates) });
        return this;
    }

    updateCollectionLineByField(relationshipName: string, relationship: SublistRelationship, matchFieldKey: string, matchValue: RecordFieldValue, updates: Record<string, unknown>): this {
        const configFieldKey = this.resolveRelationshipFieldKey(relationshipName, relationship, matchFieldKey);
        const matchField = this.resolveWritableField(configFieldKey);
        this.lineUpdates.push({
            sublistId: relationship.recordAccessId,
            line: -1,
            matchField: {
                fieldId: matchField.recordFieldId ?? matchField.queryFieldId,
                value: this.convertValue(matchValue, matchField),
            },
            fields: this.resolveCollectionFields(relationshipName, relationship, updates),
        });
        return this;
    }

    addCollectionLine(relationshipName: string, relationship: SublistRelationship, values: Record<string, unknown>): this {
        this.lineAdds.push({ sublistId: relationship.recordAccessId, fields: this.resolveCollectionFields(relationshipName, relationship, values) });
        return this;
    }

    submit(): UpdateResult {
        if (this.recordId === null) {
            return { success: false, error: 'Record ID is not set. Call id() before submit().' };
        }

        if (this.getPendingCount() === 0) {
            return { success: true, id: Number(this.recordId), details: emptyDetails() };
        }

        try {
            this.assertPerformanceGuardrails(this.plan());
            return this.canUseSubmitFields() ? this.submitFields() : this.loadSave();
        } catch (error) {
            return { success: false, error: formatError(error) };
        }
    }

    plan(): UpdatePlan {
        const pendingCount = this.getPendingCount();
        const executionMode = pendingCount === 0 ? 'none' : this.canUseSubmitFields() ? 'submitFields' : 'loadSave';
        const operations = executionMode === 'submitFields' ? this.planSubmitFieldsOperations() : executionMode === 'loadSave' ? this.planLoadSaveOperations() : [];
        const details = this.getPendingDetails();

        return {
            recordType: this.config.recordType,
            recordId: this.recordId ?? undefined,
            executionMode,
            pendingCount,
            details,
            operations,
            performance: this.estimatePerformance(executionMode),
        };
    }

    clear(): this {
        this.bodyFields.clear();
        this.subrecordFields.clear();
        this.subrecordReloads.clear();
        this.lineUpdates = [];
        this.lineAdds = [];
        this.lineRemoves = [];
        return this;
    }

    getPendingCount(): number {
        let count = this.bodyFields.size + this.lineUpdates.length + this.lineAdds.length + this.lineRemoves.length;
        for (const fields of Array.from(this.subrecordFields.values())) {
            count += fields.size;
        }
        return count;
    }

    private canUseSubmitFields(): boolean {
        return this.bodyFields.size > 0 && this.subrecordFields.size === 0 && this.lineUpdates.length === 0 && this.lineAdds.length === 0 && this.lineRemoves.length === 0;
    }

    private getPendingDetails(): UpdateDetails {
        return {
            bodyFieldsUpdated: this.bodyFields.size,
            subrecordsUpdated: this.subrecordFields.size,
            sublistLinesUpdated: this.lineUpdates.length,
            sublistLinesAdded: this.lineAdds.length,
            sublistLinesRemoved: this.lineRemoves.length,
        };
    }

    private planSubmitFieldsOperations(): UpdatePlanOperation[] {
        return [{
            kind: 'submitFields',
            recordType: this.config.recordType,
            recordId: this.recordId ?? undefined,
            fields: this.toPlanFields(this.sortUpdates(Array.from(this.bodyFields.values()))),
        }];
    }

    private planLoadSaveOperations(): UpdatePlanOperation[] {
        const operations: UpdatePlanOperation[] = [{
            kind: 'loadRecord',
            recordType: this.config.recordType,
            recordId: this.recordId ?? undefined,
            isDynamic: this.options.isDynamic,
        }];

        if (this.bodyFields.size > 0) {
            operations.push({
                kind: 'bodyFields',
                fields: this.toPlanFields(this.sortUpdates(Array.from(this.bodyFields.values()))),
            });
        }

        for (const remove of [...this.lineRemoves].sort((left, right) => right.line - left.line)) {
            operations.push({ kind: 'sublistRemove', sublistId: remove.sublistId, line: remove.line });
        }

        for (const lineUpdate of this.lineUpdates) {
            operations.push({
                kind: 'sublistUpdate',
                sublistId: lineUpdate.sublistId,
                line: lineUpdate.matchField ? undefined : lineUpdate.line,
                matchField: lineUpdate.matchField ? { key: lineUpdate.matchField.fieldId, fieldId: lineUpdate.matchField.fieldId, value: lineUpdate.matchField.value } : undefined,
                fields: this.toPlanFields(this.sortUpdates(lineUpdate.fields)),
            });
        }

        for (const lineAdd of this.lineAdds) {
            operations.push({
                kind: 'sublistAdd',
                sublistId: lineAdd.sublistId,
                fields: this.toPlanFields(this.sortUpdates(lineAdd.fields)),
            });
        }

        for (const [subrecordId, updates] of Array.from(this.subrecordFields.entries())) {
            const reload = this.subrecordReloads.get(subrecordId);
            operations.push({
                kind: 'subrecord',
                subrecordFieldId: subrecordId,
                fields: this.toPlanFields(this.sortUpdates(Array.from(updates.values()))),
                reload: reload ? { clearFieldId: reload.listFieldToClear, conditional: true } : undefined,
            });
        }

        operations.push({
            kind: 'saveRecord',
            enableSourcing: this.options.enableSourcing,
            ignoreMandatoryFields: this.options.ignoreMandatoryFields,
        });

        return operations;
    }

    private estimatePerformance(executionMode: UpdatePlan['executionMode']): UpdatePerformanceEstimate {
        const conditionalSubrecordReloads = Array.from(this.subrecordFields.keys()).filter((subrecordId) => this.subrecordReloads.has(subrecordId)).length;
        const sublistLineScans = this.lineUpdates.filter((lineUpdate) => Boolean(lineUpdate.matchField)).length;
        const notes: string[] = [];

        if (executionMode === 'submitFields') {
            notes.push('Uses record.submitFields; avoids record.load and record.save.');
        } else if (executionMode === 'loadSave') {
            notes.push('Uses record.load and record.save because the update touches subrecords, sublists, or line operations.');
        }
        if (conditionalSubrecordReloads > 0) {
            notes.push('Subrecord reloads are conditional; each one may add one save and one reload if the linked list field has a value.');
        }
        if (sublistLineScans > 0) {
            notes.push('Line matching scans existing sublist lines; prefer stable line indexes or unique line keys when possible.');
        }

        return {
            executionMode,
            netSuiteRecordCalls: executionMode === 'none' ? 0 : executionMode === 'submitFields' ? 1 : 2 + conditionalSubrecordReloads * 2,
            recordLoads: executionMode === 'loadSave' ? 1 + conditionalSubrecordReloads : 0,
            recordSaves: executionMode === 'loadSave' ? 1 + conditionalSubrecordReloads : 0,
            submitFieldsCalls: executionMode === 'submitFields' ? 1 : 0,
            sublistLineScans,
            conditionalSubrecordReloads,
            notes,
        };
    }

    private toPlanFields(updates: PendingFieldUpdate[]): UpdatePlanField[] {
        return updates.map((update) => ({ key: update.key, fieldId: update.recordFieldId }));
    }

    private assertPerformanceGuardrails(plan: UpdatePlan): void {
        const violations: string[] = [];

        if (this.options.requireFastPath && plan.executionMode !== 'submitFields' && plan.executionMode !== 'none') {
            violations.push(`requires fast path but planned execution is '${plan.executionMode}'`);
        }

        if (plan.performance.netSuiteRecordCalls > this.options.maxRecordCalls) {
            violations.push(`planned ${plan.performance.netSuiteRecordCalls} NetSuite record calls exceeds maxRecordCalls ${this.options.maxRecordCalls}`);
        }

        if (!this.options.allowLineScans && plan.performance.sublistLineScans > 0) {
            violations.push(`planned ${plan.performance.sublistLineScans} sublist line scan(s), but allowLineScans is false`);
        }

        if (!this.options.allowSubrecordReloads && plan.performance.conditionalSubrecordReloads > 0) {
            violations.push(`planned ${plan.performance.conditionalSubrecordReloads} conditional subrecord reload(s), but allowSubrecordReloads is false`);
        }

        if (violations.length > 0) {
            throw new Error(`Update performance guardrail rejected ${this.config.recordType} update: ${violations.join('; ')}.`);
        }
    }

    private submitFields(): UpdateResult {
        const values: Record<string, NsRecord.FieldValue> = {};
        for (const update of this.sortUpdates(Array.from(this.bodyFields.values()))) {
            values[update.recordFieldId] = update.value;
        }

        const savedId = getNsRecord().submitFields({
            type: this.config.recordType,
            id: this.recordId as string | number,
            values,
            options: {
                enableSourcing: this.options.enableSourcing,
                ignoreMandatoryFields: this.options.ignoreMandatoryFields,
            },
        });

        this.clear();
        return {
            success: true,
            id: savedId,
            details: { ...emptyDetails(), bodyFieldsUpdated: Object.keys(values).length },
        };
    }

    private loadSave(): UpdateResult {
        let loadedRecord = getNsRecord().load({
            type: this.config.recordType,
            id: this.recordId as string | number,
            isDynamic: this.options.isDynamic,
        }) as EditableRecord;
        const details = emptyDetails();

        for (const update of this.sortUpdates(Array.from(this.bodyFields.values()))) {
            loadedRecord.setValue({ fieldId: update.recordFieldId, value: update.value, ignoreFieldChange: true });
            details.bodyFieldsUpdated++;
        }

        for (const remove of [...this.lineRemoves].sort((left, right) => right.line - left.line)) {
            loadedRecord.removeLine({ sublistId: remove.sublistId, line: remove.line });
            details.sublistLinesRemoved++;
        }

        for (const lineUpdate of this.lineUpdates) {
            this.applyLineUpdate(loadedRecord, lineUpdate);
            details.sublistLinesUpdated++;
        }

        for (const lineAdd of this.lineAdds) {
            this.applyLineAdd(loadedRecord, lineAdd);
            details.sublistLinesAdded++;
        }

        for (const [subrecordId, updates] of Array.from(this.subrecordFields.entries())) {
            loadedRecord = this.applySubrecordUpdate(loadedRecord, subrecordId, Array.from(updates.values()));
            details.subrecordsUpdated++;
        }

        const savedId = loadedRecord.save({
            enableSourcing: this.options.enableSourcing,
            ignoreMandatoryFields: this.options.ignoreMandatoryFields,
        });

        this.clear();
        return { success: true, id: savedId, details };
    }

    private applyLineUpdate(recordInstance: EditableRecord, lineUpdate: PendingLineUpdate): void {
        const line = lineUpdate.matchField
            ? this.findLine(recordInstance, lineUpdate.sublistId, lineUpdate.matchField.fieldId, lineUpdate.matchField.value)
            : lineUpdate.line;

        if (line < 0) {
            throw new Error(`No matching line found for sublist '${lineUpdate.sublistId}'.`);
        }

        for (const update of this.sortUpdates(lineUpdate.fields)) {
            recordInstance.setSublistValue({ sublistId: lineUpdate.sublistId, line, fieldId: update.recordFieldId, value: update.value });
        }
    }

    private applyLineAdd(recordInstance: EditableRecord, lineAdd: PendingLineAdd): void {
        const line = recordInstance.getLineCount({ sublistId: lineAdd.sublistId });
        for (const update of this.sortUpdates(lineAdd.fields)) {
            recordInstance.setSublistValue({ sublistId: lineAdd.sublistId, line, fieldId: update.recordFieldId, value: update.value });
        }
    }

    private applySubrecordUpdate(recordInstance: EditableRecord, subrecordId: string, updates: PendingFieldUpdate[]): EditableRecord {
        const reload = this.subrecordReloads.get(subrecordId);
        let currentRecord = recordInstance;

        if (reload && currentRecord.getValue({ fieldId: reload.listFieldToClear })) {
            currentRecord.setValue({ fieldId: reload.listFieldToClear, value: '', ignoreFieldChange: true });
            currentRecord.save({ enableSourcing: this.options.enableSourcing, ignoreMandatoryFields: this.options.ignoreMandatoryFields });
            currentRecord = getNsRecord().load({ type: this.config.recordType, id: this.recordId as string | number, isDynamic: this.options.isDynamic }) as EditableRecord;
        }

        const subrecord = currentRecord.getSubrecord({ fieldId: subrecordId });
        for (const update of this.sortUpdates(updates)) {
            subrecord.setValue({ fieldId: update.recordFieldId, value: update.value, ignoreFieldChange: true });
        }

        return currentRecord;
    }

    private findLine(recordInstance: EditableRecord, sublistId: string, fieldId: string, value: NsRecord.FieldValue): number {
        const lineCount = recordInstance.getLineCount({ sublistId });
        for (let line = 0; line < lineCount; line++) {
            if (recordInstance.getSublistValue({ sublistId, fieldId, line }) === value) {
                return line;
            }
        }
        return -1;
    }

    private resolveLineFields(sublistId: string, updates: Partial<TUpdate> | Record<string, unknown>): PendingFieldUpdate[] {
        return Object.entries(this.flattenUpdates(updates)).map(([key, value]) => {
            const field = this.findSublistField(sublistId, key);
            return this.toPendingUpdate(key, field, value);
        });
    }

    private findSublistField(sublistId: string, fieldKey: string): QueryField {
        const field = this.resolveWritableField(fieldKey, { recordAccess: 'sublist', recordAccessId: sublistId });
        if ((field.recordAccess ?? 'body') !== 'sublist' || field.recordAccessId !== sublistId) {
            throw new Error(`Field '${fieldKey}' is not configured for sublist '${sublistId}'.`);
        }
        return field;
    }

    private resolveCollectionFields(relationshipName: string, relationship: SublistRelationship, updates: Record<string, unknown>): PendingFieldUpdate[] {
        return Object.entries(this.flattenRelationshipUpdates(updates)).map(([fieldKey, value]) => {
            const configFieldKey = this.resolveRelationshipFieldKey(relationshipName, relationship, fieldKey);
            const field = this.resolveWritableField(configFieldKey, { recordAccess: 'sublist', recordAccessId: relationship.recordAccessId, fieldId: fieldKey });
            return this.toPendingUpdate(configFieldKey, field, value);
        });
    }

    private patchRelationship(relationshipName: string, relationship: EntityRelationship, value: unknown): void {
        if (relationship.kind === 'owned') {
            if (!isPlainObject(value)) {
                throw new Error(`Owned relationship '${relationshipName}' expects an object patch.`);
            }
            this.setOwnedMany(relationshipName, relationship, value);
            return;
        }

        if (!isPlainObject(value)) {
            throw new Error(`Collection relationship '${relationshipName}' expects a collection patch object.`);
        }
        this.patchCollection(relationshipName, relationship, value as CollectionPatch);
    }

    private patchCollection(relationshipName: string, relationship: SublistRelationship, patch: CollectionPatch): void {
        for (const linePatch of patch.update ?? []) {
            this.patchCollectionUpdate(relationshipName, relationship, linePatch);
        }

        for (const add of patch.add ?? []) {
            this.addCollectionLine(relationshipName, relationship, add);
        }

        for (const line of patch.remove ?? []) {
            this.removeLine(relationship.recordAccessId, line);
        }
    }

    private patchCollectionUpdate(relationshipName: string, relationship: SublistRelationship, linePatch: CollectionLinePatch): void {
        const values = linePatch.values ?? linePatch.updates;
        if (!values) {
            throw new Error(`Collection relationship '${relationshipName}' update requires values or updates.`);
        }

        if (linePatch.line !== undefined) {
            this.updateCollectionLine(relationshipName, relationship, linePatch.line, values);
            return;
        }

        const match = linePatch.match ?? (relationship.matchField ? { field: relationship.matchField, value: (values as Record<string, unknown>)[relationship.matchField] as RecordFieldValue } : undefined);
        if (!match || match.value === undefined) {
            throw new Error(`Collection relationship '${relationshipName}' update requires line or match.`);
        }

        this.updateCollectionLineByField(relationshipName, relationship, match.field, match.value, values);
    }

    private getRelationship(name: string): EntityRelationship {
        const relationship = this.config.relationships?.[name];
        if (!relationship) {
            throw new Error(`Relationship '${name}' is not defined in query config for '${this.config.recordType}'.`);
        }
        return relationship;
    }

    private getOwnedRelationship(name: string): OwnedSubrecordRelationship {
        const relationship = this.getRelationship(name);
        if (relationship.kind !== 'owned') {
            throw new Error(`Relationship '${name}' is not an owned subrecord relationship.`);
        }
        return relationship;
    }

    private getCollectionRelationship(name: string): SublistRelationship {
        const relationship = this.getRelationship(name);
        if (relationship.kind !== 'collection') {
            throw new Error(`Relationship '${name}' is not a collection relationship.`);
        }
        return relationship;
    }

    private resolveRelationshipFieldKey(relationshipName: string, relationship: EntityRelationship, fieldKey: string): string {
        const mapped = relationship.fields?.[fieldKey];
        if (mapped) {
            return mapped;
        }

        const prefixed = `${relationshipName}_${fieldKey}`;
        if (this.config.fields[prefixed]) {
            return prefixed;
        }

        for (const [configFieldKey, field] of Object.entries(this.config.fields)) {
            if (field.recordAccessId === relationship.recordAccessId && (field.nestPath === `${relationshipName}.${fieldKey}` || field.nestPath?.endsWith(`.${fieldKey}`))) {
                return configFieldKey;
            }
        }

        throw new Error(`Field '${fieldKey}' is not mapped on relationship '${relationshipName}' for '${this.config.recordType}'.`);
    }

    private registerSubrecordReload(subrecordId: string, relationship: OwnedSubrecordRelationship, field: QueryField): void {
        const listFieldToClear = relationship.reload?.listFieldToClear ?? field.subrecordListFieldToClear;
        if ((relationship.reload || field.subrecordNeedsReload) && listFieldToClear && !this.subrecordReloads.has(subrecordId)) {
            this.subrecordReloads.set(subrecordId, {
                subrecordFieldId: subrecordId,
                listFieldToClear,
            });
        }
    }

    private resolveWritableField(fieldKey: string, accessHint?: { recordAccess?: 'body' | 'subrecord' | 'sublist'; recordAccessId?: string; fieldId?: string }): QueryField {
        const configuredField = this.config.fields[fieldKey];
        const field = configuredField ? this.applyUpdateMapping(fieldKey, configuredField) : this.createRestRecordMetadataField(fieldKey, accessHint);
        if (!field) {
            throw new Error(`Field '${fieldKey}' is not defined in query config or REST record metadata for '${this.config.recordType}'.`);
        }
        if (this.config.composite?.updateMode === 'explicit' && configuredField && !configuredField.updateMapping) {
            throw new Error(`Field '${fieldKey}' belongs to an explicit composite config and does not declare an updateMapping.`);
        }
        if (field.readonly) {
            throw new Error(`Field '${fieldKey}' is readonly.`);
        }
        this.assertRestRecordMetadataAllowsField(fieldKey, field);
        return field;
    }

    private applyUpdateMapping(fieldKey: string, field: QueryField): QueryField {
        const mapping = field.updateMapping;
        if (!mapping) return field;

        switch (mapping.kind) {
            case 'readonly':
            case 'derived':
            case 'external':
                throw new Error(`Field '${fieldKey}' is ${mapping.kind}${mapping.reason ? `: ${mapping.reason}` : '.'}`);
            case 'relatedRecord':
                throw new Error(`Field '${fieldKey}' maps to related record '${mapping.recordType}'. Use a repository operation that can update related records explicitly.`);
            case 'body':
                return {
                    ...field,
                    recordFieldId: mapping.fieldId ?? field.recordFieldId ?? field.queryFieldId,
                    recordAccess: 'body',
                    recordAccessId: undefined,
                    setFirst: mapping.setFirst ?? field.setFirst,
                };
            case 'ownedSubrecord': {
                const mappedField = {
                    ...field,
                    recordFieldId: mapping.fieldId ?? field.recordFieldId ?? field.queryFieldId,
                    recordAccess: 'subrecord' as const,
                    recordAccessId: mapping.subrecordFieldId,
                    setFirst: mapping.setFirst ?? field.setFirst,
                    subrecordNeedsReload: Boolean(mapping.clearBeforeUpdateFieldId) || field.subrecordNeedsReload,
                    subrecordListFieldToClear: mapping.clearBeforeUpdateFieldId ?? field.subrecordListFieldToClear,
                };
                if (mapping.clearBeforeUpdateFieldId && !this.subrecordReloads.has(mapping.subrecordFieldId)) {
                    this.subrecordReloads.set(mapping.subrecordFieldId, {
                        subrecordFieldId: mapping.subrecordFieldId,
                        listFieldToClear: mapping.clearBeforeUpdateFieldId,
                    });
                }
                return mappedField;
            }
            case 'sublist':
                return {
                    ...field,
                    recordFieldId: mapping.fieldId ?? field.recordFieldId ?? field.queryFieldId,
                    recordAccess: 'sublist',
                    recordAccessId: mapping.sublistId,
                    setFirst: mapping.setFirst ?? field.setFirst,
                };
        }
    }

    private createRestRecordMetadataField(fieldKey: string, accessHint?: { recordAccess?: 'body' | 'subrecord' | 'sublist'; recordAccessId?: string; fieldId?: string }): QueryField | undefined {
        const metadata = this.config.restRecordMetadata;
        if (!metadata) return undefined;

        const fieldId = accessHint?.fieldId ?? fieldKey;
        if (accessHint?.recordAccess === 'sublist' && accessHint.recordAccessId) {
            const fieldSchema = metadata.sublists?.[accessHint.recordAccessId]?.fields?.[fieldId] ?? metadata.sublists?.[accessHint.recordAccessId]?.fields?.[fieldKey];
            if (!fieldSchema) return undefined;
            return {
                queryFieldId: fieldSchema.id,
                tableAlias: this.config.query.from.alias,
                type: toQueryFieldType(fieldSchema.kind),
                recordFieldId: fieldSchema.id,
                readonly: fieldSchema.writable === false,
                recordAccess: 'sublist',
                recordAccessId: accessHint.recordAccessId,
            };
        }

        if (accessHint?.recordAccess === 'subrecord' && accessHint.recordAccessId) {
            // No public API currently passes recordAccess:'subrecord' as an accessHint; defensive branch for future use
            /* istanbul ignore next */
            const fieldSchema = metadata.subrecords?.[accessHint.recordAccessId]?.fields?.[fieldId] ?? metadata.subrecords?.[accessHint.recordAccessId]?.fields?.[fieldKey];
            /* istanbul ignore next */
            if (!fieldSchema) return undefined;
            /* istanbul ignore next */
            return {
                queryFieldId: fieldSchema.id,
                tableAlias: this.config.query.from.alias,
                type: toQueryFieldType(fieldSchema.kind),
                recordFieldId: fieldSchema.id,
                readonly: fieldSchema.writable === false,
                recordAccess: 'subrecord',
                recordAccessId: accessHint.recordAccessId,
            };
        }

        const fieldSchema = metadata.fields?.[fieldId] ?? metadata.fields?.[fieldKey];
        if (!fieldSchema) return undefined;
        return {
            queryFieldId: fieldSchema.id,
            tableAlias: this.config.query.from.alias,
            type: toQueryFieldType(fieldSchema.kind),
            recordFieldId: fieldSchema.id,
            readonly: fieldSchema.writable === false,
            recordAccess: fieldSchema.kind === 'sublist' ? 'sublist' : fieldSchema.kind === 'subrecord' ? 'subrecord' : 'body',
            recordAccessId: fieldSchema.kind === 'sublist' || fieldSchema.kind === 'subrecord' ? fieldSchema.id : undefined,
        };
    }

    private toPendingUpdate(key: string, field: QueryField, value: unknown): PendingFieldUpdate {
        this.assertRestRecordMetadataAllowsValue(key, field, value);
        const schema = this.getRestRecordFieldMetadata(key, field);
        return {
            key,
            field,
            recordFieldId: field.recordFieldId ?? field.queryFieldId,
            value: this.convertValue(value as RecordFieldValue, field, schema),
        };
    }

    private convertValue(value: RecordFieldValue, field: QueryField, schema?: RestRecordFieldMetadata): NsRecord.FieldValue {
        if (value === undefined || value === null) {
            return null;
        }

        if (schema?.kind === 'reference' && isPlainObject(value)) {
            if ('id' in value) return value.id as NsRecord.FieldValue;
            if ('externalId' in value) return value.externalId as NsRecord.FieldValue;
            if ('refName' in value) return value.refName as NsRecord.FieldValue;
        }

        switch (field.type) {
            case 'integer':
            case 'key':
                return typeof value === 'number' ? Math.floor(value) : parseInt(String(value), 10);
            case 'float':
            case 'currency':
                return typeof value === 'number' ? value : parseFloat(String(value));
            case 'boolean':
            case 'checkbox':
                return typeof value === 'boolean' ? value : String(value).toUpperCase() === 'T' || String(value).toLowerCase() === 'true';
            case 'multiselect':
                return Array.isArray(value) ? value.map(String) : [String(value)];
            default:
                return value as NsRecord.FieldValue;
        }
    }

    private assertRestRecordMetadataAllowsField(fieldKey: string, field: QueryField): void {
        const schema = this.getRestRecordFieldMetadata(fieldKey, field);
        if (!schema) return;
        if (schema.writable === false) {
            throw new Error(`Field '${fieldKey}' is not writable according to REST record metadata.`);
        }

        const access = field.recordAccess ?? 'body';
        if (access === 'subrecord') {
            const subrecordId = this.requireRecordAccessId(fieldKey, field, 'subrecord');
            const subrecordSchema = this.config.restRecordMetadata?.subrecords?.[subrecordId];
            if (subrecordSchema?.writable === false) {
                throw new Error(`Subrecord '${subrecordId}' is not writable according to REST record metadata.`);
            }
            const clearBeforeUpdateFieldId = subrecordSchema?.clearBeforeUpdateFieldId;
            if (clearBeforeUpdateFieldId && !this.subrecordReloads.has(subrecordId)) {
                this.subrecordReloads.set(subrecordId, {
                    subrecordFieldId: subrecordId,
                    listFieldToClear: clearBeforeUpdateFieldId,
                });
            }
        }

        if (access === 'sublist') {
            const sublistId = this.requireRecordAccessId(fieldKey, field, 'sublist');
            const sublistSchema = this.config.restRecordMetadata?.sublists?.[sublistId];
            if (sublistSchema?.writable === false) {
                throw new Error(`Sublist '${sublistId}' is not writable according to REST record metadata.`);
            }
        }
    }

    private assertRestRecordMetadataAllowsValue(fieldKey: string, field: QueryField, value: unknown): void {
        const schema = this.getRestRecordFieldMetadata(fieldKey, field);
        if (value === undefined) return;
        if (value === null) {
            if (schema?.required && schema.nullable === false) {
                throw new Error(`Field '${fieldKey}' is required and not nullable according to REST record metadata.`);
            }
            return;
        }
        if (!schema?.kind || schema.kind === 'unknown') return;

        if (schema.enumValues?.length && !schema.enumValues.some((enumValue) => enumValue === value || String(enumValue) === String(value))) {
            throw new Error(`Field '${fieldKey}' expects one of ${schema.enumValues.map(String).join(', ')} according to REST record metadata.`);
        }

        if (typeof value === 'string') {
            if (schema.minLength !== undefined && value.length < schema.minLength) {
                throw new Error(`Field '${fieldKey}' expects at least ${schema.minLength} characters according to REST record metadata.`);
            }
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                throw new Error(`Field '${fieldKey}' expects no more than ${schema.maxLength} characters according to REST record metadata.`);
            }
            if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
                throw new Error(`Field '${fieldKey}' does not match the REST record metadata pattern.`);
            }
        }

        const isReferenceValue = isPlainObject(value) && ('id' in value || 'refName' in value || 'externalId' in value);
        switch (schema.kind) {
            case 'integer':
            case 'float':
            case 'currency':
                if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Number(value)))) {
                    throw new Error(`Field '${fieldKey}' expects a numeric value according to REST record metadata.`);
                }
                if (schema.minimum !== undefined && Number(value) < schema.minimum) {
                    throw new Error(`Field '${fieldKey}' expects a value greater than or equal to ${schema.minimum} according to REST record metadata.`);
                }
                if (schema.maximum !== undefined && Number(value) > schema.maximum) {
                    throw new Error(`Field '${fieldKey}' expects a value less than or equal to ${schema.maximum} according to REST record metadata.`);
                }
                return;
            case 'boolean':
                if (typeof value !== 'boolean' && !['t', 'f', 'true', 'false'].includes(String(value).toLowerCase())) {
                    throw new Error(`Field '${fieldKey}' expects a boolean value according to REST record metadata.`);
                }
                return;
            case 'date':
            case 'datetime':
                if (!(value instanceof Date) && (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value)))) {
                    throw new Error(`Field '${fieldKey}' expects a date value according to REST record metadata.`);
                }
                return;
            case 'multiselect':
                if (!Array.isArray(value)) {
                    throw new Error(`Field '${fieldKey}' expects an array value according to REST record metadata.`);
                }
                return;
            case 'reference':
                if (typeof value !== 'string' && typeof value !== 'number' && !isReferenceValue) {
                    throw new Error(`Field '${fieldKey}' expects a record reference value according to REST record metadata.`);
                }
                return;
            case 'object':
            case 'subrecord':
            case 'sublist':
                if (!isPlainObject(value) && !Array.isArray(value)) {
                    throw new Error(`Field '${fieldKey}' expects an object value according to REST record metadata.`);
                }
                return;
            default:
                return;
        }
    }

    private getRestRecordFieldMetadata(fieldKey: string, field: QueryField): RestRecordFieldMetadata | undefined {
        const metadata = this.config.restRecordMetadata;
        if (!metadata) return undefined;

        const recordFieldId = field.recordFieldId ?? field.queryFieldId;
        const access = field.recordAccess ?? 'body';
        if (access === 'subrecord' && field.recordAccessId) {
            return metadata.subrecords?.[field.recordAccessId]?.fields?.[recordFieldId]
                ?? metadata.subrecords?.[field.recordAccessId]?.fields?.[fieldKey]
                ?? metadata.fields?.[recordFieldId]
                ?? metadata.fields?.[fieldKey];
        }

        if (access === 'sublist' && field.recordAccessId) {
            return metadata.sublists?.[field.recordAccessId]?.fields?.[recordFieldId]
                ?? metadata.sublists?.[field.recordAccessId]?.fields?.[fieldKey]
                ?? metadata.fields?.[recordFieldId]
                ?? metadata.fields?.[fieldKey];
        }

        return metadata.fields?.[recordFieldId] ?? metadata.fields?.[fieldKey];
    }

    private flattenUpdates(updates: Record<string, unknown>, prefix = ''): Record<string, unknown> {
        const output: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates)) {
            const fullKey = prefix ? `${prefix}_${key}` : key;

            if (this.config.fields[fullKey]) {
                output[fullKey] = value;
                continue;
            }

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const hasNestedField = Object.keys(this.config.fields).some((fieldKey) => fieldKey.startsWith(`${fullKey}_`));
                if (hasNestedField) {
                    Object.assign(output, this.flattenUpdates(value as Record<string, unknown>, fullKey));
                    continue;
                }
            }

            if (!prefix) {
                output[fullKey] = value;
            }
        }
        return output;
    }

    private flattenPatchUpdates(updates: Record<string, unknown>, pathPrefix = '', keyPrefix = ''): Record<string, unknown> {
        const output: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates)) {
            const path = pathPrefix ? `${pathPrefix}.${key}` : key;
            const legacyKey = keyPrefix ? `${keyPrefix}_${key}` : key;
            const fieldKey = this.resolvePatchFieldKey(path, legacyKey);

            if (fieldKey) {
                output[fieldKey] = value;
                continue;
            }

            if (Array.isArray(value)) {
                const sublistId = this.resolveArrayPatchSublistId(path);
                if (sublistId) {
                    this.queueSublistArrayPatch(path, value, sublistId);
                    continue;
                }

                value.forEach((item, index) => {
                    if (isPlainObject(item)) {
                        Object.assign(output, this.flattenPatchUpdates(item, `${path}.${index}`, `${legacyKey}_${index}`));
                    } else if (this.isExplicitCompositeUpdate()) {
                        throw new Error(`Patch path '${path}.${index}' is not mapped in explicit composite config for '${this.config.recordType}'.`);
                    }
                });
                continue;
            }

            if (isPlainObject(value)) {
                Object.assign(output, this.flattenPatchUpdates(value, path, legacyKey));
                continue;
            }

            if (!pathPrefix) {
                output[legacyKey] = value;
                continue;
            }

            if (this.isExplicitCompositeUpdate()) {
                throw new Error(`Patch path '${path}' is not mapped in explicit composite config for '${this.config.recordType}'.`);
            }
        }
        return output;
    }

    private isExplicitCompositeUpdate(): boolean {
        return this.config.composite?.updateMode === 'explicit';
    }

    private queueSublistArrayPatch(arrayPath: string, values: unknown[], sublistId: string): void {
        values.forEach((value, index) => {
            if (!isPlainObject(value)) {
                throw new Error(`Patch path '${arrayPath}.${index}' must be an object to update sublist '${sublistId}'.`);
            }

            const identity = this.resolveSublistLineIdentity(arrayPath, sublistId, value);
            if (!identity) {
                throw new Error(`Sublist patch '${arrayPath}.${index}' needs a line number or a configured matchBy value for sublist '${sublistId}'.`);
            }

            const updateValues = this.omitLineIdentityProperties(value);
            const flattened = this.flattenPatchUpdates(updateValues, `${arrayPath}.*`, `${arrayPath.replace(/[^a-zA-Z0-9]/g, '_')}_${index}`);
            const fields: PendingFieldUpdate[] = [];

            for (const [fieldKey, fieldValue] of Object.entries(flattened)) {
                const field = this.resolveWritableField(fieldKey, { recordAccess: 'sublist', recordAccessId: sublistId });
                if ((field.recordAccess ?? 'body') !== 'sublist' || field.recordAccessId !== sublistId) {
                    if (this.isExplicitCompositeUpdate()) {
                        throw new Error(`Patch field '${fieldKey}' does not map to sublist '${sublistId}'.`);
                    }
                    continue;
                }

                if (identity.matchField && this.isSameField(field, identity.matchField.fieldId)) {
                    continue;
                }

                fields.push(this.toPendingUpdate(fieldKey, field, fieldValue));
            }

            if (fields.length === 0) return;

            this.lineUpdates.push(identity.line !== undefined
                ? { sublistId, line: identity.line, fields }
                : { sublistId, line: -1, matchField: identity.matchField, fields });
        });
    }

    private resolveSublistLineIdentity(arrayPath: string, sublistId: string, value: Record<string, unknown>): { line: number; matchField?: never } | { line?: never; matchField: { fieldId: string; value: NsRecord.FieldValue } } | undefined {
        const line = this.getLineNumber(value);
        if (line !== undefined) return { line };

        const matchBy = this.resolveSublistMatchBy(arrayPath, sublistId);
        if (!matchBy) return undefined;

        const matchValue = this.getValueByPathOrKey(value, matchBy, arrayPath);
        if (matchValue === undefined) {
            throw new Error(`Sublist patch '${arrayPath}' is missing matchBy value '${matchBy}' for sublist '${sublistId}'.`);
        }

        const matchField = this.findSublistMatchField(sublistId, matchBy);
        if (!matchField) {
            throw new Error(`Sublist '${sublistId}' matchBy field '${matchBy}' is not mapped in query config.`);
        }

        return {
            matchField: {
                fieldId: matchField.field.recordFieldId ?? matchField.field.queryFieldId,
                value: this.convertValue(matchValue as RecordFieldValue, matchField.field),
            },
        };
    }

    private resolveArrayPatchSublistId(arrayPath: string): string | undefined {
        const sublistIds = new Set<string>();
        for (const field of Object.values(this.config.fields)) {
            const sublistId = this.getMappedSublistId(field);
            if (!sublistId) continue;
            if (this.getFieldPaths(field).some((fieldPath) => this.isFieldUnderArrayPath(fieldPath, arrayPath))) {
                sublistIds.add(sublistId);
            }
        }

        if (sublistIds.size > 1) {
            throw new Error(`Patch array '${arrayPath}' maps to multiple sublists (${Array.from(sublistIds).join(', ')}). Use an explicit collection patch.`);
        }

        return Array.from(sublistIds)[0];
    }

    private resolveSublistMatchBy(arrayPath: string, sublistId: string): string | undefined {
        const matchFields = new Set<string>();
        for (const field of Object.values(this.config.fields)) {
            const mapping = field.updateMapping;
            if (mapping?.kind === 'sublist' && mapping.sublistId === sublistId && mapping.matchBy && this.getFieldPaths(field).some((fieldPath) => this.isFieldUnderArrayPath(fieldPath, arrayPath))) {
                matchFields.add(mapping.matchBy);
            }
        }

        if (matchFields.size > 1) {
            throw new Error(`Patch array '${arrayPath}' has multiple matchBy fields (${Array.from(matchFields).join(', ')}). Use an explicit collection patch.`);
        }

        return Array.from(matchFields)[0];
    }

    private findSublistMatchField(sublistId: string, matchBy: string): { fieldKey: string; field: QueryField } | undefined {
        for (const [fieldKey, field] of Object.entries(this.config.fields)) {
            const mappedField = this.mapSublistFieldForRead(field);
            if (!mappedField || mappedField.recordAccessId !== sublistId) continue;
            const fieldId = mappedField.recordFieldId ?? mappedField.queryFieldId;
            const fieldPaths = this.getFieldPaths(mappedField);
            if (fieldKey === matchBy || fieldId === matchBy || mappedField.queryFieldId === matchBy || fieldPaths.some((path) => path === matchBy || path.endsWith(`.${matchBy}`))) {
                return { fieldKey, field: mappedField };
            }
        }
        return undefined;
    }

    private mapSublistFieldForRead(field: QueryField): QueryField | undefined {
        const mapping = field.updateMapping;
        if (mapping?.kind === 'sublist') {
            return {
                ...field,
                recordFieldId: mapping.fieldId ?? field.recordFieldId ?? field.queryFieldId,
                recordAccess: 'sublist',
                recordAccessId: mapping.sublistId,
            };
        }

        if (field.recordAccess === 'sublist' && field.recordAccessId) return field;
        return undefined;
    }

    private getMappedSublistId(field: QueryField): string | undefined {
        return field.updateMapping?.kind === 'sublist' ? field.updateMapping.sublistId : field.recordAccess === 'sublist' ? field.recordAccessId : undefined;
    }

    private getFieldPaths(field: QueryField): string[] {
        return [field.nestPath, field.source?.path].filter((value): value is string => Boolean(value));
    }

    private isFieldUnderArrayPath(fieldPath: string, arrayPath: string): boolean {
        const normalizedFieldPath = this.withoutArrayIdentitySegments(fieldPath);
        const normalizedArrayPath = this.withoutArrayIdentitySegments(arrayPath);
        return normalizedFieldPath.startsWith(`${normalizedArrayPath}.`);
    }

    private withoutArrayIdentitySegments(path: string): string {
        return path.replace(/\.(\*|\d+)(?=\.|$)/g, '');
    }

    private getLineNumber(value: Record<string, unknown>): number | undefined {
        for (const key of ['line', '_line', 'lineNumber', 'lineIndex']) {
            const candidate = value[key];
            if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate;
            if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isInteger(Number(candidate)) && Number(candidate) >= 0) return Number(candidate);
        }
        return undefined;
    }

    private omitLineIdentityProperties(value: Record<string, unknown>): Record<string, unknown> {
        const output = { ...value };
        delete output.line;
        delete output._line;
        delete output.lineNumber;
        delete output.lineIndex;
        return output;
    }

    private getValueByPathOrKey(value: Record<string, unknown>, pathOrKey: string, arrayPath: string): unknown {
        const direct = this.getValueAtPath(value, pathOrKey);
        if (direct !== undefined) return direct;

        const relativePath = pathOrKey
            .replace(new RegExp(`^${this.escapeRegExp(arrayPath)}\\.(\\*|\\d+)\\.`), '')
            .replace(new RegExp(`^${this.escapeRegExp(arrayPath)}\\.`), '');
        return this.getValueAtPath(value, relativePath);
    }

    private getValueAtPath(value: Record<string, unknown>, path: string): unknown {
        return path.split('.').filter(Boolean).reduce<unknown>((current, segment) => {
            if (!isPlainObject(current)) return undefined;
            return current[segment];
        }, value);
    }

    private isSameField(field: QueryField, fieldId: string): boolean {
        return (field.recordFieldId ?? field.queryFieldId) === fieldId || field.queryFieldId === fieldId;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private resolvePatchFieldKey(path: string, legacyKey: string): string | undefined {
        if (this.config.fields[legacyKey]) return legacyKey;
        if (this.config.fields[path]) return path;

        const pathCandidates = new Set<string>([
            path,
            this.toWildcardPath(path),
            this.withoutNumericPathSegments(path),
            this.withoutArrayIdentitySegments(path),
        ]);

        for (const [fieldKey, field] of Object.entries(this.config.fields)) {
            const fieldPaths = [field.nestPath, field.source?.path].filter((value): value is string => Boolean(value));
            if (fieldPaths.some((fieldPath) => pathCandidates.has(fieldPath) || pathCandidates.has(this.toWildcardPath(fieldPath)) || pathCandidates.has(this.withoutNumericPathSegments(fieldPath)) || pathCandidates.has(this.withoutArrayIdentitySegments(fieldPath)))) {
                return fieldKey;
            }
        }

        return undefined;
    }

    private toWildcardPath(path: string): string {
        return path.replace(/\.\d+(?=\.|$)/g, '.*');
    }

    private withoutNumericPathSegments(path: string): string {
        return path.replace(/\.\d+(?=\.|$)/g, '');
    }

    private flattenRelationshipUpdates(updates: Record<string, unknown>, prefix = ''): Record<string, unknown> {
        const output: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates)) {
            const fullKey = prefix ? `${prefix}_${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(output, this.flattenRelationshipUpdates(value as Record<string, unknown>, fullKey));
                continue;
            }
            output[fullKey] = value;
        }
        return output;
    }

    private sortUpdates(updates: PendingFieldUpdate[]): PendingFieldUpdate[] {
        return [...updates].sort((left, right) => Number(Boolean(right.field.setFirst)) - Number(Boolean(left.field.setFirst)));
    }

    private requireRecordAccessId(fieldKey: string, field: QueryField, access: string): string {
        if (!field.recordAccessId) {
            throw new Error(`Field '${fieldKey}' has recordAccess='${access}' but no recordAccessId.`);
        }
        return field.recordAccessId;
    }
}

export function updateRecord<TResult, TUpdate extends Record<string, unknown> = Partial<TResult> & Record<string, unknown>>(config: QueryConfig<TResult> | QueryConfigInput<TResult>): RecordUpdater<TResult, TUpdate> {
    return RecordUpdater.for<TResult, TUpdate>(config);
}