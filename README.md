# @amerilux/netsuite-repository

Entity Framework style data access for NetSuite SuiteScript, in NetSuite's own vocabulary.

- **A model is a class.** `@RecordType('salesorder')` on a class makes it a record set on the context. Every declared property is a field; the member decorators name what NetSuite calls the rest: `@Subrecord` on an object-typed property, `@Sublist` on an array-typed property, `@Reference` on a property typed as another record class. Decorators only override what the model itself already says.
- **A build step generates the config and type files** from the classes, TanStack Router style, so the SuiteScript bundle carries plain objects and no decorator machinery.
- **The runtime queries through the N/query object model** (`query.create`, `autoJoin`, `joinTo`, `joinFrom`, columns, conditions, sorts, `runPaged`), maps rows into typed objects, and writes through `N/record` with the fast path (`submitFields`) whenever the change allows it. SuiteQL text is never assembled.
- **The library carries no NetSuite schema.** Tables, key columns, and join predicates come from N/query at run time; the few NetSuite facts a model needs are declared in the model.
- **Change tracking** gives you `find()`, mutate, `saveChanges()`.

## Vocabulary

| NetSuite term | Entity Framework equivalent | In a model |
| --- | --- | --- |
| Record type | Entity | a class with `@RecordType('salesorder')` |
| Internal id | Key | the property `id` |
| Field | Column / property | any declared property |
| Select field | Foreign key | a `number` property holding an internal id, `customerId` |
| Reference | Reference navigation | a property typed as another record class, `customer?: Pick<Customer, ...>` |
| Subrecord | Owned type | an object-typed property, `shippingAddress: TransactionAddress` |
| Sublist | Collection navigation | an array-typed property, `@Sublist('item') lines: TransactionLine[]` |
| Sublist line | Dependent entity | a record type whose `@ParentId()` property points at the parent |
| Record set | DbSet | `db.salesOrders` |

## Install

```sh
npm install @amerilux/netsuite-repository
```

Enable decorators in the project that authors models:

```json
{ "compilerOptions": { "experimentalDecorators": true } }
```

The build step needs Node 18 or newer and the `typescript` package of your project.

## Define a model

```ts
// src/models/SalesOrder.ts
import { Field, InternalId, ParentId, RecordType, Sublist, Subrecord } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import type { InventoryItem } from './InventoryItem';

/** Shared by the shipping and billing addresses; the subrecord field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @Field({ setFirst: true }) state!: string | null;   // written before zip so address validation accepts it
    zip!: string | null;
}

/** A sublist line is a record type. Its @ParentId() property is the field N/query joins the lines through. */
@RecordType('transactionline')
export class TransactionLine {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;   // queried as id, written through the sublist field line
    @ParentId() @Field('transaction', { readOnly: true }) transactionId!: number;
    @Field('item') itemId!: number;
    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;    // reference inside the line
    quantity!: number;
    rate!: number | null;
    @Field({ readOnly: true }) amount!: number;
}

/** Common transaction fields. No @RecordType, so no record set of its own; every transaction type inherits it. */
export abstract class Transaction {
    id!: number;                                             // internal id, read-only
    @Field('tranid') tranId!: string;                        // renamed field
    tranDate!: Date;                                         // field 'trandate', type date, writable
    memo?: string | null;
    @Field('entity') customerId!: number;                    // select field
    customer?: Pick<Customer, 'id' | 'companyName'>;          // reference, joined on customerId, two fields only
    @Field({ queryFieldId: 'status', text: true }) statusText!: string;        // display text, read-only
    @Field('orderstatus', { queryFieldId: 'status' }) status!: string;        // queried as status, written as orderstatus
    @Subrecord({ clearListField: 'shipaddresslist' }) shippingAddress!: TransactionAddress;
    @Subrecord({ clearListField: 'billaddresslist' }) billingAddress?: TransactionAddress;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Field('shipmethod') shipMethodId!: number | null;
    @Field('foreigntotal', { readOnly: true }) total!: number;
    /** The item lines: queried from the `transaction` root through `transactionlines` (a `salesorder` root has no join to its lines), without the header line. */
    @Sublist('item', { queryType: 'transaction', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
}
```

Three rules cover most of what you see above:

1. **Every declared property is a mapped field.** `@NotMapped()` opts out; the property stays on the generated type for values you fill in after the query.
2. **Every body field is writable.** `@Field({ readOnly: true })` opts out. The field id is the lowercased property name and doubles as the N/query field id; `@Field(id)` renames it, `@Field(id, { queryFieldId })` splits the two when NetSuite queries a field under one name and writes it under another.
3. **A property typed as another model class is a reference, subrecord, or sublist.** The join comes from the declared type and N/query: a subrecord is `autoJoin` on its field, a sublist is `joinFrom` through the line class's `@ParentId()` field, a reference is `joinTo` through its select field and the target's record type. No predicate is ever written by hand.

The class decorator is only ever `@RecordType`. A sublist line class is a record type like any other; the sublist it belongs to is declared on the property of the parent.

### What the model declares, and what it does not have to

| Concern | Default | Override |
| --- | --- | --- |
| Internal id | the property `id`, type integer | `@InternalId()` on another property |
| Parent of a line | | `@ParentId()` on the line class's property holding the parent's internal id |
| Field id | lowercased property name | `@Field('x')` |
| N/query field id | the field id | `@Field('x', { queryFieldId: 'y' })` |
| Field type | `string`, `number` (float), `boolean`, `Date`, `string[]` / `number[]` (multiselect); the internal id is a `key`, the select field behind a reference and a `@ParentId()` field a `select` | `@Field({ type })` |
| Select field with no reference | a number or string like any other | `@Field('location', { type: 'select' })`: N/query compares select and key fields through `ANY_OF`, not `EQUAL` |
| Read-only | the internal id, `text: true` fields, fields of a referenced record | `@Field({ readOnly: true })` |
| Default select | every mapped field and relation | `@Field({ selectByDefault: false })`, or `{ selectByDefault: false }` on `@Reference`, `@Subrecord`, `@Sublist`; `include()` brings it back per query |
| Text of a select field | | `@Field({ queryFieldId: 'status', text: true })`, read in DISPLAY context |
| Field the root does not expose | read on the root | `@Field('subsidiary', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] })`: read off the joined component, still written through the record's own field |
| Query type | the record type | `@RecordType('x', { queryType })` |
| Root filter | none | `@RecordType('x', { filter: [{ fieldId, operator, values }] })` |
| Reference or subrecord | a plain class is a subrecord; a record class is a reference | `@Reference()`, `@Subrecord()` |
| Select field of a reference | `<reference>Id` on the same class; when the class declares none, the build step adds it (a shadow select field, see below) | `@Reference('entityId')` names a declared one; `@Field('entity')` on the reference configures the shadow |
| Reference join | `joinTo` through the select field and the target's record type | `@Reference({ join: 'auto' })` |
| Reference matched on another field | | `@Reference('code', { targetKey: 'code' })`; always loaded separately |
| Reference N/query has no join for | | `@Reference('parentId', { load: 'separate' })`: a second query matches the target's internal id against the select field values. A custom List/Record field whose list is Item is one such field: `autoJoin` on it fails with "Record Join ... was not found", while custom fields pointing at one custom record or at a standard record such as `shipitem` do join |
| Subrecord field id | lowercased property name | `@Subrecord('x')` |
| Subrecord list field to clear | none | `@Subrecord({ clearListField: 'shipaddresslist' })` |
| Sublist id | lowercased property name | `@Sublist('x')` |
| Sublist join | `joinFrom` through the line class's `@ParentId()` field | `@Sublist('x', { relationship })` for `autoJoin` on a relationship field; needed when the root has no reverse join for the line's field (a `salesorder` root reaches its lines through `transactionlines`, not through `transactionline.transaction`) |
| Sublist rows | every row of the line type | `@Sublist('x', { filter: [...] })` |
| Loading | `join`: read in the parent's query; NetSuite decides inner or outer | `load: 'separate'` on `@Sublist`, `@Subrecord`, `@Reference` |
| Root of the line query | the owner's query type | `@Sublist('item', { queryType: 'transaction', relationship: 'transactionlines' })` when the lines hang off another record than the owner (a `salesorder` root has no join to its lines; `transaction` has); the lines then run as their own query, matched to the owner by internal id |
| Has-many keyed by a field on the child | | `@Sublist({ load: 'separate' })` on the owner with `@ParentId()` on the child's field that points back at it (a fulfillment's SPS contents, keyed by their fulfillment field): the children run as their own query on the child's record type, batched on that field with ANY_OF; nothing is joined to reach them |
| Items more than one join away | | `@Sublist({ relationship: 'nexttransactionlink', through: [{ fieldId: 'nextdoc', target: 'transaction' }] })`: each hop is a relationship field (`autoJoin`) or a select field with the query type it points at (`joinTo`); the items' fields are read on the last hop, and nothing on the way needs a class |
| Record set name | pluralized camel-case class name | `@RecordType('x', { setName })` |

Nothing in the build step knows a NetSuite table, relationship, sublist, or field. What the table does not list is either derived from the class or resolved by N/query when the query runs. A missing declaration the build step needs is a diagnostic naming the decorator that supplies it.

### References project with the declared type

The declared type of a reference is its projection, so a lookup never pulls the whole record:

```ts
customer?: Pick<Customer, 'id' | 'companyName'>;   // two fields
customer?: Omit<Customer, 'notes'>;                   // everything but one
customer?: CustomerSummary;                            // type CustomerSummary = Pick<Customer, ...>
customer?: Customer;                                   // every mapped field
```

References are read-only; write the select field (`customerId`) instead. A reference that loads its own class without a projection is a build error.

### The select field of a reference

A reference reads the internal id it joins on from `<reference>Id`. Declare that property when you want to control it, or leave it out and the build step adds it to the generated type, like an Entity Framework shadow foreign key:

```ts
@Field('entity') customerId!: number;                     // declared: its own type and options
customer?: Pick<Customer, 'id' | 'companyName'>;

subsidiary?: Pick<Subsidiary, 'id' | 'name'>;            // generated type gains subsidiaryId: number | null
@Field('custbody_approver') approver?: Pick<Employee, 'id'>; // generated type gains approverId, read from custbody_approver
```

- The shadow is an ordinary field on the generated type: read it, filter on it, write it. Its field id is the reference's lowercased name, its type the referenced record's internal id or `null`.
- `@Field` on the reference configures the shadow: its field id, `readOnly`, or `relationship` and `filter` to read it off a joined component.
- A declared property is always the select field, whatever its type; the build step never replaces it, even when it is `@NotMapped()`. `@Field` options on a reference whose select field is declared are a build error: put them on the declared property.
- A reference that names its select field (`@Reference('entityId')`) or matches on another key (`targetKey`) must declare it.
- A projection in another model file cannot name a shadow: `Pick<Order, 'subsidiaryId'>` does not compile when the `Order` class does not declare it. Declare the select field when another model projects it.

### Join or separate

N/query has no join-type option: NetSuite decides whether a relationship joins inner or outer. Subrecords come back outer; the line join of a sublist is inner, so a query that reads lines returns only the parents that have matching lines. When parents must come back regardless, load the relation with a query of its own:

```ts
@Sublist('item', { queryType: 'transaction', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
```

`separate` runs one query for the parents and one per batch of parent ids for the relation, then stitches the lines in (`[]` when there are none, `null` for a subrecord or reference). Rows never fan out, `limit()` and `page()` count records, and a `where` on a field of the relation narrows the relation's rows rather than the parents. It costs one extra `run` per batch. A reference matched on a field other than the target's internal id (`targetKey`) always loads this way, because N/query joins only through internal ids, and so does a reference whose select field is read through a relationship (see [Fields the root does not expose](#fields-the-root-does-not-expose)).

Where the second query runs depends on how the relation is joined. A sublist reached through a relationship field (`relationship`) or another root (`queryType`) queries that root and joins the lines; a has-many joined `from` the child's `@ParentId()` field queries the child's own record type, with the sublist filter as a root condition and the child's parent field matched against the owners' ids, and the child's own references (`spsPackage`, `spsPackage.packType`) join inside that query:

```ts
@RecordType('customrecord_sps_content')
export class SpsContent {
    id!: number;
    @ParentId() @Field('custrecord_pack_content_fulfillment') fulfillmentId!: number;
    @Field('custrecord_sps_content_package') packageId!: number | null;
    @Reference('packageId', { join: 'auto' }) spsPackage?: Pick<SpsPackage, 'id' | 'sscc' | 'packType'>;
}

@RecordType('itemfulfillment')
export class ItemFulfillment {
    id!: number;
    @Sublist({ load: 'separate' }) contents!: SpsContent[];   // FROM customrecord_sps_content WHERE custrecord_pack_content_fulfillment ANY_OF [...]
}
```

A separate relation inside a separately loaded relation is not planned: compose it in the repository, as the order-processing test project does when it reads the fulfillments of a set of orders and stitches them onto the orders itself.

### Items more than one join away

A has-many whose items sit past further joins from the relationship field declares those joins on the property. Nothing on the way needs a class: only the items do, and a projection of a base class serves. A transaction's related records hang off the link `nexttransactionlink`, and the transaction each link points at off the link's `nextdoc`:

```ts
@RecordType('salesorder')
export class SalesOrder extends Transaction {
    /** The transactions this order led to: the link off `transaction`, then the transaction it points at. */
    @Sublist({ queryType: 'transaction', relationship: 'nexttransactionlink', through: [{ fieldId: 'nextdoc', target: 'transaction' }] })
    relatedTransactions!: Pick<Transaction, 'id' | 'tranId' | 'statusText'>[];
}
```

- `relationship` is the first join, `autoJoin` on a relationship field. Each entry of `through` is one more: a string is a relationship field (`autoJoin`), an object a select field with the query type it points at (`joinTo`). A hop may carry its own `filter`; the sublist's `filter` applies to the relationship's component (`linktype ANY_OF [...]` on the link).
- The build step emits one component per hop, parent to child, and reads the items' fields on the last. Result paths do not spell the hops: `order.relatedTransactions[0].tranId`, and `where('relatedTransactions.tranId', ...)` and `orderBy()` address the items the same way.
- Loaded separately (`queryType`, or `load: 'separate'`), the second query joins the whole chain from its root and matches the owners by internal id; a `where` on the items narrows the items. Joined (`load: 'join'`, on an owner whose own query type carries the relationship field), the chain joins into the owner's query and a `where` on the items narrows the owners.
- The items are other records, not lines of the owner, so their fields are read-only.
- The relationship and hop field ids are what the Records Catalog lists under the record's joins; N/query resolves the predicates.

### Fields the root does not expose

N/query inside SuiteScript rejects some body fields on the root that the record itself has: a transaction's `subsidiary` fails with `NOT_EXPOSED - Field is marked as internal for channel SEARCH`, even though SuiteQL through the REST service reads it. Its main line carries the same value, so the field is read there:

```ts
@RecordType(NetsuiteRecordType.INVOICE, { queryType: 'transaction', filter: [{ fieldId: 'type', operator: 'ANY_OF', values: ['CustInvc'] }] })
export class Invoice {
    id!: number;
    @Field('subsidiary', { type: 'select', relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [true] }] })
    subsidiaryId!: number;
    subsidiary?: Pick<Subsidiary, 'id' | 'name'>;   // loaded by a second query, by the id read off the main line
}
```

- The build step emits one component per relationship (`autoJoin` with the filter as its conditions) and puts the field on it; the value still lands at the root of the result (`invoice.subsidiaryId`), and `where()` and `orderBy()` on it join the same component.
- The filter must pick one row per record. `mainline IS true` does, so rows never fan out and `page()` stays a row window.
- Fields read through one relationship share its join, so they must declare the same filter; the build step reports two that differ, and a filter with no relationship.
- A reference whose select field is read this way loads separately: a second query reads the target by the ids collected off the component. N/query inside SuiteScript has no join from that component to the target: the join the build step used to emit, from the main line to `subsidiary`, failed in production on 2026-09-25 with `Record Join 'subsidiary^subsidiary' for record 'transactionLine' was not found`. `load: 'join'` on such a reference is a build error, and so is projecting it into another relation, where it cannot load separately.
- Without `subsidiaryId`, the options go on the reference itself: `@Field({ relationship: 'transactionlines', filter: [...] }) subsidiary?: Pick<Subsidiary, 'id' | 'name'>` reads its shadow select field off the main line and loads the subsidiary separately the same way.
- Writes are unchanged: the field writes through the record's own field id. Declare it `readOnly: true` when the record has no such field.

### Inheritance

A base class without `@RecordType` is a mapping base whose members are inherited. Each `@RecordType` class queries its own record type, so `salesorder` and `invoice` classes extending one `Transaction` base each read their own fields with no discriminator to declare.

### Decorator reference

| Decorator | Where | Purpose |
| --- | --- | --- |
| `@RecordType(id, { queryType?, filter?, setName?, coerce?, updater? })` | class | A queryable record type with a record set on the context. `id` is a native type from `NetsuiteRecordType` (`NetsuiteRecordType.SALES_ORDER`, a runtime copy of N/record's `Type` so the model needs no N/* import) or a custom record id (`'customrecord_x'`). `updater` sets the default `RecordUpdaterOptions` for every write. |
| `@InternalId()` | property | The internal id when it is not `id`. |
| `@ParentId()` | property | On a line class: the property holding the parent record's internal id. |
| `@Field(id?, { queryFieldId?, type?, text?, coerce?, relationship?, filter?, readOnly?, setFirst?, selectByDefault?, transform? })` | property | Renames the field, separates the query field id from the record field id, overrides the inferred type, or reads the field through a relationship when the root does not expose it. On a reference with no declared select field, it configures the shadow select field. The flags: `readOnly` excludes it from writes, `setFirst` writes it before the others, `selectByDefault: false` leaves it out of the default select, and `transform` maps the value read; a transform must be an exported function so the build step can import it by name. |
| `@Reference(selectFieldProperty?, { targetKey?, load?, join?, selectByDefault? })` | property | A reference: the declared select field behind it when it is not `<reference>Id`, how it joins and loads, and the referenced property to match on when it is not the internal id. |
| `@Subrecord(fieldId?, { clearListField?, load?, selectByDefault? })` | property | A subrecord: its field id and the list field cleared before an edit. |
| `@Sublist(sublistId?, { filter?, relationship?, through?, queryType?, load?, selectByDefault? })` | property | A sublist, or any has-many: its id, the conditions that pick its lines, and how the lines are reached (a relationship field, further joins past it, another root, or the line class's `@ParentId()` field). |
| `@NotMapped()` | property | Leaves the property out of the model; it stays on the generated type for values filled in after the query. |

`@ReadOnly()`, `@SetFirst()`, `@ExcludeFromDefaultSelect()`, and `@Transform(fn)` still work but are deprecated: they are the `readOnly`, `setFirst`, `selectByDefault: false`, and `transform` options above.

## Build step and generated files

Add a config file at the project root (every key is optional; the file itself is optional too). Relative paths in it resolve against the config file's own directory:

```json
{
  "models": ["src/models/**/*.ts"],
  "outDir": "src/repositories/generated",
  "context": { "name": "App", "fileName": "context.gen.ts" },
  "types": { "fileName": "types.gen.ts" },
  "tsconfig": "tsconfig.json",
  "repositories": "none"
}
```

`repositories` is `none` by default. Set it to `classes` to also emit a base repository class per record type and let the context factory accept subclasses (see Repositories).

Then run the build step:

```sh
npx netsuite-repository generate     # write the generated files
npx netsuite-repository check        # exit non-zero when they are out of date, or when no model files match (CI)
npx netsuite-repository watch        # regenerate whenever a model file changes
```

It writes:

- `generated/types.gen.ts`, the interface of every exported class (extending its base class's interface) and, for record types, `<Class>Patch` and `<Class>Create`. It holds types only, so a bundler erases any import of it: put DTOs shared with a browser client on it. `types.fileName` renames it, and `types.outDir` moves it to another directory, such as a `common/` workspace the client also compiles; every generated file imports it from there.
- `generated/<Class>.gen.ts` for every record type, the runtime side: the `<Class>Config` literal the runtime reads, and `<Class>Fields`, a constant whose properties mirror the model and hold its field paths (`SalesOrderFields.lines.item.type` is `'lines.item.type'`) for `where()`, `orderBy()`, and `select()`. It re-exports the class's three types from the types file, so server code can import the type and the fields from one place.
- `generated/context.gen.ts` with `AppSchema`, the `AppContext` type, `createAppContext()`, and `dbContext`: the record sets for reading without tracking, plus `withTracking()` for a fresh tracking context.
- With `"repositories": "classes"`, each record type's file also exports `<Class>RepositoryBase`, a `RecordSet` bound to the config, and the context factory accepts subclasses through `createAppContext({ repositories })`.

The build step reads the classes with the TypeScript type checker, so it sees every property, its declared type, `Pick` projections, and inheritance. Model files are also evaluated in a sandbox to collect the decorators; they may import the library and other model files by relative path, and nothing else. Anything that cannot be mapped is reported with the file, class, and property.

Vite and Rollup accept the plugin directly:

```ts
import { netsuiteRepositoryPlugin } from '@amerilux/netsuite-repository/plugin';

export default { plugins: [netsuiteRepositoryPlugin({ watch: true })] };
```

Other bundlers can call `createModelWatcher()` from `@amerilux/netsuite-repository/cli` in a few lines.

## Use the context

```ts
import { createAppContext } from './repositories/generated/context.gen';

const db = createAppContext();

// Read
const order = db.salesOrders.find(9876);
const pending = db.salesOrders.query()
    .where('status', '=', 'B')
    .where('customer.companyName', 'LIKE', 'Acme%')
    .orderByDesc('tranDate')
    .page(1, 50)
    .executeTyped();

// One-call writes: load, patch, plan, save; throw on failure
const approved = db.salesOrders.update(9876, { memo: 'Auto-approved', shippingAddress: { city: 'Dallas' }, lines: { add: [{ itemId: 1, quantity: 2 }] } });
const customer = db.customers.create({ companyName: 'Acme' }); // the same object, with its new id written back
db.salesOrders.delete(9876);

// Change tracking: a unit of work across records
order.memo = 'Auto-approved';
order.shippingAddress.city = 'Dallas';
order.lines.push({ itemId: 1, quantity: 2 } as TransactionLine);
const result = db.saveChanges();

// The record updater underneath: results instead of exceptions
db.salesOrders.submitPatch(9876, { memo: 'x', lines: { add: [{ itemId: 1, quantity: 2 }] } });
db.salesOrders.createRecord({ customerId: 12, memo: 'new' });
db.salesOrders.deleteRecord(9876);
```

`getById()`, `list()`, `create()`, `update()`, and `delete()` are the standard operations of every record set. `update()` loads the record, applies the patch to the tracked entity, plans the save, and writes only that entity. `create()` tracks the values object, saves it, and returns it with its id. All three throw: `RecordNotFoundError` when the id does not exist, `SaveChangesError` when NetSuite rejects the save (its `result` lists every entity's outcome). Both take options: `beforeSave` receives the plan before anything is written (log it, or throw to refuse an expensive one), and `updater` passes record updater options such as `requireFastPath` for that write.

A patch is the entity's own shape made partial (`<Model>Patch` in the generated file): scalars replace, `null` clears, `undefined` is skipped, a subrecord merges, and a sublist takes `{ update, add, remove }` where each line patch carries the line's identity (the model's line field, or its match field). A reference cannot be patched; set its select field instead.

Entities returned by `find()`, `getById()`, `list()`, `first()`, and `executeTyped()` are tracked. `saveChanges()` diffs each one against its snapshot and writes the difference through the record updater: body-only changes use `submitFields`, and anything touching a subrecord or sublist loads, mutates, and saves. Lines are matched by their line key. Added entities get their new id written back. `planChanges()` shows what would happen without calling NetSuite, and both take `{ entities }` to work on a subset. Changes to a referenced record's fields are reported as ignored, never written.

Use `asNoTracking()` for reporting reads, and `{ tracking: false }` on `createAppContext()` for contexts that never write. Contexts hold tracked entities strongly, so never keep a tracking one at module scope. The generated `dbContext` is safe there: its record sets (`dbContext.salesOrders`) read through one context that never tracks, and `dbContext.withTracking()` returns a new context each call, so a tracker lives only as long as the function that asked for it. The Layering section below says where that happens.

## Repositories

The record set on the context is the repository, the way a DbSet is in Entity Framework, and the context is its unit of work: the change tracker that `saveChanges()` writes. Domain queries are built from specifications: plain functions over the query builder that `list`, `first`, `count`, and `exists` apply in order.

The simplest home for them is a module of functions over the generated `dbContext`: reads through its sets, writes through `withTracking()`:

```ts
// specifications/salesOrders.ts
import type { Specification } from '@amerilux/netsuite-repository';
import type { SalesOrder } from '../repositories/generated/SalesOrder.gen';
import { SalesOrderFields as so } from '../repositories/generated/SalesOrder.gen';

export const forCustomer = (customerId: number): Specification<SalesOrder> => (query) => query.where(so.customerId, '=', customerId);
export const pendingFulfillment = (): Specification<SalesOrder> => (query) => query.where(so.status, '=', 'SalesOrd:B');

// repositories/salesOrders.ts
import { dbContext } from './generated/context.gen';
import type { SalesOrder } from './generated/SalesOrder.gen';
import { SalesOrderFields as so } from './generated/SalesOrder.gen';
import { forCustomer, pendingFulfillment } from '../specifications/salesOrders';

export function listPendingSalesOrders(customerId: number): SalesOrder[] {
    return dbContext.salesOrders.list(forCustomer(customerId), pendingFulfillment(), (query) => query.orderByAsc(so.tranDate));
}

export function approveSalesOrder(salesOrderId: number, memo: string): SalesOrder {
    return dbContext.withTracking().salesOrders.update(salesOrderId, { memo }, { beforeSave: (plan) => log.debug('approve plan', plan.entries) });
}

// services/salesOrders.ts
import { approveSalesOrder, listPendingSalesOrders } from '../repositories/salesOrders';

export function approveOldestPendingSalesOrder(customerId: number): SalesOrder | undefined {
    const pending = listPendingSalesOrders(customerId);
    return pending.length > 0 ? approveSalesOrder(pending[0].id, 'Auto-approved') : undefined;
}
```

Nothing is registered, a function can read several record sets, and the service above never sees the context or the library. Writes wrap the set's `create()`, `update()`, and `delete()` the same way: the module adds the validation and the domain name, the set does the loading, planning, and saving. This is the style to reach for first. Keep the specifications in a module of their own, one per record type, and the query functions in another; the predicates then read as a vocabulary and the functions as sentences built from it.

A flow that reads several records, changes them, and writes them back is one repository function too: it keeps `dbContext.withTracking()` in a local, does the reads through that, mutates the entities, and calls `saveChanges()` on it once before it returns. The tracker is shared by everything inside that function and by nothing outside it, so the service that calls it still sees only a domain name and a result.

If you prefer the queries on the set itself, set `"repositories": "classes"` in the build config. The build step then emits a base repository per record type; extend it and register the subclass when the context is created:

```ts
export class SalesOrderRepository extends SalesOrderRepositoryBase {
    listPending(customerId: number): SalesOrder[] {
        return this.list(forCustomer(customerId), pendingFulfillment());
    }
}

const db = createAppContext({ repositories: { salesOrders: SalesOrderRepository } });
db.salesOrders.listPending(12);      // typed as SalesOrderRepository
db.customers.find(12);               // every other set is its generated base
```

Either way:

- Specifications are testable through `describe()` without a context, and compose by being passed together.
- `first()` and `find()` read every matching row on a model with a joined sublist, so the record comes back with all of its lines; a separately loaded sublist pages over records instead.
- A registered repository is constructed with the context's change tracker, so the entities it returns are tracked and `saveChanges()` writes them.
- Repositories and specifications are plain functions and classes with no Node dependencies. They bundle into SuiteScript like the rest of the runtime; only the build step runs in Node.

### Layering

Everything that touches NetSuite data lives in the repositories layer, and the context never leaves it. The layout the defaults assume, and what each layer may import (the `models` globs decide where the model classes live; a project that shares them with a browser client keeps them in a `common/` workspace and points the globs there):

| Folder | Holds | Imports |
|---|---|---|
| `src/models/` | The decorated model classes (source, hand-written) | This package's decorators |
| `src/repositories/generated/` | The build step's output: `<Class>.gen.ts` and `context.gen.ts`, plus `types.gen.ts` unless `types.outDir` moves it into the shared workspace | Never edited |
| `src/specifications/` | One module per record type of `Specification` builders: the query vocabulary | `generated/`, this package's types |
| `src/repositories/` | Query and write functions over `dbContext`: reads through its sets, writes through `withTracking()`, saved before the function returns | `generated/`, `specifications/` |
| `src/services/` | Decisions: interpret the request, call repository functions, shape the result | `repositories/` (functions and model types only) |
| Endpoints, entry points | Parse the request, call a service, shape the reply | `services/` only |

A read goes through `dbContext.<set>` and tracks nothing. A write calls `dbContext.withTracking()`, keeps the result in a local, and finishes its own write before returning. Two repository functions never share a tracker; when a flow needs one, the flow is a single repository function. The only module-scope state is the read-only context behind `dbContext`, which holds no entities, so lifetimes stay visible in the code and do not depend on how NetSuite instantiates modules.

A repository test mocks the generated `dbContext` with a fake carrying the sets the function reads; a service test mocks the repository module. `N/record`, `N/query`, `N/search`, and `context.gen` are never imported above the repositories layer, which a lint rule can enforce per folder.

## Queries

```ts
db.salesOrders.query()
    .exclude('lines')                                   // leave a relation and its joins out
    .include('customer')                                // bring one in declared selectByDefault: false
    .selectFormula('{quantity} * {rate}', 'lineTotal', { type: 'FLOAT', fieldType: 'currency' })
    .whereGroup((group) => group.where('memo', 'IS NULL').orWhere('memo', '=', ''))
    .whereFormula('{trandate} > SYSDATE - 30')
    .orderByAsc('lineTotal')
    .page(2, 25)
    .executeTyped();
```

- A query only joins the components its selected fields, conditions, and sorts touch; `exclude()` drops a relation's fields, and a relation declared `selectByDefault: false` waits for `include()`.
- N/query sorts only on the query's own columns. `orderBy()` on a selected field sorts on that column; on a field that is not selected it adds a hidden column (`__sort0`, …) that the mapped result never shows.
- `where()`, `orderBy()`, and `select()` are typed against the model: properties and dotted paths into relations (`customer.companyName`, `lines.item.type`) are checked, so a misspelled path is a compile error, inside specifications too. The generated `<Model>Fields` constant spells them for you (`so.lines.item.type`), with completion on every level. An alias declared on the same query by `selectFormula()` is accepted as well.
- The operators and the value follow the property's declared type, and are translated to N/query's operators. Text takes `=`, `!=`, `LIKE`, `NOT LIKE`, `IN`, and `NOT IN`; a number adds `<`, `<=`, `>`, `>=`, and `BETWEEN`; a `Date` takes the comparisons and `BETWEEN` with `Date` values; a checkbox takes `=` and `!=` with a boolean or NetSuite's `'T'`/`'F'`. Every field takes `IS NULL` and `IS NOT NULL`; `null` is not a comparison value. The N/query operator names follow N/search's: `=` becomes `IS` on text and on a checkbox, `EQUAL` on a number, `ON` on a date, and `ANY_OF` on a select, multiselect, or key field (the internal id, a reference's select field, anything declared `type: 'select'`); `>=` on a date becomes `ON_OR_AFTER`; `LIKE 'Acme%'` becomes `START_WITH`, `'%Acme'` `ENDWITH`, `'%Acme%'` `CONTAIN`, and `'Acme'` `IS`; `IS NULL` becomes `EMPTY`. `IN` becomes `ANY_OF` on a select or key field; on text, numbers, dates, and checkboxes, which have no list operator in N/query, it becomes one equality per value joined with `OR` (`NOT IN`: one negated equality per value joined with `AND`). A select field the model does not mark as one fails at run time with "Operator EQUAL is not valid"; declare it with `@Field({ type: 'select' })`. Any N/query operator name is accepted directly on any field (`where(so.tranDate, 'WITHIN', [from, to])`). A `LIKE` pattern with `_` or a `%` in the middle has no N/query operator and is rejected; write it as a formula.
- With `useText`, and for a `text: true` field, the comparison is against the display text through a `{field#DISPLAY}` formula, so the text operators and string values apply whatever the field.
- `selectFormula()` and `whereFormula()` are the escape hatch for anything the model does not declare. Formulas use N/query's `{fieldid}` and `{relation.fieldid}` syntax and are sent as written; values in them are part of the text, so never build a formula from untrusted input.
- `limit()`, `offset()`, and `page()` read a row window through `runPaged`; N/query pages are five to a thousand rows, so a window smaller than five still fetches five and slices. Every query's sort ends with the internal id, so rows that tie on the other sorts never change places between pages. With a joined sublist the rows fan out, so the window applies to mapped records and the query reads every row.
- `count()` counts records, distinct by primary key when a component is joined; `exists()` asks for one row.
- `describe()` returns what the query will ask N/query for as plain data, `describeText()` renders it one clause per line, and `toSQL()` shows the SuiteQL NetSuite would run. None of them executes anything.
- Read-side coercion turns numeric strings into numbers, `T`/`F` into booleans, and date strings into `Date` through `N/format`. Generated configs enable it; hand-written configs do not. Override per query with `coerce(false)`, per config with `coerce`, or per field.

### Past N/query's 5,000 rows

N/query's `run()` answers at most 5,000 rows and says nothing when it stops there. `list()`, `all()`, `executeTyped()`, and `execute()` read on past it:

- Every query's sort ends with the internal id (`ORDER BY …, id ASC`), so its order is complete. When an answer comes back 5,000 rows long, the next `run()` asks for the rows after its last one, by the value of each sort and then the id, until an answer comes back shorter. A query under 5,000 rows is still one `run()`.
- The comparison follows the sort's type. The id, numbers, and dates use their own operators (`GREATER`, `AFTER`, `EQUAL`, `ON`). Text is compared upper-cased in a formula (`UPPER({companyname}) > UPPER('Acme')`): N/query refuses `GREATER` on text, and NetSuite orders text by `UPPER()`. Blanks go where NetSuite sorts them, last ascending and first descending.
- A query no read can pick up after is read again through `runPaged`, a thousand rows a fetch: one sorted by a select field, a checkbox, a datetime, display text, or a formula; one with a joined sublist, whose rows are lines; one whose config has no internal id.
- A separately loaded relation whose batch comes back 5,000 rows long splits the batch in two and reads each half again. One parent with 5,000 related rows fails rather than come back short.
- One 5,000-row `run()` costs 10 governance units; one `runPaged` read of a thousand costs 20. Before every read past the first, the query checks `N/runtime`'s remaining usage, which costs nothing. When another read like the last would leave less than the reserve (`governanceReserve` on the query options, 100 units by default), `list()` throws a `GovernanceLimitError` carrying `rowsRead`, `remainingUsage`, `readCost`, and `reserve`, instead of NetSuite ending the script halfway through a read.

To read a list across requests, a page at a time, use `listPage()`:

```ts
const first = db.invoices.listPage({ limit: 5000 }, forCustomer(2431), open());
// first.items; first.next is null when nothing follows
const second = db.invoices.listPage({ after: first.next, limit: 5000 }, forCustomer(2431), open());
```

- Each page picks up after the previous page's last record by its sort values, so a record changed or deleted between two pages cannot shift the rest, and nothing is counted: `next` is null once the records run out.
- `next` is a string carrying the last record's sort values and id; hand it back unchanged. A marker from another query is rejected.
- A page larger than 5,000 is read in several answers. When the script cannot afford another read, the page stops early and `next` says where to continue.
- Every sort must be one a read can compare (the id, numbers, dates, text), and the model must not join a sublist; load it separately (`load: 'separate'`) to page it.

Each comparison, cost, and blank position above was checked against 17,369 records in a sandbox account on 2026-09-24; the sorts listed as read through `runPaged` were not, which is why they are.

## Writes

The record updater chooses the cheapest NetSuite path for a change:

- body fields only: one `record.submitFields` call;
- subrecords or sublists: `record.load`, apply, `record.save`;
- an address whose list field is set: clear the list field, save, reload, edit the subrecord, save.

`plan()` on any updater describes the calls it would make, and options such as `requireFastPath`, `maxRecordCalls`, `allowLineScans`, and `allowSubrecordReloads` reject expensive plans before they run. `@RecordType('x', { updater })` sets the defaults for a record type; the `updater` option of `create()`, `update()`, and `delete()` and the `updaterOptions` of `saveChanges()` layer over them for one write. The updater trusts the model: a field id NetSuite does not accept surfaces as an `N/record` error at save time.

The record set exposes the updater in three layers. `create()`, `update()`, and `delete()` go through change tracking and throw. `add()`, `remove()`, and mutation wait for `saveChanges()`, which returns a result per entity. `updater(id)`, `submitPatch()`, `createRecord()`, and `deleteRecord()` call the updater directly with a graph patch and return results without throwing; reach for them when a failure is something to log rather than an error.

## Testing

`@amerilux/netsuite-repository/testing` is an in-memory stand-in for N/query. Map the module to it in jest, queue the rows a query should get, and assert on what was asked:

```js
// jest.config.js
moduleNameMapper: { '^N/query$': '<rootDir>/__tests__/netsuite-stubs/query.ts', ... }
```

```ts
// __tests__/netsuite-stubs/query.ts
import { fakeNQuery } from '@amerilux/netsuite-repository/testing';
export = fakeNQuery;
```

```ts
import { fakeNQuery } from '@amerilux/netsuite-repository/testing';

beforeEach(() => fakeNQuery.reset());

it('lists open orders for a customer', () => {
    fakeNQuery.queueRows('salesorder', [{ id: 1, tranid: 'SO1', lines_id: 1, lines_quantity: 2 }]);

    const orders = listOpenSalesOrders(db, 12);

    expect(orders[0].lines).toHaveLength(1);
    expect(fakeNQuery.calls[0].text).toContain("WHERE entity ANY_OF [12]");
});
```

`queueRows` matches the next query by root type, by a joined component, by a substring of the rendered text, or by a predicate; every queued set answers one query unless it repeats (`{ repeat: true }`). The double answers whatever is queued and has no 5,000-row limit: queue exactly 5,000 rows to make a list read on. `fakeNRuntime`, from the same entry point, stands in for `N/runtime`: map `N/runtime` to it and `queueRemainingUsage(1000, 990, 105)` to exercise the governance guard. Where `N/runtime` answers no usage, every read is affordable. `calls` records each query as a `QueryDescription` plus its rendered text and whether it ran, ran paged, or was rendered. The double implements the enums the runtime reads (`Operator`, `FieldContext`, `ReturnType`, `Aggregate`), so the same code runs against it and against NetSuite.

The double sees only what N/query sees, so it names joined components by the field ids it was given, not by the model's property paths: a sublist joined from `transactionline.transaction` is the component `transactionline.transaction`, a subrecord `shippingaddress` is `shippingaddress`, and a sublist filter lands in the `WHERE` line. `describeText()` on a query builder renders the same plan with the model's names (`lines`, `shippingAddress`) before anything runs; assert on it when the property path is what matters. Row keys are matched case-insensitively against the column aliases (`lines_priceLevelName` or `lines_pricelevelname` both work), and a separately loaded relation's rows carry the parent key under `__parentKey`.

## Advanced: raw config

Everything above compiles to a `QueryConfig`. Hand-written configs still work and can be mixed with generated ones in the same context:

```ts
export const VendorConfig = defineQueryConfig<Vendor>({
    recordType: 'vendor',
    fields: {
        id: { queryFieldId: 'id', type: 'integer', isPrimary: true, readonly: true },
        companyName: { queryFieldId: 'companyname', type: 'string', recordFieldId: 'companyname' },
    },
});
```

A relation is a `components` entry (`path`, `join`, `load`, and any `conditions`), fields under it carry `component` and `nestPath`, and `relationships` describe subrecords, sublists, and references the same way the generated configs do. `fields` may be grouped into `query`, `common`, and `record` sections.

## Package entry points

| Import | Contents |
| --- | --- |
| `@amerilux/netsuite-repository` | Everything the runtime needs: decorators, query builder, record updater, context, tracking. |
| `@amerilux/netsuite-repository/model` | The decorators and the registry the build step reads. |
| `@amerilux/netsuite-repository/tracking` | `ChangeTracker`, `EntityState`, diff helpers. |
| `@amerilux/netsuite-repository/testing` | The N/query test double. |
| `@amerilux/netsuite-repository/cli` | `runGenerate`, `checkGenerated`, `createModelWatcher`, `runCli`, and the model compiler. Node only. |
| `@amerilux/netsuite-repository/plugin` | `netsuiteRepositoryPlugin`. Node only. |

The runtime entry points never import Node modules, so the SuiteScript bundle stays free of build tooling.

## Design notes

`docs/entity-conventions-redesign.md` records why the surface looks the way it does: the three rules, the vocabulary, the decisions taken along the way, and the 1.0.0 move to the N/query object model.
