import { Field, InternalId, ParentId, RecordType, Sublist, Subrecord } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';

/** linesequencenumber is one-based in SuiteQL; sublist line indexes are zero-based. */
export const toZeroBasedLine = (value: unknown): unknown => (typeof value === 'number' ? value - 1 : value);

/** Shared by the shipping and billing addresses; the subrecord field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    addr2!: string | null;
    city!: string | null;
    @Field({ setFirst: true }) state!: string | null;
    zip!: string | null;
}

/**
 * One line of the item sublist. The line's id is queried as `id` and written through the sublist field `line`;
 * `transaction` points at the parent, which is how N/query joins the lines to the order.
 */
@RecordType('transactionline')
export class TransactionLine {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;
    @ParentId() @Field('transaction', { readOnly: true }) transactionId!: number;
    @Field('linesequencenumber', { readOnly: true, transform: toZeroBasedLine }) line!: number;
    @Field('item') itemId!: number;
    quantity!: number;
    rate!: number;
    @Field({ readOnly: true }) amount!: number;
}

/** Common transaction fields. No @RecordType, so it has no record set of its own; sales orders inherit it. */
export abstract class Transaction {
    id!: number;
    @Field('tranid') tranId!: string;
    @Field('trandate') tranDate!: Date;
    /** The display text of the status; read-only. */
    @Field({ queryFieldId: 'status', text: true }) statusText!: string;
    /** The status code, queried as `status` and written through the record field `orderstatus`. */
    @Field('orderstatus', { queryFieldId: 'status' }) status!: string;
    memo?: string | null;
    @Field('entity', { setFirst: true }) customerId!: number;
    customer?: Pick<Customer, 'id' | 'companyName' | 'email'>;
    /** The subrecord 'shippingaddress': N/query resolves the join; the list field must be cleared before an edit. */
    @Subrecord({ clearListField: 'shipaddresslist' }) shippingAddress!: TransactionAddress;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('foreigntotal', { readOnly: true }) total!: number;
    @Field('custbody_auto_approved') autoApproved!: boolean;
    @Field('shipmethod') shipMethodId!: number | null;
    /**
     * The item lines. A `salesorder` root has no join to its lines in N/query; the `transaction` root reaches them through
     * `transactionlines`, so the lines run as their own query on that root, matched to the order by id.
     */
    @Sublist('item', { queryType: 'transaction', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
    /**
     * The transactions this order led to (fulfillments, invoices): the link off `transaction`, then the transaction each
     * link points at. Nothing between them needs a class, and the items are read-only.
     */
    @Sublist({ queryType: 'transaction', relationship: 'nexttransactionlink', through: [{ fieldId: 'nextdoc', target: 'transaction' }] }) relatedTransactions!: Pick<Transaction, 'id' | 'tranId' | 'statusText'>[];
}
