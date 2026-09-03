import { configFromEntity } from '../model';
import { areFieldValuesEqual, buildAddedEntityPatch, diffTrackedEntity } from '../tracking';
import type { QueryConfig } from '../types';
import { DecoratedSalesOrder } from './model-fixtures';

const salesOrderConfig = configFromEntity(DecoratedSalesOrder) as QueryConfig<unknown>;

function snapshotOrder() {
    return {
        id: 1,
        tranId: 'SO1',
        memo: 'old',
        customerName: 'Acme',
        shippingAddress: { addr1: '1 Main', city: 'Dallas' },
        lines: [
            { line: 0, itemId: 10, quantity: 2 },
            { line: 1, itemId: 11, quantity: 1 },
            { line: 2, itemId: 12, quantity: 5 },
        ],
        customer: { companyName: 'Acme' },
    };
}

function withoutLineField(config: QueryConfig<unknown>, alsoWithoutMatchField = false): QueryConfig<unknown> {
    const lines = { ...(config.relationships!.lines as { kind: 'collection'; recordAccessId: string; fields: Record<string, string>; matchField?: string; lineField?: string }) };
    delete lines.lineField;
    if (alsoWithoutMatchField) {
        delete lines.matchField;
    }
    return { ...config, relationships: { ...config.relationships, lines } };
}

describe('areFieldValuesEqual()', () => {
    it('absorbs read-side coercion differences', () => {
        expect(areFieldValuesEqual('12', 12, 'integer')).toBe(true);
        expect(areFieldValuesEqual('12.5', 12.5, 'currency')).toBe(true);
        expect(areFieldValuesEqual('abc', 'abc', 'key')).toBe(true);
        expect(areFieldValuesEqual('abc', 'abd', 'key')).toBe(false);
        expect(areFieldValuesEqual('T', true, 'boolean')).toBe(true);
        expect(areFieldValuesEqual(' false ', false, 'checkbox')).toBe(true);
        expect(areFieldValuesEqual('maybe', true, 'boolean')).toBe(false);
        expect(areFieldValuesEqual(1, true, 'boolean')).toBe(true);
        expect(areFieldValuesEqual(new Date(2024, 0, 1), new Date(2024, 0, 1), 'date')).toBe(true);
        expect(areFieldValuesEqual(new Date(2024, 0, 1), new Date(2024, 0, 2), 'date')).toBe(false);
        expect(areFieldValuesEqual(new Date('bad'), new Date('bad'), 'date')).toBe(true);
        expect(areFieldValuesEqual(null, undefined, 'string')).toBe(true);
        expect(areFieldValuesEqual('', null, 'string')).toBe(true);
        expect(areFieldValuesEqual([1, 2], ['1', '2'], 'multiselect')).toBe(true);
        expect(areFieldValuesEqual([1, 2], [2, 1], 'multiselect')).toBe(false);
        expect(areFieldValuesEqual('a', 'b', undefined)).toBe(false);
    });
});

describe('diffTrackedEntity() – scalars and owned subrecords', () => {
    it('returns no patch when nothing changed', () => {
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), snapshotOrder())).toEqual({ patch: undefined, ignoredProperties: [] });
    });

    it('patches writable scalars and reports read-only changes', () => {
        const current = { ...snapshotOrder(), memo: 'new', tranId: 'SO2', customerName: 'Other', customer: { companyName: 'Other' } };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), current)).toEqual({
            patch: { memo: 'new' },
            ignoredProperties: ['tranId', 'customerName', 'customer_companyName'],
        });
    });

    it('treats cleared values as null', () => {
        const current = { ...snapshotOrder(), memo: undefined };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), current).patch).toEqual({ memo: null });
    });

    it('patches only the changed owned properties and nulls a removed subrecord', () => {
        const changedCity = { ...snapshotOrder(), shippingAddress: { addr1: '1 Main', city: 'Austin' } };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), changedCity).patch).toEqual({ shippingAddress: { city: 'Austin' } });

        const removed = { ...snapshotOrder(), shippingAddress: null };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), removed).patch).toEqual({ shippingAddress: { addr1: null, city: null } });
    });

    it('reports read-only owned properties and skips unmapped relationship fields', () => {
        const config: QueryConfig<unknown> = {
            ...salesOrderConfig,
            fields: { ...salesOrderConfig.fields, shippingAddress_city: { ...salesOrderConfig.fields.shippingAddress_city, readonly: true } },
            relationships: {
                ...salesOrderConfig.relationships,
                shippingAddress: { kind: 'owned', recordAccessId: 'shippingaddress', fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city', ghost: 'missing_field' } },
            },
        };
        const current = { ...snapshotOrder(), shippingAddress: { addr1: '2 Main', city: 'Austin', ghost: 'x' } };
        expect(diffTrackedEntity(config, snapshotOrder(), current)).toEqual({ patch: { shippingAddress: { addr1: '2 Main' } }, ignoredProperties: ['shippingAddress_city'] });
    });
});

describe('diffTrackedEntity() – collections', () => {
    it('identifies lines by the line number property, adjusting indexes for removed lines', () => {
        const current = { ...snapshotOrder(), lines: [
            { line: 1, itemId: 11, quantity: 1 },
            { line: 2, itemId: 12, quantity: 7 },
            { itemId: 13, quantity: 3, amount: 99 },
        ] };

        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), current).patch).toEqual({
            lines: {
                update: [{ line: 1, values: { quantity: 7 } }],
                add: [{ itemId: 13, quantity: 3 }],
                remove: [0],
            },
        });
    });

    it('identifies lines by the match property when no line number property is configured', () => {
        const config = withoutLineField(salesOrderConfig);
        const current = { ...snapshotOrder(), lines: [
            { line: 0, itemId: 10, quantity: 2 },
            { line: 1, itemId: 11, quantity: 4 },
        ] };

        expect(diffTrackedEntity(config, snapshotOrder(), current).patch).toEqual({
            lines: {
                update: [{ match: { field: 'itemId', value: 11 }, values: { quantity: 4 } }],
                remove: [2],
            },
        });
    });

    it('falls back to array positions and ignores non-object lines', () => {
        const config = withoutLineField(salesOrderConfig, true);
        const current = { ...snapshotOrder(), lines: [
            { line: 0, itemId: 10, quantity: 2 },
            null,
            { line: 1, itemId: 11, quantity: 9 },
        ] };

        expect(diffTrackedEntity(config, snapshotOrder(), current).patch).toEqual({
            lines: {
                update: [{ line: 1, values: { quantity: 9 } }],
                remove: [2],
            },
        });
    });

    it('reports read-only line changes and removes every line when the collection is cleared', () => {
        const readOnlyChange = { ...snapshotOrder(), lines: snapshotOrder().lines.map((line) => ({ ...line, amount: 5 })) };
        const config: QueryConfig<unknown> = { ...salesOrderConfig, fields: { ...salesOrderConfig.fields, lines_amount: { queryFieldId: 'amount', tableAlias: 'tl', readonly: true, nestPath: 'lines.amount', cardinality: 'many' } }, relationships: { ...salesOrderConfig.relationships, lines: { ...(salesOrderConfig.relationships!.lines as object), fields: { ...(salesOrderConfig.relationships!.lines as { fields: Record<string, string> }).fields, amount: 'lines_amount' } } as never } };
        expect(diffTrackedEntity(config, snapshotOrder(), readOnlyChange)).toEqual({ patch: undefined, ignoredProperties: ['lines_amount', 'lines_amount', 'lines_amount'] });

        const cleared = { ...snapshotOrder(), lines: undefined };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), cleared).patch).toEqual({ lines: { remove: [0, 1, 2] } });
    });

    it('skips relationship line fields that are not in the config', () => {
        const lines = salesOrderConfig.relationships!.lines as { fields: Record<string, string> };
        const config: QueryConfig<unknown> = { ...salesOrderConfig, relationships: { ...salesOrderConfig.relationships, lines: { ...lines, fields: { ...lines.fields, ghost: 'missing_field' } } as never } };
        const current = { ...snapshotOrder(), lines: snapshotOrder().lines.map((line) => ({ ...line, ghost: 'x' })) };
        expect(diffTrackedEntity(config, snapshotOrder(), current).patch).toBeUndefined();
    });

    it('skips added lines that carry no writable values', () => {
        const current = { ...snapshotOrder(), lines: [...snapshotOrder().lines, { amount: 1 }] };
        expect(diffTrackedEntity(salesOrderConfig, snapshotOrder(), current).patch).toBeUndefined();
    });
});

describe('buildAddedEntityPatch()', () => {
    it('includes every defined writable value, owned values, and lines as adds', () => {
        const added = {
            tranId: 'SO9',
            memo: 'hello',
            shippingAddress: { addr1: '9 Main', city: undefined },
            lines: [{ itemId: 1, quantity: 2 }, { itemId: 2 }],
            customer: { companyName: 'x' },
        };

        expect(buildAddedEntityPatch(salesOrderConfig, added)).toEqual({
            patch: {
                memo: 'hello',
                shippingAddress: { addr1: '9 Main' },
                lines: { add: [{ itemId: 1, quantity: 2 }, { itemId: 2 }] },
            },
            ignoredProperties: ['tranId', 'customer_companyName'],
        });
    });

    it('returns an empty patch for an empty entity', () => {
        expect(buildAddedEntityPatch(salesOrderConfig, {})).toEqual({ patch: undefined, ignoredProperties: [] });
    });
});
