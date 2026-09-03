import * as fileSystem from 'fs';
import * as path from 'path';

const runtimeSourceDirectory = path.resolve(__dirname, '..', '..', 'src');
const excludedDirectories = new Set(['__tests__', '__mocks__']);
const forbiddenImportPattern = /from\s+['"](node:[^'"]+|fs|path|crypto|os|child_process|http|https|net|stream|util|vm|events)['"]/;
const forbiddenGlobalPattern = /\b(process\.|Buffer\b|__dirname|__filename)/;

function listRuntimeSourceFiles(directory: string): string[] {
    const entries = fileSystem.readdirSync(directory, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return excludedDirectories.has(entry.name) ? [] : listRuntimeSourceFiles(fullPath);
        }
        return entry.name.endsWith('.ts') ? [fullPath] : [];
    });
}

describe('runtime isolation – src/ never depends on Node', () => {
    const runtimeSourceFiles = listRuntimeSourceFiles(runtimeSourceDirectory);

    it('finds runtime source files to check', () => {
        expect(runtimeSourceFiles.length).toBeGreaterThan(0);
    });

    it.each(runtimeSourceFiles.map((filePath) => [path.relative(runtimeSourceDirectory, filePath), filePath]))(
        'keeps %s free of Node module imports and Node globals',
        (_relativePath, filePath) => {
            const source = fileSystem.readFileSync(filePath, 'utf8');
            expect(source).not.toMatch(forbiddenImportPattern);
            expect(source).not.toMatch(forbiddenGlobalPattern);
        }
    );
});
