import { defineQueryConfig, normalizeQueryConfig, normalizeQueryField } from '../types';
import type { QueryFieldConfig, QueryField } from '../types';

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
