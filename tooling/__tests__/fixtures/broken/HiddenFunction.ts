import { RecordType, Transform } from '@amerilux/netsuite-repository';

const hiddenTransform = (value: unknown) => value;

@RecordType('customer')
export class HiddenFunction {
    id!: number;
    @Transform(hiddenTransform) name!: string;
}
