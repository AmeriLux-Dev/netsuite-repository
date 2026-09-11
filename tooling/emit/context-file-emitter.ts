import { buildGeneratedFileHeader } from './header';

export interface ContextModelReference {
    modelName: string;
    setName: string;
    /** Import path (extension-less, relative) of the model's generated file. */
    importPath: string;
}

export interface ContextFileEmitOptions {
    contextName: string;
    models: ContextModelReference[];
    libraryModule: string;
    /** Wire the generated base repositories and accept subclasses through the factory's `repositories` option. */
    repositories: boolean;
    version?: string;
}

/** Emits `context.gen.ts`: the schema, the context type, and a factory; with repositories, also the generated bases and the option to swap in subclasses. */
export function emitContextFile(options: ContextFileEmitOptions): string {
    const sortedModels = [...options.models].sort((left, right) => left.setName.localeCompare(right.setName));
    const { contextName, libraryModule } = options;
    const header = buildGeneratedFileHeader(`${contextName} context wiring every generated model.`, options.version);
    const schema = [
        `export const ${contextName}Schema = {`,
        ...sortedModels.map((model) => `    ${model.setName}: ${model.modelName}Config,`),
        '};',
    ];

    if (!options.repositories) {
        return [
            header,
            `import { createNetSuiteContext } from '${libraryModule}';`,
            `import type { NetSuiteContextInstance, NetSuiteContextOptions } from '${libraryModule}';`,
            ...sortedModels.map((model) => `import { ${model.modelName}Config } from '${model.importPath}';`),
            '',
            ...schema,
            '',
            `export type ${contextName}Context = NetSuiteContextInstance<typeof ${contextName}Schema>;`,
            '',
            `export function create${contextName}Context(options?: NetSuiteContextOptions): ${contextName}Context {`,
            `    return createNetSuiteContext(${contextName}Schema, options);`,
            '}',
            '',
        ].join('\n');
    }

    return [
        header,
        `import { createNetSuiteContext } from '${libraryModule}';`,
        `import type { ContextFactoryOptions, MergeRepositories, NetSuiteContextInstance, RepositoryMap } from '${libraryModule}';`,
        ...sortedModels.map((model) => `import { ${model.modelName}Config, ${model.modelName}RepositoryBase } from '${model.importPath}';`),
        '',
        ...schema,
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
