import type { ModelTypeInfo, ModelTypeShape } from '../collect/property-type-reader';
import { isAnonymousShape } from '../collect/property-type-reader';
import { buildGeneratedFileHeader } from './header';

export interface TypeFileEmitOptions {
    modelName: string;
    types: ModelTypeInfo;
    libraryModule: string;
    version?: string;
}

function emitInterface(shape: ModelTypeShape): string {
    const members = shape.properties.map((property) => `    ${property.name}${property.optional ? '?' : ''}: ${property.typeText};`);
    return [`export interface ${shape.name} {`, ...members, '}'].join('\n');
}

/** Emits `<Model>.types.gen.ts`: plain interfaces plus patch and create helper types. */
export function emitTypeFile(options: TypeFileEmitOptions): string {
    const namedNestedShapes = options.types.nested.filter((shape) => !isAnonymousShape(shape));
    const sections = [
        buildGeneratedFileHeader(`Plain types for the ${options.modelName} model.`, options.version),
        `import type { RecordGraphPatch } from '${options.libraryModule}';`,
        '',
        ...namedNestedShapes.map((shape) => `${emitInterface(shape)}\n`),
        emitInterface(options.types.root),
        '',
        `export type ${options.modelName}Patch = RecordGraphPatch<${options.modelName}>;`,
        `export type ${options.modelName}Create = Partial<${options.modelName}>;`,
        '',
    ];
    return sections.join('\n');
}
