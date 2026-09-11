import type { QueryConfig } from '../../src/types';
import { buildGeneratedFileHeader } from './header';
import { serializeToTypeScriptLiteral } from './serialize';

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

export interface ModelFileEmitOptions {
    className: string;
    libraryModule: string;
    /** Import path (extension-less, relative to the output directory) of the types file holding the class's interface. */
    typesImportPath: string;
    config: QueryConfig<unknown>;
    functionImports: FunctionImport[];
    fields: FieldPathTree;
    /** Also emit `<Model>RepositoryBase`, a RecordSet bound to the config. */
    repository: boolean;
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
 * Emits `<Class>.gen.ts`, the runtime side of one record type: the `<Class>Config` literal, the `<Class>Fields` paths,
 * and, when asked for, the `<Class>RepositoryBase` class. The interface and helper types live in the types file; this
 * file imports the interface from there and re-exports the three, so a server module can import everything from one place.
 */
export function emitModelFile(options: ModelFileEmitOptions): string {
    const { className, libraryModule, typesImportPath } = options;
    const lines: string[] = [];
    const parts = ['config', 'field paths'];
    if (options.repository) parts.push('base repository');
    lines.push(buildGeneratedFileHeader(`Generated ${parts.join(', ')} for the ${className} model.`, options.version));

    // Imports: the runtime first, then the interface from the types file, then functions the config references.
    const libraryTypeImports = ['QueryConfig'];
    if (options.repository) {
        lines.push(`import { RecordSet } from '${libraryModule}';`);
        libraryTypeImports.push('QueryConfigSource', 'RecordSetOptions');
    }
    lines.push(`import type { ${libraryTypeImports.sort().join(', ')} } from '${libraryModule}';`);
    lines.push(`import type { ${className} } from '${typesImportPath}';`);

    const identifierByFunction = new Map(options.functionImports.map((entry) => [entry.fn, entry.identifier]));
    const configLiteral = serializeToTypeScriptLiteral(options.config, { functionReferences: identifierByFunction });
    const importsByPath = new Map<string, string[]>();
    for (const entry of options.functionImports) {
        if (isIdentifierReferenced(configLiteral, entry.identifier)) {
            const specifier = entry.identifier === entry.exportName ? entry.identifier : `${entry.exportName} as ${entry.identifier}`;
            importsByPath.set(entry.importPath, [...(importsByPath.get(entry.importPath) ?? []), specifier]);
        }
    }
    for (const [importPath, specifiers] of Array.from(importsByPath.entries()).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`import { ${specifiers.sort().join(', ')} } from '${importPath}';`);
    }

    lines.push('', `export type { ${className}, ${className}Create, ${className}Patch } from '${typesImportPath}';`);
    lines.push('', `export const ${className}Config: QueryConfig<${className}> = ${configLiteral};`);
    lines.push('', `/** Field paths of ${className}, for where(), orderBy(), and select(): \`${className}Fields.<property>\` at any depth. */`);
    lines.push(`export const ${className}Fields = {`, ...renderFieldTree(options.fields, '    '), '} as const;');
    if (options.repository) {
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

    lines.push('');
    return lines.join('\n');
}
