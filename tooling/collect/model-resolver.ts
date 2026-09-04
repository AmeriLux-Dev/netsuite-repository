import type { Discriminator, FieldType, JoinType, QueryField, RecordUpdaterOptions, RestRecordMetadata } from '../../src/types';
import type { LineKey, PropertyOverrides, RelationKind, TypeTableOptions } from '../../src/model';
import type { CollectedClass, ModelFileDiagnostic } from './model-file-evaluator';
import { defaultLineKeyField, resolveFieldIdForColumn, resolveRecordTypeConvention, resolveSublistConvention, resolveSubrecordConvention } from './netsuite-conventions';
import { classKeyOf } from './property-type-reader';
import type { ClassIdentity, DeclaredClass, DeclaredProperty } from './property-type-reader';

export type { RelationKind };

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
    /** Base class when it is one of the collected classes. */
    base?: ClassIdentity;
    /** Set for @RecordType classes; plain classes (subrecord shapes, mapping bases) have none. */
    recordType?: string;
    table?: string;
    setName?: string;
    discriminator?: Discriminator;
    typeTables?: Record<string, TypeTableOptions>;
    keyProperty: string;
    coerce?: boolean;
    updaterOptions?: RecordUpdaterOptions;
    restRecordMetadata?: RestRecordMetadata;
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

/** Sublists and subrecords are part of their record, so they join inner; a reference is another record that may be absent. */
const defaultJoinTypes: Record<RelationKind, JoinType> = { sublist: 'inner', subrecord: 'inner', reference: 'leftOuter' };

/** A relation nested under a left outer join keeps the outer join, otherwise the nested inner join would filter the parent out. */
function resolveJoinType(kind: RelationKind, declared: JoinType | undefined, parentJoinType: JoinType | undefined): JoinType {
    if (declared) {
        return declared;
    }
    return parentJoinType === 'leftOuter' ? 'leftOuter' : defaultJoinTypes[kind];
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

    function keyColumnOf(resolved: Pick<ResolvedClass, 'keyProperty' | 'fields'>): string {
        const keyField = resolved.fields.find((field) => field.name === resolved.keyProperty);
        return keyField?.column ?? resolved.keyProperty.toLowerCase();
    }

    function ownerTableOf(resolved: Pick<ResolvedClass, 'table' | 'keyProperty' | 'fields'>): OwnerTable | undefined {
        return resolved.table ? { table: resolved.table, keyColumn: keyColumnOf(resolved) } : undefined;
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
        const convention = overrides.recordType ? resolveRecordTypeConvention(overrides.recordType) : undefined;
        const baseTable = overrides.table ?? convention?.table;

        const resolved: ResolvedClass = {
            className: entry.declared.className,
            filePath: entry.declared.filePath,
            exportName: entry.collected.exportName,
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

        if (overrides.recordType !== undefined && !resolved.fields.some((field) => field.name === keyProperty)) {
            report(entry, `Record type '${entry.declared.className}' has no internal id property; declare '${keyProperty}' or mark one with @InternalId().`);
        }

        return resolved;
    }

    function projectFields(target: ResolvedClass, projection: string[] | 'all'): ResolvedField[] {
        return projection === 'all' ? target.fields : target.fields.filter((field) => projection.includes(field.name));
    }

    function resolveRelations(entry: ClassEntry, resolved: ResolvedClass, stack: string[], parentJoinType?: JoinType): ResolvedRelation[] {
        const overrides = entry.collected.overrides;
        const owner = ownerTableOf(resolved);
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

            const toRelation = (kind: RelationKind): ResolvedRelation => ({
                name: property.name,
                kind,
                optional: property.optional,
                inherited: property.inherited,
                joinType: resolveJoinType(kind, propertyOverrides?.joinType, parentJoinType),
                selectByDefault: propertyOverrides?.selectByDefault,
                targetClassName: target.className,
                projection: property.target?.projection ?? 'all',
                fields: projectFields(target, property.target?.projection ?? 'all'),
                relations: [],
            });
            const nested = (relation: ResolvedRelation): ResolvedRelation[] => nestedRelations(targetEntry, target, relation.projection, stack, entry, property.name, relation.kind, relation.joinType);

            if (property.isArray) {
                if (declaredKind !== undefined && declaredKind !== 'sublist') {
                    report(entry, `Property '${qualifiedName}' is an array; use @Sublist() on it, @Subrecord() and @Reference() apply to object properties.`);
                    continue;
                }
                const lineTableFromClass = targetIsRecordType ? target.table : undefined;
                const convention = owner ? resolveSublistConvention(owner.table, { sublistId: propertyOverrides?.sublistId, lineTable: propertyOverrides?.sublistTable ?? lineTableFromClass }) : undefined;
                const sublistId = propertyOverrides?.sublistId ?? convention?.sublistId ?? property.name.toLowerCase();
                const sublistTable = propertyOverrides?.sublistTable ?? convention?.table ?? lineTableFromClass;
                const parentColumn = propertyOverrides?.parentColumn ?? convention?.parentColumn;
                const base = toRelation('sublist');
                if (!owner) {
                    relations.push({ ...base, sublistId });
                    continue;
                }
                if (!sublistTable) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') has no known line table; declare it with @Sublist('${sublistId}', { table, parentColumn }) or type it with a @RecordType class.`);
                    continue;
                }
                if (!parentColumn) {
                    report(entry, `Sublist '${qualifiedName}' ('${sublistId}') has no known parent column on '${sublistTable}'; declare it with @Sublist('${sublistId}', { parentColumn }).`);
                    continue;
                }
                const lineKeyProperty = target.keyProperty;
                const lineKey = propertyOverrides?.lineKey ?? convention?.lineKey ?? { column: keyColumnOf(target), field: defaultLineKeyField };
                relations.push({
                    ...base,
                    sublistId,
                    sublistTable,
                    parentColumn,
                    where: propertyOverrides?.sublistWhere ?? convention?.where,
                    lineKey,
                    lineKeyProperty,
                    relations: nested(base),
                });
                continue;
            }

            if (declaredKind === 'sublist') {
                report(entry, `Property '${qualifiedName}' is marked @Sublist() but is not an array.`);
                continue;
            }

            const subrecordFieldId = propertyOverrides?.subrecordFieldId ?? property.name.toLowerCase();
            const subrecordConvention = owner ? resolveSubrecordConvention(owner.table, subrecordFieldId) : undefined;
            // A plain class can only be a subrecord; a record class is a reference unless the property or the conventions say otherwise.
            const kind: RelationKind = declaredKind ?? (!targetIsRecordType || subrecordConvention ? 'subrecord' : 'reference');

            if (kind === 'reference') {
                const selectFieldProperty = propertyOverrides?.selectFieldProperty ?? `${property.name}Id`;
                const selectField = resolved.fields.find((field) => field.name === selectFieldProperty);
                if (!selectField) {
                    report(entry, `Reference '${qualifiedName}' needs a select field: declare '${selectFieldProperty}', name one with @Reference('<property>'), or mark the property @Subrecord() if it is one.`);
                    continue;
                }
                const targetKeyProperty = propertyOverrides?.targetKeyProperty ?? target.keyProperty;
                const targetKeyField = target.fields.find((field) => field.name === targetKeyProperty);
                if (!targetKeyField) {
                    report(entry, `Reference '${qualifiedName}' joins on '${target.className}.${targetKeyProperty}', which is not a mapped field.`);
                    continue;
                }
                const base = toRelation('reference');
                relations.push({
                    ...base,
                    selectFieldColumn: selectField.column,
                    selectFieldTable: selectField.table,
                    targetTable: target.table,
                    targetKeyColumn: targetKeyField.column,
                    targetDiscriminator: target.discriminator,
                    targetTypeTables: target.typeTables,
                    relations: nested(base),
                });
                continue;
            }

            const subrecordTable = propertyOverrides?.subrecordTable ?? subrecordConvention?.table ?? (targetIsRecordType ? target.table : undefined);
            const subrecordKey = propertyOverrides?.subrecordKey ?? subrecordConvention?.key ?? (targetIsRecordType ? keyColumnOf(target) : undefined);
            const base = toRelation('subrecord');
            if (!owner) {
                relations.push({ ...base, subrecordFieldId });
                continue;
            }
            if (!subrecordTable || !subrecordKey) {
                report(entry, `Subrecord '${qualifiedName}' ('${subrecordFieldId}') has no known table; declare it with @Subrecord('${subrecordFieldId}', { table, key }).`);
                continue;
            }
            relations.push({
                ...base,
                subrecordFieldId,
                subrecordTable,
                subrecordKey,
                clearListField: propertyOverrides?.clearListField ?? subrecordConvention?.clearListField,
                relations: nested(base),
            });
        }

        return relations;
    }

    function nestedRelations(targetEntry: ClassEntry, target: ResolvedClass, projection: string[] | 'all', stack: string[], owner: ClassEntry, propertyName: string, ownerKind: RelationKind, ownerJoinType: JoinType): ResolvedRelation[] {
        const targetKey = classKeyOf(targetEntry.collected);
        const wanted = targetEntry.declared.properties.filter((property) => property.target && (projection === 'all' || projection.includes(property.name)) && !targetEntry.collected.overrides.notMapped.has(property.name));
        if (wanted.length === 0) {
            return [];
        }
        if (stack.includes(targetKey)) {
            report(owner, `Property '${owner.declared.className}.${propertyName}' brings '${target.className}' back into itself; project it with Pick<${target.className}, ...> to cut the cycle.`);
            return [];
        }
        const nested = resolveRelations(targetEntry, target, [...stack, targetKey], ownerJoinType).filter((relation) => projection === 'all' || projection.includes(relation.name));
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
