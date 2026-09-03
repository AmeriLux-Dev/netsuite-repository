import { updateRecord } from '../record-updater';
import { buildAddedEntityPatch, diffTrackedEntity } from '../tracking/diff';
import type { QueryConfig } from '../types';
import { salesOrderModelConfig } from './model-fixtures';

const config = salesOrderModelConfig as QueryConfig<unknown>;

describe('references are read-only', () => {
    it('rejects a patch that targets a reference', () => {
        expect(() => updateRecord(config).id(1).patch({ customer: { companyName: 'Acme' } })).toThrow("Reference 'customer' is read-only; set its select field instead.");
    });

    it('rejects owned() and collection() on a reference', () => {
        expect(() => updateRecord(config).id(1).owned('customer')).toThrow("Relationship 'customer' is not an owned subrecord relationship.");
        expect(() => updateRecord(config).id(1).collection('customer')).toThrow("Relationship 'customer' is not a collection relationship.");
    });

    it('reports changed reference fields as ignored instead of writing them', () => {
        const snapshot = { id: 1, memo: 'a', customer: { companyName: 'Acme' } };
        const changed = { id: 1, memo: 'b', customer: { companyName: 'Other' } };
        expect(diffTrackedEntity(config, snapshot, changed)).toEqual({ patch: { memo: 'b' }, ignoredProperties: ['customer_companyName'] });
        expect(diffTrackedEntity(config, snapshot, { ...snapshot })).toEqual({ patch: undefined, ignoredProperties: [] });
    });

    it('reports reference values on a new entity as ignored', () => {
        const added = buildAddedEntityPatch(config, { memo: 'new', customer: { companyName: 'Acme' } });
        expect(added.patch).toEqual({ memo: 'new' });
        expect(added.ignoredProperties).toEqual(['customer_companyName']);
    });

    it('ignores relationship field maps that point at unknown config keys', () => {
        const broken: QueryConfig<unknown> = { ...config, relationships: { ...config.relationships, customer: { kind: 'reference', fields: { ghost: 'missing_key' } } } };
        expect(diffTrackedEntity(broken, { id: 1 }, { id: 1, customer: { ghost: 'x' } })).toEqual({ patch: undefined, ignoredProperties: [] });
    });
});
