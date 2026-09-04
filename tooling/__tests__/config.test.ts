import * as nodePath from 'path';
import { BuildConfigError, DEFAULT_BUILD_CONFIG_FILE_NAME, defaultBuildConfig, loadBuildConfig } from '../config';
import { createInMemoryFileSystemAdapter } from '../file-system';

const cwd = nodePath.resolve('/project');
const defaultConfigPath = nodePath.join(cwd, DEFAULT_BUILD_CONFIG_FILE_NAME);

describe('loadBuildConfig()', () => {
    it('returns defaults when no config file exists', () => {
        const config = loadBuildConfig(createInMemoryFileSystemAdapter(), cwd);
        expect(config).toEqual({ ...defaultBuildConfig, rootDirectory: cwd });
        expect(config.context).not.toBe(defaultBuildConfig.context);
    });

    it('merges a config file over the defaults', () => {
        const fileSystem = createInMemoryFileSystemAdapter({
            [defaultConfigPath]: JSON.stringify({ models: ['models/*.ts'], outDir: 'models/generated', context: { name: 'Erp', fileName: 'erp.gen.ts' }, tsconfig: 'tsconfig.json', libraryModule: '@acme/orm' }),
        });

        expect(loadBuildConfig(fileSystem, cwd)).toEqual({
            models: ['models/*.ts'],
            outDir: 'models/generated',
            context: { name: 'Erp', fileName: 'erp.gen.ts' },
            tsconfig: 'tsconfig.json',
            libraryModule: '@acme/orm',
            repositories: 'none',
            rootDirectory: cwd,
        });
    });

    it('resolves relative paths against the directory of an explicitly named config file', () => {
        const configPath = nodePath.join(cwd, 'examples', DEFAULT_BUILD_CONFIG_FILE_NAME);
        const fileSystem = createInMemoryFileSystemAdapter({ [configPath]: JSON.stringify({ models: ['models/*.ts'] }) });
        const config = loadBuildConfig(fileSystem, cwd, 'examples/netsuite-repository.config.json');
        expect(config.rootDirectory).toBe(nodePath.join(cwd, 'examples'));
        expect(config.models).toEqual(['models/*.ts']);
    });

    it('accepts a partial context object', () => {
        const fileSystem = createInMemoryFileSystemAdapter({ [defaultConfigPath]: JSON.stringify({ context: { name: 'Erp' } }) });
        expect(loadBuildConfig(fileSystem, cwd).context).toEqual({ name: 'Erp', fileName: 'context.gen.ts' });
    });

    it('throws when an explicit config path does not exist', () => {
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter(), cwd, 'custom.json')).toThrow(BuildConfigError);
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter(), cwd, 'custom.json')).toThrow('file does not exist');
    });

    it('reports unparsable JSON and non-object roots', () => {
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter({ [defaultConfigPath]: '{ not json' }), cwd)).toThrow('could not parse JSON');
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter({ [defaultConfigPath]: '[]' }), cwd)).toThrow('top-level value must be an object');
    });

    it('collects every validation problem', () => {
        const fileSystem = createInMemoryFileSystemAdapter({
            [defaultConfigPath]: JSON.stringify({ models: [], outDir: ' ', context: { name: '1bad', fileName: 'x.js' }, tsconfig: 5, libraryModule: '' }),
        });
        let caught: unknown;
        try {
            loadBuildConfig(fileSystem, cwd);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(BuildConfigError);
        expect((caught as BuildConfigError).problems).toEqual([
            "'models' must be a non-empty array of glob strings.",
            "'outDir' must be a non-empty string.",
            "'context.name' must be a valid identifier.",
            "'context.fileName' must end with '.ts'.",
            "'tsconfig' must be a string path.",
            "'libraryModule' must be a non-empty string.",
        ]);
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter({ [defaultConfigPath]: JSON.stringify({ context: 'nope' }) }), cwd)).toThrow("'context' must be an object.");
    });
});

describe('loadBuildConfig() repositories switch', () => {
    it("defaults to 'none', accepts 'classes', and rejects anything else", () => {
        expect(loadBuildConfig(createInMemoryFileSystemAdapter({}), cwd).repositories).toBe('none');
        expect(loadBuildConfig(createInMemoryFileSystemAdapter({ [defaultConfigPath]: JSON.stringify({ repositories: 'classes' }) }), cwd).repositories).toBe('classes');
        expect(() => loadBuildConfig(createInMemoryFileSystemAdapter({ [defaultConfigPath]: JSON.stringify({ repositories: 'modules' }) }), cwd)).toThrow("'repositories' must be 'classes' or 'none'.");
    });
});
