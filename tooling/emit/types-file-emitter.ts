import { buildGeneratedFileHeader } from './header';

export interface TypesFileClassReference {
    className: string;
    /** Whether the class's generated file also exports `<Class>Patch` and `<Class>Create` (a record type whose config serialized). */
    helperTypes: boolean;
    /** Import path (extension-less, relative) of the class's generated file. */
    importPath: string;
}

export interface TypesFileEmitOptions {
    classes: TypesFileClassReference[];
    version?: string;
}

/**
 * Emits `types.gen.ts`: a barrel of type-only re-exports, so the interface and helper types of every generated class
 * are importable from one file without touching the configs, and a bundler erases the import entirely.
 */
export function emitTypesFile(options: TypesFileEmitOptions): string {
    const sortedClasses = [...options.classes].sort((left, right) => left.className.localeCompare(right.className));
    const header = buildGeneratedFileHeader('Type barrel: the interface and helper types of every generated model, re-exported type-only.', options.version);
    return [
        header,
        ...sortedClasses.map((reference) => {
            const names = reference.helperTypes
                ? [reference.className, `${reference.className}Create`, `${reference.className}Patch`]
                : [reference.className];
            return `export type { ${names.join(', ')} } from '${reference.importPath}';`;
        }),
        '',
    ].join('\n');
}
