import { Field, SetFirst, Transform } from '@amerilux/netsuite-repository';
import { uppercaseText } from './shared';

/** Shared by the shipping and billing subrecords; the field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
}

/** Mapping base for every transaction type: no record set of its own, its members are inherited. */
export abstract class Transaction {
    id!: number;
    @Field('tranid') @Transform(uppercaseText) tranId!: string;
    tranDate!: Date;
    memo?: string | null;
    @Field('entity') customerId!: number;
    @Field('status', { text: true }) statusText!: string;
    shippingAddress!: TransactionAddress;
    billingAddress?: TransactionAddress;
}
