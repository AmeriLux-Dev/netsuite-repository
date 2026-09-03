import { loadBuildConfig } from './config';
import { createNodeFileSystemAdapter } from './file-system';
import type { FileSystemAdapter } from './file-system';
import { runGenerate } from './generate';
import type { GenerateOptions, GenerateResult } from './generate';
import { createModelWatcher } from './watch';
import type { ModelWatcher } from './watch';

export interface NetSuiteRepositoryPluginOptions {
    cwd?: string;
    configPath?: string;
    /** Regenerate on model changes for as long as the bundler stays open. */
    watch?: boolean;
    fileSystem?: FileSystemAdapter;
    /** Replaceable for tests; defaults to runGenerate. */
    generate?: (options: GenerateOptions) => GenerateResult;
    log?: (message: string) => void;
}

/** The object shape Vite and Rollup accept directly; webpack and esbuild users can call the same hooks from a tiny wrapper. */
export interface NetSuiteRepositoryPlugin {
    name: string;
    buildStart(): void;
    closeBundle(): void;
}

export class GenerationFailedError extends Error {
    constructor(public readonly result: GenerateResult) {
        super(`Model generation reported ${result.diagnostics.length} problem(s):\n${result.diagnostics.map((diagnostic) => ` - ${diagnostic.filePath}${diagnostic.exportName ? ` (${diagnostic.exportName})` : ''}: ${diagnostic.message}`).join('\n')}`);
        this.name = 'GenerationFailedError';
    }
}

export function netsuiteRepositoryPlugin(options: NetSuiteRepositoryPluginOptions = {}): NetSuiteRepositoryPlugin {
    const cwd = options.cwd ?? process.cwd();
    const fileSystem = options.fileSystem ?? createNodeFileSystemAdapter();
    const generate = options.generate ?? runGenerate;
    const log = options.log ?? (() => undefined);
    let watcher: ModelWatcher | undefined;

    return {
        name: 'netsuite-repository',
        buildStart() {
            const config = loadBuildConfig(fileSystem, cwd, options.configPath);
            const generateOptions: GenerateOptions = { config, cwd: config.rootDirectory, fileSystem };

            if (options.watch) {
                if (!watcher) {
                    watcher = createModelWatcher({
                        ...generateOptions,
                        generate,
                        onGenerated: (result) => log(describeGenerateResult(result)),
                        onError: (error) => log(`netsuite-repository: ${error instanceof Error ? error.message : String(error)}`),
                    });
                    watcher.start();
                }
                return;
            }

            const result = generate(generateOptions);
            log(describeGenerateResult(result));
            if (result.diagnostics.length > 0) {
                throw new GenerationFailedError(result);
            }
        },
        closeBundle() {
            watcher?.stop();
            watcher = undefined;
        },
    };
}

export function describeGenerateResult(result: GenerateResult): string {
    const lines = [`netsuite-repository: ${result.models.length} model(s), ${result.writtenFiles.length} file(s) written, ${result.unchangedFiles.length} unchanged.`];
    for (const diagnostic of result.diagnostics) {
        lines.push(` - ${diagnostic.filePath}${diagnostic.exportName ? ` (${diagnostic.exportName})` : ''}: ${diagnostic.message}`);
    }
    return lines.join('\n');
}
