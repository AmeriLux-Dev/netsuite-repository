import { Field, RecordType, Transform } from '@amerilux/netsuite-repository';
import { trimText } from './shared';

@RecordType('customer', { setName: 'customers' })
export class Customer {
    id!: number;
    @Field('companyname') @Transform(trimText) companyName!: string;
    email!: string | null;
    @Field('isinactive') isInactive!: boolean;
    @Field('category') categoryIds!: number[];
}
