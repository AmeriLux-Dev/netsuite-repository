import { compileEntityModel, configFromEntity, defineModel, extendModel, isEntityModelDefinition, modelFromEntity, resolveQueryConfig } from '../model';
import type { EntityModelDefinition } from '../model';
import { customerConfig } from './fixtures';
import { DecoratedSalesOrder, buildSalesOrderMetadata } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

export const FluentSalesOrderModel = defineModel<SalesOrderModel>((model) => model
    .hasSetName('salesOrders')
    .toRecord('salesorder')
    .toTable('transaction', 'txn')
    .hasKey('id')
    .hasJoin('cust', { table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } })
    .property('id').isReadOnly()
    .property('tranId').hasColumn('tranid')
    .property('memo').hasRecordField('memo')
    .property('customerName').hasColumn('companyname', 'cust')
    .end()
    .ownsOne('shippingAddress', (address) => address
        .toSubrecord('shippingaddress')
        .clearListField('shipaddresslist')
        .viaJoin('shipaddr', { table: 'transactionshippingaddress', on: 'shipaddr.nkey = txn.shippingaddress' })
        .property('addr1').hasRecordField('addr1')
        .property('city').hasRecordField('city'))
    .ownsMany('lines', (line) => line
        .toSublist('item')
        .matchBy('itemId')
        .lineNumberProperty('line')
        .viaJoin('tl', { table: 'transactionline', type: 'inner', on: "tl.transaction = txn.id AND tl.mainline = ?", params: ['F'] })
        .property('line').hasColumn('linesequencenumber').hasType('integer').isReadOnly()
        .property('itemId').hasColumn('item').hasType('key').hasRecordField('item')
        .property('quantity').hasType('float').hasRecordField())
    .hasRelated('customer', (customer) => customer
        .fromAlias('cust')
        .property('companyName').hasColumn('companyname')));

interface CustomerModel {
    id: number;
    companyName: string;
    status: string;
    scratch: string;
}

describe('defineModel() – fluent authoring surface', () => {
    it('compiles the fluent sales order to the same config as the hand-built metadata and the decorated class', () => {
        expect(FluentSalesOrderModel.compile()).toEqual(compileEntityModel(buildSalesOrderMetadata()));
        expect(FluentSalesOrderModel.compile()).toEqual(configFromEntity(DecoratedSalesOrder));
    });

    it('caches the compiled config and rebuilds metadata on demand', () => {
        expect(FluentSalesOrderModel.compile()).toBe(FluentSalesOrderModel.compile());
        expect(FluentSalesOrderModel.buildMetadata()).not.toBe(FluentSalesOrderModel.buildMetadata());
    });

    it('reflects every entity and property builder method in the compiled config', () => {
        const uppercase = (value: unknown) => String(value).toUpperCase();
        const postProcess = (result: CustomerModel) => result;
        const model = defineModel<CustomerModel>((entity) => entity
            .toRecord('customer')
            .toTable('customer')
            .hasKey('id')
            .ignore('scratch')
            .updaterOptions({ isDynamic: true })
            .updaterOptions({ requireFastPath: true })
            .coerce(false)
            .hasRestMetadata({ recordType: 'customer' })
            .hasComposite({ updateMode: 'explicit' })
            .postProcess(postProcess)
            .property('id').hasType('integer').hasRecordField('id').end()
            .property('companyName').hasColumn('companyname').hasAlias('name').setFirst().hasRecordField().excludeFromDefaultSelect().end()
            .property('status').hasColumn('entitystatus').fromAlias('customer').useText().coerce(false).transform(uppercase).hasUpdateMapping({ kind: 'body', fieldId: 'entitystatus' })
            .property('scratch').hasColumn('x'));

        const config = model.compile();

        expect(config).toEqual({
            recordType: 'customer',
            query: { from: { name: 'customer', alias: 'customer' } },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 'customer', type: 'integer', isPrimary: true, recordFieldId: 'id' },
                companyName: { queryFieldId: 'companyname', tableAlias: 'customer', type: 'string', alias: 'name', setFirst: true, recordFieldId: 'companyname', select: false },
                status: { queryFieldId: 'entitystatus', tableAlias: 'customer', type: 'string', useText: true, coerce: false, transform: uppercase, updateMapping: { kind: 'body', fieldId: 'entitystatus' } },
            },
            coerce: false,
            updaterOptions: { isDynamic: true, requireFastPath: true },
            restRecordMetadata: { recordType: 'customer' },
            composite: { updateMode: 'explicit' },
            postProcess,
        });
    });

    it('replaces a join declared twice with the same alias and merges relationship field mappings', () => {
        const model = defineModel<SalesOrderModel>((entity) => entity
            .toRecord('salesorder').toTable('transaction', 'txn').hasKey('id')
            .hasJoin('cust', { table: 'wrong', on: 'x' })
            .hasJoin('cust', { table: 'customer', on: 'cust.id = txn.entity' })
            .ownsOne('shippingAddress', (address) => address
                .toSubrecord('shippingaddress').fromAlias('txn')
                .withRelationshipFields({ line1: 'shippingAddress_addr1' })
                .withRelationshipFields({ town: 'shippingAddress_city' })
                .property('addr1').hasColumn('shipaddr1').hasRecordField('addr1')
                .property('city').hasColumn('shipcity').hasRecordField('city')));

        const config = model.compile();

        expect(config.query.joins).toEqual([{ toTable: { name: 'customer', alias: 'cust' }, fromTable: 'txn', type: 'leftOuter', on: 'cust.id = txn.entity' }]);
        expect(config.fields.shippingAddress_addr1).toEqual(expect.objectContaining({ queryFieldId: 'shipaddr1', tableAlias: 'txn' }));
        expect(config.relationships?.shippingAddress).toEqual({
            kind: 'owned', recordAccessId: 'shippingaddress',
            fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city', line1: 'shippingAddress_addr1', town: 'shippingAddress_city' },
        });
    });
});

describe('extendModel() and modelFromEntity()', () => {
    it('layers overrides without touching the base definition', () => {
        const extended = extendModel(FluentSalesOrderModel, (entity) => entity
            .property('memo').isReadOnly().end()
            .ownsMany('lines', (line) => line.matchBy('line')));

        expect(extended.compile().fields.memo).toEqual(expect.objectContaining({ readonly: true }));
        expect(extended.compile().relationships?.lines).toEqual(expect.objectContaining({ matchField: 'line' }));
        expect(FluentSalesOrderModel.compile().fields.memo.readonly).toBeUndefined();
        expect(FluentSalesOrderModel.compile().relationships?.lines).toEqual(expect.objectContaining({ matchField: 'itemId' }));
    });

    it('can be chained: extending an extended definition replays every step in order', () => {
        const once = extendModel(FluentSalesOrderModel, (entity) => entity.coerce(false));
        const twice = extendModel(once, (entity) => entity.updaterOptions({ allowLineScans: false }));

        expect(twice.compile()).toEqual(expect.objectContaining({ coerce: false, updaterOptions: { allowLineScans: false } }));
        expect(once.compile().updaterOptions).toBeUndefined();
    });

    it('rejects definitions that were not produced by this module', () => {
        const foreign: EntityModelDefinition<SalesOrderModel> = { kind: 'entityModel', buildMetadata: () => buildSalesOrderMetadata(), compile: () => FluentSalesOrderModel.compile() };
        expect(() => extendModel(foreign, () => undefined)).toThrow('extendModel() requires a definition created by defineModel(), modelFromEntity(), or extendModel().');
    });

    it('seeds a definition from a decorated class and lets fluent calls override the decorators', () => {
        const unchanged = modelFromEntity(DecoratedSalesOrder);
        const overridden = modelFromEntity(DecoratedSalesOrder, (entity) => entity.property('tranId').hasRecordField('tranid'));

        expect(unchanged.compile()).toEqual(configFromEntity(DecoratedSalesOrder));
        expect(overridden.compile().fields.tranId).toEqual({ queryFieldId: 'tranid', tableAlias: 'txn', type: 'string', recordFieldId: 'tranid' });
        expect(configFromEntity(DecoratedSalesOrder).fields.tranId.readonly).toBe(true);
    });
});

describe('isEntityModelDefinition() and resolveQueryConfig()', () => {
    it('recognizes definitions and resolves them through compile()', () => {
        expect(isEntityModelDefinition(FluentSalesOrderModel)).toBe(true);
        expect(isEntityModelDefinition({ kind: 'entityModel' })).toBe(false);
        expect(isEntityModelDefinition(customerConfig)).toBe(false);
        expect(isEntityModelDefinition(undefined)).toBe(false);
        expect(resolveQueryConfig(FluentSalesOrderModel)).toBe(FluentSalesOrderModel.compile());
    });
});
