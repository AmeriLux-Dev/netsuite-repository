import { Column, Entity, Join, Key, OwnsMany, OwnsOne, ReadOnly, RecordField, Related, SetFirst, Transform } from '@amerilux/netsuite-repository';

/** linesequencenumber is one-based in SuiteQL; sublist line indexes are zero-based. */
export const toZeroBasedLine = (value: unknown): unknown => (typeof value === 'number' ? value - 1 : value);

export class ShippingAddress {
    @RecordField('addr1') addr1!: string | null;
    @RecordField('addr2') addr2!: string | null;
    @RecordField('city') city!: string | null;
    @RecordField('state') state!: string | null;
    @RecordField('zip') zip!: string | null;
}

export class SalesOrderLine {
    @Column('linesequencenumber') @Transform(toZeroBasedLine) @ReadOnly() line!: number;
    @Column('item', { type: 'key' }) @RecordField('item') itemId!: number;
    @RecordField() quantity!: number;
    @RecordField() rate!: number;
    @ReadOnly() amount!: number;
}

export class CustomerLookup {
    @Column('companyname') companyName!: string;
    @Column('email') email!: string | null;
}

@Entity({ recordType: 'salesorder', table: 'transaction', alias: 'txn' })
@Join('cust', { table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } })
export class SalesOrder {
    @Key() id!: number;
    @Column('tranid') tranId!: string;
    @Column('trandate') tranDate!: Date;
    @Column('status') status!: string;
    @Column('foreigntotal') total!: number;
    @RecordField('memo') memo?: string | null;
    @Column('custbody_auto_approved') @RecordField() autoApproved!: boolean;
    @Column('entity') @RecordField('entity') @SetFirst() customerId!: number;

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
        join: { alias: 'tl', table: 'transactionline', on: "tl.transaction = txn.id AND tl.mainline = 'F'" },
    })
    lines!: SalesOrderLine[];

    @Related(() => CustomerLookup, { from: 'cust' })
    customer!: CustomerLookup;
}
