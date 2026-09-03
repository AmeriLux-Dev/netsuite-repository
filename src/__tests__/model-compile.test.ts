import {
    ModelValidationError,
    cloneEntityModelMetadata,
    compileEntityModel,
    createEntityModelMetadata,
    getOrCreateNavigationMetadata,
    getOrCreatePropertyMetadata,
} from '../model';
import type { EntityModelMetadata } from '../model';
import { QueryBuilder } from '../query';
import { updateRecord } from '../record-updater';
import * as NsQuery from 'N/query';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;

import { buildSalesOrderMetadata } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

describe('compileEntityModel() – emitted config', () => {
    it('compiles scalars, joins, owned, collection, and related navigations into a QueryConfig', () => {
        const config = compileEntityModel<SalesOrderModel>(buildSalesOrderMetadata());

        expect(config).toEqual({
            recordType: 'salesorder',
            query: {
                from: { name: 'transaction', alias: 'txn' },
                joins: [
                    { toTable: { name: 'customer', alias: 'cust' }, fromTable: 'txn', type: 'leftOuter', constraints: [{ joinKeys: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } }] },
                    { toTable: { name: 'transactionshippingaddress', alias: 'shipaddr' }, fromTable: 'txn', type: 'leftOuter', on: 'shipaddr.nkey = txn.shippingaddress' },
                    { toTable: { name: 'transactionline', alias: 'tl' }, fromTable: 'txn', type: 'inner', on: "tl.transaction = txn.id AND tl.mainline = ?", params: ['F'] },
                ],
            },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 'txn', type: 'integer', isPrimary: true, readonly: true },
                tranId: { queryFieldId: 'tranid', tableAlias: 'txn', type: 'string', readonly: true },
                memo: { queryFieldId: 'memo', tableAlias: 'txn', type: 'string', recordFieldId: 'memo' },
                customerName: { queryFieldId: 'companyname', tableAlias: 'cust', type: 'string', readonly: true },
                shippingAddress_addr1: { queryFieldId: 'addr1', tableAlias: 'shipaddr', type: 'string', recordFieldId: 'addr1', nestPath: 'shippingAddress.addr1', recordAccess: 'subrecord', recordAccessId: 'shippingaddress', subrecordNeedsReload: true, subrecordListFieldToClear: 'shipaddresslist' },
                shippingAddress_city: { queryFieldId: 'city', tableAlias: 'shipaddr', type: 'string', recordFieldId: 'city', nestPath: 'shippingAddress.city', recordAccess: 'subrecord', recordAccessId: 'shippingaddress', subrecordNeedsReload: true, subrecordListFieldToClear: 'shipaddresslist' },
                lines_line: { queryFieldId: 'linesequencenumber', tableAlias: 'tl', type: 'integer', readonly: true, nestPath: 'lines.line', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item' },
                lines_itemId: { queryFieldId: 'item', tableAlias: 'tl', type: 'key', recordFieldId: 'item', nestPath: 'lines.itemId', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item', updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item', matchBy: 'item' } },
                lines_quantity: { queryFieldId: 'quantity', tableAlias: 'tl', type: 'float', recordFieldId: 'quantity', nestPath: 'lines.quantity', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item', updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
                customer_companyName: { queryFieldId: 'companyname', tableAlias: 'cust', type: 'string', readonly: true, nestPath: 'customer.companyName' },
            },
            relationships: {
                shippingAddress: { kind: 'owned', recordAccessId: 'shippingaddress', fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city' }, reload: { listFieldToClear: 'shipaddresslist' } },
                lines: { kind: 'collection', recordAccessId: 'item', fields: { line: 'lines_line', itemId: 'lines_itemId', quantity: 'lines_quantity' }, matchField: 'itemId', lineField: 'line' },
            },
            coerce: true,
        });
    });

    it('applies defaults: lowercased column, string type, integer key, read-only without a record field', () => {
        const metadata = createEntityModelMetadata();
        metadata.recordType = 'customer';
        metadata.table = { name: 'customer', alias: 'customer' };
        getOrCreatePropertyMetadata(metadata.properties, 'id');
        getOrCreatePropertyMetadata(metadata.properties, 'companyName');

        const config = compileEntityModel(metadata);

        expect(config.fields.id).toEqual({ queryFieldId: 'id', tableAlias: 'customer', type: 'integer', isPrimary: true, readonly: true });
        expect(config.fields.companyName).toEqual({ queryFieldId: 'companyname', tableAlias: 'customer', type: 'string', readonly: true });
        expect(config.query.joins).toBeUndefined();
        expect(config.relationships).toBeUndefined();
    });

    it('passes through property options and entity options', () => {
        const metadata = createEntityModelMetadata();
        metadata.recordType = 'customer';
        metadata.table = { name: 'customer', alias: 'c' };
        metadata.keyProperty = 'internalId';
        metadata.coerce = false;
        metadata.updaterOptions = { requireFastPath: true };
        metadata.composite = { updateMode: 'explicit' };
        metadata.restRecordMetadata = { recordType: 'customer' };
        metadata.postProcess = (result) => result;
        const transform = (value: unknown) => value;
        Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'internalId'), { column: 'id', type: 'integer', recordFieldId: 'id' });
        Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'status'), {
            column: 'entitystatus', alias: 'statusText', useText: true, setFirst: true, selectByDefault: false, coerce: false, transform,
            source: { kind: 'recordField' as const }, meta: { label: 'Status' }, updateMapping: { kind: 'body' as const, fieldId: 'entitystatus' },
        });
        metadata.ignoredProperties.add('scratch');
        getOrCreatePropertyMetadata(metadata.properties, 'scratch');

        const config = compileEntityModel(metadata);

        expect(config.fields.internalId).toEqual({ queryFieldId: 'id', tableAlias: 'c', type: 'integer', isPrimary: true, recordFieldId: 'id' });
        expect(config.fields.status).toEqual({
            queryFieldId: 'entitystatus', tableAlias: 'c', type: 'string', alias: 'statusText', select: false, useText: true, transform, setFirst: true, coerce: false,
            updateMapping: { kind: 'body', fieldId: 'entitystatus' }, source: { kind: 'recordField' }, meta: { label: 'Status' },
        });
        expect(config.fields.scratch).toBeUndefined();
        expect(config).toEqual(expect.objectContaining({
            coerce: false,
            updaterOptions: { requireFastPath: true },
            composite: { updateMode: 'explicit' },
            restRecordMetadata: { recordType: 'customer' },
            postProcess: metadata.postProcess,
        }));
    });

    it('supports key pair arrays on joins and additional relationship field mappings', () => {
        const metadata = buildSalesOrderMetadata();
        metadata.joins = [{ alias: 'cust', table: 'customer', type: 'inner', from: 'txn', on: [{ sourceForeignKey: 'entity', targetPrimaryKey: 'id' }, { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'subsidiary' }] }];
        const shippingAddress = metadata.navigations.get('shippingAddress')!;
        shippingAddress.additionalRelationshipFields = { line1: 'shippingAddress_addr1' };

        const config = compileEntityModel(metadata);

        expect(config.query.joins?.[0]).toEqual({
            toTable: { name: 'customer', alias: 'cust' }, fromTable: 'txn', type: 'inner',
            constraints: [{ joinKeys: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } }, { joinKeys: { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'subsidiary' } }],
        });
        expect(config.relationships?.shippingAddress).toEqual(expect.objectContaining({ fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city', line1: 'shippingAddress_addr1' } }));
    });

    it('keeps an explicit updateMapping on a collection property and omits matchBy when no match property is set', () => {
        const metadata = buildSalesOrderMetadata();
        const lines = metadata.navigations.get('lines')!;
        lines.matchByProperty = undefined;
        lines.properties.get('quantity')!.updateMapping = { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'line' };

        const config = compileEntityModel(metadata);

        expect(config.fields.lines_itemId.updateMapping).toEqual({ kind: 'sublist', sublistId: 'item', fieldId: 'item' });
        expect(config.fields.lines_quantity.updateMapping).toEqual({ kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'line' });
        expect(config.relationships?.lines).toEqual(expect.not.objectContaining({ matchField: expect.anything() }));
    });
});

describe('compileEntityModel() – runtime behavior of the compiled config', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('produces SQL with every join and maps nested results', () => {
        const config = compileEntityModel<SalesOrderModel>(buildSalesOrderMetadata());
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [
            { id: '1', tranid: 'SO1', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '1', lines_itemid: '10', lines_quantity: '2', customer_companyname: 'Acme' },
            { id: '1', tranid: 'SO1', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: '2', lines_itemid: '11', lines_quantity: '1', customer_companyname: 'Acme' },
        ] });

        const built = QueryBuilder.from(config).where('memo', 'IS NULL').build();
        const [order] = QueryBuilder.from(config).executeTyped();

        expect(built.sql).toContain('LEFT OUTER JOIN customer cust ON txn.entity = cust.id');
        expect(built.sql).toContain('LEFT OUTER JOIN transactionshippingaddress shipaddr ON shipaddr.nkey = txn.shippingaddress');
        expect(built.sql).toContain("INNER JOIN transactionline tl ON tl.transaction = txn.id AND tl.mainline = ?");
        expect(built.params).toEqual(['F']);
        expect(order).toEqual({
            id: 1, tranId: 'SO1', memo: null, customerName: 'Acme',
            shippingAddress: { addr1: '1 Main', city: 'Dallas' },
            lines: [{ line: 1, itemId: 10, quantity: 2 }, { line: 2, itemId: 11, quantity: 1 }],
            customer: { companyName: 'Acme' },
        });
    });

    it('plans updates through the existing record updater semantics', () => {
        const config = compileEntityModel<SalesOrderModel>(buildSalesOrderMetadata());

        const plan = updateRecord<SalesOrderModel, Record<string, unknown>>(config).id(1).patch({
            memo: 'hello',
            shippingAddress: { city: 'Austin' },
            lines: { update: [{ match: { field: 'itemId', value: 10 }, values: { quantity: 5 } }], add: [{ itemId: 12, quantity: 1 }] },
        }).plan();

        expect(plan.executionMode).toBe('loadSave');
        expect(plan.operations.map((operation) => operation.kind)).toEqual(['loadRecord', 'bodyFields', 'sublistUpdate', 'sublistAdd', 'subrecord', 'saveRecord']);
        expect(plan.operations.find((operation) => operation.kind === 'subrecord')).toEqual(expect.objectContaining({ reload: { clearFieldId: 'shipaddresslist', conditional: true } }));
        expect(() => updateRecord(config).id(1).set('tranId', 'x')).toThrow(/readonly|read-only/i);
        expect(() => updateRecord(config).id(1).set('customer_companyName', 'x')).toThrow(/readonly|read-only/i);
    });
});

describe('compileEntityModel() – validation', () => {
    function expectProblems(mutate: (metadata: EntityModelMetadata) => void, ...expected: string[]) {
        const metadata = buildSalesOrderMetadata();
        mutate(metadata);
        let caught: unknown;
        try {
            compileEntityModel(metadata);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ModelValidationError);
        const validationError = caught as ModelValidationError;
        expect(validationError.entityName).toBe('salesOrders');
        for (const problem of expected) {
            expect(validationError.problems).toContainEqual(expect.stringContaining(problem));
        }
        expect(validationError.message).toContain("Model 'salesOrders' is invalid");
    }

    it('requires a record type and a table', () => {
        expectProblems((metadata) => {
            metadata.recordType = undefined;
            metadata.table = undefined;
        }, 'recordType is required', 'table is required');
    });

    it('requires a key property that exists and is selected', () => {
        expectProblems((metadata) => {
            metadata.keyProperty = undefined;
            metadata.properties.delete('id');
        }, 'a key property is required');
        expectProblems((metadata) => {
            metadata.keyProperty = 'missing';
        }, "key property 'missing' is not a declared scalar property");
        expectProblems((metadata) => {
            metadata.properties.get('id')!.selectByDefault = false;
        }, "key property 'id' cannot be excluded from the default select");
    });

    it('rejects join alias collisions', () => {
        expectProblems((metadata) => {
            metadata.joins.push({ alias: 'txn', table: 'x', on: 'x' });
        }, "join alias 'txn' on the entity collides with the root table alias");
        expectProblems((metadata) => {
            metadata.navigations.get('shippingAddress')!.join!.alias = 'cust';
        }, "join alias 'cust' on navigation 'shippingAddress' is already declared on the entity");
    });

    it('rejects unknown table aliases on properties and navigations', () => {
        expectProblems((metadata) => {
            metadata.properties.get('customerName')!.tableAlias = 'nope';
            metadata.navigations.get('customer')!.sourceAlias = 'nope';
            metadata.navigations.get('lines')!.properties.get('line')!.tableAlias = 'nope';
        }, "property 'customerName' references unknown table alias 'nope'", "navigation 'customer' references unknown source alias 'nope'", "navigation 'lines' property 'line' references unknown table alias 'nope'");
    });

    it('rejects duplicate keys and navigation name collisions', () => {
        expectProblems((metadata) => {
            getOrCreatePropertyMetadata(metadata.properties, 'lines_line');
            getOrCreatePropertyMetadata(metadata.properties, 'lines');
        }, "field key 'lines_line' from navigation 'lines' property 'line' collides with property 'lines_line'", "navigation 'lines' collides with a scalar property of the same name");
    });

    it('rejects navigations without properties, joins, subrecord ids, or sublist ids', () => {
        expectProblems((metadata) => {
            const shippingAddress = metadata.navigations.get('shippingAddress')!;
            shippingAddress.properties.clear();
            shippingAddress.join = undefined;
            shippingAddress.subrecordFieldId = undefined;
            metadata.navigations.get('lines')!.sublistId = undefined;
        }, "navigation 'shippingAddress' declares no properties", "navigation 'shippingAddress' needs a join or a source alias", "owned navigation 'shippingAddress' requires a subrecord field id", "collection navigation 'lines' requires a sublist id");
    });

    it('rejects matchBy and lineNumberProperty that are not collection properties', () => {
        expectProblems((metadata) => {
            metadata.navigations.get('lines')!.matchByProperty = 'sku';
            metadata.navigations.get('lines')!.lineNumberProperty = 'index';
        }, "collection navigation 'lines' matchBy 'sku' is not one of its properties", "collection navigation 'lines' lineNumberProperty 'index' is not one of its properties");
    });

    it('rejects writable properties on related navigations', () => {
        expectProblems((metadata) => {
            metadata.navigations.get('customer')!.properties.get('companyName')!.recordFieldId = 'companyname';
        }, "related navigation 'customer' property 'companyName' cannot declare a record field");
    });

    it('names the entity by record type when it has no name', () => {
        const metadata = createEntityModelMetadata();
        metadata.recordType = 'customer';
        expect(() => compileEntityModel(metadata)).toThrow("Model 'customer' is invalid");
        expect(() => compileEntityModel(createEntityModelMetadata())).toThrow("Model 'unnamed' is invalid");
    });
});

describe('cloneEntityModelMetadata()', () => {
    it('copies properties, joins, and navigations so the clone can change independently', () => {
        const original = buildSalesOrderMetadata();
        const clone = cloneEntityModelMetadata(original);

        clone.properties.get('memo')!.recordFieldId = 'custbody_memo';
        clone.joins[0].alias = 'c2';
        clone.navigations.get('lines')!.join!.alias = 'tl2';
        clone.navigations.get('lines')!.properties.get('quantity')!.type = 'integer';
        clone.navigations.get('lines')!.additionalRelationshipFields = { qty: 'lines_quantity' };
        clone.ignoredProperties.add('memo');

        expect(original.properties.get('memo')!.recordFieldId).toBe('memo');
        expect(original.joins[0].alias).toBe('cust');
        expect(original.navigations.get('lines')!.join!.alias).toBe('tl');
        expect(original.navigations.get('lines')!.properties.get('quantity')!.type).toBe('float');
        expect(original.navigations.get('lines')!.additionalRelationshipFields).toBeUndefined();
        expect(original.ignoredProperties.size).toBe(0);
    });

    it('preserves an existing additional relationship field map on clone', () => {
        const original = buildSalesOrderMetadata();
        original.navigations.get('customer')!.additionalRelationshipFields = { name: 'customer_companyName' };
        const clone = cloneEntityModelMetadata(original);
        clone.navigations.get('customer')!.additionalRelationshipFields!.name = 'other';
        expect(original.navigations.get('customer')!.additionalRelationshipFields!.name).toBe('customer_companyName');
    });
});

describe('getOrCreateNavigationMetadata()', () => {
    it('reuses an existing navigation and updates its kind', () => {
        const metadata = createEntityModelMetadata();
        const first = getOrCreateNavigationMetadata(metadata, 'lines', 'related');
        const second = getOrCreateNavigationMetadata(metadata, 'lines', 'collection');
        expect(second).toBe(first);
        expect(first.kind).toBe('collection');
    });
});
