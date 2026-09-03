import { Column, Entity } from '@amerilux/netsuite-repository';

@Entity({ recordType: 'customer', table: 'customer' })
export class InvalidModel {
    @Column('companyname') companyName!: string;
}
