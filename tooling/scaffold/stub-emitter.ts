import { buildGeneratedFileHeader } from '../emit/header';
import { mapRecordFieldKind, mapSuiteQlColumnType, renderJoinPredicate, resolveTableForRecordType, resolveTableForSublist, resolveTableForSubrecord, toCamelCasePropertyName, toPascalCaseModelName } from './mapping';
import type { MetadataProvider, RecordFieldMetadataDescriptor, RecordTypeMetadataDescriptor, SuiteQlTableMetadataDescriptor } from './metadata';

export interface ScaffoldRecordOptions {
    recordType: string;
    modelName?: string;
    /** Override the root SuiteQL table and alias when the built-in map does not know the record type. */
    table?: string;
    alias?: string;
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

interface ScaffoldedProperty {
    name: string;
    line: string;
}

function quote(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** `Task` + `timeItem` → `TaskTimeItem`; falls back to the lowercase id when the metadata carries no camel-case name. */
function toNestedClassName(modelName: string, id: string, propertyName: string | undefined): string {
    const base = propertyName ?? toCamelCasePropertyName(id);
    return `${modelName}${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

function toPropertyLine(fieldId: string, field: RecordFieldMetadataDescriptor | undefined, column: { name: string; type?: string; joinable?: boolean } | undefined, isKey: boolean): ScaffoldedProperty {
    const name = field?.propertyName ?? toCamelCasePropertyName(fieldId);
    const mapped = column ? mapSuiteQlColumnType(column.type, column.joinable) : mapRecordFieldKind(field?.kind ?? 'unknown');
    const decorators: string[] = [];
    const columnId = column?.name ?? fieldId.toLowerCase();

    if (isKey) {
        decorators.push('@Key()');
    } else {
        const columnOptions = mapped.fieldType !== 'string' && mapped.fieldType !== 'float' ? `, { type: ${quote(mapped.fieldType)} }` : '';
        decorators.push(columnId === name.toLowerCase() && columnOptions === '' ? '@Column()' : `@Column(${quote(columnId)}${columnOptions})`);
    }

    if (field?.writable && !isKey) {
        decorators.push(field.id === columnId ? '@RecordField()' : `@RecordField(${quote(field.id)})`);
    } else if (!isKey) {
        decorators.push('@ReadOnly()');
    }

    // Internal ids are numbers in SuiteQL and N/record even though the catalog declares them as strings.
    const typeScriptType = isKey ? 'number' : mapped.typeScriptType;
    const nullable = !isKey && typeScriptType !== 'boolean';
    return { name, line: `    ${decorators.join(' ')} ${name}!: ${typeScriptType}${nullable ? ' | null' : ''};` };
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

/** Emits a decorated model stub from NetSuite metadata. Anything that cannot be mapped becomes a TODO comment so the file still compiles. */
export async function scaffoldRecordModel(provider: MetadataProvider, options: ScaffoldRecordOptions): Promise<ScaffoldedModel> {
    const recordType = options.recordType.toLowerCase();
    const record = await provider.getRecordTypeMetadata(recordType);
    if (!record) {
        throw new Error(`No record metadata is available for '${recordType}'.`);
    }

    const modelName = options.modelName ?? toPascalCaseModelName(recordType);
    const todos: string[] = [];
    const rootTable = options.table ? { table: options.table, alias: options.alias ?? options.table } : resolveTableForRecordType(recordType);
    if (!rootTable) {
        todos.push(`the SuiteQL table for record type '${recordType}' is not known; set it on @Entity({ table })`);
    }
    const rootAlias = rootTable?.alias ?? 'root';
    const table = rootTable ? await provider.getSuiteQlTableMetadata(rootTable.table) : undefined;
    if (rootTable && !table) {
        todos.push(`no SuiteQL column metadata for table '${rootTable.table}'; column names were taken from record field ids and need review`);
    }

    const imports = new Set(['Column', 'Entity', 'Key', 'ReadOnly', 'RecordField']);
    const nestedClasses: string[] = [];
    const rootProperties: string[] = [];
    const navigationProperties: string[] = [];

    // Hand-written snapshots may key fields in any case; the emitter always works with lowercase ids.
    const fieldsByLowercaseId = new Map(Object.values(record.fields).map((field) => [field.id.toLowerCase(), field]));
    for (const fieldId of selectFieldIds(record, table, options)) {
        const column = table?.columns[fieldId];
        const field = fieldsByLowercaseId.get(fieldId);
        if (!column && !field) {
            continue;
        }
        rootProperties.push(toPropertyLine(fieldId, field, column, fieldId === 'id').line);
    }

    for (const field of Object.values(record.fields)) {
        if (field.writable && table && !table.columns[field.id.toLowerCase()] && !(options.exclude ?? []).includes(field.id)) {
            rootProperties.push(`    // TODO(scaffold): '${field.id}' is writable but has no SuiteQL column on '${rootTable?.table}'; map it with @Column('<column>') @RecordField(${quote(field.id)}) if it can be queried.`);
            todos.push(`writable field '${field.id}' has no SuiteQL column`);
        }
    }

    for (const subrecord of Object.values(record.subrecords)) {
        const className = toNestedClassName(modelName, subrecord.fieldId, subrecord.propertyName);
        const mapping = resolveTableForSubrecord(recordType, subrecord.fieldId);
        const nestedTable = mapping ? await provider.getSuiteQlTableMetadata(mapping.table) : undefined;
        const lines = Object.values(subrecord.fields).map((field) => toPropertyLine(field.id, field, nestedTable?.columns[field.id.toLowerCase()], false).line);
        nestedClasses.push([`export class ${className} {`, ...lines, '}'].join('\n'));
        imports.add('OwnsOne');

        if (mapping) {
            const clearListField = mapping.clearListField ?? subrecord.clearBeforeUpdateFieldId;
            navigationProperties.push([
                `    @OwnsOne(() => ${className}, {`,
                `        subrecord: ${quote(subrecord.fieldId)},`,
                ...(clearListField ? [`        clearListField: ${quote(clearListField)},`] : []),
                `        join: { alias: ${quote(mapping.alias)}, table: ${quote(mapping.table)}, on: ${quote(renderJoinPredicate(mapping.on, mapping.alias, rootAlias))} },`,
                '    })',
                `    ${subrecord.propertyName ?? toCamelCasePropertyName(subrecord.fieldId)}!: ${className};`,
            ].join('\n'));
        } else {
            todos.push(`subrecord '${subrecord.fieldId}' has no known SuiteQL table; add a join to query it`);
            navigationProperties.push([
                `    // TODO(scaffold): subrecord '${subrecord.fieldId}' has no known SuiteQL table. Add a join (or from: '${rootAlias}' when its columns live on the root row) and uncomment.`,
                `    // @OwnsOne(() => ${className}, { subrecord: ${quote(subrecord.fieldId)}, join: { alias: '<alias>', table: '<table>', on: '<alias>.nkey = ${rootAlias}.${subrecord.fieldId}' } })`,
                `    // ${subrecord.propertyName ?? toCamelCasePropertyName(subrecord.fieldId)}!: ${className};`,
            ].join('\n'));
        }
    }

    for (const sublist of Object.values(record.sublists)) {
        const className = `${toNestedClassName(modelName, sublist.sublistId, sublist.propertyName)}Line`;
        const mapping = resolveTableForSublist(recordType, sublist.sublistId);
        const lineTable = mapping ? await provider.getSuiteQlTableMetadata(mapping.table) : undefined;
        const lines: string[] = [];
        if (mapping?.lineNumberColumn) {
            lines.push(`    @Column(${quote(mapping.lineNumberColumn)}, { type: 'integer' }) @ReadOnly() line!: number;`);
        }
        lines.push(...Object.values(sublist.fields).map((field) => toPropertyLine(field.id, field, lineTable?.columns[field.id.toLowerCase()], false).line));
        nestedClasses.push([`export class ${className} {`, ...lines, '}'].join('\n'));
        imports.add('OwnsMany');

        if (mapping) {
            navigationProperties.push([
                `    // TODO(scaffold): choose the line identity: matchBy: '<property>' for a unique line value${mapping.lineNumberColumn ? ", or lineNumberProperty: 'line' after mapping it to a zero-based index" : ''}.`,
                `    @OwnsMany(() => ${className}, {`,
                `        sublist: ${quote(sublist.sublistId)},`,
                `        join: { alias: ${quote(mapping.alias)}, table: ${quote(mapping.table)}, on: ${quote(renderJoinPredicate(mapping.on, mapping.alias, rootAlias))} },`,
                '    })',
                `    ${sublist.propertyName ?? toCamelCasePropertyName(sublist.sublistId)}!: ${className}[];`,
            ].join('\n'));
            todos.push(`sublist '${sublist.sublistId}' needs a line identity (matchBy or lineNumberProperty)`);
        } else {
            todos.push(`sublist '${sublist.sublistId}' has no known SuiteQL line table; add a join to query it`);
            navigationProperties.push([
                `    // TODO(scaffold): sublist '${sublist.sublistId}' has no known SuiteQL line table. Add a join and a line identity, then uncomment.`,
                `    // @OwnsMany(() => ${className}, { sublist: ${quote(sublist.sublistId)}, matchBy: '<property>', join: { alias: '<alias>', table: '<table>', on: '<alias>.<parent> = ${rootAlias}.id' } })`,
                `    // ${sublist.propertyName ?? toCamelCasePropertyName(sublist.sublistId)}!: ${className}[];`,
            ].join('\n'));
        }
    }

    const entityLine = rootTable
        ? `@Entity({ recordType: ${quote(recordType)}, table: ${quote(rootTable.table)}, alias: ${quote(rootTable.alias)} })`
        : `// TODO(scaffold): set the SuiteQL table for '${recordType}'.\n@Entity({ recordType: ${quote(recordType)}, table: '<table>', alias: 'root' })`;

    const content = [
        buildGeneratedFileHeader(`Scaffolded model for the '${recordType}' record. This file is yours to edit; the scaffold never overwrites it.`, options.version),
        `import { ${Array.from(imports).sort().join(', ')} } from '${options.libraryModule}';`,
        '',
        ...nestedClasses.map((nested) => `${nested}\n`),
        entityLine,
        `export class ${modelName} {`,
        ...rootProperties,
        ...(navigationProperties.length > 0 ? ['', ...navigationProperties] : []),
        '}',
        '',
    ].join('\n');

    return { modelName, content, todos };
}
