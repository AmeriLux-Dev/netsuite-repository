import { RecordType, Transform } from '@amerilux/netsuite-repository';

export const normalizeText = (value: unknown): unknown => (typeof value === 'string' ? value.toUpperCase() : value);

@RecordType('vendor')
export class SecondNormalized {
    id!: number;
    @Transform(normalizeText) name!: string;
}
