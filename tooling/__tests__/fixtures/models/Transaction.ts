import { ExcludeFromDefaultSelect, Field, ReadOnly, RecordType, SetFirst, Subrecord, Transform } from '@amerilux/netsuite-repository';
import type { InventoryItem } from './InventoryItem';
import { uppercaseText } from './shared';

/** Shared by the shipping and billing subrecords; the field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
}

/** One line of a transaction sublist, read from the transactionline table. `id` is the line key the conventions match on write. */
@RecordType('transactionline')
export class TransactionLine {
    id!: number;
    @Field('item') itemId!: number;
    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;
    quantity!: number;
    @ReadOnly() amount!: number;
    @ExcludeFromDefaultSelect() @Field('custcol_notes') notes!: string | null;
}

/** Mapping base for every transaction type: no record set of its own, its members are inherited. */
export abstract class Transaction {
    id!: number;
    @Field('tranid') @Transform(uppercaseText) tranId!: string;
    tranDate!: Date;
    memo?: string | null;
    @Field('entity') customerId!: number;
    @Field('status', { text: true }) statusText!: string;
    @Subrecord('shippingaddress') shippingAddress!: TransactionAddress;
    billingAddress?: TransactionAddress;
}
