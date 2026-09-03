import * as nodePath from 'path';
import type * as ts from 'typescript';
import * as runtime from '../src';
import { compileEntityModel } from '../src/model';
import type { EntityModelMetadata, PropertyMetadata } from '../src/model';
import type { FieldType } from '../src/types';
import { evaluateModelFiles } from './collect/model-file-evaluator';
import type { CollectedModel, ModelFileDiagnostic } from './collect/model-file-evaluator';
import { createModelTypeProgram, readCompilerOptionsFromTsconfig, readModelTypes } from './collect/property-type-reader';
import type { ModelTypeInfo, ModelTypeShape } from './collect/property-type-reader';
import type { BuildConfig } from './config';
import { emitConfigFile } from './emit/config-file-emitter';
import type { FunctionImport } from './emit/config-file-emitter';
import { emitContextFile } from './emit/context-file-emitter';
import { emitTypeFile } from './emit/type-file-emitter';
import { resolveGlobs, toPosixPath } from './file-system';
import type { FileSystemAdapter } from './file-system';

export interface GenerateOptions {
    config: BuildConfig;
    cwd: string;
    fileSystem: FileSystemAdapter;
    /** Extra compiler options merged over the tsconfig (or defaults); tests use `paths` to resolve the library. */
    compilerOptions?: ts.CompilerOptions;
    version?: string;
}

export interface PlannedFile {
    path: string;
    content: string;
}

export interface GeneratedModelSummary {
    modelName: string;
    setName: string;
    filePath: string;
    source: 'class' | 'definition';
}

export interface GenerationPlan {
    files: PlannedFile[];
    models: GeneratedModelSummary[];
    diagnostics: ModelFileDiagnostic[];
}

export interface GenerateResult extends GenerationPlan {
    writtenFiles: string[];
    unchangedFiles: string[];
}

export interface CheckResult extends GenerationPlan {
    driftedFiles: string[];
    missingFiles: string[];
}

export function toEntitySetName(modelName: string): string {
    const camel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    if (/[^aeiou]y$/i.test(camel)) return `${camel.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(camel)) return `${camel}es`;
    return `${camel}s`;
}

function toImportPath(fromDirectory: string, toFile: string): string {
    const relative = toPosixPath(nodePath.relative(fromDirectory, toFile)).replace(/\.ts$/, '');
    return relative.startsWith('.') ? relative : `./${relative}`;
}

function inferFieldTypeFromShape(shape: ModelTypeShape | undefined, property: PropertyMetadata, isKey: boolean): FieldType | undefined {
    const typeInfo = shape?.properties.find((candidate) => candidate.name === property.name);
    if (!typeInfo?.fieldType) {
        return undefined;
    }
    return isKey && typeInfo.fieldType === 'float' ? 'integer' : typeInfo.fieldType;
}

/** Gives every exported function a unique identifier for generated imports; same-named exports from different files are aliased. */
function buildFunctionImports(functionReferences: Map<Function, { exportName: string; filePath: string }>, outDir: string): FunctionImport[] {
    const usedIdentifiers = new Set<string>();
    const imports: FunctionImport[] = [];
    for (const [fn, reference] of functionReferences) {
        let identifier = reference.exportName;
        let suffix = 2;
        while (usedIdentifiers.has(identifier)) {
            identifier = `${reference.exportName}_${suffix++}`;
        }
        usedIdentifiers.add(identifier);
        imports.push({ fn, identifier, exportName: reference.exportName, importPath: toImportPath(outDir, reference.filePath) });
    }
    return imports;
}

/** Fills missing field types on the metadata from the declared TypeScript types; reports properties that cannot be mapped. */
function applyDeclaredTypes(model: CollectedModel, types: ModelTypeInfo | undefined, diagnostics: ModelFileDiagnostic[]): EntityModelMetadata {
    const metadata = model.metadata;
    const keyProperty = metadata.keyProperty ?? 'id';
    const shapesByName = new Map(types?.nested.map((shape) => [shape.name, shape]) ?? []);

    const fill = (property: PropertyMetadata, shape: ModelTypeShape | undefined, owner: string, isKey: boolean) => {
        if (property.type !== undefined) {
            return;
        }
        const inferred = inferFieldTypeFromShape(shape, property, isKey);
        if (inferred) {
            property.type = inferred;
        } else if (!isKey) {
            const typeText = shape?.properties.find((candidate) => candidate.name === property.name)?.typeText ?? 'unknown';
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: `Property '${owner}.${property.name}' has type '${typeText}', which does not map to a NetSuite field type. Declare it with @Column({ type }) or hasType().` });
        }
    };

    for (const property of metadata.properties.values()) {
        if (!metadata.ignoredProperties.has(property.name)) {
            fill(property, types?.root, model.modelName, property.name === keyProperty);
        }
    }

    for (const navigation of metadata.navigations.values()) {
        const rootProperty = types?.root.properties.find((candidate) => candidate.name === navigation.name);
        const nestedShape = rootProperty?.nestedShapeName ? shapesByName.get(rootProperty.nestedShapeName) : undefined;
        for (const property of navigation.properties.values()) {
            fill(property, nestedShape, `${model.modelName}.${navigation.name}`, false);
        }
    }

    return metadata;
}

function resolveCompilerOptions(options: GenerateOptions): ts.CompilerOptions {
    const fromTsconfig = options.config.tsconfig ? readCompilerOptionsFromTsconfig(nodePath.resolve(options.cwd, options.config.tsconfig)) : {};
    return { ...fromTsconfig, ...(options.compilerOptions ?? {}) };
}

/** Computes every generated file without touching disk. */
export function planGeneration(options: GenerateOptions): GenerationPlan {
    const { config, cwd, fileSystem } = options;
    const outDir = nodePath.resolve(cwd, config.outDir);
    const modelFiles = resolveGlobs(fileSystem, cwd, config.models);
    const evaluation = evaluateModelFiles({
        filePaths: modelFiles,
        fileSystem,
        libraryModule: config.libraryModule,
        runtimeModule: runtime,
        runtimeApi: runtime,
    });
    const diagnostics = [...evaluation.diagnostics];
    if (modelFiles.length === 0) {
        diagnostics.push({ filePath: cwd, message: `No model files matched the 'models' globs (${config.models.join(', ')}) under '${cwd}'. Check 'models' in the build config.` });
    }
    const functionImports = buildFunctionImports(evaluation.functionReferences, outDir);
    const files: PlannedFile[] = [];
    const models: GeneratedModelSummary[] = [];
    const program = evaluation.models.length > 0 ? createModelTypeProgram(modelFiles, resolveCompilerOptions(options)) : undefined;
    const seenModelNames = new Map<string, string>();

    for (const model of evaluation.models) {
        const previousFile = seenModelNames.get(model.modelName);
        if (previousFile) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: `Model name '${model.modelName}' is already used in '${previousFile}'.` });
            continue;
        }
        seenModelNames.set(model.modelName, model.filePath);

        const types = program ? readModelTypes(program, model.filePath, model.exportName, model.modelName) : undefined;
        if (!types) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: `Could not read the TypeScript declaration of '${model.exportName}'.` });
            continue;
        }

        const metadata = applyDeclaredTypes(model, types, diagnostics);
        let compiledConfig;
        try {
            compiledConfig = compileEntityModel(metadata);
        } catch (error) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: error instanceof Error ? error.message : String(error) });
            continue;
        }

        const typesFilePath = nodePath.join(outDir, `${model.modelName}.types.gen.ts`);
        const configFilePath = nodePath.join(outDir, `${model.modelName}.config.gen.ts`);
        try {
            files.push({ path: typesFilePath, content: emitTypeFile({ modelName: model.modelName, types, libraryModule: config.libraryModule, version: options.version }) });
            files.push({
                path: configFilePath,
                content: emitConfigFile({
                    modelName: model.modelName,
                    config: compiledConfig,
                    libraryModule: config.libraryModule,
                    typesImportPath: toImportPath(outDir, typesFilePath),
                    functionImports,
                    version: options.version,
                }),
            });
        } catch (error) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: error instanceof Error ? error.message : String(error) });
            continue;
        }

        models.push({ modelName: model.modelName, setName: metadata.setName ?? toEntitySetName(model.modelName), filePath: model.filePath, source: model.source });
    }

    if (models.length > 0) {
        files.push({
            path: nodePath.join(outDir, config.context.fileName),
            content: emitContextFile({
                contextName: config.context.name,
                libraryModule: config.libraryModule,
                version: options.version,
                models: models.map((model) => ({ modelName: model.modelName, setName: model.setName, configImportPath: `./${model.modelName}.config.gen` })),
            }),
        });
    }

    return { files, models, diagnostics };
}

/** Writes the generated files, skipping any whose content is unchanged. */
export function runGenerate(options: GenerateOptions): GenerateResult {
    const plan = planGeneration(options);
    const writtenFiles: string[] = [];
    const unchangedFiles: string[] = [];

    for (const file of plan.files) {
        const existing = options.fileSystem.fileExists(file.path) ? options.fileSystem.readTextFile(file.path) : undefined;
        if (existing === file.content) {
            unchangedFiles.push(file.path);
            continue;
        }
        options.fileSystem.ensureDirectory(nodePath.dirname(file.path));
        options.fileSystem.writeTextFile(file.path, file.content);
        writtenFiles.push(file.path);
    }

    return { ...plan, writtenFiles, unchangedFiles };
}

/** Compares the generated files on disk with what generation would produce, without writing. */
export function checkGenerated(options: GenerateOptions): CheckResult {
    const plan = planGeneration(options);
    const driftedFiles: string[] = [];
    const missingFiles: string[] = [];

    for (const file of plan.files) {
        if (!options.fileSystem.fileExists(file.path)) {
            missingFiles.push(file.path);
        } else if (options.fileSystem.readTextFile(file.path) !== file.content) {
            driftedFiles.push(file.path);
        }
    }

    return { ...plan, driftedFiles, missingFiles };
}
