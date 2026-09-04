import { Field, RecordType, Subrecord } from '@amerilux/netsuite-repository';

export class Address {
    city!: string | null;
}

@RecordType('location')
export class Warehouse {
    id!: number;
    name!: string | null;
    /** Not in the conventions, so the property names the table and key. Inner join by default. */
    @Subrecord('mainaddress', { table: 'locationmainaddress', key: 'nkey' }) mainAddress?: Address;
}

@RecordType('transactionline')
export class InvoiceLine {
    id!: number;
    @Field('location') locationId!: number | null;
    /** A reference joins left outer; the subrecord under it must not turn that back into an inner join. */
    location?: Pick<Warehouse, 'id' | 'mainAddress'>;
}

@RecordType('invoice')
export class Invoice {
    id!: number;
    /** No @Sublist: the line table is transactionline, so the conventions know this is the `item` sublist. */
    lines!: InvoiceLine[];
}
