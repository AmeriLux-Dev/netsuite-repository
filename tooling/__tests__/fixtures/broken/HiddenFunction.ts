import { Field, RecordType } from '@amerilux/netsuite-repository';

const hiddenTransform = (value: unknown) => value;

@RecordType('customer')
export class HiddenFunction {
    id!: number;
    @Field({ transform: hiddenTransform }) name!: string;
}
