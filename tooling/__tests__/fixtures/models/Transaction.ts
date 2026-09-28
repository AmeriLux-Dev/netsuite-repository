import { Field, InternalId, ParentId, RecordType, Subrecord } from '@amerilux/netsuite-repository';
import type { InventoryItem } from './InventoryItem';
import { uppercaseText } from './shared';

/** Shared by the shipping and billing subrecords; the field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @Field({ setFirst: true }) state!: string | null;
}

/** One line of a transaction sublist. The line id is queried as `id` and written through the sublist field `line`; `transaction` points at the parent. */
@RecordType('transactionline')
export class TransactionLine {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;
    @ParentId() @Field('transaction', { readOnly: true }) transactionId!: number;
    @Field('item') itemId!: number;
    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;
    quantity!: number;
    @Field({ readOnly: true }) amount!: number;
    @Field('custcol_notes', { selectByDefault: false }) notes!: string | null;
}

/** Mapping base for every transaction type: no record set of its own, its members are inherited. */
export abstract class Transaction {
    id!: number;
    @Field('tranid', { transform: uppercaseText }) tranId!: string;
    tranDate!: Date;
    memo?: string | null;
    @Field('entity') customerId!: number;
    @Field({ queryFieldId: 'status', text: true }) statusText!: string;
    @Subrecord('shippingaddress', { clearListField: 'shipaddresslist' }) shippingAddress!: TransactionAddress;
    @Subrecord({ clearListField: 'billaddresslist' }) billingAddress?: TransactionAddress;
}
