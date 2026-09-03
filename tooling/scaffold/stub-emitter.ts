import { buildGeneratedFileHeader } from '../emit/header';
import { mapRecordFieldKind, mapSuiteQlColumnType, resolveTableForRecordType, resolveTableForSublist, resolveTableForSubrecord, toCamelCasePropertyName, toPascalCaseModelName } from './mapping';
import type { MetadataProvider, RecordFieldMetadataDescriptor, RecordTypeMetadataDescriptor, SuiteQlTableMetadataDescriptor } from './metadata';

export interface ScaffoldRecordOptions {
    recordType: string;
    modelName?: string;
    /** Override the base SuiteQL table when the conventions do not know the record type. */
    table?: string;
    /** Field ids to include (default: every field with a SuiteQL column) or exclude. */
    include?: string[];
    exclude?: string[];
    libraryModule: string;
    version?: string;
}

export interface ScaffoldedModel {
    modelName: string;
    content: string;
    /** Things the developer must finish by hand. Each is also present as a TODO comment in the file. */
    todos: string[];
}

/** Field types the conventions infer from the TypeScript type alone; anything else needs @Field({ type }). */
const inferredFieldTypes = new Set(['string', 'float', 'boolean', 'date', 'multiselect']);

function quote(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** `Task` + `timeItem` → `TaskTimeItem`; falls back to the lowercase id when the metadata carries no camel-case name. */
function toNestedClassName(modelName: string, id: string, propertyName: string | undefined): string {
    const base = propertyName ?? toCamelCasePropertyName(id);
    return `${modelName}${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

interface PropertyLineOptions {
    fieldId: string;
    field: RecordFieldMetadataDescriptor | undefined;
    column: { name: string; type?: string; joinable?: boolean } | undefined;
    isKey: boolean;
    imports: Set<string>;
}

/**
 * One property line. By convention the field id is the lowercased property name and every field is writable,
 * so decorators appear only where the metadata disagrees: a renamed field, a column that differs from the field id,
 * a type the TypeScript type cannot imply, or a field the record does not accept on write.
 */
function toPropertyLine(options: PropertyLineOptions): string {
    const { fieldId, field, column, isKey, imports } = options;
    const name = field?.propertyName ?? toCamelCasePropertyName(fieldId);
    const mapped = column ? mapSuiteQlColumnType(column.type, column.joinable) : mapRecordFieldKind(field?.kind ?? 'unknown');
    const columnId = column?.name ?? fieldId.toLowerCase();
    const decorators: string[] = [];

    if (!isKey) {
        const fieldOptions: string[] = [];
        if (columnId !== fieldId.toLowerCase()) fieldOptions.push(`column: ${quote(columnId)}`);
        if (!inferredFieldTypes.has(mapped.fieldType)) fieldOptions.push(`type: ${quote(mapped.fieldType)}`);
        const renamed = fieldId.toLowerCase() !== name.toLowerCase();
        if (renamed || fieldOptions.length > 0) {
            imports.add('Field');
            const optionsText = fieldOptions.length > 0 ? `{ ${fieldOptions.join(', ')} }` : '';
            decorators.push(renamed ? `@Field(${quote(fieldId.toLowerCase())}${optionsText ? `, ${optionsText}` : ''})` : `@Field(${optionsText})`);
        }
        if (!field?.writable) {
            imports.add('ReadOnly');
            decorators.push('@ReadOnly()');
        }
    }

    // Internal ids are numbers in SuiteQL and N/record even though the catalog declares them as strings.
    const typeScriptType = isKey ? 'number' : mapped.typeScriptType;
    const nullable = !isKey && typeScriptType !== 'boolean';
    const prefix = decorators.length > 0 ? `${decorators.join(' ')} ` : '';
    return `    ${prefix}${name}!: ${typeScriptType}${nullable ? ' | null' : ''};`;
}

function selectFieldIds(record: RecordTypeMetadataDescriptor, table: SuiteQlTableMetadataDescriptor | undefined, options: ScaffoldRecordOptions): string[] {
    const candidates = table ? Object.keys(table.columns) : Object.keys(record.fields);
    const include = options.include?.map((id) => id.toLowerCase());
    const exclude = new Set((options.exclude ?? []).map((id) => id.toLowerCase()));
    return candidates
        .map((id) => id.toLowerCase())
        .filter((id) => (include ? include.includes(id) : true) && !exclude.has(id))
        .sort((left, right) => (left === 'id' ? -1 : right === 'id' ? 1 : left.localeCompare(right)));
}

/** Emits a convention-mapped model stub from NetSuite metadata. Anything that cannot be mapped becomes a TODO comment so the file still compiles. */
export async function scaffoldRecordModel(provider: MetadataProvider, options: ScaffoldRecordOptions): Promise<ScaffoldedModel> {
    const recordType = options.recordType.toLowerCase();
    const record = await provider.getRecordTypeMetadata(recordType);
    if (!record) {
        throw new Error(`No record metadata is available for '${recordType}'.`);
    }

    const modelName = options.modelName ?? toPascalCaseModelName(recordType);
    const todos: string[] = [];
    const knownTable = resolveTableForRecordType(recordType);
    const tableName = options.table ?? knownTable?.table;
    if (!tableName) {
        todos.push(`the SuiteQL table for record type '${recordType}' is not known; the conventions will use '${recordType}', set @RecordType({ table }) if that is wrong`);
    }
    const table = tableName ? await provider.getSuiteQlTableMetadata(tableName) : undefined;
    if (tableName && !table) {
        todos.push(`no SuiteQL column metadata for table '${tableName}'; column names were taken from record field ids and need review`);
    }

    const imports = new Set(['RecordType']);
    const nestedClasses: string[] = [];
    const rootProperties: string[] = [];
    const relationProperties: string[] = [];

    // Hand-written snapshots may key fields in any case; the emitter always works with lowercase ids.
    const fieldsByLowercaseId = new Map(Object.values(record.fields).map((field) => [field.id.toLowerCase(), field]));
    for (const fieldId of selectFieldIds(record, table, options)) {
        const column = table?.columns[fieldId];
        const field = fieldsByLowercaseId.get(fieldId);
        if (!column && !field) {
            continue;
        }
        rootProperties.push(toPropertyLine({ fieldId, field, column, isKey: fieldId === 'id', imports }));
    }

    for (const field of Object.values(record.fields)) {
        if (field.writable && table && !table.columns[field.id.toLowerCase()] && !(options.exclude ?? []).includes(field.id)) {
            rootProperties.push(`    // TODO(scaffold): '${field.id}' is writable but has no SuiteQL column on '${tableName}'; declare it with @Field(${quote(field.id)}, { column: '<column>' }) if it can be queried.`);
            todos.push(`writable field '${field.id}' has no SuiteQL column`);
        }
    }

    for (const subrecord of Object.values(record.subrecords)) {
        const className = toNestedClassName(modelName, subrecord.fieldId, subrecord.propertyName);
        const mapping = resolveTableForSubrecord(recordType, subrecord.fieldId);
        const nestedTable = mapping ? await provider.getSuiteQlTableMetadata(mapping.table) : undefined;
        const lines = Object.values(subrecord.fields).map((field) => toPropertyLine({ fieldId: field.id, field, column: nestedTable?.columns[field.id.toLowerCase()], isKey: false, imports }));
        nestedClasses.push([`export class ${className} {`, ...lines, '}'].join('\n'));
        const propertyName = subrecord.propertyName ?? toCamelCasePropertyName(subrecord.fieldId);
        const needsFieldId = propertyName.toLowerCase() !== subrecord.fieldId.toLowerCase();

        if (mapping) {
            if (needsFieldId) {
                imports.add('Subrecord');
                relationProperties.push(`    @Subrecord(${quote(subrecord.fieldId)}) ${propertyName}!: ${className};`);
            } else {
                relationProperties.push(`    ${propertyName}!: ${className};`);
            }
        } else {
            todos.push(`subrecord '${subrecord.fieldId}' has no known SuiteQL table; declare it to query it`);
            const clearListField = subrecord.clearBeforeUpdateFieldId ? `, clearListField: ${quote(subrecord.clearBeforeUpdateFieldId)}` : '';
            relationProperties.push([
                `    // TODO(scaffold): subrecord '${subrecord.fieldId}' has no known SuiteQL table. Fill in the table and its key column, then uncomment.`,
                `    // @Subrecord(${quote(subrecord.fieldId)}, { table: '<table>', key: '<key>'${clearListField} })`,
                `    // ${propertyName}!: ${className};`,
            ].join('\n'));
        }
    }

    for (const sublist of Object.values(record.sublists)) {
        const className = `${toNestedClassName(modelName, sublist.sublistId, sublist.propertyName)}Line`;
        const mapping = resolveTableForSublist(recordType, sublist.sublistId);
        const lineTable = mapping ? await provider.getSuiteQlTableMetadata(mapping.table) : undefined;
        const lines = ['    id!: number;', ...Object.values(sublist.fields).map((field) => toPropertyLine({ fieldId: field.id, field, column: lineTable?.columns[field.id.toLowerCase()], isKey: false, imports }))];
        imports.add('Sublist');
        const propertyName = sublist.propertyName ?? toCamelCasePropertyName(sublist.sublistId);

        if (mapping) {
            nestedClasses.push([`@Sublist(${quote(sublist.sublistId)})`, `export class ${className} {`, ...lines, '}'].join('\n'));
            relationProperties.push(`    ${propertyName}!: ${className}[];`);
        } else {
            todos.push(`sublist '${sublist.sublistId}' has no known SuiteQL line table; declare it to query it`);
            nestedClasses.push([
                `// TODO(scaffold): sublist '${sublist.sublistId}' has no known SuiteQL line table. Fill in the line table and the column holding the parent id.`,
                `@Sublist(${quote(sublist.sublistId)}, { table: '<table>', parentColumn: '<column>' })`,
                `export class ${className} {`,
                ...lines,
                '}',
            ].join('\n'));
            relationProperties.push(`    // TODO(scaffold): uncomment once '${className}' names its line table.\n    // ${propertyName}!: ${className}[];`);
        }
    }

    const recordTypeLine = options.table && options.table !== knownTable?.table
        ? `@RecordType(${quote(recordType)}, { table: ${quote(options.table)} })`
        : tableName
            ? `@RecordType(${quote(recordType)})`
            : `// TODO(scaffold): confirm the SuiteQL table for '${recordType}' (the conventions assume '${recordType}').\n@RecordType(${quote(recordType)})`;

    const content = [
        buildGeneratedFileHeader(`Scaffolded model for the '${recordType}' record. This file is yours to edit; the scaffold never overwrites it.`, options.version),
        `import { ${Array.from(imports).sort().join(', ')} } from '${options.libraryModule}';`,
        '',
        ...nestedClasses.map((nested) => `${nested}\n`),
        recordTypeLine,
        `export class ${modelName} {`,
        ...rootProperties,
        ...(relationProperties.length > 0 ? ['', ...relationProperties] : []),
        '}',
        '',
    ].join('\n');

    return { modelName, content, todos };
}
