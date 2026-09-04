import { buildGeneratedFileHeader } from './header';

export interface ContextModelReference {
    modelName: string;
    setName: string;
    /** Import paths (extension-less, relative) of the generated config and repository files. */
    configImportPath: string;
    repositoryImportPath: string;
}

export interface ContextFileEmitOptions {
    contextName: string;
    models: ContextModelReference[];
    libraryModule: string;
    version?: string;
}

/** Emits `context.gen.ts`: the schema, the generated base repositories, the context type, and a factory that accepts repository subclasses. */
export function emitContextFile(options: ContextFileEmitOptions): string {
    const sortedModels = [...options.models].sort((left, right) => left.setName.localeCompare(right.setName));
    const { contextName } = options;
    return [
        buildGeneratedFileHeader(`${contextName} context wiring every generated model.`, options.version),
        `import { createNetSuiteContext } from '${options.libraryModule}';`,
        `import type { ContextFactoryOptions, MergeRepositories, NetSuiteContextInstance, RepositoryMap } from '${options.libraryModule}';`,
        ...sortedModels.map((model) => `import { ${model.modelName}Config } from '${model.configImportPath}';`),
        ...sortedModels.map((model) => `import { ${model.modelName}RepositoryBase } from '${model.repositoryImportPath}';`),
        '',
        `export const ${contextName}Schema = {`,
        ...sortedModels.map((model) => `    ${model.setName}: ${model.modelName}Config,`),
        '};',
        '',
        '/** The generated base repositories. A subclass passed to the factory replaces the base for its set. */',
        `export const ${contextName}Repositories = {`,
        ...sortedModels.map((model) => `    ${model.setName}: ${model.modelName}RepositoryBase,`),
        '};',
        '',
        `export type ${contextName}RepositoryMap = RepositoryMap<typeof ${contextName}Schema>;`,
        '',
        `export type ${contextName}Context<TRepositories extends ${contextName}RepositoryMap = {}> = NetSuiteContextInstance<typeof ${contextName}Schema, MergeRepositories<typeof ${contextName}Repositories, TRepositories>>;`,
        '',
        `export function create${contextName}Context<TRepositories extends ${contextName}RepositoryMap = {}>(options: ContextFactoryOptions<TRepositories> = {}): ${contextName}Context<TRepositories> {`,
        `    return createNetSuiteContext(${contextName}Schema, { ...options, repositories: { ...${contextName}Repositories, ...options.repositories } }) as unknown as ${contextName}Context<TRepositories>;`,
        '}',
        '',
    ].join('\n');
}
