import type { QueryConfig } from '../../src/types';
import { buildGeneratedFileHeader } from './header';
import { serializeToTypeScriptLiteral } from './serialize';

export interface ConfigFileEmitOptions {
    modelName: string;
    config: QueryConfig<unknown>;
    libraryModule: string;
    /** Import path (extension-less, relative) of the generated type file. */
    typesImportPath: string;
    /** Functions the config may reference, each with the identifier to emit and where to import it from. */
    functionImports: FunctionImport[];
    version?: string;
}

export interface FunctionImport {
    fn: Function;
    identifier: string;
    exportName: string;
    /** Import path (extension-less, relative to the output directory). */
    importPath: string;
}

function isIdentifierReferenced(literal: string, identifier: string): boolean {
    return new RegExp(`(^|[^A-Za-z0-9_$])${identifier}([^A-Za-z0-9_$]|$)`).test(literal);
}

/** Emits `<Model>.config.gen.ts`: the plain QueryConfig literal the runtime imports. */
export function emitConfigFile(options: ConfigFileEmitOptions): string {
    const identifierByFunction = new Map(options.functionImports.map((entry) => [entry.fn, entry.identifier]));
    const literal = serializeToTypeScriptLiteral(options.config, { functionReferences: identifierByFunction });
    const importsByPath = new Map<string, string[]>();
    for (const entry of options.functionImports) {
        if (isIdentifierReferenced(literal, entry.identifier)) {
            const specifier = entry.identifier === entry.exportName ? entry.identifier : `${entry.exportName} as ${entry.identifier}`;
            importsByPath.set(entry.importPath, [...(importsByPath.get(entry.importPath) ?? []), specifier]);
        }
    }

    const lines = [
        buildGeneratedFileHeader(`Query and record configuration for the ${options.modelName} model.`, options.version),
        `import type { QueryConfig } from '${options.libraryModule}';`,
        `import type { ${options.modelName} } from '${options.typesImportPath}';`,
    ];
    for (const [importPath, specifiers] of Array.from(importsByPath.entries()).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`import { ${specifiers.sort().join(', ')} } from '${importPath}';`);
    }
    lines.push('', `export const ${options.modelName}Config: QueryConfig<${options.modelName}> = ${literal};`, '');
    return lines.join('\n');
}
