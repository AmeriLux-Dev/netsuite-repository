import { buildGeneratedFileHeader } from './header';

export interface RepositoryFileEmitOptions {
    modelName: string;
    libraryModule: string;
    /** Import paths (extension-less, relative) of the generated config and type files. */
    configImportPath: string;
    typesImportPath: string;
    version?: string;
}

/**
 * Emits `<Model>.repository.gen.ts`: the base repository of one record type, a RecordSet bound to the generated
 * config. Consumers extend it with domain queries and register the subclass with the context factory.
 */
export function emitRepositoryFile(options: RepositoryFileEmitOptions): string {
    const { modelName, libraryModule } = options;
    return [
        buildGeneratedFileHeader(`Base repository for the ${modelName} model. Extend it with domain queries and register the subclass through the context factory's 'repositories' option.`, options.version),
        `import { RecordSet } from '${libraryModule}';`,
        `import type { QueryConfigSource, RecordSetOptions } from '${libraryModule}';`,
        `import { ${modelName}Config } from '${options.configImportPath}';`,
        `import type { ${modelName} } from '${options.typesImportPath}';`,
        '',
        `export class ${modelName}RepositoryBase extends RecordSet<${modelName}> {`,
        `    constructor(source: QueryConfigSource<${modelName}> = ${modelName}Config, options?: RecordSetOptions) {`,
        '        super(source, options);',
        '    }',
        '}',
        '',
    ].join('\n');
}
