import { buildGeneratedFileHeader } from './header';

export interface ContextModelReference {
    modelName: string;
    setName: string;
    /** Import path (extension-less, relative) of the generated config file. */
    configImportPath: string;
}

export interface ContextFileEmitOptions {
    contextName: string;
    models: ContextModelReference[];
    libraryModule: string;
    version?: string;
}

/** Emits `context.gen.ts`: the schema object, the context type, and a factory. */
export function emitContextFile(options: ContextFileEmitOptions): string {
    const sortedModels = [...options.models].sort((left, right) => left.setName.localeCompare(right.setName));
    const { contextName } = options;
    return [
        buildGeneratedFileHeader(`${contextName} context wiring every generated model.`, options.version),
        `import { createNetSuiteContext } from '${options.libraryModule}';`,
        `import type { NetSuiteContextInstance, NetSuiteContextOptions } from '${options.libraryModule}';`,
        ...sortedModels.map((model) => `import { ${model.modelName}Config } from '${model.configImportPath}';`),
        '',
        `export const ${contextName}Schema = {`,
        ...sortedModels.map((model) => `    ${model.setName}: ${model.modelName}Config,`),
        '};',
        '',
        `export type ${contextName}Context = NetSuiteContextInstance<typeof ${contextName}Schema>;`,
        '',
        `export function create${contextName}Context(options?: NetSuiteContextOptions): ${contextName}Context {`,
        `    return createNetSuiteContext(${contextName}Schema, options);`,
        '}',
        '',
    ].join('\n');
}
