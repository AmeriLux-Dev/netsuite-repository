# @amerilux/netsuite-repository

An Entity Framework-inspired data-access layer for NetSuite SuiteScript.

The package has three jobs:

1. Build and run SuiteQL from a config using `N/query`.
2. Map `asMappedResults()` rows into typed objects.
3. Update records from the same config using `N/record`.

## Install

```sh
npm install @amerilux/netsuite-repository
```

This package is meant to run inside SuiteScript or inside a SuiteScript bundle/build that can resolve NetSuite modules such as `N/query` and `N/record`.

## Shape

The ideal API is context-first:

```ts
const db = createNetSuiteContext({
    customers: CustomerConfig,
    salesOrders: SalesOrderConfig,
});

const customer = db.customers.find(12345);

const openOrders = db.salesOrders
    .where('status', '=', 'Pending Fulfillment')
    .orderByDesc('tranDate')
    .limit(25)
    .executeTyped();

const saved = db.customers.submitPatch(12345, {
    email: 'billing@example.com',
});
```

The lower-level `query(config)` and `updateRecord(config)` functions are still exported for scripts that want direct builder access.

## Relationships

Entity configs can define EF-style relationships for NetSuite subrecords and sublists. Scalar fields still describe how SuiteQL selects and maps values; relationships describe how those fields are reached when writing with `N/record`.

```ts
export const SalesOrderConfig = defineQueryConfig<SalesOrder>({
    recordType: 'salesorder',
    query: {
        from: { name: 'transaction', alias: 'txn' },
        joins: [
            // joins omitted
        ],
    },
    fields: {
        id: { queryFieldId: 'id', tableAlias: 'txn', type: 'integer', isPrimary: true, readonly: true },
        memo: { queryFieldId: 'memo', tableAlias: 'txn', type: 'string' },
        shippingAddress_addr1: { queryFieldId: 'addr1', tableAlias: 'shipAddr', type: 'string', nestPath: 'shippingAddress.addr1', recordFieldId: 'addr1' },
        shippingAddress_city: { queryFieldId: 'city', tableAlias: 'shipAddr', type: 'string', nestPath: 'shippingAddress.city', recordFieldId: 'city' },
        item_item: { queryFieldId: 'item', tableAlias: 'line', type: 'key', nestPath: 'items.item', cardinality: 'many', recordFieldId: 'item' },
        item_quantity: { queryFieldId: 'quantity', tableAlias: 'line', type: 'float', nestPath: 'items.quantity', cardinality: 'many', recordFieldId: 'quantity' },
    },
    relationships: {
        shippingAddress: {
            kind: 'owned',
            recordAccessId: 'shippingaddress',
            reload: { listFieldToClear: 'shipaddresslist' },
            fields: {
                addr1: 'shippingAddress_addr1',
                city: 'shippingAddress_city',
            },
        },
        items: {
            kind: 'collection',
            recordAccessId: 'item',
            fields: {
                item: 'item_item',
                quantity: 'item_quantity',
            },
        },
    },
});
```

Fields may also be grouped into `query`, `common`, and `record` sections. `defineQueryConfig`, `query`, `updateRecord`, and contexts normalize this shape into the same flat `QueryField` objects used above.

```ts
memo: {
    query: { queryFieldId: 'memo', tableAlias: 'txn' },
    common: { type: 'string' },
    record: { recordFieldId: 'memo' },
}
```

With that metadata, most updates can be a single object-shaped graph patch:

```ts
const result = db.salesOrders.submitPatch(9876, {
    memo: 'Updated from repository',
    shippingAddress: {
        addr1: '123 Main St',
        city: 'Dallas',
    },
    items: {
        update: [
            { line: 0, values: { quantity: 12 } },
            { match: { field: 'item', value: 12345 }, values: { quantity: 2 } },
        ],
        add: [
            { item: 67890, quantity: 1 },
        ],
        remove: [3],
    },
});
```

The fluent chain is still available when a script needs more control:

```ts
db.salesOrders.update(9876)
    .set('memo', 'Updated from repository')
    .owned('shippingAddress')
        .setMany({ addr1: '123 Main St', city: 'Dallas' })
        .end()
    .collection('items')
        .updateLine(0, { quantity: 12 })
        .addLine({ item: 12345, quantity: 1 })
        .end()
    .submit();
```

If a relationship field follows the naming convention `<relationshipName>_<fieldName>`, the `fields` map is optional. Explicit maps are better when NetSuite field names and domain property names drift apart.

## Define An Entity

```ts
import { defineQueryConfig } from '@amerilux/netsuite-repository';

interface CustomerSummary {
    id: number;
    entityId: string;
    companyName: string;
    email: string | null;
}

export const CustomerConfig = defineQueryConfig<CustomerSummary>({
    recordType: 'customer',
    query: {
        from: { name: 'customer', alias: 'cust' },
    },
    fields: {
        id: { queryFieldId: 'id', tableAlias: 'cust', type: 'integer', isPrimary: true, readonly: true },
        entityId: { queryFieldId: 'entityid', tableAlias: 'cust', type: 'string', readonly: true },
        companyName: { queryFieldId: 'companyname', tableAlias: 'cust', type: 'string', recordFieldId: 'companyname' },
        email: { queryFieldId: 'email', tableAlias: 'cust', type: 'string', recordFieldId: 'email' },
    },
});
```

The NetSuite MCP metadata tools are useful for validating `queryFieldId`, table names, field types, and joinable fields while creating these configs. SuiteQL metadata exposes joinable fields with `x-n:joinable` and `x-n:recordType`; record metadata exposes fields that can be submitted back to `N/record`.

## Create A Context

```ts
import { createNetSuiteContext } from '@amerilux/netsuite-repository';
import { CustomerConfig } from './CustomerConfig';
import { SalesOrderConfig } from './SalesOrderConfig';

export const db = createNetSuiteContext({
    customers: CustomerConfig,
    salesOrders: SalesOrderConfig,
});
```

Each registered entity becomes an `EntitySet` on the context. You can use the property form (`db.customers`) or lookup form (`db.set('customers')`).

## Query Typed Results

```ts
import { db } from './db';

const customers = db.customers.query()
    .where('email', 'IS NOT NULL')
    .orderByAsc('companyName')
    .limit(50)
    .executeTyped();
```

For simple primary-key lookups, mark one config field with `isPrimary: true` and call `find()`.

```ts
const customer = db.customers.find(12345);
```

Use `nestPath` and `cardinality: 'many'` to map joined rows into nested objects or arrays.

```ts
fields: {
    id: { queryFieldId: 'id', tableAlias: 'txn', type: 'integer', isPrimary: true },
    tranId: { queryFieldId: 'tranid', tableAlias: 'txn', type: 'string' },
    itemId: { queryFieldId: 'item', tableAlias: 'line', type: 'key', nestPath: 'lines.itemId', cardinality: 'many' },
    quantity: { queryFieldId: 'quantity', tableAlias: 'line', type: 'float', nestPath: 'lines.quantity', cardinality: 'many' },
}
```

## Update Records

```ts
import { db } from './db';

const result = db.customers
    .update(12345)
    .set('companyName', 'Acme Industrial')
    .set('email', 'ap@example.com')
    .submit();
```

For patch-style updates, use `submitPatch(id, values)`. The older `submit(id, values)` alias also routes through the same graph patch API.

```ts
const result = db.customers.submitPatch(12345, {
    companyName: 'Acme Industrial',
    email: 'ap@example.com',
});
```

Body-only updates use `record.submitFields()`. Subrecord or sublist changes load the record, apply changes, and save it.

### Billing And Shipping Addresses

Address fields are modeled as owned subrecord relationships. Billing and shipping addresses often point at an address-book entry, so NetSuite can reject direct edits until the list field is cleared and the transaction/customer is saved and reloaded. Declare that behavior on the relationship with `reload.listFieldToClear`.

```ts
relationships: {
    shippingAddress: {
        kind: 'owned',
        recordAccessId: 'shippingaddress',
        reload: { listFieldToClear: 'shipaddresslist' },
    },
    billingAddress: {
        kind: 'owned',
        recordAccessId: 'billingaddress',
        reload: { listFieldToClear: 'billaddresslist' },
    },
}
```

Then patch nested values normally:

```ts
db.salesOrders.submitPatch(9876, {
    shippingAddress: {
        addr1: '123 Main St',
        city: 'Dallas',
    },
});
```

The updater groups fields by the relationship `recordAccessId`, clears the configured list field, saves/reloads the record, updates the subrecord with `getSubrecord().setValue()`, and saves again.

```ts
db.salesOrders.submitPatch(9876, {
    items: {
        update: [
            { line: 0, values: { quantity: 12 } },
        ],
        add: [
            { item: 12345, quantity: 1 },
        ],
    },
});
```

## Direct Builder API

```ts
import { repository } from '@amerilux/netsuite-repository';

const customers = repository(CustomerConfig);

const rows = customers.query()
    .where('entityId', 'LIKE', 'ABC%')
    .executeTyped();

const saved = customers.update(12345)
    .set('email', 'billing@example.com')
    .submit();
```