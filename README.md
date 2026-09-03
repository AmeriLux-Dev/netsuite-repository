# @amerilux/netsuite-repository

Entity Framework style data access for NetSuite SuiteScript.

- **Models are decorated classes** that read like annotated type files. A fluent API is available as a second way to describe a model.
- **A build step generates the config file and the type file** for every model, TanStack Router style, so the SuiteScript bundle carries plain objects and no decorator machinery.
- **The runtime** queries SuiteQL through `N/query`, maps rows into typed objects, and writes through `N/record` with the fast path (`submitFields`) whenever the change allows it.
- **Change tracking** gives you `find()`, mutate, `saveChanges()`.

Record-side NetSuite ids (record field ids, sublist ids, subrecord ids, list fields to clear) are never guessed. You declare them once, next to the property they belong to.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Authoring surface | What you write to describe a model: decorators (primary) or the fluent API. |
| Build step | `netsuite-repository generate`, or the watch plugin, which reads the models and writes the generated files. |
| Generated files | `<Model>.config.gen.ts` (the `QueryConfig`), `<Model>.types.gen.ts` (plain interfaces and helper types), and `context.gen.ts`. |
| Runtime | The query builder, record updater, context, and change tracker that run inside NetSuite. |

## Install

```sh
npm install @amerilux/netsuite-repository
```

Enable decorators in the project that authors models:

```json
{ "compilerOptions": { "experimentalDecorators": true } }
```

The build step needs Node 18 or newer and the `typescript` package of your project.

## Define a model with decorators

```ts
// src/models/SalesOrder.ts
import { Column, Entity, Join, Key, OwnsMany, OwnsOne, ReadOnly, RecordField, Related, SetFirst } from '@amerilux/netsuite-repository';

export class ShippingAddress {
    @RecordField('addr1') addr1!: string | null;
    @RecordField('city') city!: string | null;
}

export class SalesOrderLine {
    @Column('linesequencenumber') @ReadOnly() line!: number;
    @Column('item', { type: 'key' }) @RecordField('item') itemId!: number;
    @RecordField() quantity!: number;
    @ReadOnly() amount!: number;
}

export class CustomerLookup {
    @Column('companyname') companyName!: string;
}

@Entity({ recordType: 'salesorder', table: 'transaction', alias: 'txn' })
@Join('cust', { table: 'customer', on: { sourceForeignKey: 'entity', targetPrimaryKey: 'id' } })
export class SalesOrder {
    @Key() id!: number;
    @Column('tranid') tranId!: string;                        // read-only: no @RecordField
    @Column('trandate') tranDate!: Date;                      // the build step emits type: 'date'
    @RecordField('memo') memo?: string | null;                // writable through submitFields
    @Column('entity') @RecordField('entity') @SetFirst() customerId!: number;
    @Column('companyname', { from: 'cust' }) customerName!: string;

    @OwnsOne(() => ShippingAddress, {
        subrecord: 'shippingaddress',
        clearListField: 'shipaddresslist',
        join: { alias: 'shipaddr', table: 'transactionshippingaddress', on: 'shipaddr.nkey = txn.shippingaddress' },
    })
    shippingAddress!: ShippingAddress;

    @OwnsMany(() => SalesOrderLine, {
        sublist: 'item',
        matchBy: 'itemId',
        lineNumberProperty: 'line',
        join: { alias: 'tl', table: 'transactionline', on: "tl.transaction = txn.id AND tl.mainline = 'F'" },
    })
    lines!: SalesOrderLine[];

    @Related(() => CustomerLookup, { from: 'cust' })
    customer!: CustomerLookup;
}
```

What is inferred and what is not:

| Inferred | Declared |
| --- | --- |
| The SuiteQL column: the lowercased property name unless `@Column` says otherwise. | `recordType` and `table`. |
| The table alias: the root alias, or the join alias of the navigation. | Record field ids (`@RecordField`), subrecord ids (`subrecord`), sublist ids (`sublist`), list fields to clear. |
| The field type, from the TypeScript declaration, when the build step runs. | Joins and their predicates. |
| Nested paths, cardinality, flattened keys, relationship field maps. | Which line property identifies a line (`matchBy`, `lineNumberProperty`). |

A property without `@RecordField` is read-only. Writing to it is rejected at plan time, before NetSuite is called.

### Decorator reference

| Decorator | Where | Purpose |
| --- | --- | --- |
| `@Entity({ recordType, table, alias?, setName? })` | class | Marks a root model. Nested classes need no `@Entity`. |
| `@Join(alias, { table, on, type?, from?, params? })` | class | Declares a join that `@Column({ from: alias })` properties read from. Repeatable. |
| `@UpdaterOptions(options)` | class | Default `RecordUpdaterOptions` for every write on this model. |
| `@Coerce(enabled)` | class | Read-side coercion default (on for generated configs). |
| `@RestMetadata(metadata)` | class | Attaches record metadata used to validate writes. |
| `@Key(options?)` | property | The primary key. Defaults to type `integer`. |
| `@Column(column?, { from?, type?, alias?, useText? })` | property | Maps a SuiteQL column. |
| `@RecordField(fieldId?)` | property | Opts the property into writes. No argument means the record field id equals the column. |
| `@ReadOnly()`, `@SetFirst()`, `@ExcludeFromDefaultSelect()`, `@Transform(fn)`, `@NotMapped()` | property | Flags. Transforms must be exported functions so the build step can import them by name. |
| `@OwnsOne(() => Class, { subrecord, clearListField?, join?, from?, fields? })` | property | An owned subrecord. |
| `@OwnsMany(() => Class, { sublist, matchBy?, lineNumberProperty?, join?, from?, fields? })` | property | A sublist collection. |
| `@Related(() => Class, { join?, from? })` | property | A read-only joined lookup. |

`lineNumberProperty` must hold the zero-based sublist line index. If you read `linesequencenumber`, add a transform that subtracts one.

## Define a model with the fluent API

The same model can be described against a hand-written interface. The build step reads the interface for the types.

```ts
import { defineModel } from '@amerilux/netsuite-repository';

export interface Customer {
    id: number;
    companyName: string;
    email: string | null;
    billingAddress: { addr1: string | null; city: string | null };
}

export const CustomerModel = defineModel<Customer>((model) => model
    .toRecord('customer').toTable('customer', 'cust').hasKey('id')
    .property('companyName').hasColumn('companyname').hasRecordField()
    .property('email').hasRecordField()
    .end()
    .ownsOne('billingAddress', (address) => address
        .toSubrecord('billingaddress')
        .fromAlias('cust')
        .property('addr1').hasColumn('billaddr1').hasRecordField('addr1')
        .property('city').hasColumn('billcity').hasRecordField('city')));
```

`extendModel(base, configure)` layers overrides on a definition without touching it, and `modelFromEntity(Class, configure)` seeds a definition from a decorated class so fluent calls can override the decorators.

## Build step and generated files

Add a config file at the project root (every key is optional). Relative paths in it resolve against the config file's own directory, so `--config examples/netsuite-repository.config.json` works from anywhere:

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

For every model it writes:

- `generated/SalesOrder.types.gen.ts` with `interface SalesOrder`, the nested interfaces, `SalesOrderPatch`, and `SalesOrderCreate`.
- `generated/SalesOrder.config.gen.ts` with `SalesOrderConfig: QueryConfig<SalesOrder>`, a plain object literal.
- `generated/context.gen.ts` with `AppSchema`, the `AppContext` type, and `createAppContext()`.

Model files are evaluated in a sandbox during generation. They may import the library and other model files by relative path, and nothing else. Anything the build step cannot map is reported with the file, class, and property, for example a property typed `Map<string, string>` with no explicit `type`.

Vite and Rollup accept the plugin directly:

```ts
import { netsuiteRepositoryPlugin } from '@amerilux/netsuite-repository/plugin';

export default { plugins: [netsuiteRepositoryPlugin({ watch: true })] };
```

Other bundlers can call `createModelWatcher()` from `@amerilux/netsuite-repository/cli` in a few lines.

The decorators also work without the build step, for unit tests or projects that skip generation: `configFromEntity(SalesOrder)` compiles the class at runtime. In that mode non-string properties need an explicit `type`, because TypeScript types are not visible at runtime.

## Scaffold models from NetSuite metadata (best effort)

The scaffold writes a decorated model stub per record type so you edit instead of typing from scratch. It never overwrites a file it already wrote.

```sh
# Record-side metadata comes from the documented REST metadata catalog (token authenticated).
export NETSUITE_ACCOUNT_ID=1234567_SB1 NETSUITE_CONSUMER_KEY=... NETSUITE_CONSUMER_SECRET=... NETSUITE_TOKEN_ID=... NETSUITE_TOKEN_SECRET=...
npx netsuite-repository snapshot --record salesorder,customer --out netsuite.records.json

# SuiteQL table metadata only exists in the Records Catalog, which needs a browser session.
# Print a console script, run it on the Records Catalog page, and save the download next to the record snapshot.
npx netsuite-repository catalog-script --table transaction,transactionline,transactionshippingaddress

npx netsuite-repository scaffold --record salesorder --snapshot netsuite.records.json,netsuite.tables.snapshot.json
```

The stub keeps the catalog's camel-case names as property names (`startDate`) over the lowercase ids N/record and SuiteQL use (`startdate`), treats `id` and the created/modified timestamps as read-only, declares `@RecordField` only where the record metadata says the field is writable, adds joins for the transaction, entity, and address families it knows, and leaves a `// TODO(scaffold)` comment for everything else: unknown tables, sublists without a known line table, and the line identity (`matchBy` or `lineNumberProperty`) that only you can decide.

## Use the context

```ts
import { createAppContext } from './models/generated/context.gen';

const db = createAppContext();

// Read
const order = db.salesOrders.find(9876);
const pending = db.salesOrders.query()
    .where('status', '=', 'B')
    .orderByDesc('tranDate')
    .page(1, 50)
    .executeTyped();

// Change tracking
order.memo = 'Auto-approved';
order.shippingAddress.city = 'Dallas';
order.lines.push({ itemId: 1, quantity: 2 } as SalesOrderLine);
const result = db.saveChanges();

// Explicit patches still work
db.salesOrders.submitPatch(9876, { memo: 'x', lines: { add: [{ itemId: 1, quantity: 2 }] } });
db.salesOrders.createRecord({ customerId: 12, memo: 'new' });
db.salesOrders.delete(9876);
```

Entities returned by `find()`, `executeTyped()`, `all()`, and `first()` are tracked. `saveChanges()` diffs each one against its snapshot and writes the difference through the record updater: body-only changes use `submitFields`, and anything touching a subrecord or sublist loads, mutates, and saves. Lines are matched by `lineNumberProperty`, then `matchBy`, then array position. Added entities get their new id written back. `planChanges()` shows what would happen without calling NetSuite.

Use `asNoTracking()` for reporting reads, and `{ tracking: false }` on `createAppContext()` for contexts that never write. Contexts hold tracked entities strongly, so create one per script execution.

## Queries

```ts
db.salesOrders.query()
    .leftJoin('customer', 'c', { sourceForeignKey: 'entity', targetPrimaryKey: 'id' })
    .leftJoin('transactionline', 'l', 'l.transaction = txn.id AND l.mainline = ?', { params: ['F'] })
    .selectRaw('SUM(l.amount)', 'total', { type: 'currency' })
    .where('c.companyname', 'LIKE', 'Acme%')
    .whereGroup((group) => group.where('memo', 'IS NULL').orWhere('memo', '=', ''))
    .orderByAsc('total')
    .page(2, 25)
    .executeTyped();
```

- Joins declared per query render after the model's joins. A raw `on` predicate can carry `?` placeholders; join parameters are bound before `WHERE` parameters.
- `where()` and `orderBy()` accept model properties, `selectRaw()` aliases, and `alias.column` for any known alias.
- Pagination emits `OFFSET n ROWS FETCH NEXT m ROWS ONLY`. Add an `orderBy` for deterministic pages. `pagination('top')` restores the legacy `TOP` clause if an account rejects the syntax.
- Read-side coercion turns numeric strings into numbers, `T`/`F` into booleans, and date strings into `Date` through `N/format`. Generated configs enable it; hand-written configs do not. Override per query with `coerce(false)`, per config with `coerce`, or per field.

## Writes

The record updater chooses the cheapest NetSuite path for a change:

- body fields only: one `record.submitFields` call;
- subrecords or sublists: `record.load`, apply, `record.save`;
- an owned address whose list field is set: clear the list field, save, reload, edit the subrecord, save.

`plan()` on any updater describes the calls it would make, and options such as `requireFastPath`, `maxRecordCalls`, `allowLineScans`, and `allowSubrecordReloads` reject expensive plans before they run. `createRecord()` and `deleteRecord()` cover the remaining operations.

## Advanced: raw config

Everything above compiles to a `QueryConfig`. Hand-written configs still work and can be mixed with models in the same context:

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

`fields` may be grouped into `query`, `common`, and `record` sections, and `relationships` describe owned subrecords and sublist collections the same way the decorators do.

## Package entry points

| Import | Contents |
| --- | --- |
| `@amerilux/netsuite-repository` | Everything the runtime needs: decorators, fluent API, query builder, record updater, context, tracking. |
| `@amerilux/netsuite-repository/model` | Decorators, `defineModel`, `compileEntityModel`, `configFromEntity`. |
| `@amerilux/netsuite-repository/tracking` | `ChangeTracker`, `EntityState`, diff helpers. |
| `@amerilux/netsuite-repository/cli` | `runGenerate`, `checkGenerated`, `createModelWatcher`, `runCli`. Node only. |
| `@amerilux/netsuite-repository/plugin` | `netsuiteRepositoryPlugin`. Node only. |

The runtime entry points never import Node modules, so the SuiteScript bundle stays free of build tooling.
