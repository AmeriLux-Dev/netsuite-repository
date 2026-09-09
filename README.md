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
import { Field, InternalId, ParentId, ReadOnly, RecordType, SetFirst, Sublist, Subrecord } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import type { InventoryItem } from './InventoryItem';

/** Shared by the shipping and billing addresses; the subrecord field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
    zip!: string | null;
}

/** A sublist line is a record type. Its @ParentId() property is the field N/query joins the lines through. */
@RecordType('transactionline')
export class TransactionLine {
    @InternalId() @Field('line', { queryFieldId: 'id' }) id!: number;   // queried as id, written through the sublist field line
    @ParentId() @Field('transaction') @ReadOnly() transactionId!: number;
    @Field('item') itemId!: number;
    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;    // reference inside the line
    quantity!: number;
    rate!: number | null;
    @ReadOnly() amount!: number;
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
    @Field('foreigntotal') @ReadOnly() total!: number;
    /** The item lines: the order's `transactionlines` relationship, without the header line. */
    @Sublist('item', { relationship: 'transactionlines', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
}
```

Three rules cover most of what you see above:

1. **Every declared property is a mapped field.** `@NotMapped()` opts out; the property stays on the generated type for values you fill in after the query.
2. **Every body field is writable.** `@ReadOnly()` opts out. The field id is the lowercased property name and doubles as the N/query field id; `@Field(id)` renames it, `@Field(id, { queryFieldId })` splits the two when NetSuite queries a field under one name and writes it under another.
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
| Read-only | the internal id, `text: true` fields, fields of a referenced record | `@ReadOnly()` |
| Text of a select field | | `@Field({ queryFieldId: 'status', text: true })`, read in DISPLAY context |
| Query type | the record type | `@RecordType('x', { queryType })` |
| Root filter | none | `@RecordType('x', { filter: [{ fieldId, operator, values }] })` |
| Reference or subrecord | a plain class is a subrecord; a record class is a reference | `@Reference()`, `@Subrecord()` |
| Select field of a reference | `<reference>Id` on the same class | `@Reference('entityId')` |
| Reference join | `joinTo` through the select field and the target's record type | `@Reference({ join: 'auto' })` |
| Reference matched on another field | | `@Reference('code', { targetKey: 'code' })`; always loaded separately |
| Reference N/query has no join for | | `@Reference('parentId', { load: 'separate' })`: a second query matches the target's internal id against the select field values |
| Subrecord field id | lowercased property name | `@Subrecord('x')` |
| Subrecord list field to clear | none | `@Subrecord({ clearListField: 'shipaddresslist' })` |
| Sublist id | lowercased property name | `@Sublist('x')` |
| Sublist join | `joinFrom` through the line class's `@ParentId()` field | `@Sublist('x', { relationship })` for `autoJoin` on a relationship field; needed when the root has no reverse join for the line's field (a `salesorder` root reaches its lines through `transactionlines`, not through `transactionline.transaction`) |
| Sublist rows | every row of the line type | `@Sublist('x', { filter: [...] })` |
| Loading | `join`: read in the parent's query; NetSuite decides inner or outer | `load: 'separate'` on `@Sublist`, `@Subrecord`, `@Reference` |
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

### Join or separate

N/query has no join-type option: NetSuite decides whether a relationship joins inner or outer. Subrecords come back outer; the line join of a sublist is inner, so a query that reads lines returns only the parents that have matching lines. When parents must come back regardless, load the relation with a query of its own:

```ts
@Sublist('item', { relationship: 'transactionlines', load: 'separate', filter: [{ fieldId: 'mainline', operator: 'IS', values: [false] }] }) lines!: TransactionLine[];
```

`separate` runs one query for the parents and one per batch of parent ids for the relation, then stitches the lines in (`[]` when there are none, `null` for a subrecord or reference). Rows never fan out, `limit()` and `page()` count records, and a `where` on a field of the relation narrows the relation's rows rather than the parents. It costs one extra `run` per batch. A reference matched on a field other than the target's internal id (`targetKey`) always loads this way, because N/query joins only through internal ids.

### Inheritance

A base class without `@RecordType` is a mapping base whose members are inherited. Each `@RecordType` class queries its own record type, so `salesorder` and `invoice` classes extending one `Transaction` base each read their own fields with no discriminator to declare.

### Decorator reference

| Decorator | Where | Purpose |
| --- | --- | --- |
| `@RecordType(id, { queryType?, filter?, setName?, coerce?, updater? })` | class | A queryable record type with a record set on the context. `updater` sets the default `RecordUpdaterOptions` for every write. |
| `@InternalId()` | property | The internal id when it is not `id`. |
| `@ParentId()` | property | On a line class: the property holding the parent record's internal id. |
| `@Field(id?, { queryFieldId?, type?, text?, coerce? })` | property | Renames the field, separates the query field id from the record field id, or overrides the inferred type. |
| `@ReadOnly()` | property | Excludes the property from writes. |
| `@Reference(selectFieldProperty?, { targetKey?, load?, join? })` | property | A reference: the select field behind it, and the referenced property to match on when it is not the internal id. |
| `@Subrecord(fieldId?, { clearListField?, load? })` | property | A subrecord: its field id and the list field cleared before an edit. |
| `@Sublist(sublistId?, { filter?, relationship?, load? })` | property | A sublist: its id and the conditions that pick its lines. |
| `@SetFirst()`, `@ExcludeFromDefaultSelect()`, `@Transform(fn)`, `@NotMapped()` | property | Flags. Transforms must be exported functions so the build step can import them by name. |

## Build step and generated files

Add a config file at the project root (every key is optional; the file itself is optional too). Relative paths in it resolve against the config file's own directory:

```json
{
  "models": ["src/models/**/*.ts", "!src/models/generated/**"],
  "outDir": "src/models/generated",
  "context": { "name": "App", "fileName": "context.gen.ts" },
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

- `generated/<Class>.gen.ts` for every exported class, with everything for that class as named exports: the interface, extending the base class's interface and importing the referenced ones; and for record types also `<Class>Patch`, `<Class>Create`, the `<Class>Config` literal the runtime reads, and `<Class>Fields`, a constant whose properties mirror the model and hold its field paths (`SalesOrderFields.lines.item.type` is `'lines.item.type'`) for `where()`, `orderBy()`, and `select()`.
- `generated/context.gen.ts` with `AppSchema`, the `AppContext` type, and `createAppContext()`.
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
import { createAppContext } from './models/generated/context.gen';

const db = createAppContext();

// Read
const order = db.salesOrders.find(9876);
const pending = db.salesOrders.query()
    .where('status', '=', 'B')
    .where('customer.companyName', 'LIKE', 'Acme%')
    .orderByDesc('tranDate')
    .page(1, 50)
    .executeTyped();

// Change tracking
order.memo = 'Auto-approved';
order.shippingAddress.city = 'Dallas';
order.lines.push({ itemId: 1, quantity: 2 } as TransactionLine);
const result = db.saveChanges();

// Explicit patches still work
db.salesOrders.submitPatch(9876, { memo: 'x', lines: { add: [{ itemId: 1, quantity: 2 }] } });
db.salesOrders.createRecord({ customerId: 12, memo: 'new' });
db.salesOrders.delete(9876);
```

Entities returned by `find()`, `executeTyped()`, `all()`, and `first()` are tracked. `saveChanges()` diffs each one against its snapshot and writes the difference through the record updater: body-only changes use `submitFields`, and anything touching a subrecord or sublist loads, mutates, and saves. Lines are matched by their line key. Added entities get their new id written back. `planChanges()` shows what would happen without calling NetSuite. Changes to a referenced record's fields are reported as ignored, never written.

Use `asNoTracking()` for reporting reads, and `{ tracking: false }` on `createAppContext()` for contexts that never write. Contexts hold tracked entities strongly, so create one per script execution.

## Repositories

The record set on the context is the repository, the way a DbSet is in Entity Framework, and the context is the unit of work. Domain queries are built from specifications: plain functions over the query builder that `list`, `first`, `count`, and `exists` apply in order.

The simplest home for them is a module of functions that take the context:

```ts
// queries/salesOrders.ts
import type { Specification } from '@amerilux/netsuite-repository';
import type { AppContext } from '../models/generated/context.gen';
import type { SalesOrder } from '../models/generated/SalesOrder.gen';

import { SalesOrderFields as so } from '../models/generated/SalesOrder.gen';

export const forCustomer = (customerId: number): Specification<SalesOrder> => (query) => query.where(so.customerId, '=', customerId);
export const pendingFulfillment = (): Specification<SalesOrder> => (query) => query.where(so.status, '=', 'SalesOrd:B');

export function listPendingSalesOrders(db: AppContext, customerId: number): SalesOrder[] {
    return db.salesOrders.list(forCustomer(customerId), pendingFulfillment(), (query) => query.orderByAsc(so.tranDate));
}

// a script
const db = createAppContext();
const pending = listPendingSalesOrders(db, 12);
db.saveChanges();
```

Nothing is registered, a function can read several record sets, and a test can pass any object with the sets it needs. This is the style to reach for first. Keep the specifications in a module of their own, one per record type, and the query functions in another; the predicates then read as a vocabulary and the functions as sentences built from it.

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

## Queries

```ts
db.salesOrders.query()
    .exclude('lines')                                   // leave a relation and its joins out
    .include('customer')                                // bring one in that is @ExcludeFromDefaultSelect
    .selectFormula('{quantity} * {rate}', 'lineTotal', { type: 'FLOAT', fieldType: 'currency' })
    .whereGroup((group) => group.where('memo', 'IS NULL').orWhere('memo', '=', ''))
    .whereFormula('{trandate} > SYSDATE - 30')
    .orderByAsc('lineTotal')
    .page(2, 25)
    .executeTyped();
```

- A query only joins the components its selected fields, conditions, and sorts touch; `exclude()` drops a relation's fields, and a relation marked `@ExcludeFromDefaultSelect()` waits for `include()`.
- `where()`, `orderBy()`, and `select()` are typed against the model: properties and dotted paths into relations (`customer.companyName`, `lines.item.type`) are checked, so a misspelled path is a compile error, inside specifications too. The generated `<Model>Fields` constant spells them for you (`so.lines.item.type`), with completion on every level. An alias declared on the same query by `selectFormula()` is accepted as well.
- The operators and the value follow the property's declared type, and are translated to N/query's operators. Text takes `=`, `!=`, `LIKE`, `NOT LIKE`, `IN`, and `NOT IN`; a number adds `<`, `<=`, `>`, `>=`, and `BETWEEN`; a `Date` takes the comparisons and `BETWEEN` with `Date` values; a checkbox takes `=` and `!=` with a boolean or NetSuite's `'T'`/`'F'`. Every field takes `IS NULL` and `IS NOT NULL`; `null` is not a comparison value. The N/query operator names follow N/search's: `=` becomes `IS` on text and on a checkbox, `EQUAL` on a number, `ON` on a date, and `ANY_OF` on a select, multiselect, or key field (the internal id, a reference's select field, anything declared `type: 'select'`); `>=` on a date becomes `ON_OR_AFTER`; `LIKE 'Acme%'` becomes `START_WITH`, `'%Acme'` `ENDWITH`, `'%Acme%'` `CONTAIN`, and `'Acme'` `IS`; `IS NULL` becomes `EMPTY`. `IN` becomes `ANY_OF` on a select or key field; on text, numbers, dates, and checkboxes, which have no list operator in N/query, it becomes one equality per value joined with `OR` (`NOT IN`: one negated equality per value joined with `AND`). A select field the model does not mark as one fails at run time with "Operator EQUAL is not valid"; declare it with `@Field({ type: 'select' })`. Any N/query operator name is accepted directly on any field (`where(so.tranDate, 'WITHIN', [from, to])`). A `LIKE` pattern with `_` or a `%` in the middle has no N/query operator and is rejected; write it as a formula.
- With `useText`, and for a `text: true` field, the comparison is against the display text through a `{field#DISPLAY}` formula, so the text operators and string values apply whatever the field.
- `selectFormula()` and `whereFormula()` are the escape hatch for anything the model does not declare. Formulas use N/query's `{fieldid}` and `{relation.fieldid}` syntax and are sent as written; values in them are part of the text, so never build a formula from untrusted input.
- `limit()`, `offset()`, and `page()` read a row window through `runPaged`; N/query pages are five to a thousand rows, so a window smaller than five still fetches five and slices. Add an `orderBy` for deterministic pages. With a joined sublist the rows fan out, so the window applies to mapped records and the query reads every row.
- `count()` counts records, distinct by primary key when a component is joined; `exists()` asks for one row.
- `describe()` returns what the query will ask N/query for as plain data, `describeText()` renders it one clause per line, and `toSQL()` shows the SuiteQL NetSuite would run. None of them executes anything.
- Read-side coercion turns numeric strings into numbers, `T`/`F` into booleans, and date strings into `Date` through `N/format`. Generated configs enable it; hand-written configs do not. Override per query with `coerce(false)`, per config with `coerce`, or per field.

## Writes

The record updater chooses the cheapest NetSuite path for a change:

- body fields only: one `record.submitFields` call;
- subrecords or sublists: `record.load`, apply, `record.save`;
- an address whose list field is set: clear the list field, save, reload, edit the subrecord, save.

`plan()` on any updater describes the calls it would make, and options such as `requireFastPath`, `maxRecordCalls`, `allowLineScans`, and `allowSubrecordReloads` reject expensive plans before they run. `@RecordType('x', { updater })` sets the defaults for a record type. `createRecord()` and `deleteRecord()` cover the remaining operations. The updater trusts the model: a field id NetSuite does not accept surfaces as an `N/record` error at save time.

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

`queueRows` matches the next query by root type, by a joined component, by a substring of the rendered text, or by a predicate; every queued set answers one query unless it repeats (`{ repeat: true }`). `calls` records each query as a `QueryDescription` plus its rendered text and whether it ran, ran paged, or was rendered. The double implements the enums the runtime reads (`Operator`, `FieldContext`, `ReturnType`, `Aggregate`), so the same code runs against it and against NetSuite.

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

`docs/entity-conventions-redesign.md` records why the surface looks the way it does: the three rules, the vocabulary, the decisions taken along the way, and the 1.0.0 move to the N/query object model. `experiments/` holds the sandbox probes that established what N/query resolves on its own.
