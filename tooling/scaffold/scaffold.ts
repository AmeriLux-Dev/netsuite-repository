import * as nodePath from 'path';
import type { FileSystemAdapter } from '../file-system';
import { createSnapshotMetadataProvider, mergeMetadataSnapshots, parseMetadataSnapshot } from './metadata';
import type { MetadataProvider, MetadataSnapshot, RecordTypeMetadataDescriptor } from './metadata';
import { scaffoldRecordModel } from './stub-emitter';
import type { ScaffoldRecordOptions } from './stub-emitter';

export interface ScaffoldOptions {
    provider: MetadataProvider;
    records: Array<Omit<ScaffoldRecordOptions, 'libraryModule' | 'version'>>;
    outDir: string;
    cwd: string;
    fileSystem: FileSystemAdapter;
    libraryModule: string;
    version?: string;
    /** Overwrite existing model files. Off by default because scaffolded files are hand-edited afterwards. */
    force?: boolean;
}

export interface ScaffoldResult {
    writtenFiles: string[];
    skippedFiles: string[];
    todos: Array<{ modelName: string; message: string }>;
    errors: Array<{ recordType: string; message: string }>;
}

/** Writes one decorated model stub per record type. Existing files are left alone unless `force` is set. */
export async function runScaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
    const result: ScaffoldResult = { writtenFiles: [], skippedFiles: [], todos: [], errors: [] };
    const outDir = nodePath.resolve(options.cwd, options.outDir);

    for (const record of options.records) {
        let scaffolded;
        try {
            scaffolded = await scaffoldRecordModel(options.provider, { ...record, libraryModule: options.libraryModule, version: options.version });
        } catch (error) {
            result.errors.push({ recordType: record.recordType, message: error instanceof Error ? error.message : String(error) });
            continue;
        }

        const filePath = nodePath.join(outDir, `${scaffolded.modelName}.ts`);
        if (options.fileSystem.fileExists(filePath) && !options.force) {
            result.skippedFiles.push(filePath);
            continue;
        }
        options.fileSystem.ensureDirectory(outDir);
        options.fileSystem.writeTextFile(filePath, scaffolded.content);
        result.writtenFiles.push(filePath);
        result.todos.push(...scaffolded.todos.map((message) => ({ modelName: scaffolded.modelName, message })));
    }

    return result;
}

/** Loads one or more snapshot files (record metadata, table metadata, or both) and merges them. */
export function loadMetadataSnapshots(fileSystem: FileSystemAdapter, cwd: string, snapshotPaths: string[]): MetadataSnapshot {
    let merged: MetadataSnapshot = { records: {}, tables: {} };
    for (const snapshotPath of snapshotPaths) {
        const resolved = nodePath.resolve(cwd, snapshotPath);
        if (!fileSystem.fileExists(resolved)) {
            throw new Error(`Metadata snapshot '${resolved}' does not exist.`);
        }
        merged = mergeMetadataSnapshots(merged, parseMetadataSnapshot(JSON.parse(fileSystem.readTextFile(resolved)), `snapshot '${resolved}'`));
    }
    return merged;
}

/** Fetches record metadata through a provider and writes it as a snapshot file for offline or CI use. */
export async function writeRecordMetadataSnapshot(provider: MetadataProvider, recordTypes: string[], fileSystem: FileSystemAdapter, snapshotPath: string): Promise<{ records: string[]; missing: string[] }> {
    const records: Record<string, RecordTypeMetadataDescriptor> = {};
    const missing: string[] = [];
    for (const recordType of recordTypes) {
        const descriptor = await provider.getRecordTypeMetadata(recordType);
        if (descriptor) {
            records[recordType.toLowerCase()] = descriptor;
        } else {
            missing.push(recordType);
        }
    }
    const sorted = Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)));
    fileSystem.ensureDirectory(nodePath.dirname(snapshotPath));
    fileSystem.writeTextFile(snapshotPath, `${JSON.stringify({ records: sorted, tables: {} }, null, 2)}\n`);
    return { records: Object.keys(sorted), missing };
}

export { createSnapshotMetadataProvider };
