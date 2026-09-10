import * as nodePath from 'path';
import type { FileSystemAdapter } from './file-system';

export interface BuildConfig {
    /** Globs (relative to the config file's directory) selecting model files. Patterns starting with `!` exclude. */
    models: string[];
    /** Directory (relative to the config file's directory) receiving the generated files. */
    outDir: string;
    context: {
        /** Prefix for the generated context: `AppSchema`, `AppContext`, `createAppContext()`. The unit-of-work names `UnitOfWork` and `openUnitOfWork()` carry no prefix. */
        name: string;
        fileName: string;
    };
    /** Optional tsconfig path (relative to the config file's directory) used to type-check model files; defaults to sensible compiler options. */
    tsconfig?: string;
    /** Module specifier model files import the library from, and generated files import the runtime from. */
    libraryModule: string;
    /**
     * 'classes' also emits a base repository class per record type and lets the context factory accept subclasses.
     * 'none' (default) emits only the configs, types, and context; queries live in modules of functions that take the context.
     */
    repositories: 'classes' | 'none';
}

/** A loaded build config plus the directory its relative paths resolve against. */
export interface ResolvedBuildConfig extends BuildConfig {
    /** The config file's directory, or the working directory when no config file exists and the defaults apply. */
    rootDirectory: string;
}

export const DEFAULT_BUILD_CONFIG_FILE_NAME = 'netsuite-repository.config.json';

export const defaultBuildConfig: BuildConfig = {
    models: ['src/models/**/*.ts'],
    outDir: 'src/repositories/generated',
    context: { name: 'App', fileName: 'context.gen.ts' },
    libraryModule: '@amerilux/netsuite-repository',
    repositories: 'none',
};

export class BuildConfigError extends Error {
    constructor(public readonly configPath: string, public readonly problems: string[]) {
        super(`Build config '${configPath}' is invalid:\n - ${problems.join('\n - ')}`);
        this.name = 'BuildConfigError';
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateBuildConfig(raw: Record<string, unknown>, configPath: string): BuildConfig {
    const problems: string[] = [];
    const config: BuildConfig = {
        ...defaultBuildConfig,
        context: { ...defaultBuildConfig.context },
    };

    if (raw.models !== undefined) {
        if (isStringArray(raw.models) && raw.models.length > 0) {
            config.models = raw.models;
        } else {
            problems.push("'models' must be a non-empty array of glob strings.");
        }
    }
    if (raw.outDir !== undefined) {
        if (typeof raw.outDir === 'string' && raw.outDir.trim() !== '') {
            config.outDir = raw.outDir;
        } else {
            problems.push("'outDir' must be a non-empty string.");
        }
    }
    if (raw.context !== undefined) {
        const context = raw.context as Record<string, unknown> | null;
        if (!context || typeof context !== 'object') {
            problems.push("'context' must be an object.");
        } else {
            if (context.name !== undefined) {
                if (typeof context.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(context.name)) {
                    config.context.name = context.name;
                } else {
                    problems.push("'context.name' must be a valid identifier.");
                }
            }
            if (context.fileName !== undefined) {
                if (typeof context.fileName === 'string' && context.fileName.endsWith('.ts')) {
                    config.context.fileName = context.fileName;
                } else {
                    problems.push("'context.fileName' must end with '.ts'.");
                }
            }
        }
    }
    if (raw.tsconfig !== undefined) {
        if (typeof raw.tsconfig === 'string') {
            config.tsconfig = raw.tsconfig;
        } else {
            problems.push("'tsconfig' must be a string path.");
        }
    }
    if (raw.libraryModule !== undefined) {
        if (typeof raw.libraryModule === 'string' && raw.libraryModule.trim() !== '') {
            config.libraryModule = raw.libraryModule;
        } else {
            problems.push("'libraryModule' must be a non-empty string.");
        }
    }

    if (raw.repositories !== undefined) {
        if (raw.repositories === 'classes' || raw.repositories === 'none') {
            config.repositories = raw.repositories;
        } else {
            problems.push("'repositories' must be 'classes' or 'none'.");
        }
    }

    if (problems.length > 0) {
        throw new BuildConfigError(configPath, problems);
    }
    return config;
}

/**
 * Loads the build config from disk, falling back to defaults when no config file exists.
 * Relative paths inside the config resolve against the config file's directory, so `--config examples/netsuite-repository.config.json` works from anywhere.
 */
export function loadBuildConfig(fileSystem: FileSystemAdapter, cwd: string, configPath?: string): ResolvedBuildConfig {
    const resolvedPath = nodePath.resolve(cwd, configPath ?? DEFAULT_BUILD_CONFIG_FILE_NAME);

    if (!fileSystem.fileExists(resolvedPath)) {
        if (configPath !== undefined) {
            throw new BuildConfigError(resolvedPath, ['file does not exist.']);
        }
        return { ...defaultBuildConfig, context: { ...defaultBuildConfig.context }, rootDirectory: cwd };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(fileSystem.readTextFile(resolvedPath));
    } catch (error) {
        throw new BuildConfigError(resolvedPath, [`could not parse JSON: ${error instanceof Error ? error.message : String(error)}`]);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BuildConfigError(resolvedPath, ['top-level value must be an object.']);
    }

    return { ...validateBuildConfig(raw as Record<string, unknown>, resolvedPath), rootDirectory: nodePath.dirname(resolvedPath) };
}
