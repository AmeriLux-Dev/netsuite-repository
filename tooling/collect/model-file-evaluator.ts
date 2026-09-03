import * as nodePath from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import type { EntityModelMetadata } from '../../src/model';
import type { FileSystemAdapter } from '../file-system';

export interface ModelFileDiagnostic {
    filePath: string;
    message: string;
    exportName?: string;
}

export interface CollectedModel {
    filePath: string;
    exportName: string;
    /** Class name for decorated classes; export name without a trailing `Model`/`Definition` for fluent definitions. */
    modelName: string;
    source: 'class' | 'definition';
    metadata: EntityModelMetadata;
}

/** Where an exported function lives, so transforms can be emitted as imports by name. */
export interface FunctionReference {
    exportName: string;
    filePath: string;
}

/** The subset of the runtime the evaluator relies on. Passed in so the sandbox shares the caller's module instance. */
export interface RuntimeModelApi {
    isRootEntityClass(value: unknown): boolean;
    isEntityModelDefinition(value: unknown): value is { buildMetadata(): EntityModelMetadata };
    resolveDecoratedEntityMetadata(entityClass: Function): EntityModelMetadata;
}

export interface EvaluateModelFilesOptions {
    filePaths: string[];
    fileSystem: FileSystemAdapter;
    /** Module specifier that resolves to the runtime inside model files, e.g. '@amerilux/netsuite-repository'. */
    libraryModule: string;
    /** The loaded runtime module object handed to model files when they import the library. */
    runtimeModule: object;
    runtimeApi: RuntimeModelApi;
}

export interface EvaluateModelFilesResult {
    models: CollectedModel[];
    diagnostics: ModelFileDiagnostic[];
    /** Every function exported by any evaluated module (model files and their relative imports). */
    functionReferences: Map<Function, FunctionReference>;
}

const transpileOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    esModuleInterop: true,
};

class ModelImportError extends Error {}

function stripDefinitionSuffix(exportName: string): string {
    const stripped = exportName.replace(/(Model|Definition)$/, '');
    return stripped === '' ? exportName : stripped;
}

function resolveRelativeModelFile(fileSystem: FileSystemAdapter, importingFile: string, specifier: string): string | undefined {
    const base = nodePath.resolve(nodePath.dirname(importingFile), specifier.replace(/\.js$/, ''));
    const candidates = [base, `${base}.ts`, nodePath.join(base, 'index.ts')];
    return candidates.find((candidate) => candidate.endsWith('.ts') && fileSystem.fileExists(candidate));
}

/**
 * Transpiles and runs model files in a sandbox whose `require` only knows the library and relative model files.
 * Decorated classes and fluent definitions register themselves through the shared runtime instance.
 */
export function evaluateModelFiles(options: EvaluateModelFilesOptions): EvaluateModelFilesResult {
    const { fileSystem, libraryModule, runtimeModule, runtimeApi } = options;
    const moduleCache = new Map<string, { exports: Record<string, unknown> }>();
    const diagnostics: ModelFileDiagnostic[] = [];
    const models: CollectedModel[] = [];

    const loadModelModule = (filePath: string): Record<string, unknown> => {
        const cached = moduleCache.get(filePath);
        if (cached) {
            return cached.exports;
        }

        const moduleRecord = { exports: {} as Record<string, unknown> };
        moduleCache.set(filePath, moduleRecord);

        const source = fileSystem.readTextFile(filePath);
        const transpiled = ts.transpileModule(source, { compilerOptions: transpileOptions, fileName: filePath }).outputText;
        const sandboxRequire = (specifier: string): unknown => {
            if (specifier === libraryModule || specifier.startsWith(`${libraryModule}/`)) {
                return runtimeModule;
            }
            if (specifier.startsWith('.')) {
                const resolved = resolveRelativeModelFile(fileSystem, filePath, specifier);
                if (!resolved) {
                    throw new ModelImportError(`Cannot resolve relative import '${specifier}' from '${filePath}'.`);
                }
                return loadModelModule(resolved);
            }
            throw new ModelImportError(`Model files may only import '${libraryModule}' or relative model files; found '${specifier}'.`);
        };

        const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${transpiled}\n})`, { filename: filePath });
        wrapper(moduleRecord.exports, sandboxRequire, moduleRecord, filePath, nodePath.dirname(filePath));
        return moduleRecord.exports;
    };

    for (const filePath of options.filePaths) {
        let exports: Record<string, unknown>;
        try {
            exports = loadModelModule(filePath);
        } catch (error) {
            diagnostics.push({ filePath, message: error instanceof Error ? error.message : String(error) });
            continue;
        }

        for (const [exportName, value] of Object.entries(exports)) {
            try {
                if (runtimeApi.isRootEntityClass(value)) {
                    const entityClass = value as Function;
                    models.push({ filePath, exportName, modelName: entityClass.name, source: 'class', metadata: runtimeApi.resolveDecoratedEntityMetadata(entityClass) });
                } else if (runtimeApi.isEntityModelDefinition(value)) {
                    models.push({ filePath, exportName, modelName: stripDefinitionSuffix(exportName), source: 'definition', metadata: value.buildMetadata() });
                }
            } catch (error) {
                diagnostics.push({ filePath, exportName, message: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    const functionReferences = new Map<Function, FunctionReference>();
    for (const [modulePath, moduleRecord] of moduleCache) {
        for (const [exportName, value] of Object.entries(moduleRecord.exports)) {
            if (typeof value === 'function' && !runtimeApi.isRootEntityClass(value) && !functionReferences.has(value)) {
                functionReferences.set(value, { exportName, filePath: modulePath });
            }
        }
    }

    return { models, diagnostics, functionReferences };
}
