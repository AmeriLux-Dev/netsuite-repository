import type { ComponentCondition, ComponentJoin, FieldType, QueryField, RecordUpdaterOptions, RelationshipLoad, SeparateLoad } from '../../src/types';
import type { PropertyOverrides, RelationKind } from '../../src/model';
import type { CollectedClass, ModelFileDiagnostic } from './model-file-evaluator';
import { classKeyOf } from './property-type-reader';
import type { ClassIdentity, DeclaredClass, DeclaredProperty } from './property-type-reader';

export type { RelationKind };

export interface ResolvedField {
    name: string;
    /** N/query field id. */
    queryFieldId: string;
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
    /** Subrecord: field id on the owner and the list field cleared before edits. */
    subrecordFieldId?: string;
    clearListField?: string;
    /** Sublist: id on the owner, the conditions that pick its lines, and the line class's key property. */
    sublistId?: string;
    filter?: ComponentCondition[];
    lineKeyProperty?: string;
    lineOrderFieldId?: string;
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

function toShallowField(property: DeclaredProperty, overrides: PropertyOverrides | undefined, isKey: boolean, isSelectField: boolean): ResolvedField | undefined {
    // The internal id is a key and a reference's select field a select: both compare through ANY_OF in N/query.
    const inferredType = overrides?.type ?? (isKey ? 'key' : isSelectField && property.scalarType ? 'select' : property.scalarType);
    if (!inferredType) {
        return undefined;
    }
    const recordFieldId = overrides?.fieldId ?? property.name.toLowerCase();
    return {
        name: property.name,
        queryFieldId: overrides?.queryFieldId ?? recordFieldId,
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
            if (property.target) {
                continue;
            }
            const field = toShallowField(property, overrides.properties.get(property.name), property.name === keyProperty, selectFieldProperties.has(property.name) || property.name === overrides.parentKeyProperty);
            if (!field) {
                report(entry, `Property '${entry.declared.className}.${property.name}' has type '${property.typeText}', which does not map to a NetSuite field type. Declare it with @Field({ type }), type it as a model class, or mark it @NotMapped().`);
                continue;
            }
            resolved.fields.push(field);
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
                if (propertyOverrides?.relationshipFieldId !== undefined) {
                    join = { kind: 'auto', fieldId: propertyOverrides.relationshipFieldId };
                } else if (!targetIsRecordType) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') is typed as '${target.className}', which has no @RecordType; a line class names its record type, or the property names the relationship with @Sublist('${sublistId}', { relationship }).`);
                    continue;
                } else {
                    const parentKeyField = target.fields.find((field) => field.name === target.parentKeyProperty);
                    if (!parentKeyField) {
                        report(entry, `Sublist '${qualifiedName}' ('${sublistId}') has no way back to its parent: mark the property of '${target.className}' holding the parent's internal id with @ParentId(), or name the relationship with @Sublist('${sublistId}', { relationship }).`);
                        continue;
                    }
                    join = { kind: 'from', fieldId: parentKeyField.queryFieldId, source: target.queryType as string };
                }
                const lineKeyField = target.fields.find((field) => field.name === target.keyProperty);
                const separateQueryType = propertyOverrides?.separateQueryType;
                if (separateQueryType !== undefined && load !== 'separate') {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') names a query type ('${separateQueryType}') for its own query, so it must load separately; add load: 'separate'.`);
                    continue;
                }
                // Lines reached from another root than the owner's are matched to the owner by internal id.
                const ownerKeyQueryFieldId = resolved.fields.find((field) => field.name === resolved.keyProperty)?.queryFieldId ?? resolved.keyProperty.toLowerCase();
                const separate = separateQueryType === undefined ? undefined : { queryType: separateQueryType, parentKeyField: resolved.keyProperty, targetKeyFieldId: ownerKeyQueryFieldId, targetKeyFieldType: 'key' as const };
                relations.push({
                    ...toRelation('sublist', join, load),
                    ...(separate ? { separate } : {}),
                    sublistId,
                    filter: propertyOverrides?.filter,
                    lineKeyProperty: target.keyProperty,
                    lineOrderFieldId: lineKeyField?.queryFieldId,
                    relations: nested(),
                });
                continue;
            }

            if (declaredKind === 'sublist') {
                report(entry, `Property '${qualifiedName}' is marked @Sublist() but is not an array.`);
                continue;
            }

            // A plain class is a subrecord; a record class is a reference unless the property says @Subrecord().
            const kind: RelationKind = declaredKind ?? (targetIsRecordType ? 'reference' : 'subrecord');

            if (kind === 'reference') {
                if (!targetIsRecordType) {
                    report(entry, `Reference '${qualifiedName}' targets '${target.className}', which has no @RecordType; a reference needs a query type.`);
                    continue;
                }
                const selectFieldProperty = propertyOverrides?.selectFieldProperty ?? `${property.name}Id`;
                const selectField = resolved.fields.find((field) => field.name === selectFieldProperty);
                if (!selectField) {
                    report(entry, `Reference '${qualifiedName}' needs a select field: declare '${selectFieldProperty}', name one with @Reference('<property>'), or mark the property @Subrecord() if it is one.`);
                    continue;
                }
                const targetKeyProperty = propertyOverrides?.targetKeyProperty;
                const join: ComponentJoin = propertyOverrides?.joinKind === 'auto'
                    ? { kind: 'auto', fieldId: selectField.queryFieldId }
                    : { kind: 'to', fieldId: selectField.queryFieldId, target: target.queryType as string };
                if (targetKeyProperty === undefined) {
                    // A reference loaded separately by internal id: the second query matches the target's key against the select field values.
                    const targetKeyQueryFieldId = target.fields.find((field) => field.name === target.keyProperty)?.queryFieldId ?? target.keyProperty.toLowerCase();
                    const separate = load === 'separate' ? { queryType: target.queryType as string, parentKeyField: selectFieldProperty, targetKeyFieldId: targetKeyQueryFieldId, targetKeyFieldType: 'key' as const } : undefined;
                    relations.push({ ...toRelation('reference', join, load), ...(separate ? { separate } : {}), relations: nested() });
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
