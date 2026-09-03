import * as nodeFileSystem from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { createInMemoryFileSystemAdapter, createNodeFileSystemAdapter, matchesGlob, resolveGlobs, toPosixPath } from '../file-system';

describe('matchesGlob()', () => {
    it('supports **, *, and ? and escapes regular expression characters', () => {
        expect(matchesGlob('src/models/**/*.ts', 'src/models/SalesOrder.ts')).toBe(true);
        expect(matchesGlob('src/models/**/*.ts', 'src/models/nested/deep/Customer.ts')).toBe(true);
        expect(matchesGlob('src/models/*.ts', 'src/models/nested/Customer.ts')).toBe(false);
        expect(matchesGlob('src/models/?.ts', 'src/models/a.ts')).toBe(true);
        expect(matchesGlob('src/models/?.ts', 'src/models/ab.ts')).toBe(false);
        expect(matchesGlob('src/**', 'src/anything/at/all.ts')).toBe(true);
        expect(matchesGlob('src/(a).ts', 'src/(a).ts')).toBe(true);
        expect(matchesGlob('src\\models\\*.ts', 'src/models/a.ts')).toBe(true);
    });
});

describe('resolveGlobs()', () => {
    it('lists matching files under the glob base directory, honoring exclusions, sorted', () => {
        const fileSystem = createInMemoryFileSystemAdapter({
            '/project/src/models/SalesOrder.ts': '',
            '/project/src/models/Customer.ts': '',
            '/project/src/models/generated/Customer.config.gen.ts': '',
            '/project/src/other/Ignored.ts': '',
        });

        const files = resolveGlobs(fileSystem, '/project', ['src/models/**/*.ts', '!src/models/generated/**']);

        expect(files.map(toPosixPath)).toEqual([
            toPosixPath(nodePath.resolve('/project/src/models/Customer.ts')),
            toPosixPath(nodePath.resolve('/project/src/models/SalesOrder.ts')),
        ]);
    });

    it('accepts a pattern that names a single file', () => {
        const fileSystem = createInMemoryFileSystemAdapter({ '/project/src/models/Only.ts': '' });
        expect(resolveGlobs(fileSystem, '/project', ['src/models/Only.ts']).map(toPosixPath)).toEqual([toPosixPath(nodePath.resolve('/project/src/models/Only.ts'))]);
    });

    it('returns nothing when the base directory does not exist', () => {
        expect(resolveGlobs(createInMemoryFileSystemAdapter(), '/project', ['missing/**/*.ts'])).toEqual([]);
    });
});

describe('createInMemoryFileSystemAdapter()', () => {
    it('reads, writes, checks existence, and notifies watchers', () => {
        const fileSystem = createInMemoryFileSystemAdapter({ '/project/a.txt': 'A' });
        const changes: string[] = [];
        const stop = fileSystem.watch(['/project'], (changedPath) => changes.push(changedPath));

        fileSystem.ensureDirectory('/project/out');
        fileSystem.writeTextFile('/project/out/b.txt', 'B');
        fileSystem.emitChange('/project/out/b.txt');
        stop();
        fileSystem.emitChange('/project/ignored.txt');

        expect(fileSystem.readTextFile('/project/a.txt')).toBe('A');
        expect(fileSystem.fileExists('/project/out')).toBe(true);
        expect(fileSystem.fileExists('/project/out/b.txt')).toBe(true);
        expect(fileSystem.fileExists('/project/nope.txt')).toBe(false);
        expect(() => fileSystem.readTextFile('/project/nope.txt')).toThrow('File not found');
        expect(changes).toEqual(['/project/out/b.txt']);
    });
});

describe('createNodeFileSystemAdapter()', () => {
    const temporaryDirectory = nodeFileSystem.mkdtempSync(nodePath.join(os.tmpdir(), 'netsuite-repository-fs-'));

    afterAll(() => {
        nodeFileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    it('round-trips files on disk and lists them recursively', () => {
        const fileSystem = createNodeFileSystemAdapter();
        const nestedDirectory = nodePath.join(temporaryDirectory, 'nested');
        const filePath = nodePath.join(nestedDirectory, 'file.txt');

        fileSystem.ensureDirectory(nestedDirectory);
        fileSystem.writeTextFile(filePath, 'hello');

        expect(fileSystem.fileExists(filePath)).toBe(true);
        expect(fileSystem.readTextFile(filePath)).toBe('hello');
        expect(fileSystem.listFiles(temporaryDirectory)).toEqual([filePath]);
        expect(fileSystem.listFiles(filePath)).toEqual([filePath]);
        expect(fileSystem.listFiles(nodePath.join(temporaryDirectory, 'missing'))).toEqual([]);
    });

    it('watches existing paths and reports changes', async () => {
        const fileSystem = createNodeFileSystemAdapter();
        const watchedFile = nodePath.join(temporaryDirectory, 'watched.txt');
        fileSystem.writeTextFile(watchedFile, 'v1');

        const changes: string[] = [];
        const stop = fileSystem.watch([watchedFile, nodePath.join(temporaryDirectory, 'missing')], (changedPath) => changes.push(changedPath));
        fileSystem.writeTextFile(watchedFile, 'v2');
        await new Promise((resolve) => setTimeout(resolve, 200));
        stop();

        expect(changes.length).toBeGreaterThan(0);
    });
});
