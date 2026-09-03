import { Field, RecordType } from '@amerilux/netsuite-repository';

export const inlineTransform = (value: unknown) => value;
const hiddenTransform = (value: unknown) => value;

@RecordType('customer')
export class Unmappable {
    id!: number;
    extra!: Map<string, string>;
    @Field({ type: 'string' }) name!: string;
}

export { hiddenTransform as hidden };
