import { buildFieldMap, getValueAtPath, mapRowsToResults, normalizeMappedResultKey, setValueAtPath, transformResultValue } from '../query';
import type { FieldMap, QueryField } from '../types';
import * as NsFormat from 'N/format';

const fields: Array<[string, QueryField]> = [
    ['id', { queryFieldId: 'id', type: 'integer', isPrimary: true }],
    ['name', { queryFieldId: 'companyname', alias: 'CompanyName', type: 'string' }],
    ['lines_itemId', { queryFieldId: 'item', component: 'lines', nestPath: 'lines.itemId', cardinality: 'many', type: 'integer' }],
    ['lines_qty', { queryFieldId: 'quantity', component: 'lines', nestPath: 'lines.qty', cardinality: 'many', type: 'float' }],
    ['address_city', { queryFieldId: 'city', component: 'address', nestPath: 'address.city' }],
];

const options = { fieldMap: buildFieldMap(fields), arrayPaths: ['lines'], primaryAlias: 'id', coerceEnabled: false };

describe('buildFieldMap', () => {
    it('keys the map by the normalized alias and keeps the output path', () => {
        expect(normalizeMappedResultKey('CompanyName')).toBe('companyname');
        expect(options.fieldMap.companyname).toEqual({ key: 'name', outputPath: 'name', field: fields[1][1] });
        expect(options.fieldMap.lines_itemid.outputPath).toBe('lines.itemId');
    });
});

describe('mapRowsToResults', () => {
    it('returns nothing for no rows', () => {
        expect(mapRowsToResults([], options)).toEqual([]);
    });

    it('groups fanned-out rows by the primary key whatever the key casing, and de-duplicates identical lines', () => {
        const rows = [
            { ID: 10, CompanyName: 'Acme', LINES_ITEMID: 1, lines_qty: 2, address_city: 'Dallas' },
            { ID: 10, CompanyName: 'Acme', LINES_ITEMID: 2, lines_qty: 3, address_city: 'Dallas' },
            { ID: 10, CompanyName: 'Acme', LINES_ITEMID: 2, lines_qty: 3, address_city: 'Dallas' },
            { ID: null, CompanyName: 'Ghost', LINES_ITEMID: 9, lines_qty: 9, address_city: null },
            { ID: 11, CompanyName: 'Bolt', LINES_ITEMID: null, lines_qty: null, address_city: null },
        ];
        expect(mapRowsToResults(rows, options)).toEqual([
            { id: 10, name: 'Acme', address: { city: 'Dallas' }, lines: [{ itemId: 1, qty: 2 }, { itemId: 2, qty: 3 }] },
            { id: 11, name: 'Bolt', address: { city: null }, lines: [] },
        ]);
    });

    it('maps one object per row when nothing fans out', () => {
        const flat = { ...options, arrayPaths: [], primaryAlias: undefined };
        expect(mapRowsToResults([{ id: 1, companyname: 'A', address_city: 'X' }], flat)).toEqual([{ id: 1, name: 'A', address: { city: 'X' }, lines: { itemId: null, qty: null } }]);
    });

    it('coerces and transforms values per field', () => {
        const map: FieldMap = buildFieldMap([
            ['id', { queryFieldId: 'id', type: 'integer', isPrimary: true }],
            ['score', { queryFieldId: 'score', type: 'float', transform: (value) => `${typeof value}:${String(value)}` }],
            ['flag', { queryFieldId: 'flag', type: 'boolean', coerce: false }],
        ]);
        expect(mapRowsToResults([{ id: '1', score: '2.5', flag: 'T' }], { fieldMap: map, arrayPaths: [], coerceEnabled: true })).toEqual([{ id: 1, score: 'number:2.5', flag: 'T' }]);
        expect(transformResultValue(undefined as never, {}, { queryFieldId: 'x' }, false)).toBeNull();
    });

    it('parses a date text once across the rows of one read, on the record and in its lines', () => {
        const mockParse = NsFormat.parse as unknown as jest.Mock;
        mockParse.mockReset();
        mockParse.mockImplementation(({ value }: { value: string }) => new Date(`${value}T00:00:00Z`));
        const map: FieldMap = buildFieldMap([
            ['id', { queryFieldId: 'id', type: 'integer', isPrimary: true }],
            ['tranDate', { queryFieldId: 'trandate', type: 'date' }],
            ['lines_shipDate', { queryFieldId: 'shipdate', component: 'lines', nestPath: 'lines.shipDate', cardinality: 'many', type: 'date' }],
        ]);
        const rows = [
            { id: 1, trandate: '2024-01-15', lines_shipdate: '2024-01-15' },
            { id: 1, trandate: '2024-01-15', lines_shipdate: '2024-02-01' },
            { id: 2, trandate: '2024-01-15', lines_shipdate: '2024-02-01' },
        ];

        const [first, second] = mapRowsToResults<{ tranDate: Date; lines: Array<{ shipDate: Date }> }>(rows, { fieldMap: map, arrayPaths: ['lines'], primaryAlias: 'id', coerceEnabled: true });

        expect(mockParse).toHaveBeenCalledTimes(2);
        expect(first.lines.map((line) => line.shipDate.toISOString().slice(0, 10))).toEqual(['2024-01-15', '2024-02-01']);
        expect(second.tranDate).toEqual(first.tranDate);
        expect(second.tranDate).not.toBe(first.tranDate);
    });
});

describe('setValueAtPath and getValueAtPath', () => {
    it('creates intermediate objects and overwrites non-object intermediates', () => {
        const target: Record<string, unknown> = { a: 'scalar', list: [] };
        setValueAtPath(target, 'a.b.c', 42);
        setValueAtPath(target, 'list.count', 5);
        expect(target).toEqual({ a: { b: { c: 42 } }, list: { count: 5 } });
        expect(getValueAtPath(target, 'a.b.c')).toBe(42);
        expect(getValueAtPath(target, 'a.x.y')).toBeUndefined();
        expect(getValueAtPath(null, 'a')).toBeUndefined();
    });
});
