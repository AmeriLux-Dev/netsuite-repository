import { Field, RecordType } from '@amerilux/netsuite-repository';

export const normalizeText = (value: unknown): unknown => (typeof value === 'string' ? value.trim() : value);

@RecordType('customer')
export class FirstNormalized {
    id!: number;
    @Field({ transform: normalizeText }) name!: string;
}
