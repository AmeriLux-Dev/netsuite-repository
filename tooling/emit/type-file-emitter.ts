import { buildGeneratedFileHeader } from './header';

export interface TypeFileMember {
    name: string;
    optional: boolean;
    typeText: string;
}

export interface TypeFileEmitOptions {
    className: string;
    /** Generated interface this one extends, when the model class has a collected base class. */
    baseClassName?: string;
    /** Own members only; inherited ones come from the base interface. */
    members: TypeFileMember[];
    /** Other generated classes referenced by the members or the base, imported from their own type files. */
    imports: string[];
    /** Record types also get the patch and create helper types. */
    isRecordType: boolean;
    libraryModule: string;
    version?: string;
}

/** Emits `<Class>.types.gen.ts`: one plain interface per model class plus, for record types, the patch and create helper types. */
export function emitTypeFile(options: TypeFileEmitOptions): string {
    const imports = Array.from(new Set(options.imports)).filter((name) => name !== options.className).sort();
    const lines = [buildGeneratedFileHeader(`Plain type for the ${options.className} model.`, options.version)];
    if (options.isRecordType) {
        lines.push(`import type { RecordGraphPatch } from '${options.libraryModule}';`);
    }
    for (const name of imports) {
        lines.push(`import type { ${name} } from './${name}.types.gen';`);
    }
    if (options.isRecordType || imports.length > 0) {
        lines.push('');
    }

    const extendsClause = options.baseClassName ? ` extends ${options.baseClassName}` : '';
    lines.push(`export interface ${options.className}${extendsClause} {`);
    for (const member of options.members) {
        lines.push(`    ${member.name}${member.optional ? '?' : ''}: ${member.typeText};`);
    }
    lines.push('}');

    if (options.isRecordType) {
        lines.push('', `export type ${options.className}Patch = RecordGraphPatch<${options.className}>;`, `export type ${options.className}Create = Partial<${options.className}>;`);
    }
    lines.push('');
    return lines.join('\n');
}
