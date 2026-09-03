import { Entity, Key } from '@amerilux/netsuite-repository';

@Entity({ recordType: 'customer', table: 'customer' })
export class Duplicate {
    @Key() id!: number;
}
