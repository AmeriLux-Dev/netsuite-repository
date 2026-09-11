import { RecordType } from '@amerilux/netsuite-repository';

class HiddenAddress {
    addr1!: string;
}

@RecordType('customer')
export class UnexportedTarget {
    id!: number;
    address?: HiddenAddress;
}
