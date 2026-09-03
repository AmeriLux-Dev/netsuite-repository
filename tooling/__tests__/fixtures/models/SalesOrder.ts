import { ExcludeFromDefaultSelect, Field, NotMapped, ReadOnly, RecordType, Sublist } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import type { InventoryItem } from './InventoryItem';
import { Transaction } from './Transaction';

@Sublist('item')
export class SalesOrderLine {
    id!: number;
    @Field('item') itemId!: number;
    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;
    quantity!: number;
    @ReadOnly() amount!: number;
    @ExcludeFromDefaultSelect() @Field('custcol_notes') notes!: string | null;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Field('custbody_approved') approved!: boolean;
    @Field('shipmethod', { table: 'salesorder' }) shipMethodId!: number | null;
    @Field('foreigntotal') @ReadOnly() total!: number;
    customer?: Pick<Customer, 'id' | 'companyName'>;
    lines!: SalesOrderLine[];
    @NotMapped() cachedLabel?: string;
}
