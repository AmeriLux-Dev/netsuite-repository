import { Column, Entity, Key, Transform } from '@amerilux/netsuite-repository';

const hiddenTransform = (value: unknown) => value;

@Entity({ recordType: 'customer', table: 'customer' })
export class HiddenFunction {
    @Key() id!: number;
    @Column('name') @Transform(hiddenTransform) name!: string;
}
