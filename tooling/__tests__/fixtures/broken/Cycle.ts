import { Field, RecordType } from '@amerilux/netsuite-repository';

@RecordType('customer')
export class CycleCustomer {
    id!: number;
    @Field('parent') parentId!: number | null;
    parent?: CycleCustomer;
}
