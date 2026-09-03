import * as nodeFileSystem from 'fs';
import * as nodePath from 'path';

/** Minimal file system surface used by the build step so tests can run fully in memory. */
export interface FileSystemAdapter {
    readTextFile(filePath: string): string;
    writeTextFile(filePath: string, content: string): void;
    fileExists(filePath: string): boolean;
    ensureDirectory(directoryPath: string): void;
    /** Recursively lists absolute file paths under a directory. Returns [] when it does not exist. */
    listFiles(directoryPath: string): string[];
    /** Watches files or directories; returns a function that stops watching. */
    watch(paths: string[], onChange: (changedPath: string) => void): () => void;
}

export function toPosixPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function globToRegularExpression(pattern: string): RegExp {
    let expression = '';
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '*') {
            if (pattern[index + 1] === '*') {
                const followedBySlash = pattern[index + 2] === '/';
                expression += followedBySlash ? '(?:.*/)?' : '.*';
                index += followedBySlash ? 2 : 1;
            } else {
                expression += '[^/]*';
            }
        } else if (character === '?') {
            expression += '[^/]';
        } else if ('.+^${}()|[]\\'.includes(character)) {
            expression += `\\${character}`;
        } else {
            expression += character;
        }
    }
    return new RegExp(`^${expression}$`);
}

/** Matches a relative POSIX path against a glob supporting `**`, `*`, and `?`. */
export function matchesGlob(pattern: string, relativePath: string): boolean {
    return globToRegularExpression(toPosixPath(pattern)).test(toPosixPath(relativePath));
}

function globBaseDirectory(pattern: string): string {
    const segments = toPosixPath(pattern).split('/');
    const baseSegments: string[] = [];
    for (const segment of segments) {
        if (/[*?]/.test(segment)) {
            break;
        }
        baseSegments.push(segment);
    }
    return baseSegments.join('/');
}

/** Resolves glob patterns (relative to cwd) to sorted absolute file paths. Patterns starting with `!` exclude. */
export function resolveGlobs(fileSystem: FileSystemAdapter, cwd: string, patterns: string[]): string[] {
    const includes = patterns.filter((pattern) => !pattern.startsWith('!'));
    const excludes = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
    const matches = new Set<string>();

    for (const pattern of includes) {
        const baseDirectory = nodePath.resolve(cwd, globBaseDirectory(pattern));
        for (const filePath of fileSystem.listFiles(baseDirectory)) {
            const relativePath = toPosixPath(nodePath.relative(cwd, filePath));
            if (matchesGlob(pattern, relativePath) && !excludes.some((exclude) => matchesGlob(exclude, relativePath))) {
                matches.add(filePath);
            }
        }
    }

    return Array.from(matches).sort();
}

export function createNodeFileSystemAdapter(): FileSystemAdapter {
    const listFiles = (directoryPath: string): string[] => {
        if (!nodeFileSystem.existsSync(directoryPath)) {
            return [];
        }
        if (!nodeFileSystem.statSync(directoryPath).isDirectory()) {
            return [directoryPath];
        }
        return nodeFileSystem.readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
            const fullPath = nodePath.join(directoryPath, entry.name);
            return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
        });
    };

    return {
        readTextFile: (filePath) => nodeFileSystem.readFileSync(filePath, 'utf8'),
        writeTextFile: (filePath, content) => nodeFileSystem.writeFileSync(filePath, content, 'utf8'),
        fileExists: (filePath) => nodeFileSystem.existsSync(filePath),
        ensureDirectory: (directoryPath) => nodeFileSystem.mkdirSync(directoryPath, { recursive: true }),
        listFiles,
        watch: (paths, onChange) => {
            const watchers = paths
                .filter((watchedPath) => nodeFileSystem.existsSync(watchedPath))
                .map((watchedPath) => nodeFileSystem.watch(watchedPath, { recursive: true }, (_eventType, fileName) => {
                    onChange(fileName ? nodePath.join(watchedPath, String(fileName)) : watchedPath);
                }));
            return () => watchers.forEach((watcher) => watcher.close());
        },
    };
}

export interface InMemoryFileSystemAdapter extends FileSystemAdapter {
    readonly files: Map<string, string>;
    /** Simulates a change notification for tests. */
    emitChange(changedPath: string): void;
}

function normalizeKey(filePath: string): string {
    return toPosixPath(nodePath.resolve(filePath));
}

export function createInMemoryFileSystemAdapter(initialFiles: Record<string, string> = {}): InMemoryFileSystemAdapter {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const listeners = new Set<(changedPath: string) => void>();

    for (const [filePath, content] of Object.entries(initialFiles)) {
        files.set(normalizeKey(filePath), content);
    }

    return {
        files,
        readTextFile: (filePath) => {
            const content = files.get(normalizeKey(filePath));
            if (content === undefined) {
                throw new Error(`File not found: ${filePath}`);
            }
            return content;
        },
        writeTextFile: (filePath, content) => {
            files.set(normalizeKey(filePath), content);
        },
        fileExists: (filePath) => files.has(normalizeKey(filePath)) || directories.has(normalizeKey(filePath)),
        ensureDirectory: (directoryPath) => {
            directories.add(normalizeKey(directoryPath));
        },
        listFiles: (directoryPath) => {
            const key = normalizeKey(directoryPath);
            if (files.has(key)) {
                return [key];
            }
            const prefix = `${key}/`;
            return Array.from(files.keys()).filter((filePath) => filePath.startsWith(prefix)).sort();
        },
        watch: (_paths, onChange) => {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
        emitChange: (changedPath) => {
            listeners.forEach((listener) => listener(changedPath));
        },
    };
}
