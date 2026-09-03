import type { Discriminator } from '../../src/types';
import type { LineKey } from '../../src/model';

/**
 * The NetSuite facts the build step is allowed to assume. Every entry is a documented property of the
 * standard record model; anything not listed here must be declared with a decorator option.
 */

export interface RecordTypeConvention {
    /** Base SuiteQL table. */
    table: string;
    /** Table-per-hierarchy filter when the table is shared with other record types. */
    discriminator?: Discriminator;
    /** Type tables sharing the internal id, keyed by table name. */
    typeTables?: Record<string, { key: string }>;
}

export interface SubrecordConvention {
    table: string;
    /** Column on the subrecord table that matches the parent's subrecord field. */
    key: string;
    /** List field cleared before the subrecord can be edited through the record. */
    clearListField?: string;
}

export interface SublistConvention {
    table: string;
    /** Column on the line table holding the parent's internal id. */
    parentColumn: string;
    /** Extra predicate; `{alias}` stands for the line table alias. */
    where?: string;
    lineKey: LineKey;
}

/** Transaction record types and the `transaction.type` value that selects them. */
const transactionTypes: Record<string, string> = {
    salesorder: 'SalesOrd',
    invoice: 'CustInvc',
    estimate: 'Estimate',
    cashsale: 'CashSale',
    cashrefund: 'CashRfnd',
    creditmemo: 'CustCred',
    customerpayment: 'CustPymt',
    customerdeposit: 'CustDep',
    customerrefund: 'CustRfnd',
    depositapplication: 'DepAppl',
    returnauthorization: 'RtnAuth',
    itemfulfillment: 'ItemShip',
    itemreceipt: 'ItemRcpt',
    purchaseorder: 'PurchOrd',
    purchaserequisition: 'PurchReq',
    vendorbill: 'VendBill',
    vendorcredit: 'VendCred',
    vendorpayment: 'VendPymt',
    vendorreturnauthorization: 'VendAuth',
    check: 'Check',
    deposit: 'Deposit',
    journalentry: 'Journal',
    expensereport: 'ExpRept',
    transferorder: 'TrnfrOrd',
    inventoryadjustment: 'InvAdjst',
    inventorytransfer: 'InvTrnfr',
    inventorycount: 'InvCount',
    workorder: 'WorkOrd',
    workordercompletion: 'WOCompl',
    workorderissue: 'WOIssue',
    workorderclose: 'WOClose',
    assemblybuild: 'Build',
    assemblyunbuild: 'Unbuild',
    opportunity: 'Opprtnty',
    paycheck: 'PayChek',
};

/** Item record types and the `item.itemtype` value that selects them. */
const itemTypes: Record<string, string> = {
    inventoryitem: 'InvtPart',
    noninventoryitem: 'NonInvtPart',
    serviceitem: 'Service',
    assemblyitem: 'Assembly',
    kititem: 'Kit',
    otherchargeitem: 'OthCharge',
    discountitem: 'Discount',
    markupitem: 'Markup',
    paymentitem: 'Payment',
    subtotalitem: 'Subtotal',
    descriptionitem: 'Description',
    giftcertificateitem: 'GiftCert',
    downloaditem: 'DwnLdItem',
};

/** Transaction record types that also have a type table of their own, joined on the internal id. */
const transactionTypeTables: Record<string, string> = {
    salesorder: 'salesorder',
};

export function resolveRecordTypeConvention(recordType: string): RecordTypeConvention {
    const lower = recordType.toLowerCase();
    const transactionType = transactionTypes[lower];
    if (transactionType) {
        const typeTable = transactionTypeTables[lower];
        return {
            table: 'transaction',
            discriminator: { column: 'type', value: transactionType },
            typeTables: typeTable ? { [typeTable]: { key: 'id' } } : undefined,
        };
    }
    const itemType = itemTypes[lower];
    if (itemType) {
        return { table: 'item', discriminator: { column: 'itemtype', value: itemType } };
    }
    return { table: lower };
}

/** Columns whose record field id differs from the SuiteQL column name. */
const fieldIdsByColumn: Record<string, Record<string, string>> = {
    transaction: { status: 'orderstatus' },
};

export function resolveFieldIdForColumn(table: string, column: string): string {
    return fieldIdsByColumn[table.toLowerCase()]?.[column.toLowerCase()] ?? column;
}

const subrecords: Record<string, Record<string, SubrecordConvention>> = {
    transaction: {
        shippingaddress: { table: 'transactionshippingaddress', key: 'nkey', clearListField: 'shipaddresslist' },
        billingaddress: { table: 'transactionbillingaddress', key: 'nkey', clearListField: 'billaddresslist' },
    },
};

export function resolveSubrecordConvention(table: string, subrecordFieldId: string): SubrecordConvention | undefined {
    return subrecords[table.toLowerCase()]?.[subrecordFieldId.toLowerCase()];
}

const sublists: Record<string, Record<string, SublistConvention>> = {
    transaction: {
        item: { table: 'transactionline', parentColumn: 'transaction', where: "{alias}.mainline = 'F'", lineKey: { column: 'id', field: 'line' } },
    },
};

export function resolveSublistConvention(table: string, sublistId: string): SublistConvention | undefined {
    return sublists[table.toLowerCase()]?.[sublistId.toLowerCase()];
}

/** The sublist field that identifies a line when nothing better is known. */
export const defaultLineKeyField = 'line';
