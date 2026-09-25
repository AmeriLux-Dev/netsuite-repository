import { Field, NetsuiteRecordType, RecordType } from '@amerilux/netsuite-repository';

@RecordType(NetsuiteRecordType.CUSTOMER)
export class Customer {
    id!: number;
    @Field('companyname') companyName!: string;
    email!: string | null;
    @Field('isinactive') isInactive!: boolean;
    @Field('datecreated', { readOnly: true }) dateCreated!: Date;
}
