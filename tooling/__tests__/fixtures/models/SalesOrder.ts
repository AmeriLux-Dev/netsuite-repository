import { Field, NotMapped, ReadOnly, RecordType, Sublist } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import { Transaction, TransactionLine } from './Transaction';

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Field('custbody_approved') approved!: boolean;
    @Field('shipmethod') shipMethodId!: number | null;
    @Field('foreigntotal') @ReadOnly() total!: number;
    customer?: Pick<Customer, 'id' | 'companyName'>;
    /** The item lines are the transaction lines that are not the header line. */
    @Sublist('item', { filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
    @NotMapped() cachedLabel?: string;
}
