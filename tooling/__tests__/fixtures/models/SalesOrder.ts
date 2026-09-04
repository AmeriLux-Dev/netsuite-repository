import { Field, NotMapped, ReadOnly, RecordType, Sublist } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import { Transaction, TransactionLine } from './Transaction';

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Field('custbody_approved') approved!: boolean;
    @Field('shipmethod', { table: 'salesorder' }) shipMethodId!: number | null;
    @Field('foreigntotal') @ReadOnly() total!: number;
    customer?: Pick<Customer, 'id' | 'companyName'>;
    @Sublist('item') lines!: TransactionLine[];
    @NotMapped() cachedLabel?: string;
}
