import {
    Coerce,
    Column,
    Entity,
    ExcludeFromDefaultSelect,
    Join,
    Key,
    NotMapped,
    OwnsMany,
    OwnsOne,
    ReadOnly,
    RecordField,
    Related,
    SetFirst,
    Transform,
    UpdaterOptions,
    createEntityModelMetadata,
    getOrCreateNavigationMetadata,
    getOrCreatePropertyMetadata,
} from '../model';
import type { EntityModelMetadata } from '../model';

// ── Shared model shape ────────────────────────────────────────────────────────

export interface SalesOrderModel {
    id: number;
    tranId: string;
    memo: string | null;
    customerName: string;
    shippingAddress: { addr1: string | null; city: string | null };
    lines: Array<{ line: number; itemId: number; quantity: number }>;
    customer: { companyName: string };
}

/** Hand-built metadata for the sales order used across the model tests. */
export function buildSalesOrderMetadata(): EntityModelMetadata {
    const metadata = createEntityModelMetadata('salesOrders');
    metadata.setName = 'salesOrders';
    metadata.recordType = 'salesorder';
    metadata.table = { name: 'transaction', alias: 'txn' };
    metadata.keyProperty = 'id';
    metadata.joins.push({ alias: 'cust', table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } });

    Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'id'), { readOnly: true });
    Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'tranId'), { column: 'tranid' });
    Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'memo'), { recordFieldId: 'memo' });
    Object.assign(getOrCreatePropertyMetadata(metadata.properties, 'customerName'), { column: 'companyname', tableAlias: 'cust' });

    const shippingAddress = getOrCreateNavigationMetadata(metadata, 'shippingAddress', 'owned');
    shippingAddress.subrecordFieldId = 'shippingaddress';
    shippingAddress.clearListFieldId = 'shipaddresslist';
    shippingAddress.join = { alias: 'shipaddr', table: 'transactionshippingaddress', on: 'shipaddr.nkey = txn.shippingaddress' };
    Object.assign(getOrCreatePropertyMetadata(shippingAddress.properties, 'addr1'), { recordFieldId: 'addr1' });
    Object.assign(getOrCreatePropertyMetadata(shippingAddress.properties, 'city'), { recordFieldId: 'city' });

    const lines = getOrCreateNavigationMetadata(metadata, 'lines', 'collection');
    lines.sublistId = 'item';
    lines.matchByProperty = 'itemId';
    lines.lineNumberProperty = 'line';
    lines.join = { alias: 'tl', table: 'transactionline', type: 'inner', on: "tl.transaction = txn.id AND tl.mainline = ?", params: ['F'] };
    Object.assign(getOrCreatePropertyMetadata(lines.properties, 'line'), { column: 'linesequencenumber', type: 'integer', readOnly: true });
    Object.assign(getOrCreatePropertyMetadata(lines.properties, 'itemId'), { column: 'item', type: 'key', recordFieldId: 'item' });
    Object.assign(getOrCreatePropertyMetadata(lines.properties, 'quantity'), { type: 'float', recordFieldId: 'quantity' });

    const customer = getOrCreateNavigationMetadata(metadata, 'customer', 'related');
    customer.sourceAlias = 'cust';
    Object.assign(getOrCreatePropertyMetadata(customer.properties, 'companyName'), { column: 'companyname' });

    return metadata;
}

// ── Decorated equivalent ──────────────────────────────────────────────────────

export class DecoratedShippingAddress {
    @RecordField('addr1') addr1!: string | null;
    @RecordField('city') city!: string | null;
}

export class DecoratedSalesOrderLine {
    @Column('linesequencenumber', { type: 'integer' }) @ReadOnly() line!: number;
    @Column('item', { type: 'key' }) @RecordField('item') itemId!: number;
    @Column(undefined, { type: 'float' }) @RecordField() quantity!: number;
}

export class DecoratedCustomerLookup {
    @Column('companyname') companyName!: string;
}

@Entity({ recordType: 'salesorder', table: 'transaction', alias: 'txn', setName: 'salesOrders' })
@Join('cust', { table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } })
export class DecoratedSalesOrder {
    @Key() @ReadOnly() id!: number;
    @Column('tranid') tranId!: string;
    @RecordField('memo') memo!: string | null;
    @Column('companyname', { from: 'cust' }) customerName!: string;

    @OwnsOne(() => DecoratedShippingAddress, {
        subrecord: 'shippingaddress',
        clearListField: 'shipaddresslist',
        join: { alias: 'shipaddr', table: 'transactionshippingaddress', on: 'shipaddr.nkey = txn.shippingaddress' },
    })
    shippingAddress!: DecoratedShippingAddress;

    @OwnsMany(() => DecoratedSalesOrderLine, {
        sublist: 'item',
        matchBy: 'itemId',
        lineNumberProperty: 'line',
        join: { alias: 'tl', table: 'transactionline', type: 'inner', on: "tl.transaction = txn.id AND tl.mainline = ?", params: ['F'] },
    })
    lines!: DecoratedSalesOrderLine[];

    @Related(() => DecoratedCustomerLookup, { from: 'cust' })
    customer!: DecoratedCustomerLookup;
}

// ── Decorated customer exercising the remaining decorators and inheritance ────

export const uppercaseTransform = (value: unknown) => String(value).toUpperCase();

@UpdaterOptions({ requireFastPath: true })
@Coerce(false)
export class DecoratedEntityBase {
    @Key({ type: 'integer' }) id!: number;
    @Column('lastmodifieddate', { type: 'datetime' }) lastModified!: Date;
    @NotMapped() cachedLabel?: string;
}

@Entity({ recordType: 'customer', table: 'customer' })
export class DecoratedCustomer extends DecoratedEntityBase {
    @Column('companyname', { alias: 'name' }) @RecordField() @SetFirst() companyName!: string;
    @Column('entitystatus', { useText: true }) @Transform(uppercaseTransform) @ExcludeFromDefaultSelect() status!: string;
    @Column('lastmodifieddate', { type: 'date' }) lastModified!: Date;
}
