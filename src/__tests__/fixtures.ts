import { defineQueryConfig } from '../types';

// ── Flat customer config ──────────────────────────────────────────────────────

export interface Customer {
    id: number;
    name: string;
    email: string;
    isActive: boolean;
    score: number;
}

export const customerConfig = defineQueryConfig<Customer>({
    recordType: 'customer',
    fields: {
        id:       { queryFieldId: 'id',               type: 'integer', isPrimary: true, recordFieldId: 'id' },
        name:     { queryFieldId: 'companyname',      type: 'string',  recordFieldId: 'companyname' },
        email:    { queryFieldId: 'email',            type: 'string',  recordFieldId: 'email' },
        isActive: { queryFieldId: 'isinactive',       type: 'boolean', recordFieldId: 'isinactive' },
        score:    { queryFieldId: 'custentity_score', type: 'float',   recordFieldId: 'custentity_score' },
    },
});

// ── Order config with a joined sublist (rows fan out, cardinality: 'many') ────

export interface OrderLine {
    itemId: number;
    qty: number;
    amount: number;
}
export interface Order {
    id: number;
    entityId: number;
    lines: OrderLine[];
}

export const orderConfig = defineQueryConfig<Order>({
    recordType: 'salesorder',
    components: {
        lines: { path: 'lines', relationship: 'lines', load: 'join', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' }, conditions: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] },
    },
    fields: {
        id:           { queryFieldId: 'id',       type: 'integer', isPrimary: true, recordFieldId: 'id' },
        entityId:     { queryFieldId: 'entity',   type: 'key',     recordFieldId: 'entity' },
        lines_itemId: { queryFieldId: 'item',     component: 'lines', type: 'key',      recordFieldId: 'item',     recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemId', cardinality: 'many' },
        lines_qty:    { queryFieldId: 'quantity', component: 'lines', type: 'float',    recordFieldId: 'quantity', recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',    cardinality: 'many' },
        lines_amount: { queryFieldId: 'amount',   component: 'lines', type: 'currency', recordFieldId: 'amount',   recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.amount', cardinality: 'many' },
    },
    relationships: {
        lines: { kind: 'sublist', recordAccessId: 'item', components: ['lines'], fields: { itemId: 'lines_itemId', qty: 'lines_qty', amount: 'lines_amount' } },
    },
});

// ── The same order with its lines loaded separately ───────────────────────────

export const separateOrderConfig = defineQueryConfig<Order>({
    ...orderConfig,
    components: {
        lines: { ...orderConfig.components!.lines, load: 'separate', lineOrderFieldId: 'linesequencenumber' },
    },
    relationships: {
        lines: { ...orderConfig.relationships!.lines, load: 'separate' },
    },
});

/** Lines queried from another root than the owner's (`transaction`), matched to the order by internal id. */
export const ownRootLinesOrderConfig = defineQueryConfig<Order>({
    ...separateOrderConfig,
    rootConditions: [{ fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] }],
    components: {
        lines: {
            ...separateOrderConfig.components!.lines,
            join: { kind: 'auto', fieldId: 'transactionlines' },
            separate: { queryType: 'transaction', parentKeyField: 'id', targetKeyFieldId: 'id', targetKeyFieldType: 'key' },
        },
    },
});

// ── Vendor bill with an owned subrecord relationship ──────────────────────────

export interface VendorBill {
    id: number;
    memo: string;
    billingAddress: { addr1: string; city: string };
}

export const vendorBillConfig = defineQueryConfig<VendorBill>({
    recordType: 'vendorbill',
    components: {
        billingAddress: { path: 'billingAddress', relationship: 'billingAddress', load: 'join', join: { kind: 'auto', fieldId: 'billingaddress' } },
    },
    fields: {
        id:   { queryFieldId: 'id',   type: 'integer', isPrimary: true, recordFieldId: 'id' },
        memo: { queryFieldId: 'memo', type: 'string',  recordFieldId: 'memo' },
        billingAddress_addr1: {
            queryFieldId: 'addr1', component: 'billingAddress', type: 'string',
            recordFieldId: 'addr1', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
            nestPath: 'billingAddress.addr1',
        },
        billingAddress_city: {
            queryFieldId: 'city', component: 'billingAddress', type: 'string',
            recordFieldId: 'city', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
            nestPath: 'billingAddress.city',
        },
    },
    relationships: {
        billingAddress: { kind: 'subrecord', recordAccessId: 'billingaddress', components: ['billingAddress'] },
    },
});

// ── Sales order with a sublist that writes through update mappings ────────────

export interface SalesOrderLine { itemId: number; qty: number; }
export interface SalesOrder { id: number; tranId: string; lines: SalesOrderLine[]; }

export const salesOrderConfig = defineQueryConfig<SalesOrder>({
    recordType: 'salesorder',
    components: {
        lines: { path: 'lines', relationship: 'lines', load: 'join', join: { kind: 'from', fieldId: 'transaction', source: 'transactionline' } },
    },
    fields: {
        id:          { queryFieldId: 'id',       type: 'integer', isPrimary: true, recordFieldId: 'id' },
        tranId:      { queryFieldId: 'tranid',   type: 'string',  recordFieldId: 'tranid' },
        lines_itemId:{ queryFieldId: 'item',     component: 'lines', type: 'key',   recordFieldId: 'item',     recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemId', cardinality: 'many',
            updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
        lines_qty:   { queryFieldId: 'quantity', component: 'lines', type: 'float', recordFieldId: 'quantity', recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',    cardinality: 'many',
            updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
    },
    relationships: {
        lines: { kind: 'sublist', recordAccessId: 'item', matchField: 'itemId', components: ['lines'] },
    },
});

// ── Composite explicit update config ─────────────────────────────────────────

export interface Invoice { id: number; memo: string; amount: number; }

export const compositeConfig = defineQueryConfig<Invoice>({
    recordType: 'invoice',
    composite: { updateMode: 'explicit' },
    fields: {
        id:     { queryFieldId: 'id',     isPrimary: true, updateMapping: { kind: 'body', fieldId: 'id' } },
        memo:   { queryFieldId: 'memo',   updateMapping: { kind: 'body', fieldId: 'memo' } },
        amount: { queryFieldId: 'amount', updateMapping: { kind: 'body', fieldId: 'amount' } },
    },
});

// ── Employee with a joined reference and a display-text field ─────────────────

export interface Employee { id: number; deptName: string; department: { name: string } }

export const employeeConfig = defineQueryConfig<Employee>({
    recordType: 'employee',
    components: {
        department: { path: 'department', relationship: 'department', load: 'join', join: { kind: 'to', fieldId: 'department', target: 'department' } },
    },
    fields: {
        id:              { queryFieldId: 'id', type: 'integer', isPrimary: true },
        deptName:        { queryFieldId: 'department', type: 'string', alias: 'departmentName', fieldContext: 'DISPLAY', readonly: true },
        department_name: { queryFieldId: 'name', component: 'department', type: 'string', nestPath: 'department.name', readonly: true },
    },
    relationships: {
        department: { kind: 'reference', components: ['department'], fields: { name: 'department_name' } },
    },
});

// ── Shipment with a reference matched on a code column, loaded separately ─────

export interface Shipment { id: number; carrierCode: string; carrier: { id: number; name: string; scac: { code: string } } | null }

export const shipmentConfig = defineQueryConfig<Shipment>({
    recordType: 'customrecord_shipment',
    components: {
        carrier: {
            path: 'carrier', relationship: 'carrier', load: 'separate',
            join: { kind: 'to', fieldId: 'custrecord_carrier_code', target: 'customrecord_carrier' },
            separate: { queryType: 'customrecord_carrier', parentKeyField: 'carrierCode', targetKeyFieldId: 'custrecord_carrier_code', targetKeyFieldType: 'string' },
        },
        'carrier.scac': { path: 'carrier.scac', parent: 'carrier', relationship: 'carrier', load: 'join', join: { kind: 'auto', fieldId: 'custrecord_carrier_scac' } },
    },
    fields: {
        id:                { queryFieldId: 'id', type: 'integer', isPrimary: true },
        carrierCode:       { queryFieldId: 'custrecord_carrier_code', type: 'string', recordFieldId: 'custrecord_carrier_code' },
        carrier_id:        { queryFieldId: 'id', component: 'carrier', type: 'integer', nestPath: 'carrier.id', readonly: true },
        carrier_name:      { queryFieldId: 'name', component: 'carrier', type: 'string', nestPath: 'carrier.name', readonly: true },
        carrier_scac_code: { queryFieldId: 'code', component: 'carrier.scac', type: 'string', nestPath: 'carrier.scac.code', readonly: true },
    },
    relationships: {
        carrier: { kind: 'reference', load: 'separate', components: ['carrier', 'carrier.scac'], fields: { id: 'carrier_id', name: 'carrier_name' } },
    },
});

// ── Order with a has-many keyed by a field on the child, loaded on the child's own type ──

export interface OrderPackage {
    id: number;
    weight: number;
    type: { name: string } | null;
}
export interface OrderWithPackages {
    id: number;
    entityId: number;
    packages: OrderPackage[];
}

/** Packages joined `from` their order field; loaded separately they run on `customrecord_pkg`, batched on that field. */
export const childRootedPackagesOrderConfig = defineQueryConfig<OrderWithPackages>({
    recordType: 'salesorder',
    components: {
        packages: {
            path: 'packages', relationship: 'packages', load: 'separate',
            join: { kind: 'from', fieldId: 'custrecord_pkg_order', source: 'customrecord_pkg' },
            conditions: [{ fieldId: 'isinactive', operator: 'IS', values: [false] }],
            separate: { queryType: 'customrecord_pkg', parentKeyField: 'id', targetKeyFieldId: 'custrecord_pkg_order', targetKeyFieldType: 'select' },
            lineOrderFieldId: 'id',
        },
        'packages.type': { path: 'packages.type', parent: 'packages', relationship: 'packages', load: 'separate', join: { kind: 'auto', fieldId: 'custrecord_pkg_type' } },
    },
    fields: {
        id:                 { queryFieldId: 'id',     type: 'integer', isPrimary: true, recordFieldId: 'id' },
        entityId:           { queryFieldId: 'entity', type: 'key',     recordFieldId: 'entity' },
        packages_id:        { queryFieldId: 'id',                       component: 'packages',      type: 'key',    nestPath: 'packages.id',        cardinality: 'many', readonly: true },
        packages_weight:    { queryFieldId: 'custrecord_pkg_weight',    component: 'packages',      type: 'float',  nestPath: 'packages.weight',    cardinality: 'many', readonly: true },
        packages_type_name: { queryFieldId: 'name',                     component: 'packages.type', type: 'string', nestPath: 'packages.type.name', cardinality: 'many', readonly: true },
    },
    relationships: {
        packages: { kind: 'sublist', recordAccessId: 'packages', components: ['packages', 'packages.type'], load: 'separate', fields: { id: 'packages_id', weight: 'packages_weight', 'type.name': 'packages_type_name' } },
    },
});

// ── Order with its related transactions, two joins away ──────────────────────
// The link hangs off `nexttransactionlink`; the transaction each link points at off the link's `nextdoc`. The items'
// fields are read on the second hop, and the link component carries none of its own.

export interface RelatedTransaction {
    id: number;
    tranId: string;
    type: string;
}
export interface OrderWithRelatedTransactions {
    id: number;
    entityId: number;
    relatedTransactions: RelatedTransaction[];
}

export const relatedTransactionsOrderConfig = defineQueryConfig<OrderWithRelatedTransactions>({
    recordType: 'salesorder',
    components: {
        relatedTransactions: {
            path: 'relatedTransactions', relationship: 'relatedTransactions', load: 'separate',
            join: { kind: 'auto', fieldId: 'nexttransactionlink' },
            conditions: [{ fieldId: 'linktype', operator: 'ANY_OF', values: ['OrdShip', 'OrdBill'] }],
            separate: { queryType: 'transaction', parentKeyField: 'id', targetKeyFieldId: 'id', targetKeyFieldType: 'key' },
            lineOrderFieldId: 'id',
            lineOrderComponent: 'relatedTransactions.nextdoc',
        },
        'relatedTransactions.nextdoc': { path: 'relatedTransactions.nextdoc', parent: 'relatedTransactions', relationship: 'relatedTransactions', load: 'separate', join: { kind: 'to', fieldId: 'nextdoc', target: 'transaction' } },
    },
    fields: {
        id:       { queryFieldId: 'id',     type: 'integer', isPrimary: true, recordFieldId: 'id' },
        entityId: { queryFieldId: 'entity', type: 'key',     recordFieldId: 'entity' },
        relatedTransactions_id:     { queryFieldId: 'id',     component: 'relatedTransactions.nextdoc', type: 'key',    nestPath: 'relatedTransactions.id',     cardinality: 'many', readonly: true },
        relatedTransactions_tranId: { queryFieldId: 'tranid', component: 'relatedTransactions.nextdoc', type: 'string', nestPath: 'relatedTransactions.tranId', cardinality: 'many', readonly: true },
        relatedTransactions_type:   { queryFieldId: 'type',   component: 'relatedTransactions.nextdoc', type: 'string', nestPath: 'relatedTransactions.type',   cardinality: 'many', readonly: true },
    },
    relationships: {
        relatedTransactions: { kind: 'sublist', recordAccessId: 'relatedtransactions', components: ['relatedTransactions', 'relatedTransactions.nextdoc'], load: 'separate', fields: { id: 'relatedTransactions_id', tranId: 'relatedTransactions_tranId', type: 'relatedTransactions_type' } },
    },
});

/** The same items joined into the owner's query: the owner queries `transaction` itself, which carries the link. */
export const joinedRelatedTransactionsOrderConfig = defineQueryConfig<OrderWithRelatedTransactions>({
    ...relatedTransactionsOrderConfig,
    queryType: 'transaction',
    rootConditions: [{ fieldId: 'type', operator: 'ANY_OF', values: ['SalesOrd'] }],
    components: {
        relatedTransactions: { ...relatedTransactionsOrderConfig.components!.relatedTransactions, load: 'join', separate: undefined },
        'relatedTransactions.nextdoc': { ...relatedTransactionsOrderConfig.components!['relatedTransactions.nextdoc'], load: 'join' },
    },
    relationships: {
        relatedTransactions: { ...relatedTransactionsOrderConfig.relationships!.relatedTransactions, load: 'join' },
    },
});
