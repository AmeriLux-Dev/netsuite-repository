/**
 * Copies an entity graph so it can later be diffed against the live object.
 * Dates are copied, arrays and plain objects recurse, functions and prototypes are dropped.
 * structuredClone is unavailable in SuiteScript, so this stays hand-written and small.
 */
export function cloneEntitySnapshot<T>(value: T, visited: WeakSet<object> = new WeakSet()): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as T;
    }

    if (visited.has(value as unknown as object)) {
        throw new Error('Cannot snapshot an entity with circular references.');
    }
    visited.add(value as unknown as object);

    if (Array.isArray(value)) {
        const copy = value.map((item) => cloneEntitySnapshot(item, visited));
        visited.delete(value as unknown as object);
        return copy as unknown as T;
    }

    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry !== 'function') {
            copy[key] = cloneEntitySnapshot(entry, visited);
        }
    }
    visited.delete(value as unknown as object);
    return copy as T;
}
