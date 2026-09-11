import { RecordType, Transform } from '@amerilux/netsuite-repository';

export const normalizeText = (value: unknown): unknown => (typeof value === 'string' ? value.trim() : value);

@RecordType('customer')
export class FirstNormalized {
    id!: number;
    @Transform(normalizeText) name!: string;
}
