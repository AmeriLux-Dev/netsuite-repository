import { RecordType } from '@amerilux/netsuite-repository';

@RecordType('customer')
export class InvalidModel {
    companyName!: string;
}
