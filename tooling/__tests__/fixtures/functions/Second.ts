import { Field, RecordType } from '@amerilux/netsuite-repository';

export const normalizeText = (value: unknown): unknown => (typeof value === 'string' ? value.toUpperCase() : value);

@RecordType('vendor')
export class SecondNormalized {
    id!: number;
    @Field({ transform: normalizeText }) name!: string;
}
