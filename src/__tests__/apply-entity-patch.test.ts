import { applyEntityPatch } from '../tracking/apply-patch';
import type { QueryConfig } from '../types';
import { salesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

const config = salesOrderModelConfig as QueryConfig<unknown>;

function order(): SalesOrderModel {
    return {
        id: 1,
        tranId: 'SO1',
        memo: 'old',
        shippingAddress: { addr1: '1 Main', city: 'Dallas' },
        lines: [
            { line: 0, itemId: 10, quantity: 2 },
            { line: 1, itemId: 11, quantity: 1 },
        ],
        customer: { companyName: 'Acme' },
    };
}

function apply(entity: SalesOrderModel, patch: Record<string, unknown>): SalesOrderModel {
    applyEntityPatch(config, entity as unknown as Record<string, unknown>, patch);
    return entity;
}

describe('applyEntityPatch() – scalars', () => {
    it('replaces values, clears with null, and skips undefined', () => {
        const entity = apply(order(), { memo: 'new', tranId: undefined });
        expect(entity.memo).toBe('new');
        expect(entity.tranId).toBe('SO1');

        expect(apply(order(), { memo: null }).memo).toBeNull();
    });

    it('rejects a property the model does not declare', () => {
        expect(() => apply(order(), { nickname: 'x' })).toThrow("'nickname' is not a property of 'salesorder'.");
    });

    it('rejects a reference, which is read-only', () => {
        expect(() => apply(order(), { customer: { companyName: 'Other' } })).toThrow("Reference 'salesorder.customer' is read-only; set its select field instead.");
    });
});

describe('applyEntityPatch() – subrecords', () => {
    it('merges into the existing subrecord', () => {
        const entity = apply(order(), { shippingAddress: { city: 'Austin' } });
        expect(entity.shippingAddress).toEqual({ addr1: '1 Main', city: 'Austin' });
    });

    it('creates the subrecord when the entity has none, and clears it with null', () => {
        const withoutAddress = { ...order(), shippingAddress: null as unknown as SalesOrderModel['shippingAddress'] };
        expect(apply(withoutAddress, { shippingAddress: { city: 'Austin' } }).shippingAddress).toEqual({ city: 'Austin' });
        expect(apply(order(), { shippingAddress: null }).shippingAddress).toBeNull();
    });

    it('rejects a scalar and an unknown nested property', () => {
        expect(() => apply(order(), { shippingAddress: 'Dallas' })).toThrow("Subrecord 'salesorder.shippingAddress' takes an object patch.");
        expect(() => apply(order(), { shippingAddress: { zip: '75001' } })).toThrow("'zip' is not a property of 'salesorder.shippingAddress'.");
    });
});

describe('applyEntityPatch() – sublists', () => {
    it('updates lines by their line field, adds, and removes', () => {
        const entity = apply(order(), {
            lines: {
                update: [{ line: 1, quantity: 9 }],
                add: [{ itemId: 12, quantity: 3 }],
                remove: [0],
            },
        });

        expect(entity.lines).toEqual([
            { line: 1, itemId: 11, quantity: 9 },
            { itemId: 12, quantity: 3 },
        ]);
    });

    it('falls back to the match field when the model declares no line field', () => {
        const byItem: QueryConfig<unknown> = {
            ...config,
            relationships: { ...config.relationships, lines: { ...config.relationships!.lines, lineField: undefined } as never },
        };
        const entity = order() as unknown as Record<string, unknown>;

        applyEntityPatch(byItem, entity, { lines: { update: [{ itemId: 11, quantity: 4 }], remove: ['10'] } });

        expect(entity.lines).toEqual([{ line: 1, itemId: 11, quantity: 4 }]);
    });

    it('copies added lines instead of aliasing the patch', () => {
        const added = { itemId: 12, quantity: 3 };
        const entity = apply(order(), { lines: { add: [added] } });
        expect(entity.lines[2]).not.toBe(added);
        expect(entity.lines[2]).toEqual(added);
    });

    it('rejects an array, a missing identity, an unknown line, and an unknown line property', () => {
        expect(() => apply(order(), { lines: [] })).toThrow("Sublist 'salesorder.lines' takes { update, add, remove }, not an array.");
        expect(() => apply(order(), { lines: { update: [{ quantity: 1 }] } })).toThrow("A line patch of 'salesorder.lines' needs a 'line' value.");
        expect(() => apply(order(), { lines: { update: [{ line: 7, quantity: 1 }] } })).toThrow("'salesorder.lines' has no line with line 7.");
        expect(() => apply(order(), { lines: { remove: [7] } })).toThrow("'salesorder.lines' has no line with line 7.");
        expect(() => apply(order(), { lines: { add: [{ rate: 1 }] } })).toThrow("'rate' is not a property of 'salesorder.lines'.");
    });

    it('rejects identity patching when the model declares neither a line field nor a match field', () => {
        const unidentified: QueryConfig<unknown> = {
            ...config,
            relationships: { ...config.relationships, lines: { ...config.relationships!.lines, lineField: undefined, matchField: undefined } as never },
        };
        const entity = order() as unknown as Record<string, unknown>;

        expect(() => applyEntityPatch(unidentified, entity, { lines: { update: [{ quantity: 1 }] } })).toThrow('declares no line field or match field');
        applyEntityPatch(unidentified, entity, { lines: { add: [{ itemId: 12, quantity: 3 }] } });
        expect((entity.lines as unknown[]).length).toBe(3);
    });
});
