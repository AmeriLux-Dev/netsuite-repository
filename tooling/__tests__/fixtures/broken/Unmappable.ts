import { Column, Entity, Key } from '@amerilux/netsuite-repository';

export const inlineTransform = (value: unknown) => value;
const hiddenTransform = (value: unknown) => value;

@Entity({ recordType: 'customer', table: 'customer' })
export class Unmappable {
    @Key() id!: number;
    @Column('extra') extra!: Map<string, string>;
    @Column('name', { type: 'string' }) name!: string;
}

export class NoKey {
    @Column('x') x!: string;
}

export { hiddenTransform as hidden };
