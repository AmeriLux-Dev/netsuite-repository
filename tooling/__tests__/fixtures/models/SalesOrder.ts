import { Column, Entity, Join, Key, OwnsMany, OwnsOne, ReadOnly, RecordField, Related, SetFirst, Transform } from '@amerilux/netsuite-repository';
import { MAIN_LINE_FILTER } from './shared';

export class ShippingAddress {
    @RecordField('addr1') addr1!: string | null;
    @RecordField('city') city!: string | null;
}

export class SalesOrderLine {
    @Column('linesequencenumber') @ReadOnly() line!: number;
    @Column('item', { type: 'key' }) @RecordField('item') itemId!: number;
    @RecordField() quantity!: number;
    @ReadOnly() amount!: number;
}

export class CustomerLookup {
    @Column('companyname') companyName!: string;
}

export const uppercaseText = (value: unknown): unknown => (typeof value === 'string' ? value.toUpperCase() : value);

@Entity({ recordType: 'salesorder', table: 'transaction', alias: 'txn' })
@Join('cust', { table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } })
export class SalesOrder {
    @Key() id!: number;
    @Column('tranid') @Transform(uppercaseText) tranId!: string;
    @Column('trandate') tranDate!: Date;
    @RecordField('memo') memo?: string | null;
    @Column('custbody_approved') @RecordField() approved!: boolean;
    @RecordField('entity') @SetFirst() customerId!: number;
    @Column('companyname', { from: 'cust' }) customerName!: string;

    @OwnsOne(() => ShippingAddress, {
        subrecord: 'shippingaddress',
        clearListField: 'shipaddresslist',
        join: { alias: 'shipaddr', table: 'transactionshippingaddress', on: 'shipaddr.nkey = txn.shippingaddress' },
    })
    shippingAddress!: ShippingAddress;

    @OwnsMany(() => SalesOrderLine, {
        sublist: 'item',
        matchBy: 'itemId',
        lineNumberProperty: 'line',
        join: { alias: 'tl', table: 'transactionline', on: MAIN_LINE_FILTER },
    })
    lines!: SalesOrderLine[];

    @Related(() => CustomerLookup, { from: 'cust' })
    customer!: CustomerLookup;
}
