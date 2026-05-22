import { defineQueryConfig, normalizeQueryConfig, normalizeQueryField } from '../types';
import type { QueryFieldConfig, QueryField } from '../types';

describe('normalizeQueryField', () => {
    it('returns a plain QueryField unchanged', () => {
        const field: QueryField = { queryFieldId: 'id', tableAlias: 'cust', type: 'integer' };
        expect(normalizeQueryField(field)).toBe(field);
    });

    it('merges query + common + record sections', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'companyname', tableAlias: 'cust' },
            common: { type: 'string', isPrimary: false },
            record: { recordFieldId: 'companyname', recordAccess: 'body' },
        };
        expect(normalizeQueryField(input)).toEqual({
            queryFieldId: 'companyname',
            tableAlias: 'cust',
            type: 'string',
            isPrimary: false,
            recordFieldId: 'companyname',
            recordAccess: 'body',
        });
    });

    it('merges query + common without record', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'email', tableAlias: 'cust' },
            common: { type: 'string' },
        };
        const result = normalizeQueryField(input);
        expect(result.queryFieldId).toBe('email');
        expect(result.type).toBe('string');
        expect(result.recordFieldId).toBeUndefined();
    });

    it('merges query + record without common', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'memo', tableAlias: 'txn' },
            record: { recordFieldId: 'memo' },
        };
        const result = normalizeQueryField(input);
        expect(result.queryFieldId).toBe('memo');
        expect(result.recordFieldId).toBe('memo');
        expect(result.type).toBeUndefined();
    });

    it('record overrides common when both are present', () => {
        const input: QueryFieldConfig = {
            query:  { queryFieldId: 'status', tableAlias: 'cust' },
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
            query: { from: { name: 'customer', alias: 'cust' } },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 'cust' },
                name: {
                    query:  { queryFieldId: 'companyname', tableAlias: 'cust' },
                    common: { type: 'string' },
                },
            },
        });
        expect(config.fields.id.queryFieldId).toBe('id');
        expect(config.fields.name.type).toBe('string');
    });

    it('preserves non-field config properties', () => {
        const config = normalizeQueryConfig({
            recordType: 'myRecord',
            query: { from: { name: 'myrecord', alias: 'r' } },
            fields: { id: { queryFieldId: 'id', tableAlias: 'r' } },
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
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id: {
                    query:  { queryFieldId: 'id', tableAlias: 't' },
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
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 't', type: 'integer', isPrimary: true },
            },
        });
        expect(config.fields.id.queryFieldId).toBe('id');
    });
});
