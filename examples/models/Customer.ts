import { Field, ReadOnly, RecordType } from '@amerilux/netsuite-repository';

@RecordType('customer')
export class Customer {
    id!: number;
    @Field('companyname') companyName!: string;
    email!: string | null;
    @Field('isinactive') isInactive!: boolean;
    @Field('datecreated') @ReadOnly() dateCreated!: Date;
}
