import { defineQueryConfig, normalizeQueryConfig, normalizeQueryField } from '../types';
import type { QueryFieldConfig, QueryField } from '../types';
import { RecordSet } from '../context';
import { query } from '../query';
import type { GroupableFieldPath, NumericFieldPath } from '../field-path';
import { customerInvoiceConfig, orderConfig } from './fixtures';
import type { CustomerInvoice, Order } from './fixtures';

/** True only when the two types are the same, not merely assignable. */
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2) ? true : false;
function expectType<TCheck extends true>(check?: TCheck): TCheck | undefined {
    return check;
}

describe('normalizeQueryField', () => {
    it('returns a plain QueryField unchanged', () => {
        const field: QueryField = { queryFieldId: 'id', type: 'integer' };
        expect(normalizeQueryField(field)).toBe(field);
    });

    it('merges query + common + record sections', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'companyname' },
            common: { type: 'string', isPrimary: false },
            record: { recordFieldId: 'companyname', recordAccess: 'body' },
        };
        expect(normalizeQueryField(input)).toEqual({
            queryFieldId: 'companyname',
            type: 'string',
            isPrimary: false,
            recordFieldId: 'companyname',
            recordAccess: 'body',
        });
    });

    it('merges query + common without record', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'email', component: 'customer' },
            common: { type: 'string' },
        };
        const result = normalizeQueryField(input);
        expect(result.queryFieldId).toBe('email');
        expect(result.component).toBe('customer');
        expect(result.type).toBe('string');
        expect(result.recordFieldId).toBeUndefined();
    });

    it('merges query + record without common', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'memo' },
            record: { recordFieldId: 'memo' },
        };
        const result = normalizeQueryField(input);
        expect(result.queryFieldId).toBe('memo');
        expect(result.recordFieldId).toBe('memo');
        expect(result.type).toBeUndefined();
    });

    it('record overrides common when both are present', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'status' },
            common: { type: 'string', recordFieldId: 'status_common' },
            record: { recordFieldId: 'status_record' },
        };
        expect(normalizeQueryField(input).recordFieldId).toBe('status_record');
    });
});

describe('normalizeQueryConfig', () => {
    it('normalizes all fields in the config', () => {
        const config = normalizeQueryConfig({
            recordType: 'customer',
            fields: {
                id: { queryFieldId: 'id' },
                name: {
                    query:  { queryFieldId: 'companyname' },
                    common: { type: 'string' },
                },
            },
        });
        expect(config.fields.id.queryFieldId).toBe('id');
        expect(config.fields.name.type).toBe('string');
    });

    it('defaults the query type to the record type and the components to an empty map', () => {
        const config = normalizeQueryConfig({ recordType: 'customer', fields: { id: { queryFieldId: 'id' } } });
        expect(config.queryType).toBe('customer');
        expect(config.components).toEqual({});
    });

    it('keeps a declared query type and component map', () => {
        const config = normalizeQueryConfig({
            recordType: 'salesorder',
            queryType: 'transaction',
            components: { lines: { path: 'lines', relationship: 'lines', load: 'join', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' } } },
            fields: { id: { queryFieldId: 'id' } },
        });
        expect(config.queryType).toBe('transaction');
        expect(config.components?.lines.join).toEqual({ kind: 'from', fieldId: 'transaction', source: 'transactionline' });
    });

    it('preserves non-field config properties', () => {
        const config = normalizeQueryConfig({
            recordType: 'myRecord',
            fields: { id: { queryFieldId: 'id' } },
            composite: { updateMode: 'explicit' },
        });
        expect(config.recordType).toBe('myRecord');
        expect(config.composite?.updateMode).toBe('explicit');
    });
});

describe('defineQueryConfig', () => {
    it('returns the config with normalized fields', () => {
        const config = defineQueryConfig<{ id: number }>({
            recordType: 'test',
            fields: {
                id: {
                    query:  { queryFieldId: 'id' },
                    common: { type: 'integer', isPrimary: true },
                },
            },
        });
        expect(config.fields.id.isPrimary).toBe(true);
        expect(config.fields.id.type).toBe('integer');
    });

    it('accepts an already-normalized QueryConfig', () => {
        const config = defineQueryConfig<{ id: number }>({
            recordType: 'test',
            fields: {
                id: { queryFieldId: 'id', type: 'integer', isPrimary: true },
            },
        });
        expect(config.fields.id.queryFieldId).toBe('id');
    });
});

describe('grouped reads – types', () => {
    it('types a group by its keys and aggregates, and turns what N/query cannot group into compile errors', () => {
        // Never executed: these lines exist for the type checker only. ts-jest reports any expectation that stops failing.
        const typeChecks = () => {
            const groups = query(customerInvoiceConfig)
                .groupBy('customerId', 'subsidiaryId', 'customer.companyName', 'currencyName')
                .aggregate('COUNT', 'id', 'invoiceCount')
                .aggregate('COUNT_DISTINCT', 'status', 'statusCount')
                .aggregate('SUM', 'amountUnpaid', 'unpaid')
                .aggregate('AVERAGE', 'daysOpen', 'averageDaysOpen')
                .aggregate('MEDIAN', 'total', 'medianTotal')
                .aggregate('MAXIMUM', 'tranDate', 'lastInvoiced')
                .aggregate('MINIMUM_DISTINCT', 'isVoided', 'anyVoided')
                .aggregate('MAXIMUM', 'currencyName', 'lastCurrency')
                .aggregateFormula('SUM', '{foreignamountunpaid}', 'pastDue', { type: 'FLOAT', fieldType: 'currency' })
                .aggregateFormula('MAXIMUM', '{trandate} + 30', 'lastDue', { type: 'DATE', fieldType: 'date' })
                .aggregateFormula('COUNT', '{id}', 'formulaCount')
                .orderByDesc('unpaid')
                .orderByAsc('customerId')
                .list();
            expectType<Equal<typeof groups, Array<{
                customerId: number;
                subsidiaryId: number;
                customer: { companyName: string };
                currencyName: string | null;
                invoiceCount: number;
                statusCount: number;
                unpaid: number | null;
                averageDaysOpen: number | null;
                medianTotal: number | null;
                lastInvoiced: Date | null;
                anyVoided: boolean | null;
                lastCurrency: string | null;
                pastDue: number | null;
                lastDue: Date | null;
                formulaCount: number;
            }>>>(true);

            const quantities = new RecordSet(orderConfig).groupBy('lines.itemId').aggregate('SUM', 'lines.qty', 'quantity').list();
            expectType<Equal<typeof quantities, Array<{ lines: { itemId: number }; quantity: number | null }>>>(true);

            const byYear = query(customerInvoiceConfig).selectFormula("TO_CHAR({trandate}, 'YYYY')", 'tranYear', { type: 'STRING' }).groupBy('tranYear').list();
            expectType<Equal<typeof byYear, Array<{ tranYear: unknown }>>>(true);

            const numeric: NumericFieldPath<CustomerInvoice> = 'amountUnpaid';
            const throughLines: GroupableFieldPath<Order> = 'lines.qty';

            const invoices = query(customerInvoiceConfig);
            // @ts-expect-error a group needs a key
            invoices.groupBy();
            // @ts-expect-error a misspelled key
            invoices.groupBy('customerIdd');
            // @ts-expect-error a multi-select holds several values, so it is not a key
            invoices.groupBy('tagIds');
            // @ts-expect-error a relation is not a key; its fields are
            invoices.groupBy('customer');
            // @ts-expect-error a sublist is not a key; its lines' fields are
            query(orderConfig).groupBy('lines');
            // @ts-expect-error SUM takes numbers: N/query fails to render it over a date
            invoices.groupBy('customerId').aggregate('SUM', 'tranDate', 'x');
            // @ts-expect-error AVERAGE takes numbers: N/query fails to render it over text
            invoices.groupBy('customerId').aggregate('AVERAGE', 'status', 'x');
            // @ts-expect-error MEDIAN takes numbers: N/query fails to render it over a checkbox
            invoices.groupBy('customerId').aggregate('MEDIAN', 'isVoided', 'x');
            // @ts-expect-error no aggregate takes a multi-select
            invoices.groupBy('customerId').aggregate('COUNT', 'tagIds', 'x');
            // @ts-expect-error a grouped read sorts by its keys and aggregate aliases only
            invoices.groupBy('customerId').aggregate('COUNT', 'id', 'n').orderByDesc('status');
            // @ts-expect-error a date is not a numeric path
            const notNumeric: NumericFieldPath<CustomerInvoice> = 'tranDate';
            // @ts-expect-error a multi-select is not a groupable path
            const notGroupable: GroupableFieldPath<CustomerInvoice> = 'tagIds';
            return [numeric, throughLines, notNumeric, notGroupable];
        };
        expect(typeChecks).toBeDefined();
    });
});
