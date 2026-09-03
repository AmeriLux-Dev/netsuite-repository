import { Field, ReadOnly, RecordType, SetFirst, Sublist, Transform } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';

/** linesequencenumber is one-based in SuiteQL; sublist line indexes are zero-based. */
export const toZeroBasedLine = (value: unknown): unknown => (typeof value === 'number' ? value - 1 : value);

/** Shared by the shipping and billing addresses; the subrecord field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    addr2!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
    zip!: string | null;
}

/** Common transaction fields. No @RecordType, so it has no record set of its own; sales orders inherit it. */
export abstract class Transaction {
    id!: number;
    @Field('tranid') tranId!: string;
    @Field('trandate') tranDate!: Date;
    @Field({ column: 'status', text: true }) statusText!: string;
    status!: string;
    memo?: string | null;
    @Field('entity') @SetFirst() customerId!: number;
    customer?: Pick<Customer, 'id' | 'companyName' | 'email'>;
    shippingAddress!: TransactionAddress;
}

@Sublist('item')
export class SalesOrderLine {
    id!: number;
    @Field('linesequencenumber') @Transform(toZeroBasedLine) @ReadOnly() line!: number;
    @Field('item') itemId!: number;
    quantity!: number;
    rate!: number;
    @ReadOnly() amount!: number;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('foreigntotal') @ReadOnly() total!: number;
    @Field('custbody_auto_approved') autoApproved!: boolean;
    @Field('shipmethod', { table: 'salesorder' }) shipMethodId!: number | null;
    lines!: SalesOrderLine[];
}
