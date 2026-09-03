import type { QueryConfig } from '../types';

/** Shape of the sales order model the build step would generate for the fixture below. */
export interface SalesOrderModel {
    id: number;
    tranId: string;
    memo: string | null;
    customerName: string;
    shippingAddress: { addr1: string | null; city: string | null };
    lines: Array<{ line: number; itemId: number; quantity: number }>;
    customer: { companyName: string };
}

/**
 * The config the build step emits for a sales order with a shipping address subrecord, an item sublist,
 * and a projected customer reference. Hand-written here so the runtime tests do not depend on the generator.
 */
export const salesOrderModelConfig: QueryConfig<SalesOrderModel> = {
    recordType: 'salesorder',
    query: {
        from: { name: 'transaction', alias: 'txn' },
        joins: [
            { toTable: { name: 'customer', alias: 'cust' }, fromTable: 'txn', type: 'leftOuter', constraints: [{ joinKeys: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } }] },
            { toTable: { name: 'transactionshippingaddress', alias: 'shipaddr' }, fromTable: 'txn', type: 'leftOuter', on: 'shipaddr.nkey = txn.shippingaddress' },
            { toTable: { name: 'transactionline', alias: 'tl' }, fromTable: 'txn', type: 'inner', on: 'tl.transaction = txn.id AND tl.mainline = ?', params: ['F'] },
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
        shippingAddress: { kind: 'subrecord', recordAccessId: 'shippingaddress', fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city' }, reload: { listFieldToClear: 'shipaddresslist' }, joinAliases: ['shipaddr'] },
        lines: { kind: 'sublist', recordAccessId: 'item', fields: { line: 'lines_line', itemId: 'lines_itemId', quantity: 'lines_quantity' }, matchField: 'itemId', lineField: 'line', joinAliases: ['tl'] },
        customer: { kind: 'reference', fields: { companyName: 'customer_companyName' }, joinAliases: ['cust'] },
    },
    coerce: true,
};

export interface VendorModel {
    id: number;
    companyName: string;
}

export const vendorModelConfig: QueryConfig<VendorModel> = {
    recordType: 'vendor',
    query: { from: { name: 'vendor', alias: 'v' } },
    fields: {
        id: { queryFieldId: 'id', tableAlias: 'v', type: 'integer', isPrimary: true, readonly: true },
        companyName: { queryFieldId: 'companyname', tableAlias: 'v', type: 'string', recordFieldId: 'companyname' },
    },
    coerce: true,
};
