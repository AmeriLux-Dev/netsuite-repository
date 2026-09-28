import type { ComponentCondition, ComponentJoin, FieldType, QueryField, RecordUpdaterOptions, RelationshipLoad, SeparateLoad } from '../../src/types';
import type { PropertyOverrides, RelationKind } from '../../src/model';
import type { CollectedClass, ModelFileDiagnostic } from './model-file-evaluator';
import { classKeyOf } from './property-type-reader';
import type { ClassIdentity, DeclaredClass, DeclaredProperty } from './property-type-reader';

export type { RelationKind };

/** A field N/query reads off a joined component instead of the root: the relationship field and the row it picks. */
export interface ResolvedFieldRelationship {
    fieldId: string;
    filter?: ComponentCondition[];
}

export interface ResolvedField {
    name: string;
    /** N/query field id. */
    queryFieldId: string;
    /** Set when the value is read through a relationship because the root does not expose it. */
    relationship?: ResolvedFieldRelationship;
    /** N/record field id the property writes through; `readOnly` says whether it ever does. */
    recordFieldId: string;
    readOnly: boolean;
    type: FieldType;
    text?: boolean;
    coerce?: boolean;
    setFirst?: boolean;
    selectByDefault?: boolean;
    transform?: QueryField['transform'];
    typeText: string;
    optional: boolean;
    inherited: boolean;
}

/** A property the class declares but the model does not map (@NotMapped); it stays on the generated type. */
export interface ResolvedUnmappedProperty {
    name: string;
    typeText: string;
    optional: boolean;
    inherited: boolean;
}

/** One join past a sublist's relationship field on the way to its items, with the conditions its component always carries. */
export interface ResolvedRelationHop {
    join: ComponentJoin;
    filter?: ComponentCondition[];
}

export interface ResolvedRelation {
    name: string;
    kind: RelationKind;
    optional: boolean;
    inherited: boolean;
    load: RelationshipLoad;
    selectByDefault?: boolean;
    targetClassName: string;
    projection: string[] | 'all';
    fields: ResolvedField[];
    relations: ResolvedRelation[];
    /** How N/query joins the relation to its parent component. */
    join: ComponentJoin;
    /** Reference matched on a field other than the target's internal id: loaded by its own query. */
    separate?: SeparateLoad;
    /** Reference: the owner's property holding the select field. */
    selectFieldProperty?: string;
    /** Reference: the relationship field its select field is read through; such a reference always loads separately. */
    selectFieldRelationship?: string;
    /** Subrecord: field id on the owner and the list field cleared before edits. */
    subrecordFieldId?: string;
    clearListField?: string;
    /** Sublist: id on the owner, the conditions that pick its lines, and the line class's key property. */
    sublistId?: string;
    filter?: ComponentCondition[];
    lineKeyProperty?: string;
    lineOrderFieldId?: string;
    /** Sublist: the joins after the relationship field that lead to the items; their fields are read on the last one. */
    through?: ResolvedRelationHop[];
}

export interface ResolvedClass extends ClassIdentity {
    exportName: string;
    /** Base class when it is one of the collected classes. */
    base?: ClassIdentity;
    /** Set for @RecordType classes; plain classes (subrecord shapes, mapping bases) have none. */
    recordType?: string;
    /** N/query root type; the record type unless overridden. */
    queryType?: string;
    rootFilter?: ComponentCondition[];
    setName?: string;
    keyProperty: string;
    parentKeyProperty?: string;
    coerce?: boolean;
    updaterOptions?: RecordUpdaterOptions;
    fields: ResolvedField[];
    relations: ResolvedRelation[];
    unmapped: ResolvedUnmappedProperty[];
}

export interface ResolveModelsOptions {
    classes: CollectedClass[];
    declared: Map<string, DeclaredClass>;
}

export interface ResolveModelsResult {
    classes: ResolvedClass[];
    diagnostics: ModelFileDiagnostic[];
}

interface ClassEntry {
    collected: CollectedClass;
    declared: DeclaredClass;
}

/** An object-typed property is what its decorator says; otherwise a record class is a reference and a plain class a subrecord. */
function inferObjectPropertyRelationKind(overrides: PropertyOverrides | undefined, targetIsRecordType: boolean): RelationKind {
    return overrides?.relationKind ?? (targetIsRecordType ? 'reference' : 'subrecord');
}

/** True when @Field set anything on the property: on a reference, those options describe its shadow select field. */
function hasFieldOptions(overrides: PropertyOverrides | undefined): boolean {
    return overrides !== undefined && [
        overrides.fieldId, overrides.queryFieldId, overrides.type, overrides.text, overrides.coerce, overrides.readOnly,
        overrides.setFirst, overrides.transform, overrides.relationshipFieldId, overrides.filter,
    ].some((value) => value !== undefined);
}

function toShallowField(property: DeclaredProperty, overrides: PropertyOverrides | undefined, isKey: boolean, isSelectField: boolean): ResolvedField | undefined {
    // The internal id is a key and a reference's select field a select: both compare through ANY_OF in N/query.
    const inferredType = overrides?.type ?? (isKey ? 'key' : isSelectField && property.scalarType ? 'select' : property.scalarType);
    if (!inferredType) {
        return undefined;
    }
    const recordFieldId = overrides?.fieldId ?? property.name.toLowerCase();
    const relationship = overrides?.relationshipFieldId === undefined ? undefined : { fieldId: overrides.relationshipFieldId, ...(overrides.filter ? { filter: overrides.filter } : {}) };
    return {
        name: property.name,
        queryFieldId: overrides?.queryFieldId ?? recordFieldId,
        ...(relationship ? { relationship } : {}),
        recordFieldId,
        readOnly: Boolean(overrides?.readOnly || isKey || overrides?.text),
        type: inferredType,
        text: overrides?.text,
        coerce: overrides?.coerce,
        setFirst: overrides?.setFirst,
        selectByDefault: overrides?.selectByDefault,
        transform: overrides?.transform,
        typeText: property.typeText,
        optional: property.optional,
        inherited: property.inherited,
    };
}

/**
 * Turns collected classes plus their declared shapes into resolved models. Every fact comes from the model itself:
 * property names and types, the decorators, and the classes properties point at. Nothing is looked up in a table of
 * NetSuite knowledge; what the model does not say, N/query resolves at run time.
 */
export function resolveModels(options: ResolveModelsOptions): ResolveModelsResult {
    const diagnostics: ModelFileDiagnostic[] = [];
    const entries = new Map<string, ClassEntry>();
    for (const collected of options.classes) {
        const declared = options.declared.get(classKeyOf(collected));
        if (declared) {
            entries.set(classKeyOf(collected), { collected, declared });
        }
    }

    const report = (entry: ClassEntry, message: string) => {
        diagnostics.push({ filePath: entry.collected.filePath, exportName: entry.collected.exportName, message });
    };

    const resolvedCache = new Map<string, ResolvedClass>();

    function keyPropertyOf(entry: ClassEntry): string {
        return entry.collected.overrides.keyProperty ?? 'id';
    }

    /**
     * The select field of a reference whose class declares none, like EF's shadow foreign key: `subsidiary` gets
     * `subsidiaryId`, typed as the referenced record's internal id, and @Field options on the reference configure it.
     * A declared property of that name is always the select field instead, mapped or not, so its type and decorators
     * are never replaced. A reference that names its select field, or matches on another key, must declare it.
     */
    function toShadowSelectField(entry: ClassEntry, property: DeclaredProperty): ResolvedField | undefined {
        const targetEntry = property.target ? entries.get(classKeyOf(property.target)) : undefined;
        const referenceOverrides = entry.collected.overrides.properties.get(property.name);
        const name = `${property.name}Id`;
        if (
            !targetEntry
            || property.isArray
            || inferObjectPropertyRelationKind(referenceOverrides, targetEntry.collected.overrides.recordType !== undefined) !== 'reference'
            || referenceOverrides?.selectFieldProperty !== undefined
            || referenceOverrides?.targetKeyProperty !== undefined
            || entry.declared.properties.some((candidate) => candidate.name === name)
        ) {
            return undefined;
        }
        const targetKeyTypeText = targetEntry.declared.properties.find((candidate) => candidate.name === keyPropertyOf(targetEntry))?.typeText ?? 'number';
        // Only the field's own options: selectByDefault and load on the reference belong to the relation.
        const fieldOverrides: PropertyOverrides = {
            name,
            fieldId: referenceOverrides?.fieldId ?? property.name.toLowerCase(),
            queryFieldId: referenceOverrides?.queryFieldId,
            type: referenceOverrides?.type,
            coerce: referenceOverrides?.coerce,
            readOnly: referenceOverrides?.readOnly,
            setFirst: referenceOverrides?.setFirst,
            transform: referenceOverrides?.transform,
            relationshipFieldId: referenceOverrides?.relationshipFieldId,
            filter: referenceOverrides?.filter,
        };
        const shadow: DeclaredProperty = { name, optional: false, nullable: true, isArray: false, typeText: `${targetKeyTypeText} | null`, scalarType: 'select', inherited: property.inherited };
        return toShallowField(shadow, fieldOverrides, false, true);
    }

    /** Resolves scalars and the class-level facts; relations are attached afterwards so cycles cannot recurse. */
    function resolveShallow(entry: ClassEntry): ResolvedClass {
        const key = classKeyOf(entry.collected);
        const cached = resolvedCache.get(key);
        if (cached) {
            return cached;
        }

        const overrides = entry.collected.overrides;
        const keyProperty = keyPropertyOf(entry);

        const resolved: ResolvedClass = {
            className: entry.declared.className,
            filePath: entry.declared.filePath,
            exportName: entry.collected.exportName,
            base: entry.declared.base && entries.has(classKeyOf(entry.declared.base)) ? entry.declared.base : undefined,
            recordType: overrides.recordType,
            queryType: overrides.recordType === undefined ? undefined : overrides.queryType ?? overrides.recordType,
            rootFilter: overrides.rootFilter,
            setName: overrides.setName,
            keyProperty,
            parentKeyProperty: overrides.parentKeyProperty,
            coerce: overrides.coerce,
            updaterOptions: overrides.updaterOptions,
            fields: [],
            relations: [],
            unmapped: [],
        };
        resolvedCache.set(key, resolved);

        const selectFieldProperties = new Set<string>();
        for (const property of entry.declared.properties) {
            if (property.target && !property.isArray && !overrides.notMapped.has(property.name)) {
                selectFieldProperties.add(overrides.properties.get(property.name)?.selectFieldProperty ?? `${property.name}Id`);
            }
        }

        for (const property of entry.declared.properties) {
            if (overrides.notMapped.has(property.name)) {
                resolved.unmapped.push({ name: property.name, typeText: property.typeText, optional: property.optional, inherited: property.inherited });
                continue;
            }
            // A reference with no declared select field brings its own (a shadow); other relations are attached later.
            const field = property.target
                ? toShadowSelectField(entry, property)
                : toShallowField(property, overrides.properties.get(property.name), property.name === keyProperty, selectFieldProperties.has(property.name) || property.name === overrides.parentKeyProperty);
            if (!field) {
                if (!property.target) {
                    report(entry, `Property '${entry.declared.className}.${property.name}' has type '${property.typeText}', which does not map to a NetSuite field type. Declare it with @Field({ type }), type it as a model class, or mark it @NotMapped().`);
                }
                continue;
            }
            const propertyOverrides = overrides.properties.get(property.name);
            if (propertyOverrides?.filter !== undefined && propertyOverrides.relationshipFieldId === undefined) {
                report(entry, `Property '${entry.declared.className}.${property.name}' declares a filter but no relationship to read it through; name the relationship field with @Field('${field.recordFieldId}', { relationship, filter }), or remove the filter.`);
            }
            resolved.fields.push(field);
        }

        // Fields read through one relationship share its join, and N/query joins a relationship once per component.
        const firstFieldByRelationship = new Map<string, ResolvedField>();
        for (const field of resolved.fields) {
            if (!field.relationship) {
                continue;
            }
            const first = firstFieldByRelationship.get(field.relationship.fieldId);
            if (!first) {
                firstFieldByRelationship.set(field.relationship.fieldId, field);
            } else if (JSON.stringify(first.relationship?.filter ?? []) !== JSON.stringify(field.relationship.filter ?? [])) {
                report(entry, `Properties '${entry.declared.className}.${first.name}' and '${entry.declared.className}.${field.name}' read through '${field.relationship.fieldId}' with different filters; N/query joins a relationship once, so give them the same filter.`);
            }
        }

        if (overrides.recordType !== undefined && !resolved.fields.some((field) => field.name === keyProperty)) {
            report(entry, `Record type '${entry.declared.className}' has no internal id property; declare '${keyProperty}' or mark one with @InternalId().`);
        }
        if (resolved.parentKeyProperty !== undefined && !resolved.fields.some((field) => field.name === resolved.parentKeyProperty)) {
            report(entry, `Property '${entry.declared.className}.${resolved.parentKeyProperty}' is marked @ParentId() but is not a mapped field.`);
        }

        return resolved;
    }

    function projectFields(target: ResolvedClass, projection: string[] | 'all'): ResolvedField[] {
        return projection === 'all' ? target.fields : target.fields.filter((field) => projection.includes(field.name));
    }

    function resolveRelations(entry: ClassEntry, resolved: ResolvedClass, stack: string[]): ResolvedRelation[] {
        const overrides = entry.collected.overrides;
        const relations: ResolvedRelation[] = [];

        for (const property of entry.declared.properties) {
            if (overrides.notMapped.has(property.name) || !property.target) {
                continue;
            }
            const targetEntry = entries.get(classKeyOf(property.target));
            if (!targetEntry) {
                report(entry, `Property '${entry.declared.className}.${property.name}' is typed as '${property.target.className}', which is not an exported class in the model files.`);
                continue;
            }
            const target = resolveShallow(targetEntry);
            const targetIsRecordType = target.recordType !== undefined;
            const propertyOverrides = overrides.properties.get(property.name);
            const declaredKind = propertyOverrides?.relationKind;
            const qualifiedName = `${entry.declared.className}.${property.name}`;
            const projection = property.target.projection ?? 'all';

            const toRelation = (kind: RelationKind, join: ComponentJoin, load: RelationshipLoad): ResolvedRelation => ({
                name: property.name,
                kind,
                optional: property.optional,
                inherited: property.inherited,
                load,
                selectByDefault: propertyOverrides?.selectByDefault,
                targetClassName: target.className,
                projection,
                fields: projectFields(target, projection),
                relations: [],
                join,
            });
            const nested = (): ResolvedRelation[] => nestedRelations(targetEntry, target, projection, stack, entry, property.name);
            const load: RelationshipLoad = propertyOverrides?.load ?? 'join';

            if (property.isArray) {
                if (declaredKind !== undefined && declaredKind !== 'sublist') {
                    report(entry, `Property '${qualifiedName}' is an array; use @Sublist() on it, @Subrecord() and @Reference() apply to object properties.`);
                    continue;
                }
                const sublistId = propertyOverrides?.sublistId ?? property.name.toLowerCase();
                let join: ComponentJoin;
                let parentKeyField: ResolvedField | undefined;
                if (propertyOverrides?.relationshipFieldId !== undefined) {
                    join = { kind: 'auto', fieldId: propertyOverrides.relationshipFieldId };
                } else if (!targetIsRecordType) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') is typed as '${target.className}', which has no @RecordType; a line class names its record type, or the property names the relationship with @Sublist('${sublistId}', { relationship }).`);
                    continue;
                } else {
                    parentKeyField = target.fields.find((field) => field.name === target.parentKeyProperty);
                    if (!parentKeyField) {
                        report(entry, `Sublist '${qualifiedName}' ('${sublistId}') has no way back to its parent: mark the property of '${target.className}' holding the parent's internal id with @ParentId(), or name the relationship with @Sublist('${sublistId}', { relationship }).`);
                        continue;
                    }
                    join = { kind: 'from', fieldId: parentKeyField.queryFieldId, source: target.queryType as string };
                }
                // Items past further joins: each hop is autoJoin on a relationship field, or joinTo through a select field.
                const hops = propertyOverrides?.through ?? [];
                if (hops.length > 0 && propertyOverrides?.relationshipFieldId === undefined) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') hops through further joins but names no relationship field to start from; declare it with @Sublist('${sublistId}', { relationship, through }).`);
                    continue;
                }
                if (hops.some((hop) => typeof hop.fieldId !== 'string' || hop.fieldId.trim() === '')) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') has a hop in 'through' with no field id; each hop is a relationship field id or { fieldId, target }.`);
                    continue;
                }
                const through: ResolvedRelationHop[] = hops.map((hop) => ({
                    join: hop.target === undefined ? { kind: 'auto', fieldId: hop.fieldId } : { kind: 'to', fieldId: hop.fieldId, target: hop.target },
                    ...(hop.filter ? { filter: hop.filter } : {}),
                }));
                const lineKeyField = target.fields.find((field) => field.name === target.keyProperty);
                // A query type of its own means the lines run as their own query, matched to the owner by internal id.
                const separateQueryType = propertyOverrides?.separateQueryType;
                if (separateQueryType !== undefined && propertyOverrides?.load === 'join') {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') names a query type ('${separateQueryType}') for its own query, which cannot be joined into the owner's. Remove load: 'join'.`);
                    continue;
                }
                const sublistLoad: RelationshipLoad = separateQueryType === undefined ? load : 'separate';
                const ownerKeyQueryFieldId = resolved.fields.find((field) => field.name === resolved.keyProperty)?.queryFieldId ?? resolved.keyProperty.toLowerCase();
                // A has-many joined from the line class's @ParentId() field and loaded separately runs on the line's own
                // record type, matching that field against the owners' internal ids (a fulfillment's SPS contents, keyed
                // by their fulfillment field). The line rows are the items, so nothing is joined to reach them.
                const separate: SeparateLoad | undefined = separateQueryType !== undefined
                    ? { queryType: separateQueryType, parentKeyField: resolved.keyProperty, targetKeyFieldId: ownerKeyQueryFieldId, targetKeyFieldType: 'key' as const }
                    : load === 'separate' && parentKeyField !== undefined
                        ? { queryType: target.queryType as string, parentKeyField: resolved.keyProperty, targetKeyFieldId: parentKeyField.queryFieldId, targetKeyFieldType: parentKeyField.type }
                        : undefined;
                relations.push({
                    ...toRelation('sublist', join, sublistLoad),
                    ...(separate ? { separate } : {}),
                    sublistId,
                    filter: propertyOverrides?.filter,
                    lineKeyProperty: target.keyProperty,
                    lineOrderFieldId: lineKeyField?.queryFieldId,
                    ...(through.length > 0 ? { through } : {}),
                    relations: nested(),
                });
                continue;
            }

            if (declaredKind === 'sublist') {
                report(entry, `Property '${qualifiedName}' is marked @Sublist() but is not an array.`);
                continue;
            }

            const kind = inferObjectPropertyRelationKind(propertyOverrides, targetIsRecordType);

            if (kind === 'reference') {
                if (!targetIsRecordType) {
                    report(entry, `Reference '${qualifiedName}' targets '${target.className}', which has no @RecordType; a reference needs a query type.`);
                    continue;
                }
                const selectFieldProperty = propertyOverrides?.selectFieldProperty ?? `${property.name}Id`;
                const selectField = resolved.fields.find((field) => field.name === selectFieldProperty);
                const isSelectFieldDeclared = entry.declared.properties.some((candidate) => candidate.name === selectFieldProperty);
                if (!selectField) {
                    report(entry, isSelectFieldDeclared
                        ? `Reference '${qualifiedName}' needs a select field, and '${selectFieldProperty}' is declared but not mapped; map it, since a declared property is never replaced by a shadow select field.`
                        : `Reference '${qualifiedName}' needs a select field: declare '${selectFieldProperty}', name one with @Reference('<property>'), or mark the property @Subrecord() if it is one.`);
                    continue;
                }
                if (isSelectFieldDeclared && hasFieldOptions(propertyOverrides)) {
                    report(entry, `Reference '${qualifiedName}' has @Field options, but its select field is the declared property '${selectFieldProperty}'; put them on '${selectFieldProperty}'.`);
                    continue;
                }
                // N/query inside SuiteScript has no join from a relationship's component to a reference's target: the one
                // case tried, transactionLine to subsidiary, failed in production on 2026-09-25 with "Record Join
                // 'subsidiary^subsidiary' for record 'transactionLine' was not found". A reference whose select field is
                // read through a relationship therefore loads separately, by the values read there. Allow a join again
                // only for a relationship proven in a real account.
                const selectFieldRelationship = selectField.relationship?.fieldId;
                if (selectFieldRelationship !== undefined && propertyOverrides?.load === 'join') {
                    report(entry, `Reference '${qualifiedName}' reads its select field '${selectFieldProperty}' through '${selectFieldRelationship}' and must load separately: N/query has no join from that component to '${target.queryType}', and the one case tried (transactionLine to subsidiary) fails with "Record Join 'subsidiary^subsidiary' for record 'transactionLine' was not found". Remove load: 'join'.`);
                    continue;
                }
                const referenceLoad: RelationshipLoad = selectFieldRelationship !== undefined ? 'separate' : load;
                const targetKeyProperty = propertyOverrides?.targetKeyProperty;
                const join: ComponentJoin = propertyOverrides?.joinKind === 'auto'
                    ? { kind: 'auto', fieldId: selectField.queryFieldId }
                    : { kind: 'to', fieldId: selectField.queryFieldId, target: target.queryType as string };
                if (targetKeyProperty === undefined) {
                    // A reference loaded separately by internal id: the second query matches the target's key against the select field values.
                    const targetKeyQueryFieldId = target.fields.find((field) => field.name === target.keyProperty)?.queryFieldId ?? target.keyProperty.toLowerCase();
                    const separate = referenceLoad === 'separate' ? { queryType: target.queryType as string, parentKeyField: selectFieldProperty, targetKeyFieldId: targetKeyQueryFieldId, targetKeyFieldType: 'key' as const } : undefined;
                    relations.push({ ...toRelation('reference', join, referenceLoad), ...(separate ? { separate } : {}), selectFieldProperty, selectFieldRelationship, relations: nested() });
                    continue;
                }
                const targetKeyField = target.fields.find((field) => field.name === targetKeyProperty);
                if (!targetKeyField) {
                    report(entry, `Reference '${qualifiedName}' matches on '${target.className}.${targetKeyProperty}', which is not a mapped field.`);
                    continue;
                }
                if (propertyOverrides?.load === 'join') {
                    report(entry, `Reference '${qualifiedName}' matches on '${target.className}.${targetKeyProperty}' and must load separately; N/query joins only through the target's internal id. Remove load: 'join'.`);
                    continue;
                }
                relations.push({
                    ...toRelation('reference', join, 'separate'),
                    separate: { queryType: target.queryType as string, parentKeyField: selectFieldProperty, targetKeyFieldId: targetKeyField.queryFieldId, targetKeyFieldType: targetKeyField.type },
                    selectFieldProperty,
                    selectFieldRelationship,
                    relations: nested(),
                });
                continue;
            }

            const subrecordFieldId = propertyOverrides?.subrecordFieldId ?? property.name.toLowerCase();
            relations.push({
                ...toRelation('subrecord', { kind: 'auto', fieldId: subrecordFieldId }, load),
                subrecordFieldId,
                clearListField: propertyOverrides?.clearListField,
                relations: nested(),
            });
        }

        return relations;
    }

    function nestedRelations(targetEntry: ClassEntry, target: ResolvedClass, projection: string[] | 'all', stack: string[], owner: ClassEntry, propertyName: string): ResolvedRelation[] {
        const targetKey = classKeyOf(targetEntry.collected);
        const wanted = targetEntry.declared.properties.filter((property) => property.target && (projection === 'all' || projection.includes(property.name)) && !targetEntry.collected.overrides.notMapped.has(property.name));
        if (wanted.length === 0) {
            return [];
        }
        if (stack.includes(targetKey)) {
            report(owner, `Property '${owner.declared.className}.${propertyName}' brings '${target.className}' back into itself; project it with Pick<${target.className}, ...> to cut the cycle.`);
            return [];
        }
        return resolveRelations(targetEntry, target, [...stack, targetKey]).filter((relation) => projection === 'all' || projection.includes(relation.name));
    }

    const classes: ResolvedClass[] = [];
    for (const entry of entries.values()) {
        classes.push(resolveShallow(entry));
    }
    for (const entry of entries.values()) {
        const resolved = resolveShallow(entry);
        resolved.relations = resolveRelations(entry, resolved, [classKeyOf(entry.collected)]);
    }

    return { classes, diagnostics };
}
