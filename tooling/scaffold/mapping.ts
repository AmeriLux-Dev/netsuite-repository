import type { FieldType, RestRecordFieldKind } from '../../src/types';

const compoundRecordTypeNames: Record<string, string> = {
    salesorder: 'SalesOrder',
    purchaseorder: 'PurchaseOrder',
    vendorbill: 'VendorBill',
    vendorcredit: 'VendorCredit',
    vendorpayment: 'VendorPayment',
    customerpayment: 'CustomerPayment',
    customerdeposit: 'CustomerDeposit',
    customerrefund: 'CustomerRefund',
    creditmemo: 'CreditMemo',
    cashsale: 'CashSale',
    cashrefund: 'CashRefund',
    itemfulfillment: 'ItemFulfillment',
    itemreceipt: 'ItemReceipt',
    inventoryadjustment: 'InventoryAdjustment',
    inventoryitem: 'InventoryItem',
    noninventoryitem: 'NonInventoryItem',
    serviceitem: 'ServiceItem',
    assemblyitem: 'AssemblyItem',
    journalentry: 'JournalEntry',
    returnauthorization: 'ReturnAuthorization',
    workorder: 'WorkOrder',
    transferorder: 'TransferOrder',
    supportcase: 'SupportCase',
    phonecall: 'PhoneCall',
    customrecord: 'CustomRecord',
};

export function toPascalCaseModelName(recordType: string): string {
    const lower = recordType.toLowerCase();
    if (compoundRecordTypeNames[lower]) {
        return compoundRecordTypeNames[lower];
    }
    return lower
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join('');
}

/** `custbody_ship_method` → `custbodyShipMethod`; `companyname` stays `companyname` (no separator to split on). */
export function toCamelCasePropertyName(fieldId: string): string {
    const segments = fieldId.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const camel = segments.map((segment, index) => (index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1))).join('');
    return /^[a-z_$]/.test(camel) ? camel : `field_${camel}`;
}

export interface MappedFieldType {
    fieldType: FieldType;
    typeScriptType: string;
}

/** SuiteQL column types as exposed by the Records Catalog (upper-cased), mapped to NetSuite field types and TypeScript types. */
export function mapSuiteQlColumnType(columnType: string | undefined, joinable = false): MappedFieldType {
    const type = (columnType ?? '').toUpperCase();
    if (joinable) return { fieldType: 'key', typeScriptType: 'number' };
    if (type === 'INTEGER' || type === 'INT') return { fieldType: 'integer', typeScriptType: 'number' };
    if (type === 'FLOAT' || type === 'DOUBLE' || type === 'NUMBER' || type === 'DECIMAL') return { fieldType: 'float', typeScriptType: 'number' };
    if (type === 'CURRENCY') return { fieldType: 'currency', typeScriptType: 'number' };
    if (type === 'BOOLEAN' || type === 'CHECKBOX') return { fieldType: 'boolean', typeScriptType: 'boolean' };
    if (type === 'DATE') return { fieldType: 'date', typeScriptType: 'Date' };
    if (type === 'DATETIME' || type === 'TIMESTAMP' || type === 'DATETIMETZ') return { fieldType: 'datetime', typeScriptType: 'Date' };
    if (type === 'MULTISELECT') return { fieldType: 'multiselect', typeScriptType: 'number[]' };
    return { fieldType: 'string', typeScriptType: 'string' };
}

/** Fallback when only record metadata is available for a field. */
export function mapRecordFieldKind(kind: RestRecordFieldKind): MappedFieldType {
    switch (kind) {
        case 'integer':
            return { fieldType: 'integer', typeScriptType: 'number' };
        case 'float':
            return { fieldType: 'float', typeScriptType: 'number' };
        case 'currency':
            return { fieldType: 'currency', typeScriptType: 'number' };
        case 'boolean':
            return { fieldType: 'boolean', typeScriptType: 'boolean' };
        case 'date':
            return { fieldType: 'date', typeScriptType: 'Date' };
        case 'datetime':
            return { fieldType: 'datetime', typeScriptType: 'Date' };
        case 'multiselect':
            return { fieldType: 'multiselect', typeScriptType: 'number[]' };
        case 'reference':
            return { fieldType: 'key', typeScriptType: 'number' };
        default:
            return { fieldType: 'string', typeScriptType: 'string' };
    }
}

export interface TableMapping {
    table: string;
    alias: string;
}

export interface SublistTableMapping extends TableMapping {
    /** Raw ON predicate using `${alias}` for the line table alias and `${root}` for the root alias. */
    on: string;
    lineNumberColumn?: string;
}

export interface SubrecordTableMapping extends TableMapping {
    on: string;
    clearListField?: string;
}

const transactionRecordTypes = new Set([
    'salesorder', 'invoice', 'purchaseorder', 'vendorbill', 'vendorcredit', 'vendorpayment', 'customerpayment', 'customerdeposit', 'customerrefund',
    'creditmemo', 'cashsale', 'cashrefund', 'itemfulfillment', 'itemreceipt', 'inventoryadjustment', 'journalentry', 'returnauthorization',
    'workorder', 'transferorder', 'estimate', 'opportunity', 'check', 'deposit', 'expensereport',
]);

const entityRecordTypes = new Set(['customer', 'vendor', 'employee', 'contact', 'partner', 'lead', 'prospect']);

const itemRecordTypes = new Set(['inventoryitem', 'noninventoryitem', 'serviceitem', 'assemblyitem', 'kititem', 'otherchargeitem', 'discountitem', 'giftcertificateitem', 'downloaditem']);

const sameNamedRecordTypes = new Set(['customer', 'vendor', 'employee', 'contact', 'partner', 'location', 'department', 'classification', 'subsidiary', 'account', 'item', 'task', 'currency', 'term', 'pricelevel', 'unitstype', 'job', 'campaign', 'promotioncode', 'supportcase', 'phonecall', 'message', 'note']);

/** Best-effort SuiteQL root table for a record type. Returns undefined when the mapping is not known. */
export function resolveTableForRecordType(recordType: string): TableMapping | undefined {
    const lower = recordType.toLowerCase();
    if (transactionRecordTypes.has(lower)) return { table: 'transaction', alias: 'txn' };
    if (itemRecordTypes.has(lower)) return { table: 'item', alias: 'itm' };
    if (sameNamedRecordTypes.has(lower)) return { table: lower, alias: lower.slice(0, 4) };
    if (lower.startsWith('customrecord')) return { table: lower, alias: 'rec' };
    return undefined;
}

export function resolveTableForSublist(recordType: string, sublistId: string): SublistTableMapping | undefined {
    const lower = recordType.toLowerCase();
    if (transactionRecordTypes.has(lower) && sublistId === 'item') {
        return { table: 'transactionline', alias: 'tl', on: "${alias}.transaction = ${root}.id AND ${alias}.mainline = 'F'", lineNumberColumn: 'linesequencenumber' };
    }
    if (transactionRecordTypes.has(lower) && sublistId === 'expense') {
        return { table: 'transactionline', alias: 'tl', on: "${alias}.transaction = ${root}.id AND ${alias}.mainline = 'F' AND ${alias}.expenseaccount IS NOT NULL", lineNumberColumn: 'linesequencenumber' };
    }
    if (entityRecordTypes.has(lower) && sublistId === 'addressbook') {
        return { table: 'entityaddressbook', alias: 'addr', on: '${alias}.entity = ${root}.id' };
    }
    return undefined;
}

export function resolveTableForSubrecord(recordType: string, subrecordFieldId: string): SubrecordTableMapping | undefined {
    const lower = recordType.toLowerCase();
    if (transactionRecordTypes.has(lower) && subrecordFieldId === 'shippingaddress') {
        return { table: 'transactionshippingaddress', alias: 'shipaddr', on: '${alias}.nkey = ${root}.shippingaddress', clearListField: 'shipaddresslist' };
    }
    if (transactionRecordTypes.has(lower) && subrecordFieldId === 'billingaddress') {
        return { table: 'transactionbillingaddress', alias: 'billaddr', on: '${alias}.nkey = ${root}.billingaddress', clearListField: 'billaddresslist' };
    }
    return undefined;
}

export function renderJoinPredicate(template: string, alias: string, rootAlias: string): string {
    return template.replace(/\$\{alias\}/g, alias).replace(/\$\{root\}/g, rootAlias);
}
