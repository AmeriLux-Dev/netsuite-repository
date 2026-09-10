import type { QueryConfig } from '../../src/types';
import { buildGeneratedFileHeader } from './header';
import { serializeToTypeScriptLiteral } from './serialize';

export interface TypeFileMember {
    name: string;
    optional: boolean;
    typeText: string;
}

/** A function a config may reference, with the identifier to emit and where to import it from. */
export interface FunctionImport {
    fn: Function;
    identifier: string;
    exportName: string;
    /** Import path (extension-less, relative to the output directory). */
    importPath: string;
}

/** A field path per property, nested by relation: `{ id: 'id', lines: { item: { type: 'lines.item.type' } } }`. */
export interface FieldPathTree {
    [name: string]: string | FieldPathTree;
}

/** What a record type adds to its generated file beyond the interface. */
export interface RecordTypeEmitOptions {
    config: QueryConfig<unknown>;
    functionImports: FunctionImport[];
    fields: FieldPathTree;
    /** Also emit `<Model>RepositoryBase`, a RecordSet bound to the config. */
    repository: boolean;
}

export interface ModelFileEmitOptions {
    className: string;
    /** Generated interface this one extends, when the model class has a collected base class. */
    baseClassName?: string;
    /** Own members only; inherited ones come from the base interface. */
    members: TypeFileMember[];
    /** Other generated classes referenced by the members or the base, imported from their own generated files. */
    imports: string[];
    libraryModule: string;
    /** Present for record types; a plain class gets the interface only. */
    record?: RecordTypeEmitOptions;
    version?: string;
}

function isIdentifierReferenced(literal: string, identifier: string): boolean {
    return new RegExp(`(^|[^A-Za-z0-9_$])${identifier}([^A-Za-z0-9_$]|$)`).test(literal);
}

function isIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function renderFieldTree(tree: FieldPathTree, indent: string): string[] {
    const lines: string[] = [];
    for (const [name, entry] of Object.entries(tree)) {
        const key = isIdentifier(name) ? name : `'${name}'`;
        if (typeof entry === 'string') {
            lines.push(`${indent}${key}: '${entry}',`);
        } else {
            lines.push(`${indent}${key}: {`, ...renderFieldTree(entry, `${indent}    `), `${indent}},`);
        }
    }
    return lines;
}

/**
 * Emits `<Class>.gen.ts`, everything generated for one class as named exports: the interface (with `<Class>Patch` and
 * `<Class>Create` for record types), then for record types the `<Class>Config` literal, the `<Class>Fields` paths,
 * and, when asked for, the `<Class>RepositoryBase` class.
 */
export function emitModelFile(options: ModelFileEmitOptions): string {
    const { className, libraryModule, record } = options;
    const lines: string[] = [];
    const parts = ['type'];
    if (record) parts.push('config', 'field paths');
    if (record?.repository) parts.push('base repository');
    lines.push(buildGeneratedFileHeader(`Generated ${parts.join(', ')} for the ${className} model.`, options.version));

    // Imports: the runtime first, then sibling generated types, then functions the config references.
    const libraryTypeImports: string[] = [];
    if (record) {
        libraryTypeImports.push('EntityCreate', 'EntityPatch', 'QueryConfig');
        if (record.repository) {
            lines.push(`import { RecordSet } from '${libraryModule}';`);
            libraryTypeImports.push('QueryConfigSource', 'RecordSetOptions');
        }
        lines.push(`import type { ${libraryTypeImports.sort().join(', ')} } from '${libraryModule}';`);
    }
    const siblingImports = Array.from(new Set(options.imports)).filter((name) => name !== className).sort();
    for (const name of siblingImports) {
        lines.push(`import type { ${name} } from './${name}.gen';`);
    }

    let configLiteral: string | undefined;
    if (record) {
        const identifierByFunction = new Map(record.functionImports.map((entry) => [entry.fn, entry.identifier]));
        configLiteral = serializeToTypeScriptLiteral(record.config, { functionReferences: identifierByFunction });
        const importsByPath = new Map<string, string[]>();
        for (const entry of record.functionImports) {
            if (isIdentifierReferenced(configLiteral, entry.identifier)) {
                const specifier = entry.identifier === entry.exportName ? entry.identifier : `${entry.exportName} as ${entry.identifier}`;
                importsByPath.set(entry.importPath, [...(importsByPath.get(entry.importPath) ?? []), specifier]);
            }
        }
        for (const [importPath, specifiers] of Array.from(importsByPath.entries()).sort(([left], [right]) => left.localeCompare(right))) {
            lines.push(`import { ${specifiers.sort().join(', ')} } from '${importPath}';`);
        }
    }
    if (lines.length > 1) {
        lines.push('');
    }

    const extendsClause = options.baseClassName ? ` extends ${options.baseClassName}` : '';
    lines.push(`export interface ${className}${extendsClause} {`);
    for (const member of options.members) {
        lines.push(`    ${member.name}${member.optional ? '?' : ''}: ${member.typeText};`);
    }
    lines.push('}');

    if (record && configLiteral !== undefined) {
        lines.push('', `/** What \`update()\` takes for a ${className}: a deep partial; subrecords merge, sublists take { update, add, remove }. */`);
        lines.push(`export type ${className}Patch = EntityPatch<${className}>;`);
        lines.push(`/** What \`create()\` takes for a ${className}: a deep partial with sublists as arrays of partial lines. */`);
        lines.push(`export type ${className}Create = EntityCreate<${className}>;`);
        lines.push('', `export const ${className}Config: QueryConfig<${className}> = ${configLiteral};`);
        lines.push('', `/** Field paths of ${className}, for where(), orderBy(), and select(): \`${className}Fields.<property>\` at any depth. */`);
        lines.push(`export const ${className}Fields = {`, ...renderFieldTree(record.fields, '    '), '} as const;');
        if (record.repository) {
            lines.push(
                '',
                `/** Base repository for ${className}. Extend it with domain queries and register the subclass through the context factory's 'repositories' option. */`,
                `export class ${className}RepositoryBase extends RecordSet<${className}> {`,
                `    constructor(source: QueryConfigSource<${className}> = ${className}Config, options?: RecordSetOptions) {`,
                '        super(source, options);',
                '    }',
                '}',
            );
        }
    }

    lines.push('');
    return lines.join('\n');
}
