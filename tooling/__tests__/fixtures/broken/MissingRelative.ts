import { RecordType } from '@amerilux/netsuite-repository';
import { nothing } from './does-not-exist';

@RecordType('customer')
export class MissingRelative {
    id!: number;
    static readonly marker = nothing;
}
