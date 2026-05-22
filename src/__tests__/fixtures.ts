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
    query: { from: { name: 'customer', alias: 'cust' } },
    fields: {
        id:       { queryFieldId: 'id',          tableAlias: 'cust', type: 'integer',  isPrimary: true, recordFieldId: 'id' },
        name:     { queryFieldId: 'companyname',  tableAlias: 'cust', type: 'string',   recordFieldId: 'companyname' },
        email:    { queryFieldId: 'email',        tableAlias: 'cust', type: 'string',   recordFieldId: 'email' },
        isActive: { queryFieldId: 'isinactive',   tableAlias: 'cust', type: 'boolean',  recordFieldId: 'isinactive' },
        score:    { queryFieldId: 'custentity_score', tableAlias: 'cust', type: 'float', recordFieldId: 'custentity_score' },
    },
});

// ── Order config with LEFT JOIN and cardinality: 'many' ───────────────────────

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
    query: {
        from: { name: 'transaction', alias: 'txn' },
        joins: [{
            toTable: { name: 'transactionline', alias: 'tl' },
            fromTable: 'txn',
            type: 'leftOuter',
            constraints: [
                { joinKeys: { sourceForeignKey: 'id', targetPrimaryKey: 'transaction' } },
                { joinKeys: { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'subsidiary', sourceTable: 'txn', targetTable: 'tl' }, joinLinkType: 'AND' },
            ],
        }],
    },
    fields: {
        id:           { queryFieldId: 'id',       tableAlias: 'txn', type: 'integer', isPrimary: true, recordFieldId: 'id' },
        entityId:     { queryFieldId: 'entity',   tableAlias: 'txn', type: 'key',     recordFieldId: 'entity' },
        lines_itemId: { queryFieldId: 'item',     tableAlias: 'tl',  type: 'key',     recordFieldId: 'item',     recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemId', cardinality: 'many' },
        lines_qty:    { queryFieldId: 'quantity', tableAlias: 'tl',  type: 'float',   recordFieldId: 'quantity', recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',    cardinality: 'many' },
        lines_amount: { queryFieldId: 'amount',   tableAlias: 'tl',  type: 'currency',recordFieldId: 'amount',   recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.amount', cardinality: 'many' },
    },
});

// ── Vendor bill with owned subrecord relationship ─────────────────────────────

export interface VendorBill {
    id: number;
    memo: string;
    billingAddress: { addr1: string; city: string };
}

export const vendorBillConfig = defineQueryConfig<VendorBill>({
    recordType: 'vendorbill',
    query: { from: { name: 'transaction', alias: 'txn' } },
    fields: {
        id:   { queryFieldId: 'id',   tableAlias: 'txn', type: 'integer', isPrimary: true, recordFieldId: 'id' },
        memo: { queryFieldId: 'memo', tableAlias: 'txn', type: 'string',  recordFieldId: 'memo' },
        billingAddress_addr1: {
            queryFieldId: 'billaddr1', tableAlias: 'txn', type: 'string',
            recordFieldId: 'addr1', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
            nestPath: 'billingAddress.addr1',
        },
        billingAddress_city: {
            queryFieldId: 'billcity', tableAlias: 'txn', type: 'string',
            recordFieldId: 'city', recordAccess: 'subrecord', recordAccessId: 'billingaddress',
            nestPath: 'billingAddress.city',
        },
    },
    relationships: {
        billingAddress: { kind: 'owned', recordAccessId: 'billingaddress' },
    },
});

// ── Sales order with sublist collection relationship ──────────────────────────

export interface SalesOrderLine { itemId: number; qty: number; }
export interface SalesOrder { id: number; tranId: string; lines: SalesOrderLine[]; }

export const salesOrderConfig = defineQueryConfig<SalesOrder>({
    recordType: 'salesorder',
    query: { from: { name: 'transaction', alias: 'txn' } },
    fields: {
        id:          { queryFieldId: 'id',       tableAlias: 'txn', type: 'integer', isPrimary: true, recordFieldId: 'id' },
        tranId:      { queryFieldId: 'tranid',   tableAlias: 'txn', type: 'string',  recordFieldId: 'tranid' },
        lines_itemId:{ queryFieldId: 'item',     tableAlias: 'tl',  type: 'key',     recordFieldId: 'item',     recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.itemId', cardinality: 'many',
            updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'item' } },
        lines_qty:   { queryFieldId: 'quantity', tableAlias: 'tl',  type: 'float',   recordFieldId: 'quantity', recordAccess: 'sublist', recordAccessId: 'item', nestPath: 'lines.qty',    cardinality: 'many',
            updateMapping: { kind: 'sublist', sublistId: 'item', fieldId: 'quantity', matchBy: 'item' } },
    },
    relationships: {
        lines: { kind: 'collection', recordAccessId: 'item', matchField: 'itemId' },
    },
});

// ── Config with REST record metadata ─────────────────────────────────────────

export interface RestCustomer { id: number; name: string; status: string; score: number; flag: boolean; tags: string[]; }

export const restMetadataConfig = defineQueryConfig<RestCustomer>({
    recordType: 'customer',
    query: { from: { name: 'customer', alias: 'cust' } },
    fields: {
        id:     { queryFieldId: 'id',     tableAlias: 'cust', isPrimary: true },
        name:   { queryFieldId: 'companyname', tableAlias: 'cust' },
        status: { queryFieldId: 'status', tableAlias: 'cust' },
        score:  { queryFieldId: 'score',  tableAlias: 'cust' },
        flag:   { queryFieldId: 'flag',   tableAlias: 'cust' },
        tags:   { queryFieldId: 'tags',   tableAlias: 'cust' },
    },
    restRecordMetadata: {
        recordType: 'customer',
        fields: {
            id:     { id: 'id',    kind: 'integer', writable: false },
            companyname: { id: 'companyname', kind: 'string', writable: true, minLength: 1, maxLength: 100 },
            status: { id: 'status', kind: 'string', writable: true, enumValues: ['active', 'inactive'] },
            score:  { id: 'score',  kind: 'float',  writable: true, minimum: 0, maximum: 100 },
            flag:   { id: 'flag',   kind: 'boolean',writable: true },
            tags:   { id: 'tags',   kind: 'multiselect', writable: true },
        },
    },
});

// ── Composite explicit update config ─────────────────────────────────────────

export interface Invoice { id: number; memo: string; amount: number; }

export const compositeConfig = defineQueryConfig<Invoice>({
    recordType: 'invoice',
    query: { from: { name: 'transaction', alias: 'txn' } },
    composite: { updateMode: 'explicit' },
    fields: {
        id:     { queryFieldId: 'id',     tableAlias: 'txn', isPrimary: true, updateMapping: { kind: 'body', fieldId: 'id' } },
        memo:   { queryFieldId: 'memo',   tableAlias: 'txn', updateMapping: { kind: 'body', fieldId: 'memo' } },
        amount: { queryFieldId: 'amount', tableAlias: 'txn', updateMapping: { kind: 'body', fieldId: 'amount' } },
    },
});

// ── Inner join config ─────────────────────────────────────────────────────────

export const innerJoinConfig = defineQueryConfig<{ id: number; dept: string }>({
    recordType: 'employee',
    query: {
        from: { name: 'employee', alias: 'emp' },
        joins: [{
            toTable: { name: 'department', alias: 'dept' },
            fromTable: 'emp',
            type: 'inner',
            constraints: [{ joinKeys: { sourceForeignKey: 'department', targetPrimaryKey: 'id' } }],
        }],
    },
    fields: {
        id:   { queryFieldId: 'id',   tableAlias: 'emp',  isPrimary: true },
        dept: { queryFieldId: 'name', tableAlias: 'dept', alias: 'deptName', useText: true },
    },
});

// ── Right outer join config ───────────────────────────────────────────────────

export const rightJoinConfig = defineQueryConfig<{ id: number; val: string }>({
    recordType: 'foo',
    query: {
        from: { name: 'foo', alias: 'f' },
        joins: [{
            toTable: { name: 'bar', alias: 'b' },
            fromTable: 'f',
            type: 'rightOuter',
            constraints: [{ joinKeys: { sourceForeignKey: 'bar_id', targetPrimaryKey: 'id' } }],
        }],
    },
    fields: {
        id:  { queryFieldId: 'id',  tableAlias: 'f', isPrimary: true },
        val: { queryFieldId: 'val', tableAlias: 'b' },
    },
});
