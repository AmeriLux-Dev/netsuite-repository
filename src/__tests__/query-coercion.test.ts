import { QueryBuilder } from '../query';
import type { QueryConfig } from '../types';
import { customerConfig, orderConfig } from './fixtures';
import * as NsQuery from 'N/query';
import * as NsFormat from 'N/format';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;
const mockParse = NsFormat.parse as unknown as jest.Mock;

function mockRows(rows: Record<string, unknown>[]) {
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => rows });
}

function extendCustomerConfig<TResult>(overrides: Partial<QueryConfig<any>>): QueryConfig<TResult> {
    return { ...(customerConfig as QueryConfig<any>), ...overrides };
}

const coercedCustomerConfig = extendCustomerConfig<{ id: number; name: string; isActive: boolean; score: number; created: Date }>({
    coerce: true,
    fields: {
        ...customerConfig.fields,
        created: { queryFieldId: 'datecreated', tableAlias: 'cust', type: 'date' },
    },
});

const customerRow = { id: '1', name: 'Acme', email: '', isactive: 'T', score: '10.5', created: '1/15/2024' };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('QueryBuilder.executeTyped() – read coercion', () => {
    it('leaves values untouched for configs without coerce', () => {
        mockRows([customerRow]);
        const [customer] = QueryBuilder.from(customerConfig).executeTyped();
        expect(customer).toMatchObject({ id: '1', isActive: 'T', score: '10.5' });
    });

    it('coerces numbers, booleans, and dates when the config opts in', () => {
        const parsed = new Date(2024, 0, 15);
        mockParse.mockReturnValue(parsed);
        mockRows([customerRow]);

        const [customer] = QueryBuilder.from(coercedCustomerConfig).executeTyped();

        expect(customer).toMatchObject({ id: 1, isActive: true, score: 10.5 });
        expect(customer.created).toBe(parsed);
    });

    it('can be switched on per query with coerce()', () => {
        mockRows([customerRow]);
        const [customer] = QueryBuilder.from(customerConfig).coerce().executeTyped();
        expect(customer).toMatchObject({ id: 1, isActive: true, score: 10.5 });
    });

    it('can be switched off per query with coerce(false)', () => {
        mockRows([customerRow]);
        const [customer] = QueryBuilder.from(coercedCustomerConfig).coerce(false).executeTyped();
        expect(customer).toMatchObject({ id: '1', isActive: 'T' });
    });

    it('honors a per-field coerce override in both directions', () => {
        const mixedConfig = extendCustomerConfig<{ id: number; score: number; isActive: boolean }>({
            fields: {
                id: customerConfig.fields.id,
                score: { ...customerConfig.fields.score, coerce: true },
                isActive: { ...customerConfig.fields.isActive, coerce: false },
            },
        });
        mockRows([{ id: '1', score: '2', isactive: 'T' }]);

        const [row] = QueryBuilder.from(mixedConfig).coerce().executeTyped();

        expect(row).toEqual({ id: 1, score: 2, isActive: 'T' });
    });

    it('passes the coerced value to transform', () => {
        const transformedConfig = extendCustomerConfig<{ id: number; score: string }>({
            coerce: true,
            fields: {
                id: customerConfig.fields.id,
                score: { ...customerConfig.fields.score, transform: (value) => `${typeof value}:${String(value)}` },
            },
        });
        mockRows([{ id: '1', score: '3' }]);

        const [row] = QueryBuilder.from(transformedConfig).executeTyped();

        expect(row.score).toBe('number:3');
    });

    it('coerces values inside grouped array items', () => {
        mockRows([
            { id: '1', entityid: '5', lines_itemid: '10', lines_qty: '2', lines_amount: '20.5' },
            { id: '1', entityid: '5', lines_itemid: '11', lines_qty: '1', lines_amount: '5' },
        ]);

        const [order] = QueryBuilder.from(orderConfig).coerce().executeTyped();

        expect(order.id).toBe(1);
        expect(order.lines).toEqual([
            { itemId: 10, qty: 2, amount: 20.5 },
            { itemId: 11, qty: 1, amount: 5 },
        ]);
    });
});
