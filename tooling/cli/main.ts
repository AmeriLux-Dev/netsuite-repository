import * as nodePath from 'path';
import { BuildConfigError, loadBuildConfig } from '../config';
import type { ResolvedBuildConfig } from '../config';
import { createNodeFileSystemAdapter } from '../file-system';
import type { FileSystemAdapter } from '../file-system';
import { checkGenerated, planGeneration, runGenerate } from '../generate';
import type { CheckResult, GenerateOptions, GenerateResult, GenerationPlan } from '../generate';
import { describeGenerateResult } from '../plugin';
import { buildRecordsCatalogExportScript } from '../scaffold/catalog-script';
import { createSnapshotMetadataProvider } from '../scaffold/metadata';
import type { MetadataProvider } from '../scaffold/metadata';
import { createRestMetadataProvider } from '../scaffold/rest-provider';
import type { HttpTransport, RestAuthentication } from '../scaffold/rest-provider';
import { loadMetadataSnapshots, runScaffold, writeRecordMetadataSnapshot } from '../scaffold/scaffold';
import { createModelWatcher } from '../watch';
import type { ModelWatcher } from '../watch';
import { parseCommandLineArguments, readFlagOption, readStringOption } from './arguments';
import type { ParsedCommandLine } from './arguments';

export interface CliEnvironment {
    cwd: string;
    fileSystem?: FileSystemAdapter;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    /** Environment variables; defaults to process.env. Used for NetSuite credentials by scaffold and snapshot. */
    env?: Record<string, string | undefined>;
    /** Replaceable for tests. */
    generate?: (options: GenerateOptions) => GenerateResult;
    check?: (options: GenerateOptions) => CheckResult;
    plan?: (options: GenerateOptions) => GenerationPlan;
    transport?: HttpTransport;
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
    '  scaffold        Write decorated model stubs from NetSuite metadata (best effort, never overwrites).',
    '  snapshot        Fetch record metadata from the REST metadata catalog into a snapshot file.',
    '  catalog-script  Print the browser console script that exports SuiteQL table metadata.',
    '  help            Show this message.',
    '',
    'Options:',
    '  --config <path>       Build config file (default: netsuite-repository.config.json).',
    '  --dry-run             With generate: list the files that would be written without writing them.',
    '  --record <types>      With scaffold and snapshot: comma-separated record types (or positional arguments).',
    '  --snapshot <paths>    With scaffold: comma-separated metadata snapshot files (record and table metadata).',
    '  --out <path>          With scaffold: model directory (default: the first models glob base); with snapshot: the file to write.',
    '  --force               With scaffold: overwrite existing model files.',
    '  --table <names>       With catalog-script: comma-separated SuiteQL table names.',
    '',
    'NetSuite credentials for scaffold and snapshot come from the environment:',
    '  NETSUITE_ACCOUNT_ID plus either NETSUITE_ACCESS_TOKEN, or NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET,',
    '  NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET for token-based authentication.',
].join('\n');

export const EXIT_SUCCESS = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

const commands = ['generate', 'check', 'watch', 'scaffold', 'snapshot', 'catalog-script'];

function formatDiagnostics(plan: GenerationPlan): string[] {
    return plan.diagnostics.map((diagnostic) => ` - ${diagnostic.filePath}${diagnostic.exportName ? ` (${diagnostic.exportName})` : ''}: ${diagnostic.message}`);
}

function readListOption(parsed: ParsedCommandLine, name: string): string[] {
    const raw = readStringOption(parsed.options, name);
    return (raw ? raw.split(',') : []).map((entry) => entry.trim()).filter(Boolean);
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

function buildRestAuthentication(env: Record<string, string | undefined>): RestAuthentication | undefined {
    if (env.NETSUITE_ACCESS_TOKEN) {
        return { kind: 'oauth2', accessToken: env.NETSUITE_ACCESS_TOKEN };
    }
    if (env.NETSUITE_CONSUMER_KEY && env.NETSUITE_CONSUMER_SECRET && env.NETSUITE_TOKEN_ID && env.NETSUITE_TOKEN_SECRET && env.NETSUITE_ACCOUNT_ID) {
        return {
            kind: 'tba',
            credentials: {
                consumerKey: env.NETSUITE_CONSUMER_KEY,
                consumerSecret: env.NETSUITE_CONSUMER_SECRET,
                tokenId: env.NETSUITE_TOKEN_ID,
                tokenSecret: env.NETSUITE_TOKEN_SECRET,
                realm: env.NETSUITE_ACCOUNT_ID,
            },
        };
    }
    return undefined;
}

function buildRestProvider(environment: CliEnvironment): MetadataProvider | undefined {
    const env = environment.env ?? process.env;
    const authentication = buildRestAuthentication(env);
    if (!env.NETSUITE_ACCOUNT_ID || !authentication) {
        return undefined;
    }
    return createRestMetadataProvider({ accountId: env.NETSUITE_ACCOUNT_ID, authentication, transport: environment.transport });
}

/** Snapshot metadata first, then the REST catalog for record types the snapshot does not know. */
function combineProviders(snapshotProvider: MetadataProvider | undefined, restProvider: MetadataProvider | undefined): MetadataProvider {
    return {
        async getRecordTypeMetadata(recordType) {
            return (await snapshotProvider?.getRecordTypeMetadata(recordType)) ?? (await restProvider?.getRecordTypeMetadata(recordType));
        },
        async getSuiteQlTableMetadata(table) {
            return (await snapshotProvider?.getSuiteQlTableMetadata(table)) ?? (await restProvider?.getSuiteQlTableMetadata(table));
        },
    };
}

async function runScaffoldCommand(parsed: ParsedCommandLine, config: ResolvedBuildConfig, fileSystem: FileSystemAdapter, environment: CliEnvironment): Promise<number> {
    const recordTypes = [...readListOption(parsed, 'record'), ...parsed.positional.flatMap((argument) => argument.split(',').map((entry) => entry.trim()).filter(Boolean))];
    if (recordTypes.length === 0) {
        environment.stderr('scaffold needs at least one record type: netsuite-repository scaffold --record salesorder');
        return EXIT_USAGE;
    }

    let snapshotProvider: MetadataProvider | undefined;
    const snapshotPaths = readListOption(parsed, 'snapshot');
    try {
        snapshotProvider = snapshotPaths.length > 0 ? createSnapshotMetadataProvider(loadMetadataSnapshots(fileSystem, environment.cwd, snapshotPaths)) : undefined;
    } catch (error) {
        environment.stderr(error instanceof Error ? error.message : String(error));
        return EXIT_USAGE;
    }

    const restProvider = buildRestProvider(environment);
    if (!snapshotProvider && !restProvider) {
        environment.stderr('scaffold needs a metadata source: pass --snapshot <file> or set the NETSUITE_* credentials in the environment.');
        return EXIT_USAGE;
    }

    // An explicit --out is a command-line path (relative to the working directory); the default comes from the config and resolves against the config file's directory.
    const explicitOutDir = readStringOption(parsed.options, 'out');
    const outDir = explicitOutDir !== undefined
        ? nodePath.resolve(environment.cwd, explicitOutDir)
        : nodePath.resolve(config.rootDirectory, globBaseDirectory(config.models.find((pattern) => !pattern.startsWith('!')) ?? 'src/models'));
    const result = await runScaffold({
        provider: combineProviders(snapshotProvider, restProvider),
        records: recordTypes.map((recordType) => ({ recordType })),
        outDir,
        cwd: environment.cwd,
        fileSystem,
        libraryModule: config.libraryModule,
        force: readFlagOption(parsed.options, 'force'),
    });

    const lines = [
        ...result.writtenFiles.map((file) => `wrote ${file}`),
        ...result.skippedFiles.map((file) => `kept existing ${file} (use --force to overwrite)`),
        ...result.todos.map((todo) => ` - TODO ${todo.modelName}: ${todo.message}`),
    ];
    environment.stdout(lines.join('\n'));
    if (result.errors.length > 0) {
        environment.stderr(result.errors.map((error) => ` - ${error.recordType}: ${error.message}`).join('\n'));
        return EXIT_PROBLEMS;
    }
    return EXIT_SUCCESS;
}

async function runSnapshotCommand(parsed: ParsedCommandLine, fileSystem: FileSystemAdapter, environment: CliEnvironment): Promise<number> {
    const recordTypes = [...readListOption(parsed, 'record'), ...parsed.positional.flatMap((argument) => argument.split(',').map((entry) => entry.trim()).filter(Boolean))];
    const outPath = readStringOption(parsed.options, 'out');
    if (recordTypes.length === 0 || !outPath) {
        environment.stderr('snapshot needs record types and an output file: netsuite-repository snapshot --record salesorder,customer --out netsuite.metadata.json');
        return EXIT_USAGE;
    }
    const restProvider = buildRestProvider(environment);
    if (!restProvider) {
        environment.stderr('snapshot needs the NETSUITE_* credentials in the environment.');
        return EXIT_USAGE;
    }

    try {
        const result = await writeRecordMetadataSnapshot(restProvider, recordTypes, fileSystem, nodePath.resolve(environment.cwd, outPath));
        environment.stdout([`wrote ${result.records.length} record type(s) to ${outPath}`, ...result.missing.map((recordType) => ` - not found: ${recordType}`)].join('\n'));
        return result.missing.length > 0 ? EXIT_PROBLEMS : EXIT_SUCCESS;
    } catch (error) {
        environment.stderr(error instanceof Error ? error.message : String(error));
        return EXIT_PROBLEMS;
    }
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

    if (command === 'catalog-script') {
        const tables = [...readListOption(parsed, 'table'), ...parsed.positional];
        if (tables.length === 0) {
            environment.stderr('catalog-script needs table names: netsuite-repository catalog-script --table transaction,transactionline');
            return EXIT_USAGE;
        }
        environment.stdout(buildRecordsCatalogExportScript(tables));
        return EXIT_SUCCESS;
    }

    if (command === 'snapshot') {
        return runSnapshotCommand(parsed, fileSystem, environment);
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

    if (command === 'scaffold') {
        return runScaffoldCommand(parsed, config, fileSystem, environment);
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
