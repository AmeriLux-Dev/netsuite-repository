import * as nodePath from 'path';
import * as runtime from '../../src';
import { evaluateModelFiles } from '../collect/model-file-evaluator';
import { createNodeFileSystemAdapter } from '../file-system';

const fixturesRoot = nodePath.join(__dirname, 'fixtures');

describe('evaluateModelFiles()', () => {
    it('reports a class whose overrides cannot be read, and still records the exported functions', () => {
        const result = evaluateModelFiles({
            filePaths: [nodePath.join(fixturesRoot, 'broken', 'InvalidModel.ts'), nodePath.join(fixturesRoot, 'models', 'shared.ts')],
            fileSystem: createNodeFileSystemAdapter(),
            libraryModule: '@amerilux/netsuite-repository',
            runtimeModule: runtime,
            runtimeApi: {
                getClassOverrides: () => {
                    throw new Error('registry unavailable');
                },
            },
        });

        expect(result.classes).toEqual([]);
        expect(result.diagnostics).toEqual([{ filePath: expect.stringContaining('InvalidModel.ts'), exportName: 'InvalidModel', message: 'registry unavailable' }]);
        expect([...result.functionReferences.values()].map((reference) => reference.exportName)).toEqual(['trimText', 'uppercaseText']);
    });
});
