# @amerilux/netsuite-repository

Entity Framework style data access for NetSuite SuiteScript, in NetSuite's own vocabulary.

- **A model is a class.** `@RecordType('salesorder')` on a class makes it a record set on the context. Every declared property is a field; the member decorators name what NetSuite calls the rest: `@Subrecord` on an object-typed property, `@Sublist` on an array-typed property, `@Reference` on a property typed as another record class. Decorators only override a convention.
- **A build step generates the config and type files** from the classes, TanStack Router style, so the SuiteScript bundle carries plain objects and no decorator machinery.
- **The runtime** queries SuiteQL through `N/query`, maps rows into typed objects, and writes through `N/record` with the fast path (`submitFields`) whenever the change allows it.
- **Change tracking** gives you `find()`, mutate, `saveChanges()`.

## Vocabulary

| NetSuite term | Entity Framework equivalent | In a model |
| --- | --- | --- |
| Record type | Entity | a class with `@RecordType('salesorder')` |
| Internal id | Key | the property `id` |
| Field | Column / property | any declared property |
| Select field | Foreign key | a `number` property holding an internal id, `customerId` |
| Reference | Reference navigation | a property typed as another record class, `customer?: Pick<Customer, ...>` |
| Subrecord | Owned type | an object-typed property, `@Subrecord('shippingaddress') shippingAddress: TransactionAddress` |
| Sublist | Collection navigation | an array-typed property, `@Sublist('item') lines: TransactionLine[]` |
| Sublist line | Dependent entity | a record type reading the line table, `@RecordType('transactionline')` |
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
import { Field, ReadOnly, RecordType, SetFirst, Sublist, Subrecord } from '@amerilux/netsuite-repository';
import type { Customer } from './Customer';
import type { InventoryItem } from './InventoryItem';

/** Shared by the shipping and billing addresses; the subrecord field id comes from the property that uses it. */
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
    zip!: string | null;
}

/** A sublist line is a record type: it reads the line table, and can be queried on its own as db.transactionLines. */
@RecordType('transactionline')
export class TransactionLine {
    id!: number;                                             // transactionline.id, matched to the sublist field 'line'
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
    @Subrecord('shippingaddress') shippingAddress!: TransactionAddress;
    @Subrecord('billingaddress') billingAddress?: TransactionAddress;
}

@RecordType('salesorder')                                    // table 'transaction', type = 'SalesOrd'
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Field('shipmethod', { table: 'salesorder' }) shipMethodId!: number | null;   // column on the sales order type table
    @Field('foreigntotal') @ReadOnly() total!: number;
    @Sublist('item') lines!: TransactionLine[];               // the 'item' sublist, read from transactionline
}
```

Three rules cover most of what you see above:

1. **Every declared property is a mapped field.** `@NotMapped()` opts out; the property stays on the generated type for values you fill in after the query.
2. **Every body field is writable.** `@ReadOnly()` opts out. The field id is the lowercased property name and doubles as the SuiteQL column; `@Field(id)` renames it.
3. **A property typed as another model class is a reference, subrecord, or sublist.** `@Reference`, `@Subrecord`, and `@Sublist` name it the way NetSuite does and carry the ids the conventions cannot supply. The join comes from the declared type and the conventions, never from a hand-written predicate.

The class decorator is only ever `@RecordType`. A sublist line class is a record type like any other, named after the table it reads (`transactionline`); the sublist it belongs to is declared on the property of the parent.

### Conventions and overrides

| Concern | Convention | Override |
| --- | --- | --- |
| Internal id | the property `id`, type integer | `@InternalId()` on another property |
| Field id and SuiteQL column | lowercased property name | `@Field('x')`, `@Field('x', { column: 'y' })` |
| Field type | `string`, `number` (float; integer for internal ids and select fields), `boolean`, `Date`, `string[]` / `number[]` (multiselect) | `@Field({ type })` |
| Read-only | the internal id, `text: true` fields, fields of a referenced record | `@ReadOnly()` |
| Text of a select field | | `@Field({ column: 'status', text: true })`, the `getText` value |
| Table | from the record type: transactions read `transaction`, items read `item`, everything else its own name | `@RecordType('x', { table })` |
| Discriminator | transactions filter `type`, items filter `itemtype` | `@RecordType('x', { discriminator: { column, value } })` |
| Type tables | `salesorder` joins `transaction` on `id` | `@RecordType('x', { tables: { extra: { key: 'id' } } })` |
| Reference or subrecord | a plain class is a subrecord; a record class is a reference unless the conventions know the subrecord | `@Reference()`, `@Subrecord()` |
| Select field of a reference | `<reference>Id` on the same class | `@Reference('entityId')` |
| Subrecord field id | lowercased property name | `@Subrecord('x')` |
| Subrecord table and list field to clear | `shippingaddress` and `billingaddress` on transactions; else the subrecord class's `@RecordType` table and internal id | `@Subrecord('x', { table, key, clearListField })` |
| Sublist id | from the line table (`transactionline` on a transaction is `item`), else the lowercased property name | `@Sublist('x')` |
| Sublist line table and parent column | the line class's `@RecordType` table; `item` on transactions reads `transactionline` where `mainline = 'F'` | `@Sublist('x', { table, parentColumn, where, lineKey })` |
| Sublist line identity | the line class's internal id, matched to the sublist field `line` | `@Sublist('x', { lineKey: { column, field } })` |
| Join type | sublists and subrecords join inner, they are part of the record; references join left outer; anything under a left outer join stays left outer | `{ join }` on `@Sublist`, `@Subrecord`, `@Reference` |
| Record set name | pluralized camel-case class name | `@RecordType('x', { setName })` |

Everything the build step assumes about NetSuite lives in one conventions table (`tooling/collect/netsuite-conventions.ts`). Anything not in it is a build diagnostic naming the decorator option that supplies it.

### References project with the declared type

The declared type of a reference is its projection, so a lookup never pulls the whole record:

```ts
customer?: Pick<Customer, 'id' | 'companyName'>;   // two fields
customer?: Omit<Customer, 'notes'>;                   // everything but one
customer?: CustomerSummary;                            // type CustomerSummary = Pick<Customer, ...>
customer?: Customer;                                   // every mapped field
```

References are read-only; write the select field (`customerId`) instead. A reference that loads its own class without a projection is a build error, and so is a sublist inside a sublist.

### Inheritance: table per hierarchy

NetSuite stores every transaction type in `transaction` and every item type in `item`, distinguished by `type` and `itemtype`. A class hierarchy maps onto it directly: a base class without `@RecordType` is a mapping base whose members are inherited, and each `@RecordType` class gets the discriminator from the conventions. Sales orders also have a type table of their own, `salesorder`, joined on the internal id; `@Field('shipmethod', { table: 'salesorder' })` reads a column from it.

### Decorator reference

| Decorator | Where | Purpose |
| --- | --- | --- |
| `@RecordType(id, { table?, setName?, coerce?, discriminator?, tables?, updater?, rest? })` | class | A queryable record type with a record set on the context. `updater` sets the default `RecordUpdaterOptions` for every write; `rest` carries REST record metadata for the scaffold. |
| `@InternalId()` | property | The internal id when it is not `id`. |
| `@Field(id?, { column?, table?, type?, text?, coerce? })` | property | Renames the field or overrides what the conventions inferred. |
| `@ReadOnly()` | property | Excludes the property from writes. |
| `@Reference(selectFieldProperty?, { join?, targetKey? })` | property | A reference: the select field behind it, and the referenced property to join on when it is not the internal id. |
| `@Subrecord(fieldId?, { table?, key?, clearListField?, join? })` | property | A subrecord: its field id and the table facts the conventions do not know. |
| `@Sublist(sublistId?, { table?, where?, parentColumn?, lineKey?, join? })` | property | A sublist: its id and the line table facts the conventions do not know. |
| `@SetFirst()`, `@ExcludeFromDefaultSelect()`, `@Transform(fn)`, `@NotMapped()` | property | Flags. Transforms must be exported functions so the build step can import them by name. |

## Build step and generated files

Add a config file at the project root (every key is optional). Relative paths in it resolve against the config file's own directory:

```json
{
  "models": ["src/models/**/*.ts", "!src/models/generated/**"],
  "outDir": "src/models/generated",
  "context": { "name": "App", "fileName": "context.gen.ts" },
  "tsconfig": "tsconfig.json"
}
```

Then run the build step:

```sh
npx netsuite-repository generate     # write the generated files
npx netsuite-repository check        # exit non-zero when they are out of date, or when no model files match (CI)
npx netsuite-repository watch        # regenerate whenever a model file changes
```

It writes:

- `generated/<Class>.types.gen.ts` for every exported class: one interface, extending the base class's interface, importing the referenced ones. Record types also get `<Class>Patch` and `<Class>Create`.
- `generated/<RecordType>.config.gen.ts` with `<RecordType>Config: QueryConfig<...>`, a plain object literal. Sublist line classes are record types, so they get one too.
- `generated/context.gen.ts` with `AppSchema`, the `AppContext` type, and `createAppContext()`.

The build step reads the classes with the TypeScript type checker, so it sees every property, its declared type, `Pick` projections, and inheritance. Model files are also evaluated in a sandbox to collect the decorators; they may import the library and other model files by relative path, and nothing else. Anything that cannot be mapped is reported with the file, class, and property.

Vite and Rollup accept the plugin directly:

```ts
import { netsuiteRepositoryPlugin } from '@amerilux/netsuite-repository/plugin';

export default { plugins: [netsuiteRepositoryPlugin({ watch: true })] };
```

Other bundlers can call `createModelWatcher()` from `@amerilux/netsuite-repository/cli` in a few lines.

## Scaffold models from NetSuite metadata (best effort)

The scaffold writes a model stub per record type so you edit instead of typing from scratch. It never overwrites a file it already wrote.

```sh
# Record-side metadata comes from the documented REST metadata catalog (token authenticated).
export NETSUITE_ACCOUNT_ID=1234567_SB1 NETSUITE_CONSUMER_KEY=... NETSUITE_CONSUMER_SECRET=... NETSUITE_TOKEN_ID=... NETSUITE_TOKEN_SECRET=...
npx netsuite-repository snapshot --record salesorder,customer --out netsuite.records.json

# SuiteQL table metadata only exists in the Records Catalog, which needs a browser session.
# Print a console script, run it on the Records Catalog page, and save the download next to the record snapshot.
npx netsuite-repository catalog-script --table transaction,transactionline,transactionshippingaddress

npx netsuite-repository scaffold --record salesorder --snapshot netsuite.records.json,netsuite.tables.snapshot.json
```

The stub keeps the catalog's camel-case names as property names, adds a field decorator only where the metadata disagrees with the conventions (a renamed field, a column that differs from the field id, a type the TypeScript type cannot imply, a field the record does not accept on write), declares every subrecord and sublist with `@Subrecord` and `@Sublist`, and leaves a `// TODO(scaffold)` comment for everything else: unknown tables, and sublists or subrecords without a known SuiteQL table.

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

## Queries

```ts
db.salesOrders.query()
    .exclude('lines')                                   // leave a relation and its joins out
    .include('customer')                                // bring one in that is @ExcludeFromDefaultSelect
    .leftJoin('transactionline', 'l', 'l.transaction = transaction.id AND l.mainline = ?', { params: ['F'] })
    .selectRaw('SUM(l.amount)', 'total', { type: 'currency' })
    .whereGroup((group) => group.where('memo', 'IS NULL').orWhere('memo', '=', ''))
    .orderByAsc('total')
    .page(2, 25)
    .executeTyped();
```

- The root table alias is the table name (`transaction`), and relation aliases follow the property path (`customer`, `lines`, `lines_item`), so raw predicates can name them.
- `where()`, `orderBy()`, and `select()` accept model properties, dotted paths into relations (`customer.companyName`), `selectRaw()` aliases, and `alias.column` for any known alias.
- A record type that shares its table adds its discriminator to every query, including `count()` and `exists()`, and it is ANDed around the user conditions so an `OR` cannot escape it.
- Sublists and subrecords join inner, so a query on `salesOrders` with `lines` in the select returns only orders that have lines; `exclude('lines')` or `@Sublist('item', { join: 'leftOuter' })` keeps the others.
- Joins declared per query render after the model's joins. A raw `on` predicate can carry `?` placeholders; join parameters are bound before `WHERE` parameters.
- Pagination emits `OFFSET n ROWS FETCH NEXT m ROWS ONLY`. Add an `orderBy` for deterministic pages. `pagination('top')` restores the legacy `TOP` clause if an account rejects the syntax.
- Read-side coercion turns numeric strings into numbers, `T`/`F` into booleans, and date strings into `Date` through `N/format`. Generated configs enable it; hand-written configs do not. Override per query with `coerce(false)`, per config with `coerce`, or per field.

## Writes

The record updater chooses the cheapest NetSuite path for a change:

- body fields only: one `record.submitFields` call;
- subrecords or sublists: `record.load`, apply, `record.save`;
- an address whose list field is set: clear the list field, save, reload, edit the subrecord, save.

`plan()` on any updater describes the calls it would make, and options such as `requireFastPath`, `maxRecordCalls`, `allowLineScans`, and `allowSubrecordReloads` reject expensive plans before they run. `@RecordType('x', { updater })` sets the defaults for a record type. `createRecord()` and `deleteRecord()` cover the remaining operations.

## Advanced: raw config

Everything above compiles to a `QueryConfig`. Hand-written configs still work and can be mixed with generated ones in the same context:

```ts
export const VendorConfig = defineQueryConfig<Vendor>({
    recordType: 'vendor',
    query: { from: { name: 'vendor', alias: 'v' } },
    fields: {
        id: { queryFieldId: 'id', tableAlias: 'v', type: 'integer', isPrimary: true, readonly: true },
        companyName: { queryFieldId: 'companyname', tableAlias: 'v', type: 'string', recordFieldId: 'companyname' },
    },
});
```

`fields` may be grouped into `query`, `common`, and `record` sections, and `relationships` describe subrecords, sublists, and references the same way the generated configs do.

## Package entry points

| Import | Contents |
| --- | --- |
| `@amerilux/netsuite-repository` | Everything the runtime needs: decorators, query builder, record updater, context, tracking. |
| `@amerilux/netsuite-repository/model` | The decorators and the registry the build step reads. |
| `@amerilux/netsuite-repository/tracking` | `ChangeTracker`, `EntityState`, diff helpers. |
| `@amerilux/netsuite-repository/cli` | `runGenerate`, `checkGenerated`, `createModelWatcher`, `runCli`, the conventions, and the model compiler. Node only. |
| `@amerilux/netsuite-repository/plugin` | `netsuiteRepositoryPlugin`. Node only. |

The runtime entry points never import Node modules, so the SuiteScript bundle stays free of build tooling.

## Design notes

`docs/entity-conventions-redesign.md` records why the surface looks the way it does: the three rules, the vocabulary, table per hierarchy and type tables, and the decisions taken along the way.
