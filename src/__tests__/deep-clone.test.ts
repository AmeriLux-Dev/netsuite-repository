import { cloneEntitySnapshot } from '../tracking';

describe('cloneEntitySnapshot()', () => {
    it('returns primitives and null unchanged', () => {
        expect(cloneEntitySnapshot(5)).toBe(5);
        expect(cloneEntitySnapshot('x')).toBe('x');
        expect(cloneEntitySnapshot(null)).toBeNull();
        expect(cloneEntitySnapshot(undefined)).toBeUndefined();
    });

    it('copies dates, arrays, and nested objects deeply and drops functions', () => {
        const when = new Date(2024, 0, 15);
        const original = { when, lines: [{ quantity: 1, tags: ['a'] }], nested: { deep: { value: true } }, act: () => 'no' };

        const copy = cloneEntitySnapshot(original);

        expect(copy).toEqual({ when, lines: [{ quantity: 1, tags: ['a'] }], nested: { deep: { value: true } } });
        expect(copy.when).not.toBe(when);
        expect(copy.lines).not.toBe(original.lines);
        expect(copy.lines[0]).not.toBe(original.lines[0]);
        expect(copy.nested.deep).not.toBe(original.nested.deep);
        expect('act' in copy).toBe(false);
    });

    it('allows the same object to appear twice without a cycle', () => {
        const shared = { value: 1 };
        expect(cloneEntitySnapshot({ first: shared, second: shared })).toEqual({ first: { value: 1 }, second: { value: 1 } });
        expect(cloneEntitySnapshot([shared, shared])).toEqual([{ value: 1 }, { value: 1 }]);
    });

    it('rejects circular references', () => {
        const circular: Record<string, unknown> = { name: 'loop' };
        circular.self = circular;
        expect(() => cloneEntitySnapshot(circular)).toThrow('Cannot snapshot an entity with circular references.');
    });
});
