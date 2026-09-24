import * as nodeFileSystem from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { defaultBuildConfig } from '../config';
import { createNodeFileSystemAdapter } from '../file-system';
import { planGeneration } from '../generate';

// A project that has just started has a models folder and no model in it yet: generate has nothing to write and
// nothing to report. A 'models' glob whose folder does not exist is still a mistake in the build config.
describe('planGeneration() – a project with no model yet', () => {
    const projectRoots: string[] = [];

    afterAll(() => {
        for (const projectRoot of projectRoots) nodeFileSystem.rmSync(projectRoot, { recursive: true, force: true });
    });

    function createProjectRoot(): string {
        const projectRoot = nodeFileSystem.mkdtempSync(nodePath.join(os.tmpdir(), 'netsuite-repository-empty-'));
        projectRoots.push(projectRoot);
        return projectRoot;
    }

    function planFor(projectRoot: string) {
        return planGeneration({
            config: { ...defaultBuildConfig, context: { ...defaultBuildConfig.context }, models: ['src/models/**/*.ts'], outDir: 'src/repositories/generated' },
            cwd: projectRoot,
            fileSystem: createNodeFileSystemAdapter(),
            compilerOptions: {},
            version: '0.0.0-test',
        });
    }

    it('plans nothing and reports nothing when the models folder exists but holds no model', () => {
        const projectRoot = createProjectRoot();
        nodeFileSystem.mkdirSync(nodePath.join(projectRoot, 'src', 'models'), { recursive: true });
        nodeFileSystem.writeFileSync(nodePath.join(projectRoot, 'src', 'models', '.gitkeep'), '');

        const plan = planFor(projectRoot);

        expect(plan.diagnostics).toEqual([]);
        expect(plan.files).toEqual([]);
        expect(plan.models).toEqual([]);
    });

    it('still reports a models glob whose folder does not exist', () => {
        const projectRoot = createProjectRoot();

        const plan = planFor(projectRoot);

        expect(plan.diagnostics).toEqual([
            { filePath: projectRoot, message: expect.stringContaining("No model files matched the 'models' globs (src/models/**/*.ts)") },
        ]);
    });
});
