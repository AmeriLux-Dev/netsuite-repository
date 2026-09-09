import { BuildConfigError, loadBuildConfig } from '../config';
import type { ResolvedBuildConfig } from '../config';
import { createNodeFileSystemAdapter } from '../file-system';
import type { FileSystemAdapter } from '../file-system';
import { checkGenerated, planGeneration, runGenerate } from '../generate';
import type { CheckResult, GenerateOptions, GenerateResult, GenerationPlan } from '../generate';
import { describeGenerateResult } from '../plugin';
import { createModelWatcher } from '../watch';
import type { ModelWatcher } from '../watch';
import { parseCommandLineArguments, readFlagOption, readStringOption } from './arguments';

export interface CliEnvironment {
    cwd: string;
    fileSystem?: FileSystemAdapter;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    /** Replaceable for tests. */
    generate?: (options: GenerateOptions) => GenerateResult;
    check?: (options: GenerateOptions) => CheckResult;
    plan?: (options: GenerateOptions) => GenerationPlan;
    /** Called with the running watcher so a caller can stop it; the CLI itself keeps the process alive. */
    onWatcherStarted?: (watcher: ModelWatcher) => void;
}

export const CLI_USAGE = [
    'Usage: netsuite-repository <command> [options]',
    '',
    'Commands:',
    '  generate        Read the model files and write the config, type, and context files.',
    '  check           Exit non-zero when the generated files are missing or out of date.',
    '  watch           Generate once, then regenerate whenever a model file changes.',
    '  help            Show this message.',
    '',
    'Options:',
    '  --config <path>       Build config file (default: netsuite-repository.config.json).',
    '  --dry-run             With generate: list the files that would be written without writing them.',
].join('\n');

export const EXIT_SUCCESS = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

const commands = ['generate', 'check', 'watch'];

function formatDiagnostics(plan: GenerationPlan): string[] {
    return plan.diagnostics.map((diagnostic) => ` - ${diagnostic.filePath}${diagnostic.exportName ? ` (${diagnostic.exportName})` : ''}: ${diagnostic.message}`);
}

/** Runs the CLI and resolves to the process exit code. Never throws for user errors. */
export async function runCli(argv: string[], environment: CliEnvironment): Promise<number> {
    const parsed = parseCommandLineArguments(argv);
    const fileSystem = environment.fileSystem ?? createNodeFileSystemAdapter();
    const command = parsed.command ?? 'help';

    if (command === 'help' || readFlagOption(parsed.options, 'help')) {
        environment.stdout(CLI_USAGE);
        return EXIT_SUCCESS;
    }

    if (!commands.includes(command)) {
        environment.stderr(`Unknown command '${command}'.\n\n${CLI_USAGE}`);
        return EXIT_USAGE;
    }

    let config: ResolvedBuildConfig;
    let options: GenerateOptions;
    try {
        config = loadBuildConfig(fileSystem, environment.cwd, readStringOption(parsed.options, 'config'));
        options = { config, cwd: config.rootDirectory, fileSystem };
    } catch (error) {
        environment.stderr(error instanceof BuildConfigError ? error.message : `Could not load build config: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT_USAGE;
    }

    if (command === 'generate') {
        if (readFlagOption(parsed.options, 'dry-run')) {
            const plan = (environment.plan ?? planGeneration)(options);
            environment.stdout([`${plan.models.length} model(s); would write:`, ...plan.files.map((file) => ` - ${file.path}`), ...formatDiagnostics(plan)].join('\n'));
            return plan.diagnostics.length > 0 ? EXIT_PROBLEMS : EXIT_SUCCESS;
        }
        const result = (environment.generate ?? runGenerate)(options);
        environment.stdout(describeGenerateResult(result));
        return result.diagnostics.length > 0 ? EXIT_PROBLEMS : EXIT_SUCCESS;
    }

    if (command === 'check') {
        const result = (environment.check ?? checkGenerated)(options);
        const problems = [
            ...result.missingFiles.map((file) => ` - missing: ${file}`),
            ...result.driftedFiles.map((file) => ` - out of date: ${file}`),
            ...formatDiagnostics(result),
        ];
        if (problems.length > 0) {
            environment.stderr(['Generated files are not up to date. Run `netsuite-repository generate`.', ...problems].join('\n'));
            return EXIT_PROBLEMS;
        }
        environment.stdout(`Generated files are up to date (${result.files.length} file(s)).`);
        return EXIT_SUCCESS;
    }

    const watcher = createModelWatcher({
        ...options,
        generate: environment.generate,
        onGenerated: (result) => environment.stdout(describeGenerateResult(result)),
        onError: (error) => environment.stderr(`netsuite-repository: ${error instanceof Error ? error.message : String(error)}`),
    });
    watcher.start();
    environment.stdout('Watching model files. Press Ctrl+C to stop.');
    environment.onWatcherStarted?.(watcher);
    return EXIT_SUCCESS;
}
