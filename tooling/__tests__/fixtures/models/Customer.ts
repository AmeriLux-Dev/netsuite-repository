import { Field, RecordType } from '@amerilux/netsuite-repository';
import { trimText } from './shared';

@RecordType('customer', { setName: 'customers' })
export class Customer {
    id!: number;
    @Field('companyname', { transform: trimText }) companyName!: string;
    email!: string | null;
    @Field('isinactive') isInactive!: boolean;
    @Field('category') categoryIds!: number[];
}
