import type { RestRecordFieldKind } from '../../src/types';

export interface RecordFieldMetadataDescriptor {
    /** N/record field id, always lowercase (`trandate`, `custevent20`). */
    id: string;
    kind: RestRecordFieldKind;
    writable: boolean;
    label?: string;
    targetRecordType?: string;
    /** Camel-case name from the REST catalog (`tranDate`), used for the scaffolded property name when present. */
    propertyName?: string;
}

export interface RecordSublistMetadataDescriptor {
    sublistId: string;
    fields: Record<string, RecordFieldMetadataDescriptor>;
    propertyName?: string;
}

export interface RecordSubrecordMetadataDescriptor {
    fieldId: string;
    fields: Record<string, RecordFieldMetadataDescriptor>;
    clearBeforeUpdateFieldId?: string;
    propertyName?: string;
}

/** Record-side metadata: what N/record can read and write. Comes from the documented REST metadata catalog. */
export interface RecordTypeMetadataDescriptor {
    recordType: string;
    fields: Record<string, RecordFieldMetadataDescriptor>;
    sublists: Record<string, RecordSublistMetadataDescriptor>;
    subrecords: Record<string, RecordSubrecordMetadataDescriptor>;
}

export interface SuiteQlColumnMetadataDescriptor {
    name: string;
    type: string;
    joinable?: boolean;
    targetRecordType?: string;
}

/** Query-side metadata: SuiteQL tables and columns. Comes from a Records Catalog export (undocumented, browser session only). */
export interface SuiteQlTableMetadataDescriptor {
    table: string;
    columns: Record<string, SuiteQlColumnMetadataDescriptor>;
}

export interface MetadataSnapshot {
    records: Record<string, RecordTypeMetadataDescriptor>;
    tables: Record<string, SuiteQlTableMetadataDescriptor>;
}

export interface MetadataProvider {
    getRecordTypeMetadata(recordType: string): Promise<RecordTypeMetadataDescriptor | undefined>;
    getSuiteQlTableMetadata(table: string): Promise<SuiteQlTableMetadataDescriptor | undefined>;
}

export function createEmptyMetadataSnapshot(): MetadataSnapshot {
    return { records: {}, tables: {} };
}

/** Reads metadata from a snapshot file written by `scaffold snapshot` or a Records Catalog export. */
export function createSnapshotMetadataProvider(snapshot: MetadataSnapshot): MetadataProvider {
    return {
        getRecordTypeMetadata: async (recordType) => snapshot.records[recordType.toLowerCase()],
        getSuiteQlTableMetadata: async (table) => snapshot.tables[table.toLowerCase()],
    };
}

/** Validates a parsed snapshot file and normalizes keys to lowercase. Throws with every problem found. */
export function parseMetadataSnapshot(raw: unknown, sourceDescription = 'snapshot'): MetadataSnapshot {
    const problems: string[] = [];
    const snapshot = createEmptyMetadataSnapshot();
    const root = raw as Partial<MetadataSnapshot> | null;

    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error(`Metadata ${sourceDescription} must be a JSON object with 'records' and 'tables'.`);
    }

    for (const [recordType, descriptor] of Object.entries(root.records ?? {})) {
        if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.recordType !== 'string') {
            problems.push(`records.${recordType} must be an object with a recordType.`);
            continue;
        }
        snapshot.records[recordType.toLowerCase()] = {
            recordType: descriptor.recordType,
            fields: descriptor.fields ?? {},
            sublists: descriptor.sublists ?? {},
            subrecords: descriptor.subrecords ?? {},
        };
    }

    for (const [table, descriptor] of Object.entries(root.tables ?? {})) {
        if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.table !== 'string') {
            problems.push(`tables.${table} must be an object with a table name.`);
            continue;
        }
        snapshot.tables[table.toLowerCase()] = { table: descriptor.table, columns: descriptor.columns ?? {} };
    }

    if (problems.length > 0) {
        throw new Error(`Metadata ${sourceDescription} is invalid:\n - ${problems.join('\n - ')}`);
    }
    return snapshot;
}

/** Merges two snapshots; entries in `overlay` win. */
export function mergeMetadataSnapshots(base: MetadataSnapshot, overlay: MetadataSnapshot): MetadataSnapshot {
    return { records: { ...base.records, ...overlay.records }, tables: { ...base.tables, ...overlay.tables } };
}
