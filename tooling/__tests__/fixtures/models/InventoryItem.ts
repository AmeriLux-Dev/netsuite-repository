import { Field, RecordType } from '@amerilux/netsuite-repository';

@RecordType('inventoryitem')
export class InventoryItem {
    id!: number;
    @Field('itemid') itemId!: string;
    @Field('displayname') displayName!: string | null;
}
