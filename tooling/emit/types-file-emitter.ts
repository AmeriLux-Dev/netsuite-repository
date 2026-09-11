import { buildGeneratedFileHeader } from './header';

export interface TypesFileMember {
    name: string;
    optional: boolean;
    typeText: string;
}

/** One class of the types file: its interface, and for a record type the `<Class>Patch` and `<Class>Create` helpers. */
export interface TypesFileClass {
    className: string;
    /** Generated interface this one extends, when the model class has a collected base class. */
    baseClassName?: string;
    /** Own members only; inherited ones come from the base interface. */
    members: TypesFileMember[];
    /** Whether to emit `<Class>Patch` and `<Class>Create`: a record type whose config serialized. */
    helperTypes: boolean;
}

export interface TypesFileEmitOptions {
    classes: TypesFileClass[];
    libraryModule: string;
    version?: string;
}

/**
 * Emits the types file: the interface of every class, extending its base and referring to the other interfaces by
 * name (they all live in this one file), and for record types `<Class>Patch` and `<Class>Create`. Everything in it is
 * a type, so a bundler erases any import of it and a browser client can share it without the configs.
 */
export function emitTypesFile(options: TypesFileEmitOptions): string {
    const sortedClasses = [...options.classes].sort((left, right) => left.className.localeCompare(right.className));
    const lines: string[] = [buildGeneratedFileHeader('The interface of every model and the helper types of every record type. Type-only; safe to share with a client.', options.version)];

    if (sortedClasses.some((reference) => reference.helperTypes)) {
        lines.push(`import type { EntityCreate, EntityPatch } from '${options.libraryModule}';`, '');
    }

    sortedClasses.forEach((reference, index) => {
        if (index > 0) lines.push('');
        const extendsClause = reference.baseClassName ? ` extends ${reference.baseClassName}` : '';
        lines.push(`export interface ${reference.className}${extendsClause} {`);
        for (const member of reference.members) {
            lines.push(`    ${member.name}${member.optional ? '?' : ''}: ${member.typeText};`);
        }
        lines.push('}');
        if (reference.helperTypes) {
            lines.push('', `/** What \`update()\` takes for a ${reference.className}: a deep partial; subrecords merge, sublists take { update, add, remove }. */`);
            lines.push(`export type ${reference.className}Patch = EntityPatch<${reference.className}>;`);
            lines.push(`/** What \`create()\` takes for a ${reference.className}: a deep partial with sublists as arrays of partial lines. */`);
            lines.push(`export type ${reference.className}Create = EntityCreate<${reference.className}>;`);
        }
    });

    lines.push('');
    return lines.join('\n');
}
