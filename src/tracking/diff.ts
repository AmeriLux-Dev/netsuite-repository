import type { CollectionLinePatch, CollectionPatch, EntityRelationship, FieldType, QueryConfig, QueryField, RecordGraphPatch } from '../types';

export interface EntityDiff {
    /** Graph patch for RecordUpdater.patch(); undefined when nothing changed. */
    patch: RecordGraphPatch | undefined;
    /** Field keys that changed but cannot be written (read-only). */
    ignoredProperties: string[];
}

const numericFieldTypes = new Set<FieldType>(['integer', 'float', 'currency', 'key']);
const booleanFieldTypes = new Set<FieldType>(['boolean', 'checkbox']);

function normalizeValueForComparison(value: unknown, fieldType: FieldType | undefined): unknown {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? String(value) : value.getTime();
    }
    if (fieldType !== undefined && numericFieldTypes.has(fieldType)) {
        const numeric = Number(value);
        return Number.isNaN(numeric) ? String(value) : numeric;
    }
    if (fieldType !== undefined && booleanFieldTypes.has(fieldType)) {
        if (typeof value === 'string') {
            const normalized = value.trim().toUpperCase();
            return normalized === 'T' || normalized === 'TRUE' ? true : normalized === 'F' || normalized === 'FALSE' ? false : value;
        }
        return Boolean(value);
    }
    if (Array.isArray(value)) {
        return JSON.stringify(value.map((item) => String(item)));
    }
    return value;
}

/** Equality that absorbs read-side coercion: '12' equals 12 for numeric fields, 'T' equals true for booleans, dates compare by time. */
export function areFieldValuesEqual(left: unknown, right: unknown, fieldType: FieldType | undefined): boolean {
    return normalizeValueForComparison(left, fieldType) === normalizeValueForComparison(right, fieldType);
}

function readPath(source: Record<string, unknown> | undefined, path: string): unknown {
    let cursor: unknown = source;
    for (const segment of path.split('.')) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
}

function isWritable(field: QueryField): boolean {
    return field.readonly !== true && (field.recordFieldId !== undefined || field.updateMapping !== undefined);
}

function relationshipRootOf(field: QueryField, key: string, relationships: Record<string, EntityRelationship>): string | undefined {
    const root = (field.nestPath ?? key).split('.')[0];
    return root in relationships ? root : undefined;
}

interface DiffContext {
    config: QueryConfig<unknown>;
    relationships: Record<string, EntityRelationship>;
    ignoredProperties: string[];
}

function diffScalars(context: DiffContext, snapshot: Record<string, unknown> | undefined, current: Record<string, unknown>, includeUnchanged: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(context.config.fields)) {
        if (relationshipRootOf(field, key, context.relationships)) {
            continue;
        }
        const path = field.nestPath ?? key;
        const currentValue = readPath(current, path);
        const changed = includeUnchanged ? currentValue !== undefined : !areFieldValuesEqual(readPath(snapshot, path), currentValue, field.type);
        if (!changed) {
            continue;
        }
        if (!isWritable(field)) {
            context.ignoredProperties.push(key);
            continue;
        }
        patch[key] = currentValue === undefined ? null : currentValue;
    }
    return patch;
}

function diffOwned(context: DiffContext, name: string, relationship: EntityRelationship, snapshot: Record<string, unknown> | undefined, current: Record<string, unknown>, includeUnchanged: boolean): Record<string, unknown> | undefined {
    const values: Record<string, unknown> = {};
    const currentOwned = current[name] as Record<string, unknown> | null | undefined;
    const snapshotOwned = snapshot?.[name] as Record<string, unknown> | null | undefined;

    for (const [propertyName, fieldKey] of Object.entries(relationship.fields ?? {})) {
        const field = context.config.fields[fieldKey];
        if (!field) {
            continue;
        }
        const currentValue = currentOwned?.[propertyName];
        const changed = includeUnchanged ? currentValue !== undefined : !areFieldValuesEqual(snapshotOwned?.[propertyName], currentValue, field.type);
        if (!changed) {
            continue;
        }
        if (!isWritable(field)) {
            context.ignoredProperties.push(fieldKey);
            continue;
        }
        values[propertyName] = currentValue === undefined ? null : currentValue;
    }

    return Object.keys(values).length > 0 ? values : undefined;
}

type CollectionRelationship = Extract<EntityRelationship, { kind: 'sublist' }>;

function lineIdentity(line: Record<string, unknown>, index: number, relationship: CollectionRelationship): { key: string; mode: 'line' | 'match' | 'index'; value: unknown } {
    if (relationship.lineField && line[relationship.lineField] !== undefined && line[relationship.lineField] !== null) {
        return { key: `line:${String(line[relationship.lineField])}`, mode: 'line', value: line[relationship.lineField] };
    }
    if (relationship.matchField && line[relationship.matchField] !== undefined && line[relationship.matchField] !== null) {
        return { key: `match:${String(line[relationship.matchField])}`, mode: 'match', value: line[relationship.matchField] };
    }
    return { key: `index:${index}`, mode: 'index', value: index };
}

function writableLineValues(context: DiffContext, relationship: CollectionRelationship, line: Record<string, unknown>, snapshotLine: Record<string, unknown> | undefined, includeUnchanged: boolean): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [propertyName, fieldKey] of Object.entries(relationship.fields ?? {})) {
        const field = context.config.fields[fieldKey];
        if (!field) {
            continue;
        }
        const currentValue = line[propertyName];
        const changed = includeUnchanged ? currentValue !== undefined : !areFieldValuesEqual(snapshotLine?.[propertyName], currentValue, field.type);
        if (!changed) {
            continue;
        }
        if (!isWritable(field)) {
            context.ignoredProperties.push(fieldKey);
            continue;
        }
        values[propertyName] = currentValue === undefined ? null : currentValue;
    }
    return values;
}

function asLines(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object') : [];
}

function diffCollection(context: DiffContext, name: string, relationship: CollectionRelationship, snapshot: Record<string, unknown> | undefined, current: Record<string, unknown>, includeUnchanged: boolean): CollectionPatch | undefined {
    const currentLines = asLines(current[name]);
    const snapshotLines = asLines(snapshot?.[name]);
    const snapshotByIdentity = new Map<string, { line: Record<string, unknown>; index: number }>();
    snapshotLines.forEach((line, index) => snapshotByIdentity.set(lineIdentity(line, index, relationship).key, { line, index }));

    const update: Array<CollectionLinePatch & { originalIndex: number }> = [];
    const add: Array<Record<string, unknown>> = [];
    const matched = new Set<string>();

    currentLines.forEach((line, index) => {
        const identity = lineIdentity(line, index, relationship);
        const existing = includeUnchanged ? undefined : snapshotByIdentity.get(identity.key);
        if (!existing) {
            const values = writableLineValues(context, relationship, line, undefined, true);
            if (Object.keys(values).length > 0) {
                add.push(values);
            }
            return;
        }
        matched.add(identity.key);
        const values = writableLineValues(context, relationship, line, existing.line, false);
        if (Object.keys(values).length === 0) {
            return;
        }
        if (identity.mode === 'match') {
            update.push({ match: { field: relationship.matchField as string, value: identity.value as CollectionLinePatch['match'] extends infer M ? M extends { value: infer V } ? V : never : never }, values, originalIndex: -1 });
        } else {
            const originalIndex = identity.mode === 'line' ? Number(identity.value) : existing.index;
            update.push({ line: originalIndex, values, originalIndex });
        }
    });

    const remove: number[] = [];
    snapshotLines.forEach((line, index) => {
        const identity = lineIdentity(line, index, relationship);
        if (!matched.has(identity.key)) {
            remove.push(identity.mode === 'line' ? Number(identity.value) : index);
        }
    });

    // The updater applies removes (descending) before index-based updates, so shift indexes that sit above removed lines.
    for (const entry of update) {
        if (entry.line !== undefined) {
            entry.line = entry.line - remove.filter((removedIndex) => removedIndex < entry.originalIndex).length;
        }
    }

    const patch: CollectionPatch = {};
    if (update.length > 0) {
        patch.update = update.map(({ originalIndex: _originalIndex, ...entry }) => entry);
    }
    if (add.length > 0) {
        patch.add = add;
    }
    if (remove.length > 0) {
        patch.remove = remove;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Referenced records are never written through the parent; changes to their fields are reported as ignored. */
function reportReferenceChanges(context: DiffContext, relationship: EntityRelationship, snapshot: Record<string, unknown> | undefined, current: Record<string, unknown>, includeUnchanged: boolean): void {
    for (const key of Object.values(relationship.fields ?? {})) {
        const field = context.config.fields[key];
        if (!field) {
            continue;
        }
        const path = field.nestPath ?? key;
        const currentValue = readPath(current, path);
        const changed = includeUnchanged ? currentValue !== undefined : !areFieldValuesEqual(readPath(snapshot, path), currentValue, field.type);
        if (changed) {
            context.ignoredProperties.push(key);
        }
    }
}

function buildPatch(config: QueryConfig<unknown>, snapshot: Record<string, unknown> | undefined, current: Record<string, unknown>, includeUnchanged: boolean): EntityDiff {
    const context: DiffContext = { config, relationships: config.relationships ?? {}, ignoredProperties: [] };
    const patch: Record<string, unknown> = diffScalars(context, snapshot, current, includeUnchanged);

    for (const [name, relationship] of Object.entries(context.relationships)) {
        if (relationship.kind === 'reference') {
            reportReferenceChanges(context, relationship, snapshot, current, includeUnchanged);
            continue;
        }
        const nested = relationship.kind === 'subrecord'
            ? diffOwned(context, name, relationship, snapshot, current, includeUnchanged)
            : diffCollection(context, name, relationship, snapshot, current, includeUnchanged);
        if (nested !== undefined) {
            patch[name] = nested;
        }
    }

    return { patch: Object.keys(patch).length > 0 ? patch : undefined, ignoredProperties: context.ignoredProperties };
}

/** Diffs a tracked entity against its snapshot and produces the graph patch describing the changes. */
export function diffTrackedEntity(config: QueryConfig<unknown>, snapshot: Record<string, unknown>, current: Record<string, unknown>): EntityDiff {
    return buildPatch(config, snapshot, current, false);
}

/** Builds the graph patch for a new entity: every defined writable value plus every collection line as an add. */
export function buildAddedEntityPatch(config: QueryConfig<unknown>, current: Record<string, unknown>): EntityDiff {
    return buildPatch(config, undefined, current, true);
}
