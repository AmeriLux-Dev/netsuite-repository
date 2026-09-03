export class SerializationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SerializationError';
    }
}

export interface SerializeOptions {
    /** Functions that can be referenced by an imported identifier instead of being inlined. */
    functionReferences?: Map<Function, string>;
    indent?: string;
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

function serializeValue(value: unknown, path: string, depth: number, options: Required<SerializeOptions>): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return quote(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return value === Number.POSITIVE_INFINITY ? 'Number.POSITIVE_INFINITY' : value === Number.NEGATIVE_INFINITY ? 'Number.NEGATIVE_INFINITY' : 'Number.NaN';
        }
        return String(value);
    }
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'function') {
        const reference = options.functionReferences.get(value);
        if (!reference) {
            throw new SerializationError(`Function at '${path}' must be exported from the model file so it can be imported by name.`);
        }
        return reference;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const inner = options.indent.repeat(depth + 1);
        const items = value.map((item, index) => `${inner}${serializeValue(item, `${path}[${index}]`, depth + 1, options)}`);
        return `[\n${items.join(',\n')},\n${options.indent.repeat(depth)}]`;
    }
    if (typeof value === 'object') {
        // Realm-agnostic plain-object check: a plain object's prototype is an Object.prototype whose own prototype is null.
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
            throw new SerializationError(`Value at '${path}' is a ${(prototype.constructor as { name?: string }).name ?? 'class'} instance and cannot be serialized.`);
        }
        const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
        if (entries.length === 0) return '{}';
        const inner = options.indent.repeat(depth + 1);
        const members = entries.map(([key, entry]) => `${inner}${identifierPattern.test(key) ? key : quote(key)}: ${serializeValue(entry, `${path}.${key}`, depth + 1, options)}`);
        return `{\n${members.join(',\n')},\n${options.indent.repeat(depth)}}`;
    }
    throw new SerializationError(`Value of type ${typeof value} at '${path}' cannot be serialized.`);
}

/** Serializes plain data (and referenced functions) to a TypeScript object literal. */
export function serializeToTypeScriptLiteral(value: unknown, options: SerializeOptions = {}): string {
    return serializeValue(value, '$', 0, { functionReferences: options.functionReferences ?? new Map(), indent: options.indent ?? '    ' });
}
