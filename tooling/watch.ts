import * as nodePath from 'path';
import type { BuildConfig } from './config';
import { DEFAULT_BUILD_CONFIG_FILE_NAME } from './config';
import type { FileSystemAdapter } from './file-system';
import { resolveTypesFilePath, runGenerate } from './generate';
import type { GenerateOptions, GenerateResult } from './generate';

export interface ModelWatcherOptions extends GenerateOptions {
    /** Called after every generation run, including the initial one. */
    onGenerated?: (result: GenerateResult) => void;
    /** Called when a generation run throws. */
    onError?: (error: unknown) => void;
    debounceMilliseconds?: number;
    /** Replaceable for tests; defaults to runGenerate. */
    generate?: (options: GenerateOptions) => GenerateResult;
}

export interface ModelWatcher {
    /** Runs generation once and starts watching. */
    start(): void;
    stop(): void;
    /** Whether the watcher is currently running. */
    readonly running: boolean;
}

function globBaseDirectory(pattern: string): string {
    const segments = pattern.replace(/\\/g, '/').split('/');
    const base: string[] = [];
    for (const segment of segments) {
        if (/[*?]/.test(segment)) {
            break;
        }
        base.push(segment);
    }
    return base.join('/');
}

/** Directories and files the watcher observes: every model glob base plus the config file. */
export function resolveWatchedPaths(config: BuildConfig, cwd: string): string[] {
    const bases = config.models
        .filter((pattern) => !pattern.startsWith('!'))
        .map((pattern) => nodePath.resolve(cwd, globBaseDirectory(pattern)));
    return Array.from(new Set([...bases, nodePath.resolve(cwd, DEFAULT_BUILD_CONFIG_FILE_NAME)]));
}

/** Re-runs generation whenever a model file changes, TanStack Router style. */
export function createModelWatcher(options: ModelWatcherOptions): ModelWatcher {
    const generate = options.generate ?? runGenerate;
    const debounceMilliseconds = options.debounceMilliseconds ?? 200;
    const outDir = nodePath.resolve(options.cwd, options.config.outDir);
    const typesFilePath = resolveTypesFilePath(options.config, options.cwd);
    let stopWatching: (() => void) | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const runOnce = (): void => {
        try {
            const result = generate(options);
            options.onGenerated?.(result);
        } catch (error) {
            options.onError?.(error);
        }
    };

    const scheduleRun = (changedPath: string): void => {
        if (isInsideDirectory(changedPath, outDir) || nodePath.resolve(changedPath) === typesFilePath) {
            return;
        }
        if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
        }
        pendingTimer = setTimeout(() => {
            pendingTimer = undefined;
            runOnce();
        }, debounceMilliseconds);
    };

    return {
        get running() {
            return running;
        },
        start() {
            if (running) {
                return;
            }
            running = true;
            runOnce();
            stopWatching = options.fileSystem.watch(resolveWatchedPaths(options.config, options.cwd), scheduleRun);
        },
        stop() {
            if (pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }
            stopWatching?.();
            stopWatching = undefined;
            running = false;
        },
    };
}

function isInsideDirectory(filePath: string, directory: string): boolean {
    const relative = nodePath.relative(directory, filePath);
    return relative !== '' && !relative.startsWith('..') && !nodePath.isAbsolute(relative);
}
