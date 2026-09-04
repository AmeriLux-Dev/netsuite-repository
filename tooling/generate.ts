import * as nodePath from 'path';
import type * as ts from 'typescript';
import * as runtime from '../src';
import { evaluateModelFiles } from './collect/model-file-evaluator';
import type { ModelFileDiagnostic } from './collect/model-file-evaluator';
import { resolveModels } from './collect/model-resolver';
import type { ResolvedClass, ResolvedRelation } from './collect/model-resolver';
import { classKeyOf, createModelTypeProgram, readCompilerOptionsFromTsconfig, readDeclaredClass } from './collect/property-type-reader';
import type { DeclaredClass } from './collect/property-type-reader';
import { compileModel } from './compile/compile-model';
import type { BuildConfig } from './config';
import { emitConfigFile } from './emit/config-file-emitter';
import type { FunctionImport } from './emit/config-file-emitter';
import { emitContextFile } from './emit/context-file-emitter';
import { emitRepositoryFile } from './emit/repository-file-emitter';
import { emitFieldsFile } from './emit/fields-file-emitter';
import type { FieldPathTree } from './emit/fields-file-emitter';
import { emitTypeFile } from './emit/type-file-emitter';
import type { TypeFileMember } from './emit/type-file-emitter';
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
}

export interface GenerationPlan {
    files: PlannedFile[];
    /** Record types, which own a config, a base repository, and a record set. Plain classes only get a type file. */
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

export function toRecordSetName(modelName: string): string {
    const camel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    if (/[^aeiou]y$/i.test(camel)) return `${camel.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(camel)) return `${camel}es`;
    return `${camel}s`;
}

function toImportPath(fromDirectory: string, toFile: string): string {
    const relative = toPosixPath(nodePath.relative(fromDirectory, toFile)).replace(/\.ts$/, '');
    return relative.startsWith('.') ? relative : `./${relative}`;
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

function resolveCompilerOptions(options: GenerateOptions): ts.CompilerOptions {
    const fromTsconfig = options.config.tsconfig ? readCompilerOptionsFromTsconfig(nodePath.resolve(options.cwd, options.config.tsconfig)) : {};
    return { ...fromTsconfig, ...(options.compilerOptions ?? {}) };
}

/** The TypeScript text of a reference, subrecord, or sublist member: the target interface, projected with Pick when the declaration projected it. */
function relationTypeText(relation: ResolvedRelation, target: ResolvedClass | undefined): string {
    const mappedNames = target ? [...target.fields.map((field) => field.name), ...target.relations.map((nested) => nested.name)] : [];
    const projected = relation.projection === 'all' ? undefined : relation.projection.filter((name) => mappedNames.includes(name));
    const base = projected && projected.length > 0 && projected.length < mappedNames.length
        ? `Pick<${relation.targetClassName}, ${projected.map((name) => `'${name}'`).join(' | ')}>`
        : relation.targetClassName;
    return relation.kind === 'sublist' ? `${base}[]` : base;
}

/** The field paths of a record type, nested by relation, for the generated fields constant. */
function buildFieldPathTree(fields: Array<{ name: string }>, relations: ResolvedRelation[], prefix = ''): FieldPathTree {
    const tree: FieldPathTree = {};
    for (const field of fields) {
        tree[field.name] = `${prefix}${field.name}`;
    }
    for (const relation of relations) {
        tree[relation.name] = buildFieldPathTree(relation.fields, relation.relations, `${prefix}${relation.name}.`);
    }
    return tree;
}

function buildTypeFileMembers(model: ResolvedClass, classesByName: Map<string, ResolvedClass>): { members: TypeFileMember[]; imports: string[] } {
    const members: TypeFileMember[] = [];
    const imports: string[] = model.base ? [model.base.className] : [];
    const ownFields = model.fields.filter((field) => !field.inherited || !model.base);
    const ownRelations = model.relations.filter((relation) => !relation.inherited || !model.base);
    for (const field of ownFields) {
        members.push({ name: field.name, optional: field.optional, typeText: field.typeText });
    }
    for (const property of model.unmapped.filter((candidate) => !candidate.inherited || !model.base)) {
        members.push({ name: property.name, optional: property.optional, typeText: property.typeText });
    }
    for (const relation of ownRelations) {
        imports.push(relation.targetClassName);
        members.push({ name: relation.name, optional: relation.optional, typeText: relationTypeText(relation, classesByName.get(relation.targetClassName)) });
    }
    return { members, imports };
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
    const program = evaluation.classes.length > 0 ? createModelTypeProgram(modelFiles, resolveCompilerOptions(options)) : undefined;

    const declared = new Map<string, DeclaredClass>();
    for (const collected of evaluation.classes) {
        const shape = program ? readDeclaredClass(program, collected.filePath, collected.className) : undefined;
        if (!shape) {
            diagnostics.push({ filePath: collected.filePath, exportName: collected.exportName, message: `Could not read the TypeScript declaration of '${collected.exportName}'.` });
            continue;
        }
        declared.set(classKeyOf(collected), shape);
    }

    const resolution = resolveModels({ classes: evaluation.classes, declared });
    diagnostics.push(...resolution.diagnostics);
    const classesWithProblems = new Set(resolution.diagnostics.map((diagnostic) => `${diagnostic.filePath}#${diagnostic.exportName}`));

    const classesByName = new Map<string, ResolvedClass>();
    for (const model of resolution.classes) {
        const previous = classesByName.get(model.className);
        if (previous) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: `Model name '${model.className}' is already used in '${previous.filePath}'.` });
            continue;
        }
        classesByName.set(model.className, model);
    }

    for (const model of classesByName.values()) {
        const typesFilePath = nodePath.join(outDir, `${model.className}.types.gen.ts`);
        const { members, imports } = buildTypeFileMembers(model, classesByName);
        files.push({
            path: typesFilePath,
            content: emitTypeFile({
                className: model.className,
                baseClassName: model.base?.className,
                members,
                imports,
                isRecordType: model.recordType !== undefined,
                libraryModule: config.libraryModule,
                version: options.version,
            }),
        });

        if (model.recordType === undefined || classesWithProblems.has(`${model.filePath}#${model.exportName}`)) {
            continue;
        }

        try {
            const compiledConfig = compileModel(model);
            files.push({
                path: nodePath.join(outDir, `${model.className}.config.gen.ts`),
                content: emitConfigFile({
                    modelName: model.className,
                    config: compiledConfig,
                    libraryModule: config.libraryModule,
                    typesImportPath: toImportPath(outDir, typesFilePath),
                    functionImports,
                    version: options.version,
                }),
            });
            files.push({
                path: nodePath.join(outDir, `${model.className}.fields.gen.ts`),
                content: emitFieldsFile({ modelName: model.className, tree: buildFieldPathTree(model.fields, model.relations), version: options.version }),
            });
            if (config.repositories === 'classes') files.push({
                path: nodePath.join(outDir, `${model.className}.repository.gen.ts`),
                content: emitRepositoryFile({
                    modelName: model.className,
                    libraryModule: config.libraryModule,
                    configImportPath: `./${model.className}.config.gen`,
                    typesImportPath: `./${model.className}.types.gen`,
                    version: options.version,
                }),
            });
        } catch (error) {
            diagnostics.push({ filePath: model.filePath, exportName: model.exportName, message: error instanceof Error ? error.message : String(error) });
            continue;
        }

        models.push({ modelName: model.className, setName: model.setName ?? toRecordSetName(model.className), filePath: model.filePath });
    }

    if (models.length > 0) {
        files.push({
            path: nodePath.join(outDir, config.context.fileName),
            content: emitContextFile({
                contextName: config.context.name,
                libraryModule: config.libraryModule,
                repositories: config.repositories === 'classes',
                version: options.version,
                models: models.map((model) => ({ modelName: model.modelName, setName: model.setName, configImportPath: `./${model.modelName}.config.gen`, repositoryImportPath: `./${model.modelName}.repository.gen` })),
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
