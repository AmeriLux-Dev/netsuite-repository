import { defineModel } from '@amerilux/netsuite-repository';
import { trimText } from './shared';

export interface Customer {
    id: number;
    companyName: string;
    email: string | null;
    isInactive: boolean;
    categoryIds: number[];
    billingAddress: { addr1: string | null; city: string | null };
}

export const CustomerModel = defineModel<Customer>((model) => model
    .hasSetName('customers')
    .toRecord('customer')
    .toTable('customer', 'cust')
    .hasKey('id')
    .property('companyName').hasColumn('companyname').hasRecordField().transform(trimText)
    .property('email').hasRecordField()
    .property('isInactive').hasColumn('isinactive').hasRecordField()
    .property('categoryIds').hasColumn('category')
    .end()
    .ownsOne('billingAddress', (address) => address
        .toSubrecord('billingaddress')
        .fromAlias('cust')
        .property('addr1').hasColumn('billaddr1').hasRecordField('addr1')
        .property('city').hasColumn('billcity').hasRecordField('city')));
