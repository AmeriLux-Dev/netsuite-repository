import { batchValues, buildFieldMap, collectDistinctParentKeys, loadSeparateRelationsIntoResults } from '../query';
import type { ResultMappingOptions, ResultRow } from '../query';
import type { QueryDescription, SeparateLoadDescription } from '../types';

const lineMapping: ResultMappingOptions = {
    fieldMap: buildFieldMap([['lines_qty', { queryFieldId: 'quantity', nestPath: 'qty' }]]),
    arrayPaths: [],
    coerceEnabled: false,
};

const emptyDescription: QueryDescription = { queryType: 'salesorder', components: [], columns: [], sort: [] };

function sublistLoad(overrides: Partial<SeparateLoadDescription> = {}): SeparateLoadDescription {
    return { relationship: 'lines', kind: 'sublist', description: emptyDescription, parentKeyPath: 'id', batchFieldId: 'id', parentKeyAlias: '__parentKey', ...overrides };
}

describe('collectDistinctParentKeys and batchValues', () => {
    it('collect distinct keys in first-seen order, skipping null and undefined', () => {
        expect(collectDistinctParentKeys([{ id: 2 }, { id: 1 }, { id: 2 }, { id: null }, {}], 'id')).toEqual([2, 1]);
        expect(batchValues([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(batchValues([], 2)).toEqual([]);
    });
});

describe('loadSeparateRelationsIntoResults', () => {
    it('queries per batch with the batch condition ANDed to the load condition and stitches arrays', () => {
        const executed: QueryDescription[] = [];
        const parents = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const load = sublistLoad({ description: { ...emptyDescription, condition: { kind: 'field', fieldId: 'quantity', operator: 'GREATER', values: [0] } } });
        loadSeparateRelationsIntoResults(parents, [load], {
            batchSize: 2,
            mappingOptionsFor: () => lineMapping,
            executeDescription: (description): ResultRow[] => {
                executed.push(description);
                const rows: ResultRow[] = [{ __PARENTKEY: 1, lines_qty: 5 }, { __parentkey: 2, lines_qty: 6 }, { __parentkey: 1, lines_qty: 7 }, { __parentkey: null, lines_qty: 9 }, { lines_qty: 10 }];
                return executed.length === 1 ? rows : [];
            },
        });
        expect(parents).toEqual([{ id: 1, lines: [{ qty: 5 }, { qty: 7 }] }, { id: 2, lines: [{ qty: 6 }] }, { id: 3, lines: [] }]);
        expect(executed.map((description) => description.condition)).toEqual([
            { kind: 'and', nodes: [{ kind: 'field', fieldId: 'id', operator: 'ANY_OF', values: [1, 2] }, { kind: 'field', fieldId: 'quantity', operator: 'GREATER', values: [0] }] },
            { kind: 'and', nodes: [{ kind: 'field', fieldId: 'id', operator: 'ANY_OF', values: [3] }, { kind: 'field', fieldId: 'quantity', operator: 'GREATER', values: [0] }] },
        ]);
    });

    it('stitches a single object or null for subrecords and references, and recurses into nested loads', () => {
        const nested = sublistLoad({ relationship: 'notes', parentKeyPath: 'id', batchFieldId: 'address' });
        const addressMapping: ResultMappingOptions = {
            fieldMap: buildFieldMap([['address_id', { queryFieldId: 'id', nestPath: 'id' }], ['address_city', { queryFieldId: 'city', nestPath: 'city' }]]),
            arrayPaths: [],
            coerceEnabled: false,
        };
        const load: SeparateLoadDescription = { relationship: 'address', kind: 'subrecord', description: { ...emptyDescription, separateLoads: [nested] }, parentKeyPath: 'id', batchFieldId: 'id', parentKeyAlias: '__parentKey' };
        const parents = [{ id: 1 }, { id: 2 }];
        const executed: QueryDescription[] = [];
        loadSeparateRelationsIntoResults(parents, [load], {
            batchSize: 10,
            mappingOptionsFor: (candidate) => (candidate.relationship === 'address' ? addressMapping : lineMapping),
            executeDescription: (description) => {
                executed.push(description);
                return executed.length === 1 ? [{ __parentkey: 1, address_id: 40, address_city: 'Dallas' }] : [{ __parentkey: 40, lines_qty: 1 }];
            },
        });
        expect(parents).toEqual([{ id: 1, address: { id: 40, city: 'Dallas', notes: [{ qty: 1 }] } }, { id: 2, address: null }]);
        expect(executed[1].condition).toEqual({ kind: 'field', fieldId: 'address', operator: 'ANY_OF', values: [40] });
    });

    it('batches a text key as one EQUAL per value, since ANY_OF applies to select and key fields only', () => {
        const executed: QueryDescription[] = [];
        const load = sublistLoad({ relationship: 'carrier', kind: 'reference', parentKeyPath: 'code', batchFieldId: 'custrecord_code', batchFieldType: 'string' });
        loadSeparateRelationsIntoResults([{ id: 1, code: 'FDX' }, { id: 2, code: 'UPS' }], [load], {
            batchSize: 10,
            mappingOptionsFor: () => lineMapping,
            executeDescription: (description) => {
                executed.push(description);
                return [];
            },
        });
        expect(executed[0].condition).toEqual({
            kind: 'or',
            nodes: [{ kind: 'field', fieldId: 'custrecord_code', operator: 'EQUAL', values: ['FDX'] }, { kind: 'field', fieldId: 'custrecord_code', operator: 'EQUAL', values: ['UPS'] }],
        });
    });

    it('does nothing when no parent has a key', () => {
        const executeDescription = jest.fn();
        loadSeparateRelationsIntoResults([{ id: null }], [sublistLoad()], { batchSize: 10, mappingOptionsFor: () => lineMapping, executeDescription });
        expect(executeDescription).not.toHaveBeenCalled();
    });
});
