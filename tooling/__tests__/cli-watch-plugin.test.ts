import * as nodePath from 'path';
import * as tooling from '../index';
import { parseCommandLineArguments, readFlagOption, readStringOption } from '../cli/arguments';
import { CLI_USAGE, EXIT_PROBLEMS, EXIT_SUCCESS, EXIT_USAGE, runCli } from '../cli/main';
import { DEFAULT_BUILD_CONFIG_FILE_NAME, defaultBuildConfig } from '../config';
import { createInMemoryFileSystemAdapter } from '../file-system';
import type { CheckResult, GenerateOptions, GenerateResult, GenerationPlan } from '../generate';
import { GenerationFailedError, describeGenerateResult, netsuiteRepositoryPlugin } from '../plugin';
import { createModelWatcher, resolveWatchedPaths } from '../watch';

const cwd = nodePath.resolve('/project');

function emptyResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
    return { files: [], models: [], diagnostics: [], writtenFiles: [], unchangedFiles: [], ...overrides };
}

function createEnvironment(fileSystem = createInMemoryFileSystemAdapter()) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { environment: { cwd, fileSystem, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }, stdout, stderr, fileSystem };
}

describe('tooling index', () => {
    it('re-exports the public surface', async () => {
        expect(typeof tooling.runGenerate).toBe('function');
        expect(typeof tooling.runCli).toBe('function');
        expect(typeof tooling.netsuiteRepositoryPlugin).toBe('function');
    });
});

describe('parseCommandLineArguments()', () => {
    it('parses commands, options in both forms, flags, and positionals', async () => {
        const parsed = parseCommandLineArguments(['generate', '--config', 'build.json', '--dry-run', '--out=dist', 'extra', '--last']);
        expect(parsed).toEqual({ command: 'generate', options: { config: 'build.json', 'dry-run': true, out: 'dist', last: true }, positional: ['extra'] });
        expect(readStringOption(parsed.options, 'config')).toBe('build.json');
        expect(readStringOption(parsed.options, 'dry-run')).toBeUndefined();
        expect(readFlagOption(parsed.options, 'dry-run')).toBe(true);
        expect(readFlagOption(parsed.options, 'missing')).toBe(false);
        expect(readFlagOption({ verbose: 'true' }, 'verbose')).toBe(true);
        expect(parseCommandLineArguments([])).toEqual({ options: {}, positional: [] });
    });
});

describe('runCli()', () => {
    it('prints usage for help and unknown commands', async () => {
        const help = createEnvironment();
        expect(await runCli([], help.environment)).toBe(EXIT_SUCCESS);
        expect(await runCli(['generate', '--help'], help.environment)).toBe(EXIT_SUCCESS);
        expect(help.stdout).toEqual([CLI_USAGE, CLI_USAGE]);

        const unknown = createEnvironment();
        expect(await runCli(['deploy'], unknown.environment)).toBe(EXIT_USAGE);
        expect(unknown.stderr[0]).toContain("Unknown command 'deploy'.");
    });

    it('reports build config problems as usage errors', async () => {
        const invalid = createEnvironment(createInMemoryFileSystemAdapter({ [nodePath.join(cwd, DEFAULT_BUILD_CONFIG_FILE_NAME)]: '{ "models": [] }' }));
        expect(await runCli(['generate'], invalid.environment)).toBe(EXIT_USAGE);
        expect(invalid.stderr[0]).toContain("'models' must be a non-empty array");

        const missing = createEnvironment();
        expect(await runCli(['generate', '--config', 'nope.json'], missing.environment)).toBe(EXIT_USAGE);
        expect(missing.stderr[0]).toContain('file does not exist');
    });

    it('wraps unexpected config loading failures', async () => {
        const broken = createEnvironment();
        broken.fileSystem.fileExists = () => {
            throw new Error('disk on fire');
        };
        expect(await runCli(['generate'], broken.environment)).toBe(EXIT_USAGE);
        expect(broken.stderr[0]).toBe('Could not load build config: disk on fire');
    });

    it('runs generate and maps diagnostics to the exit code', async () => {
        const ok = createEnvironment();
        const generate = jest.fn((options: GenerateOptions) => emptyResult({ models: [{ modelName: 'A', setName: 'as', filePath: 'A.ts' }], writtenFiles: [nodePath.join(options.cwd, 'A.config.gen.ts')] }));
        expect(await runCli(['generate'], { ...ok.environment, generate })).toBe(EXIT_SUCCESS);
        expect(generate).toHaveBeenCalledWith(expect.objectContaining({ cwd, config: { ...defaultBuildConfig, rootDirectory: cwd } }));
        expect(ok.stdout[0]).toBe('netsuite-repository: 1 model(s), 1 file(s) written, 0 unchanged.');

        const nested = createEnvironment(createInMemoryFileSystemAdapter({ [nodePath.join(cwd, 'examples', DEFAULT_BUILD_CONFIG_FILE_NAME)]: '{ "models": ["models/*.ts"] }' }));
        const nestedGenerate = jest.fn(() => emptyResult());
        expect(await runCli(['generate', '--config', 'examples/netsuite-repository.config.json'], { ...nested.environment, generate: nestedGenerate })).toBe(EXIT_SUCCESS);
        expect(nestedGenerate).toHaveBeenCalledWith(expect.objectContaining({ cwd: nodePath.join(cwd, 'examples'), config: expect.objectContaining({ models: ['models/*.ts'], rootDirectory: nodePath.join(cwd, 'examples') }) }));

        const failing = createEnvironment();
        expect(await runCli(['generate'], { ...failing.environment, generate: () => emptyResult({ diagnostics: [{ filePath: 'A.ts', exportName: 'A', message: 'boom' }] }) })).toBe(EXIT_PROBLEMS);
        expect(failing.stdout[0]).toContain(' - A.ts (A): boom');
    });

    it('supports a dry run that lists planned files', async () => {
        const dry = createEnvironment();
        const plan: GenerationPlan = { files: [{ path: '/project/out/A.config.gen.ts', content: '' }], models: [{ modelName: 'A', setName: 'as', filePath: 'A.ts' }], diagnostics: [] };
        expect(await runCli(['generate', '--dry-run'], { ...dry.environment, plan: () => plan })).toBe(EXIT_SUCCESS);
        expect(dry.stdout[0]).toBe('1 model(s); would write:\n - /project/out/A.config.gen.ts');

        const dryWithProblems = createEnvironment();
        expect(await runCli(['generate', '--dry-run'], { ...dryWithProblems.environment, plan: () => ({ ...plan, diagnostics: [{ filePath: 'A.ts', message: 'bad' }] }) })).toBe(EXIT_PROBLEMS);
        expect(dryWithProblems.stdout[0]).toContain(' - A.ts: bad');
    });

    it('runs check and reports missing, drifted, and diagnostic problems', async () => {
        const clean = createEnvironment();
        const cleanResult: CheckResult = { files: [{ path: 'a', content: '' }], models: [], diagnostics: [], driftedFiles: [], missingFiles: [] };
        expect(await runCli(['check'], { ...clean.environment, check: () => cleanResult })).toBe(EXIT_SUCCESS);
        expect(clean.stdout[0]).toBe('Generated files are up to date (1 file(s)).');

        const dirty = createEnvironment();
        expect(await runCli(['check'], { ...dirty.environment, check: () => ({ ...cleanResult, missingFiles: ['m.ts'], driftedFiles: ['d.ts'], diagnostics: [{ filePath: 'x.ts', message: 'oops' }] }) })).toBe(EXIT_PROBLEMS);
        expect(dirty.stderr[0]).toBe('Generated files are not up to date. Run `netsuite-repository generate`.\n - missing: m.ts\n - out of date: d.ts\n - x.ts: oops');
    });

    it('starts a watcher for the watch command and hands it to the caller', async () => {
        jest.useFakeTimers();
        const watching = createEnvironment();
        const generate = jest.fn(() => emptyResult());
        let watcher: ReturnType<typeof createModelWatcher> | undefined;

        expect(await runCli(['watch'], { ...watching.environment, generate, onWatcherStarted: (started) => { watcher = started; } })).toBe(EXIT_SUCCESS);

        expect(generate).toHaveBeenCalledTimes(1);
        expect(watching.stdout).toEqual(['netsuite-repository: 0 model(s), 0 file(s) written, 0 unchanged.', 'Watching model files. Press Ctrl+C to stop.']);
        watching.fileSystem.emitChange(nodePath.join(cwd, 'src/models/A.ts'));
        jest.advanceTimersByTime(250);
        expect(generate).toHaveBeenCalledTimes(2);
        watcher?.stop();
        jest.useRealTimers();
    });

    it('reports watcher generation errors on stderr', async () => {
        const failing = createEnvironment();
        let watcher: ReturnType<typeof createModelWatcher> | undefined;
        await runCli(['watch'], { ...failing.environment, generate: () => { throw new Error('cannot generate'); }, onWatcherStarted: (started) => { watcher = started; } });
        expect(failing.stderr).toEqual(['netsuite-repository: cannot generate']);
        watcher?.stop();
    });
});

describe('createModelWatcher()', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('generates on start, debounces bursts, ignores output-directory changes, and stops cleanly', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const generate = jest.fn(() => emptyResult());
        const onGenerated = jest.fn();
        const watcher = createModelWatcher({ config: defaultBuildConfig, cwd, fileSystem, generate, onGenerated, debounceMilliseconds: 100 });

        expect(watcher.running).toBe(false);
        watcher.start();
        watcher.start();
        expect(watcher.running).toBe(true);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(onGenerated).toHaveBeenCalledTimes(1);

        fileSystem.emitChange(nodePath.join(cwd, 'src/models/A.ts'));
        fileSystem.emitChange(nodePath.join(cwd, 'src/models/B.ts'));
        jest.advanceTimersByTime(50);
        expect(generate).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(60);
        expect(generate).toHaveBeenCalledTimes(2);

        fileSystem.emitChange(nodePath.join(cwd, 'src/repositories/generated/A.config.gen.ts'));
        jest.advanceTimersByTime(200);
        expect(generate).toHaveBeenCalledTimes(2);

        fileSystem.emitChange(nodePath.join(cwd, 'src/models/C.ts'));
        watcher.stop();
        jest.advanceTimersByTime(200);
        expect(generate).toHaveBeenCalledTimes(2);
        expect(watcher.running).toBe(false);
        watcher.stop();
    });

    it('routes generation errors to onError and keeps watching', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const onError = jest.fn();
        const watcher = createModelWatcher({ config: defaultBuildConfig, cwd, fileSystem, generate: () => { throw new Error('nope'); }, onError });
        watcher.start();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'nope' }));
        watcher.stop();
    });

    it('uses the default debounce when none is given', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const generate = jest.fn(() => emptyResult());
        const watcher = createModelWatcher({ config: defaultBuildConfig, cwd, fileSystem, generate });
        watcher.start();
        fileSystem.emitChange(nodePath.join(cwd, 'src/models/A.ts'));
        jest.advanceTimersByTime(199);
        expect(generate).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        expect(generate).toHaveBeenCalledTimes(2);
        watcher.stop();
    });

    it('watches every model glob base and the config file', async () => {
        expect(resolveWatchedPaths({ ...defaultBuildConfig, models: ['src/models/**/*.ts', 'lib/*.ts', '!src/models/generated/**', 'src/models/**/*.ts'] }, cwd)).toEqual([
            nodePath.resolve(cwd, 'src/models'),
            nodePath.resolve(cwd, 'lib'),
            nodePath.resolve(cwd, DEFAULT_BUILD_CONFIG_FILE_NAME),
        ]);
    });
});

describe('netsuiteRepositoryPlugin()', () => {
    it('generates on buildStart and throws when diagnostics are reported', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const log = jest.fn();
        const okPlugin = netsuiteRepositoryPlugin({ cwd, fileSystem, log, generate: () => emptyResult() });
        expect(okPlugin.name).toBe('netsuite-repository');
        expect(() => okPlugin.buildStart()).not.toThrow();
        expect(log).toHaveBeenCalledWith('netsuite-repository: 0 model(s), 0 file(s) written, 0 unchanged.');
        okPlugin.closeBundle();

        const failingPlugin = netsuiteRepositoryPlugin({ cwd, fileSystem, generate: () => emptyResult({ diagnostics: [{ filePath: 'A.ts', exportName: 'A', message: 'boom' }, { filePath: 'B.ts', message: 'bang' }] }) });
        expect(() => failingPlugin.buildStart()).toThrow(GenerationFailedError);
        expect(() => failingPlugin.buildStart()).toThrow('Model generation reported 2 problem(s):\n - A.ts (A): boom\n - B.ts: bang');
    });

    it('runs a watcher in watch mode until closeBundle', async () => {
        jest.useFakeTimers();
        const fileSystem = createInMemoryFileSystemAdapter();
        const generate = jest.fn(() => emptyResult());
        const log = jest.fn();
        const plugin = netsuiteRepositoryPlugin({ cwd, fileSystem, watch: true, generate, log });

        plugin.buildStart();
        plugin.buildStart();
        expect(generate).toHaveBeenCalledTimes(1);
        fileSystem.emitChange(nodePath.join(cwd, 'src/models/A.ts'));
        jest.advanceTimersByTime(250);
        expect(generate).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledTimes(2);

        plugin.closeBundle();
        fileSystem.emitChange(nodePath.join(cwd, 'src/models/A.ts'));
        jest.advanceTimersByTime(250);
        expect(generate).toHaveBeenCalledTimes(2);
        jest.useRealTimers();
    });

    it('logs watcher errors', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const log = jest.fn();
        const plugin = netsuiteRepositoryPlugin({ cwd, fileSystem, watch: true, generate: () => { throw new Error('watch failed'); }, log });
        plugin.buildStart();
        expect(log).toHaveBeenCalledWith('netsuite-repository: watch failed');
        plugin.closeBundle();
    });

    it('defaults cwd to the process directory and uses the real file system', async () => {
        const plugin = netsuiteRepositoryPlugin({ generate: () => emptyResult() });
        expect(() => plugin.buildStart()).not.toThrow();
    });

    it('describes results with diagnostics', async () => {
        expect(describeGenerateResult(emptyResult({ diagnostics: [{ filePath: 'A.ts', message: 'x' }] }))).toBe('netsuite-repository: 0 model(s), 0 file(s) written, 0 unchanged.\n - A.ts: x');
    });
});
