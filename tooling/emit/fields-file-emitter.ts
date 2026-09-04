import { buildGeneratedFileHeader } from './header';

/** A field path per property, nested by relation: `{ id: 'id', lines: { item: { type: 'lines.item.type' } } }`. */
export interface FieldPathTree {
    [name: string]: string | FieldPathTree;
}

export interface FieldsFileEmitOptions {
    modelName: string;
    tree: FieldPathTree;
    version?: string;
}

function isIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function renderTree(tree: FieldPathTree, indent: string): string[] {
    const lines: string[] = [];
    for (const [name, entry] of Object.entries(tree)) {
        const key = isIdentifier(name) ? name : `'${name}'`;
        if (typeof entry === 'string') {
            lines.push(`${indent}${key}: '${entry}',`);
        } else {
            lines.push(`${indent}${key}: {`, ...renderTree(entry, `${indent}    `), `${indent}},`);
        }
    }
    return lines;
}

/**
 * Emits `<Model>.fields.gen.ts`: a constant whose properties mirror the model and hold its field paths, so a
 * specification can say `where(SalesOrderFields.lines.item.type, 'IN', ...)` instead of spelling the path.
 */
export function emitFieldsFile(options: FieldsFileEmitOptions): string {
    const { modelName } = options;
    return [
        buildGeneratedFileHeader(`Field paths of the ${modelName} model, for where(), orderBy(), and select().`, options.version),
        `export const ${modelName}Fields = {`,
        ...renderTree(options.tree, '    '),
        '} as const;',
        '',
    ].join('\n');
}
