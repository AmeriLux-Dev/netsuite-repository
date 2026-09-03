import type { Discriminator, FieldType, JoinType, QueryField, RecordUpdaterOptions, RestRecordMetadata } from '../../src/types';
import type { ClassOverrides, LineKey, ModelClassKind, PropertyOverrides, TypeTableOptions } from '../../src/model';
import type { CollectedClass, ModelFileDiagnostic } from './model-file-evaluator';
import { defaultLineKeyField, resolveFieldIdForColumn, resolveRecordTypeConvention, resolveSublistConvention, resolveSubrecordConvention } from './netsuite-conventions';
import { classKeyOf } from './property-type-reader';
import type { ClassIdentity, DeclaredClass, DeclaredProperty } from './property-type-reader';

export interface ResolvedField {
    name: string;
    column: string;
    /** Type table the column is read from; undefined for the owner's base table. */
    table?: string;
    /** Record field id; undefined means the field is read-only. */
    fieldId?: string;
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

export type RelationKind = 'reference' | 'subrecord' | 'sublist';

export interface ResolvedRelation {
    name: string;
    kind: RelationKind;
    optional: boolean;
    inherited: boolean;
    joinType: JoinType;
    selectByDefault?: boolean;
    targetClassName: string;
    projection: string[] | 'all';
    fields: ResolvedField[];
    relations: ResolvedRelation[];
    /** Reference: the owner's column holding the referenced internal id, and the target's table and key. */
    selectFieldColumn?: string;
    selectFieldTable?: string;
    targetTable?: string;
    targetKeyColumn?: string;
    targetDiscriminator?: Discriminator;
    targetTypeTables?: Record<string, TypeTableOptions>;
    /** Subrecord: field id on the owner, the queryable table, its key column, and the list field cleared before edits. */
    subrecordFieldId?: string;
    subrecordTable?: string;
    subrecordKey?: string;
    clearListField?: string;
    /** Sublist: id on the owner, line table, parent column, extra predicate, and the line key column/field plus the property carrying it. */
    sublistId?: string;
    sublistTable?: string;
    parentColumn?: string;
    where?: string;
    lineKey?: LineKey;
    lineKeyProperty?: string;
}

export interface ResolvedClass extends ClassIdentity {
    exportName: string;
    kind?: ModelClassKind;
    /** Base class when it is one of the collected classes. */
    base?: ClassIdentity;
    recordType?: string;
    table?: string;
    setName?: string;
    discriminator?: Discriminator;
    typeTables?: Record<string, TypeTableOptions>;
    keyProperty: string;
    coerce?: boolean;
    updaterOptions?: RecordUpdaterOptions;
    restRecordMetadata?: RestRecordMetadata;
    sublistId?: string;
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

/** Table facts of a class: what its fields' columns are read from and what its subrecords and sublists hang off. */
interface OwnerTable {
    table: string;
    keyColumn: string;
}

function toShallowField(property: DeclaredProperty, overrides: PropertyOverrides | undefined, owner: OwnerTable | undefined, isKey: boolean, isSelectField: boolean): ResolvedField | undefined {
    const column = overrides?.column ?? overrides?.fieldId ?? property.name.toLowerCase();
    const inferredType = overrides?.type ?? (isKey || isSelectField ? 'integer' : property.scalarType);
    if (!inferredType) {
        return undefined;
    }
    const conventionalFieldId = owner ? resolveFieldIdForColumn(owner.table, column) : column;
    const readOnly = overrides?.readOnly || isKey || overrides?.text;
    return {
        name: property.name,
        column,
        table: overrides?.table,
        fieldId: readOnly ? undefined : overrides?.fieldId ?? conventionalFieldId,
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

/** Turns collected classes plus their declared shapes into resolved models, applying the NetSuite conventions. */
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

    function ownerTableOf(entry: ClassEntry, resolved: Pick<ResolvedClass, 'table' | 'keyProperty' | 'fields'>): OwnerTable | undefined {
        if (!resolved.table) {
            return undefined;
        }
        const keyField = resolved.fields.find((field) => field.name === resolved.keyProperty);
        return { table: resolved.table, keyColumn: keyField?.column ?? resolved.keyProperty.toLowerCase() };
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
        const kind = overrides.kind;
        const convention = overrides.recordType ? resolveRecordTypeConvention(overrides.recordType) : undefined;
        const baseTable = overrides.table ?? convention?.table ?? (kind === 'sublist' ? overrides.sublistTable : kind === 'subrecord' ? overrides.subrecordTable : undefined);

        const resolved: ResolvedClass = {
            className: entry.declared.className,
            filePath: entry.declared.filePath,
            exportName: entry.collected.exportName,
            kind,
            base: entry.declared.base && entries.has(classKeyOf(entry.declared.base)) ? entry.declared.base : undefined,
            recordType: overrides.recordType,
            table: baseTable,
            setName: overrides.setName,
            discriminator: overrides.discriminator ?? convention?.discriminator,
            typeTables: overrides.typeTables ?? convention?.typeTables,
            keyProperty,
            coerce: overrides.coerce,
            updaterOptions: overrides.updaterOptions,
            restRecordMetadata: overrides.restRecordMetadata,
            sublistId: overrides.sublistId,
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

        const owner: OwnerTable | undefined = baseTable ? { table: baseTable, keyColumn: keyProperty.toLowerCase() } : undefined;
        for (const property of entry.declared.properties) {
            if (overrides.notMapped.has(property.name)) {
                resolved.unmapped.push({ name: property.name, typeText: property.typeText, optional: property.optional, inherited: property.inherited });
                continue;
            }
            if (property.target) {
                continue;
            }
            const propertyOverrides = overrides.properties.get(property.name);
            const field = toShallowField(property, propertyOverrides, owner, property.name === keyProperty, selectFieldProperties.has(property.name));
            if (!field) {
                report(entry, `Property '${entry.declared.className}.${property.name}' has type '${property.typeText}', which does not map to a NetSuite field type. Declare it with @Field({ type }), type it as a model class, or mark it @NotMapped().`);
                continue;
            }
            if (field.table && !resolved.typeTables?.[field.table]) {
                report(entry, `Property '${entry.declared.className}.${property.name}' reads from table '${field.table}', which is not a type table of '${overrides.recordType ?? entry.declared.className}'. Declare it with @RecordType('...', { tables: { ${field.table}: { key: 'id' } } }).`);
            }
            resolved.fields.push(field);
        }

        if (kind === 'recordType' && !resolved.fields.some((field) => field.name === keyProperty)) {
            report(entry, `Record type '${entry.declared.className}' has no internal id property; declare '${keyProperty}' or mark one with @InternalId().`);
        }

        return resolved;
    }

    function projectFields(target: ResolvedClass, projection: string[] | 'all'): ResolvedField[] {
        return projection === 'all' ? target.fields : target.fields.filter((field) => projection.includes(field.name));
    }

    function resolveRelations(entry: ClassEntry, resolved: ResolvedClass, stack: string[]): ResolvedRelation[] {
        const overrides = entry.collected.overrides;
        const owner = ownerTableOf(entry, resolved);
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
            const propertyOverrides = overrides.properties.get(property.name);
            const targetKey = classKeyOf(property.target);
            const base: ResolvedRelation = {
                name: property.name,
                kind: 'subrecord',
                optional: property.optional,
                inherited: property.inherited,
                joinType: propertyOverrides?.joinType ?? 'leftOuter',
                selectByDefault: propertyOverrides?.selectByDefault,
                targetClassName: target.className,
                projection: property.target.projection,
                fields: projectFields(target, property.target.projection),
                relations: [],
            };

            if (property.isArray) {
                if (target.kind !== 'sublist') {
                    report(entry, `Property '${entry.declared.className}.${property.name}' is an array of '${target.className}', which is not a sublist class. Decorate '${target.className}' with @Sublist('<sublist id>').`);
                    continue;
                }
                const sublistId = target.sublistId as string;
                const convention = owner ? resolveSublistConvention(owner.table, sublistId) : undefined;
                const targetOverrides = targetEntry.collected.overrides;
                const sublistTable = targetOverrides.sublistTable ?? convention?.table;
                const parentColumn = targetOverrides.parentColumn ?? convention?.parentColumn;
                if (!owner) {
                    relations.push({ ...base, kind: 'sublist', sublistId });
                    continue;
                }
                if (!sublistTable || !parentColumn) {
                    report(entry, `Sublist '${entry.declared.className}.${property.name}' ('${sublistId}') has no known line table; declare it with @Sublist('${sublistId}', { table, parentColumn }) on '${target.className}'.`);
                    continue;
                }
                const lineKeyProperty = target.keyProperty;
                const lineKeyField = target.fields.find((field) => field.name === lineKeyProperty);
                const lineKey = targetOverrides.lineKey ?? convention?.lineKey ?? { column: lineKeyField?.column ?? lineKeyProperty.toLowerCase(), field: defaultLineKeyField };
                relations.push({
                    ...base,
                    kind: 'sublist',
                    sublistId,
                    sublistTable,
                    parentColumn,
                    where: targetOverrides.sublistWhere ?? convention?.where,
                    lineKey,
                    lineKeyProperty,
                    relations: nestedRelations(targetEntry, target, property.target.projection, stack, entry, property.name, 'sublist'),
                });
                continue;
            }

            if (target.kind === 'sublist') {
                report(entry, `Property '${entry.declared.className}.${property.name}' is typed as sublist class '${target.className}' but is not an array.`);
                continue;
            }

            if (target.kind === 'recordType') {
                const selectFieldProperty = propertyOverrides?.selectFieldProperty ?? `${property.name}Id`;
                const selectField = resolved.fields.find((field) => field.name === selectFieldProperty);
                if (!selectField) {
                    report(entry, `Reference '${entry.declared.className}.${property.name}' needs a select field: declare '${selectFieldProperty}' or name one with @Reference('<property>').`);
                    continue;
                }
                const targetKeyProperty = propertyOverrides?.targetKeyProperty ?? target.keyProperty;
                const targetKeyField = target.fields.find((field) => field.name === targetKeyProperty);
                if (!targetKeyField) {
                    report(entry, `Reference '${entry.declared.className}.${property.name}' joins on '${target.className}.${targetKeyProperty}', which is not a mapped field.`);
                    continue;
                }
                relations.push({
                    ...base,
                    kind: 'reference',
                    selectFieldColumn: selectField.column,
                    selectFieldTable: selectField.table,
                    targetTable: target.table,
                    targetKeyColumn: targetKeyField.column,
                    targetDiscriminator: target.discriminator,
                    targetTypeTables: target.typeTables,
                    relations: nestedRelations(targetEntry, target, property.target.projection, stack, entry, property.name, 'reference'),
                });
                continue;
            }

            const subrecordFieldId = propertyOverrides?.subrecordFieldId ?? property.name.toLowerCase();
            const convention = owner ? resolveSubrecordConvention(owner.table, subrecordFieldId) : undefined;
            const targetOverrides = targetEntry.collected.overrides;
            const subrecordTable = propertyOverrides?.subrecordTable ?? targetOverrides.subrecordTable ?? convention?.table;
            const subrecordKey = propertyOverrides?.subrecordKey ?? targetOverrides.subrecordKey ?? convention?.key;
            if (!owner) {
                relations.push({ ...base, kind: 'subrecord', subrecordFieldId });
                continue;
            }
            if (!subrecordTable || !subrecordKey) {
                report(entry, `Subrecord '${entry.declared.className}.${property.name}' ('${subrecordFieldId}') has no known table; declare it with @Subrecord('${subrecordFieldId}', { table, key }).`);
                continue;
            }
            relations.push({
                ...base,
                kind: 'subrecord',
                subrecordFieldId,
                subrecordTable,
                subrecordKey,
                clearListField: propertyOverrides?.clearListField ?? convention?.clearListField,
                relations: nestedRelations(targetEntry, target, property.target.projection, stack, entry, property.name, 'subrecord'),
            });
        }

        return relations;
    }

    function nestedRelations(targetEntry: ClassEntry, target: ResolvedClass, projection: string[] | 'all', stack: string[], owner: ClassEntry, propertyName: string, ownerKind: RelationKind): ResolvedRelation[] {
        const targetKey = classKeyOf(targetEntry.collected);
        const wanted = targetEntry.declared.properties.filter((property) => property.target && (projection === 'all' || projection.includes(property.name)) && !targetEntry.collected.overrides.notMapped.has(property.name));
        if (wanted.length === 0) {
            return [];
        }
        if (stack.includes(targetKey)) {
            report(owner, `Property '${owner.declared.className}.${propertyName}' brings '${target.className}' back into itself; project it with Pick<${target.className}, ...> to cut the cycle.`);
            return [];
        }
        const nested = resolveRelations(targetEntry, target, [...stack, targetKey]).filter((relation) => projection === 'all' || projection.includes(relation.name));
        for (const relation of nested) {
            if (relation.kind === 'sublist' && ownerKind === 'sublist') {
                report(owner, `Sublist '${target.className}.${relation.name}' cannot be loaded inside sublist '${owner.declared.className}.${propertyName}'; SuiteQL would multiply the rows.`);
            }
        }
        return nested.filter((relation) => !(relation.kind === 'sublist' && ownerKind === 'sublist'));
    }

    const classes: ResolvedClass[] = [];
    for (const entry of entries.values()) {
        const resolved = resolveShallow(entry);
        classes.push(resolved);
    }
    for (const entry of entries.values()) {
        const resolved = resolveShallow(entry);
        resolved.relations = resolveRelations(entry, resolved, [classKeyOf(entry.collected)]);
    }

    return { classes, diagnostics };
}
