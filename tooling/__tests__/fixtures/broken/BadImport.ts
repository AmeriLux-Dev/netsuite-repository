import { Entity, Key } from '@amerilux/netsuite-repository';
import * as fs from 'fs';

@Entity({ recordType: 'customer', table: 'customer' })
export class BadImport {
    @Key() id!: number;
    static readonly marker = typeof fs;
}
