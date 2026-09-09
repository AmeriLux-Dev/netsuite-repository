import type { QueryConfig } from '../types';

/** Shape of the sales order model the build step would generate for the fixture below. */
export interface SalesOrderModel {
    id: number;
    tranId: string;
    memo: string | null;
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
    components: {
        customer: { path: 'customer', relationship: 'customer', load: 'join', join: { kind: 'to', fieldId: 'entity', target: 'customer' } },
        shippingAddress: { path: 'shippingAddress', relationship: 'shippingAddress', load: 'join', join: { kind: 'auto', fieldId: 'shippingaddress' } },
        lines: { path: 'lines', relationship: 'lines', load: 'join', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }], lineOrderFieldId: 'linesequencenumber' },
    },
    fields: {
        id: { queryFieldId: 'id', type: 'integer', isPrimary: true, readonly: true },
        tranId: { queryFieldId: 'tranid', type: 'string', readonly: true },
        memo: { queryFieldId: 'memo', type: 'string', recordFieldId: 'memo' },
        shippingAddress_addr1: { queryFieldId: 'addr1', component: 'shippingAddress', type: 'string', recordFieldId: 'addr1', nestPath: 'shippingAddress.addr1', recordAccess: 'subrecord', recordAccessId: 'shippingaddress', subrecordNeedsReload: true, subrecordListFieldToClear: 'shipaddresslist' },
        shippingAddress_city: { queryFieldId: 'city', component: 'shippingAddress', type: 'string', recordFieldId: 'city', nestPath: 'shippingAddress.city', recordAccess: 'subrecord', recordAccessId: 'shippingaddress', subrecordNeedsReload: true, subrecordListFieldToClear: 'shipaddresslist' },
        lines_line: { queryFieldId: 'linesequencenumber', component: 'lines', type: 'integer', readonly: true, nestPath: 'lines.line', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item' },
        lines_itemId: { queryFieldId: 'item', component: 'lines', type: 'key', recordFieldId: 'item', nestPath: 'lines.itemId', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item', updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item', matchBy: 'item' } },
        lines_quantity: { queryFieldId: 'quantity', component: 'lines', type: 'float', recordFieldId: 'quantity', nestPath: 'lines.quantity', cardinality: 'many', recordAccess: 'sublist', recordAccessId: 'item', updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
        customer_companyName: { queryFieldId: 'companyname', component: 'customer', type: 'string', readonly: true, nestPath: 'customer.companyName' },
    },
    relationships: {
        shippingAddress: { kind: 'subrecord', recordAccessId: 'shippingaddress', fields: { addr1: 'shippingAddress_addr1', city: 'shippingAddress_city' }, reload: { listFieldToClear: 'shipaddresslist' }, components: ['shippingAddress'] },
        lines: { kind: 'sublist', recordAccessId: 'item', fields: { line: 'lines_line', itemId: 'lines_itemId', quantity: 'lines_quantity' }, matchField: 'itemId', lineField: 'line', components: ['lines'] },
        customer: { kind: 'reference', fields: { companyName: 'customer_companyName' }, components: ['customer'] },
    },
    coerce: true,
};

/** The same model with its lines loaded by a second query instead of a join. */
export const separateLinesSalesOrderModelConfig: QueryConfig<SalesOrderModel> = {
    ...salesOrderModelConfig,
    components: {
        ...salesOrderModelConfig.components,
        lines: { ...salesOrderModelConfig.components!.lines, load: 'separate' },
    },
    relationships: {
        ...salesOrderModelConfig.relationships,
        lines: { ...salesOrderModelConfig.relationships!.lines, load: 'separate' },
    },
};

export interface VendorModel {
    id: number;
    companyName: string;
}

export const vendorModelConfig: QueryConfig<VendorModel> = {
    recordType: 'vendor',
    fields: {
        id: { queryFieldId: 'id', type: 'integer', isPrimary: true, readonly: true },
        companyName: { queryFieldId: 'companyname', type: 'string', recordFieldId: 'companyname' },
    },
    coerce: true,
};
