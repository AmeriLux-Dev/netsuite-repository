import { Entity, Key } from '@amerilux/netsuite-repository';
import { nothing } from './does-not-exist';

@Entity({ recordType: 'customer', table: 'customer' })
export class MissingRelative {
    @Key() id!: number;
    static readonly marker = nothing;
}
