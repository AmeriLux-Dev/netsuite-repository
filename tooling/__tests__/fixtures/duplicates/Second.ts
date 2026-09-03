import { Entity, Key } from '@amerilux/netsuite-repository';

@Entity({ recordType: 'vendor', table: 'vendor' })
export class Duplicate {
    @Key() id!: number;
}
