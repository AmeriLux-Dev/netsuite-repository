import type { EntityRelationship, QueryConfig, SublistRelationship } from '../types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** The entity's own property names: the root of every field's nest path, plus every relationship. */
function ownPropertyNamesOf(config: QueryConfig<unknown>): Set<string> {
    const names = new Set<string>(Object.keys(config.relationships ?? {}));
    for (const [key, field] of Object.entries(config.fields)) {
        names.add((field.nestPath ?? key).split('.')[0]);
    }
    return names;
}

/** The property that identifies a line in a patch: the line field, or else the match field. */
function lineIdentityPropertyOf(relationship: SublistRelationship): string | undefined {
    return relationship.lineField ?? relationship.matchField;
}

function assignOwnedValues(recordType: string, relationshipName: string, relationship: EntityRelationship, target: Record<string, unknown>, values: Record<string, unknown>): void {
    const properties = relationship.fields ?? {};
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) {
            continue;
        }
        if (!(name in properties)) {
            throw new Error(`'${name}' is not a property of '${recordType}.${relationshipName}'.`);
        }
        target[name] = value;
    }
}

function applySubrecordPatch(recordType: string, entity: Record<string, unknown>, name: string, relationship: EntityRelationship, value: unknown): void {
    if (value === null) {
        entity[name] = null;
        return;
    }
    if (!isPlainObject(value)) {
        throw new Error(`Subrecord '${recordType}.${name}' takes an object patch.`);
    }
    const existing = entity[name];
    const owned = isPlainObject(existing) ? existing : {};
    entity[name] = owned;
    assignOwnedValues(recordType, name, relationship, owned, value);
}

function findLineIndex(lines: Record<string, unknown>[], identityProperty: string, identity: unknown): number {
    return lines.findIndex((line) => line[identityProperty] !== undefined && line[identityProperty] !== null && String(line[identityProperty]) === String(identity));
}

function applySublistPatch(recordType: string, entity: Record<string, unknown>, name: string, relationship: SublistRelationship, value: unknown): void {
    if (!isPlainObject(value)) {
        throw new Error(`Sublist '${recordType}.${name}' takes { update, add, remove }, not ${Array.isArray(value) ? 'an array' : 'a scalar'}.`);
    }
    const existing = entity[name];
    const lines = (Array.isArray(existing) ? existing : []) as Record<string, unknown>[];
    entity[name] = lines;
    const identityProperty = lineIdentityPropertyOf(relationship);
    const requireIdentityProperty = (): string => {
        if (identityProperty === undefined) {
            throw new Error(`Sublist '${recordType}.${name}' declares no line field or match field, so its lines cannot be patched by identity.`);
        }
        return identityProperty;
    };

    for (const linePatch of (value.update as unknown[] | undefined) ?? []) {
        if (!isPlainObject(linePatch)) {
            throw new Error(`Line patches of '${recordType}.${name}' must be objects.`);
        }
        const property = requireIdentityProperty();
        const identity = linePatch[property];
        if (identity === undefined || identity === null) {
            throw new Error(`A line patch of '${recordType}.${name}' needs a '${property}' value.`);
        }
        const index = findLineIndex(lines, property, identity);
        if (index < 0) {
            throw new Error(`'${recordType}.${name}' has no line with ${property} ${String(identity)}.`);
        }
        assignOwnedValues(recordType, name, relationship, lines[index], linePatch);
    }

    for (const added of (value.add as unknown[] | undefined) ?? []) {
        if (!isPlainObject(added)) {
            throw new Error(`Lines added to '${recordType}.${name}' must be objects.`);
        }
        const line: Record<string, unknown> = {};
        assignOwnedValues(recordType, name, relationship, line, added);
        lines.push(line);
    }

    for (const identity of (value.remove as unknown[] | undefined) ?? []) {
        const property = requireIdentityProperty();
        const index = findLineIndex(lines, property, identity);
        if (index < 0) {
            throw new Error(`'${recordType}.${name}' has no line with ${property} ${String(identity)}.`);
        }
        lines.splice(index, 1);
    }
}

/**
 * Applies an EntityPatch to a tracked entity in place, so the change tracker can diff it: scalars replace, subrecords
 * merge, sublist lines are updated, added, and removed by identity, and undefined values are skipped. A property the
 * model does not declare, or a reference, is an error rather than a silent no-op.
 */
export function applyEntityPatch(config: QueryConfig<unknown>, entity: Record<string, unknown>, patch: Record<string, unknown>): void {
    const relationships = config.relationships ?? {};
    const ownProperties = ownPropertyNamesOf(config);

    for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) {
            continue;
        }
        const relationship = relationships[name];
        if (!relationship) {
            if (!ownProperties.has(name)) {
                throw new Error(`'${name}' is not a property of '${config.recordType}'.`);
            }
            entity[name] = value;
            continue;
        }
        switch (relationship.kind) {
            case 'reference':
                throw new Error(`Reference '${config.recordType}.${name}' is read-only; set its select field instead.`);
            case 'subrecord':
                applySubrecordPatch(config.recordType, entity, name, relationship, value);
                break;
            case 'sublist':
                applySublistPatch(config.recordType, entity, name, relationship, value);
                break;
        }
    }
}
