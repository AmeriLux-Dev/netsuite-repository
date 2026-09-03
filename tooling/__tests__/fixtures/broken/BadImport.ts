import { RecordType } from '@amerilux/netsuite-repository';
import * as fs from 'fs';

@RecordType('customer')
export class BadImport {
    id!: number;
    static readonly marker = typeof fs;
}
