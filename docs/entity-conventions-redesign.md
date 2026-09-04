# Conventions redesign: Entity Framework behaviour, NetSuite vocabulary

Status: approved and implemented, 2026-09-03; member-decorator revision implemented the same day (see the last section). Target version 0.3.0 (breaking; no compatibility shim before 1.0).

## Goal

Make a model file read like an Entity Framework entity while using the words a NetSuite developer already knows: a class is a **record type**, its properties are **fields**, an object-typed property is a **subrecord**, an array-typed property is a **sublist**, and a property typed as another record class is a **reference** joined through a select field. Decorators exist only to override a convention. Everything the library knows about NetSuite that a developer would otherwise repeat on every model moves into a built-in conventions table.

Three rules drive every decision below:

1. **Every declared property is a mapped field.** `@NotMapped()` opts out.
2. **Every mapped body field is writable.** `@ReadOnly()` opts out. The record field id is the property name lowercased and doubles as the SuiteQL column; `@Field(id)` renames it.
3. **A property whose type is another model class is a reference, subrecord, or sublist.** The member decorators `@Reference`, `@Subrecord`, and `@Sublist` name it the way NetSuite does; the build step resolves the join from the declared type, the select field, and the conventions, never from a hand-written `ON` string.

## Vocabulary

| NetSuite term used here | Entity Framework equivalent | Shape in the model |
| --- | --- | --- |
| Record type | Entity | a class with `@RecordType('salesorder')` |
| Internal id | Key | the property `id` |
| Field | Column / property | any declared property |
| Select field | Foreign key | a `number` property holding an internal id, e.g. `customerId` |
| Reference | Reference navigation | a property typed as another record class, e.g. `customer?: Pick<Customer, ...>` |
| Subrecord | Owned type | an object-typed property, e.g. `@Subrecord('shippingaddress') shippingAddress: TransactionAddress` |
| Sublist | Collection navigation | an array-typed property, e.g. `@Sublist('item') lines: TransactionLine[]` |
| Sublist line | Dependent entity | a record type reading the line table, e.g. `@RecordType('transactionline')` |
| Text of a select field | (none) | `@Field('price', { text: true })`, the `getText` value |
| Record set | DbSet | `context.salesOrders` |

The plan, the README, diagnostics, and identifier names in the code use the NetSuite column. "Relation" survives only as the internal umbrella term for reference, subrecord, and sublist inside the collector.

## The authoring surface

### Class decorator

There is exactly one: `@RecordType(id, options?)`. A class is either a record type or a plain class (a subrecord shape, a mapping base). Sublist line classes are record types named after the table they read (`@RecordType('transactionline')`), which also makes lines queryable on their own (`context.transactionLines`).

| Option | Meaning |
| --- | --- |
| `table` | Base SuiteQL table when the conventions do not know it (`salesorder` maps to `transaction`, `customrecord_x` to itself). |
| `setName` | Record set name on the context; defaults from the class name. |
| `coerce` | Read-side coercion default for the record type. |
| `discriminator` | Table-per-hierarchy filter when the conventions do not know it. |
| `tables` | Type tables fields may read from with `@Field({ table })`. |
| `updater` | Default `RecordUpdaterOptions` for every write on the record type. |
| `rest` | REST record metadata used by the scaffold and by runtime field lookups outside the model. |

Removed over the course of the redesign: `@Entity`, `@Join`, `@OwnsOne`, `@OwnsMany`, `@Related`, `@Coerce`, `@Column`, `@RecordField`, the class-level `@Sublist` and `@Subrecord`, `@UpdaterOptions`, `@RestMetadata`, and the fluent API (`defineModel`, `extendModel`, `modelFromEntity`).

`@Record` was rejected as the class decorator name because a value import named `Record` shadows TypeScript's `Record<K, V>` utility type in the same file.

### Property decorators

| Decorator | Meaning |
| --- | --- |
| `@InternalId()` | Marks the internal id when it is not the property named `id`. |
| `@Field(id?, options?)` | Renames the field. `column` overrides the SuiteQL column when it differs from the field id (`@Field('orderstatus', { column: 'status' })`). `table` reads the column from a type table. `type`, `text`, and `coerce` override the inferred settings. Never required. |
| `@ReadOnly()` | Excludes the property from writes. |
| `@Reference(selectFieldProperty?, options?)` | A reference: which property holds the internal id when it is not `<reference>Id`; `targetKey` names the referenced property to join on when it is not its internal id; `join` forces the join type. |
| `@Subrecord(fieldId?, options?)` | A subrecord: the field id when it is not the lowercased property name; `table`, `key`, and `clearListField` when the conventions do not know them; `join`. |
| `@Sublist(sublistId?, options?)` | A sublist: the id when it is not known from the line table; `table`, `where`, `parentColumn`, and `lineKey` when the line class and the conventions do not supply them; `join`. |
| `@NotMapped()`, `@Transform(fn)`, `@SetFirst()`, `@ExcludeFromDefaultSelect()` | Flags. |

The three relation decorators are the NetSuite words for what EF calls navigations. None is required when the conventions can tell the kind from the declared type (an array is a sublist; a plain class is a subrecord; a record class is a reference), but they are the expected way to write a model: the sublist id and the subrecord field id almost never equal the property name.

### Conventions

| Concern | Convention | Override |
| --- | --- | --- |
| Internal id | property `id`, type integer | `@InternalId()` |
| Field id and SuiteQL column | property name lowercased | `@Field('x')`, `@Field('x', { column: 'y' })` |
| Field type | from the TypeScript type: `string`, `number` (float; integer for internal ids and select fields), `boolean`, `Date`, `string[]`/`number[]` (multiselect) | `@Field({ type })` |
| Read-only by convention | the internal id, `text: true` fields, fields of a referenced record, `@NotMapped` | none for text fields: declare a second property to write the select field itself |
| Table alias | the table name for the root, the property path for relations (`lines`, `lines_item`); never authored | none, aliases are internal |
| Reference or subrecord | a plain class is a subrecord; a record class is a reference unless the conventions know a subrecord for the field | `@Reference()`, `@Subrecord()` |
| Join type | sublists and subrecords inner, references left outer; a relation nested under a left outer join stays left outer | `{ join }` on the relation decorator |
| Select field for a reference | `<reference>Id` on the same class | `@Reference('entityId')` |
| Subrecord field id | lowercased property name (`shippingaddress`, `billingaddress`) | `@Subrecord('x')` |
| Subrecord queryable table | conventions table (`transaction.shippingaddress` reads `transactionshippingaddress` on `nkey`); else the subrecord class's `@RecordType` table and internal id | `@Subrecord('x', { table, key })` |
| List field cleared before a subrecord edit | conventions table (`shipaddresslist`, `billaddresslist`) | `@Subrecord('x', { clearListField })` |
| Sublist id | from the line table (`transactionline` under `transaction` is `item`), else the lowercased property name | `@Sublist('item')` |
| Sublist table and parent column | the line class's `@RecordType` table; conventions table for the parent column and predicate (`transactionline.transaction`, `mainline = 'F'`, line key column `id` mapped to the sublist field `line`) | `@Sublist('item', { table, where, parentColumn, lineKey })` |
| Sublist line match | the line class's internal id | `@InternalId()` on another line property |

Two properties that share one class, such as shipping and billing addresses, work because the subrecord field id comes from the property, not the class.

## References, subrecords, sublists

### Reference

```ts
@RecordType('salesorder')
export class SalesOrder {
    id!: number;
    @Field('entity') customerId!: number;
    customer?: Pick<Customer, 'id' | 'companyName'>;
}

@RecordType('customer')
export class Customer {
    id!: number;
    companyName!: string;
    email!: string | null;
    // ...
}
```

The build step sees that `customer` is typed from the `Customer` record class, finds the select field `customerId`, and emits a left outer join on `customer.id = transaction.entity` with only the two projected fields selected. The result type is `Pick<Customer, 'id' | 'companyName'>`, so a lookup that needs two fields never pulls the whole record.

### Projection on a reference

The declared type is the projection. `Pick`, `Omit`, and any alias of them are resolved through the type checker:

```ts
customer?: Pick<Customer, 'id' | 'companyName'>;    // two fields
customer?: Omit<Customer, 'notes' | 'email'>;         // everything but two fields
customer?: CustomerSummary;                            // type CustomerSummary = Pick<Customer, ...>
customer?: Customer;                                   // every mapped field
```

The build step takes the properties of the declared type, intersects them with the referenced record's mapped fields, and errors on any name that is not mapped there. References inside the projection are followed the same way (a `Pick` that keeps a reference of the target includes that reference's own projection). A sublist inside a reference or subrecord is allowed; a sublist inside a sublist is a build error because SuiteQL would multiply rows.

Per query, `include('customer')` and `exclude('customer')` toggle a reference, subrecord, or sublist, and `select` accepts dotted paths (`select('id', 'customer.companyName')`). The result type of a narrowed `select` stays the full model type for now; typed narrowing is a follow-up.

### Subrecord

```ts
export class TransactionAddress {
    addr1!: string | null;
    city!: string | null;
    @SetFirst() state!: string | null;
    zip!: string | null;
    country!: string | null;
}

@RecordType('salesorder')
export class SalesOrder {
    @Subrecord('shippingaddress') shippingAddress!: TransactionAddress;
    @Subrecord('billingaddress') billingAddress!: TransactionAddress;
}
```

`shippingAddress` is the `shippingaddress` subrecord, queried from `transactionshippingaddress`, cleared through `shipaddresslist`, all from the conventions table. Every address field is writable through the subrecord by rule 2. The join is inner: a subrecord is part of its record. `@Subrecord('shippingaddress', { join: 'leftOuter' })` keeps records whose subrecord is empty.

A subrecord class may itself be a record type when it has a table of its own (`@RecordType('locationmainaddress')` with `@InternalId() @Field('nkey') nKey`); the property then needs no table option.

### Sublist

```ts
@RecordType('transactionline')
export class TransactionLine {
    id!: number;                                   // transactionline.id, sublist field 'line', match key, read-only
    @Field('item') itemId!: number;
    item?: Pick<Item, 'itemId' | 'displayName' | 'itemType'>;
    quantity!: number;
    rate!: number | null;
    @Field('custcolskidnotes') skidNotes!: string | null;
    @NotMapped() quantityCommitted!: number;
}

@RecordType('salesorder')
export class SalesOrder {
    @Sublist('item') lines!: TransactionLine[];    // inner join: the lines are part of the order
}
```

The build step emits the `transactionline` join on `transaction = transaction.id AND mainline = 'F'`, then the `item` join from the line alias (left outer, as every reference), and sublist update mappings for every writable line field keyed on `line`. Results nest as `order.lines[].item.itemType`. `TransactionLine` also gets a config and a record set of its own, so `context.transactionLines.query()` reads lines directly.

## Inheritance: table per hierarchy

NetSuite already stores its records the way Entity Framework's Table Per Hierarchy strategy does: every transaction type is a row in `transaction` distinguished by the `type` column, every item type a row in `item` distinguished by `itemtype`. Model classes follow the same shape.

```ts
export abstract class Transaction {                       // mapping base: no record set of its own
    id!: number;
    tranId!: string;
    tranDate!: Date;
    @Field('entity') entityId!: number;
    @Subrecord('shippingaddress') shippingAddress!: TransactionAddress;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    @Sublist('item') lines!: TransactionLine[];
}

@RecordType('invoice')
export class Invoice extends Transaction {
    dueDate!: Date | null;
}
```

Conventions:

| Concern | Convention | Override |
| --- | --- | --- |
| Inherited members | A class inherits every field, subrecord, sublist, reference, and decorator override of its base classes. The type checker sees inherited members; the decorator registry walks the prototype chain. | Redeclare the property on the derived class with a new decorator. |
| Base class without `@RecordType` | A mapping base. It gets a type file (derived interfaces `extends` it) but no config and no record set. | Add `@RecordType` to make it queryable in its own right, for example `@RecordType('transaction')` for a read-only view over every transaction. |
| Table | Inherited from the first decorated ancestor, else from the conventions table for the derived record type. | `@RecordType('x', { table })` |
| Discriminator | The conventions table maps record type to the discriminator column and value (`salesorder` is `type = 'SalesOrd'`, `invoice` is `type = 'CustInvc'`, `inventoryitem` is `itemtype = 'InvtPart'`). The generated config carries it and every query on the set adds the predicate; a base set with no discriminator queries the whole table. | `@RecordType('x', { discriminator: { column, value } })` |
| Sublist line classes | Record types that inherit the same way (`SalesOrderLine extends TransactionLine`, both `@RecordType('transactionline')`). | |

The record updater is unaffected: writes go through the concrete class's record type. Change tracking keys entities by record set, so a sales order and an invoice with the same internal id never collide.

The generated config carries `discriminator?: { column: string; value: string }`, and the query builder adds `<alias>.<column> = ?` to every select, count, and exists built from that config.

### Type tables: table per type on top of the hierarchy

Some record types add a table of their own keyed by the same internal id: `salesorder` alongside `transaction`. That is Entity Framework's Table Per Type join, and NetSuite uses it together with the hierarchy above. The split between the two tables cannot be derived from the class (custom body fields of a sales order still live in `transaction`), so placement is declared per field and the join comes from the conventions table:

```ts
@RecordType('salesorder')                                          // transaction, type = 'SalesOrd', type table salesorder on id
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;                        // transaction
    @Field('shipmethod', { table: 'salesorder' }) shipMethod!: number | null;  // salesorder
}
```

| Concern | Convention | Override |
| --- | --- | --- |
| Which table a field reads from | the record type's base table | `@Field('x', { table: 'salesorder' })` |
| Type tables the build step knows | conventions table: `salesorder` joins `transaction` on `id` | `@RecordType('x', { tables: { extra: { key: 'id' } } })` |
| Join | inner join on internal id, emitted only when a field uses the table; alias is the table name | none |

Writes are unaffected: the record field id is the same whichever table the column comes from.

## Writes

Rule 2 decides what the compiled `QueryField` carries:

- body field: `recordFieldId = field id` unless `@ReadOnly` removes it
- subrecord field: `recordAccess: 'subrecord'` with the subrecord field id from the property, field id from the line
- sublist field: `updateMapping: { kind: 'sublist', sublistId, fieldId, matchBy }`
- fields of a referenced record, `text: true` fields, internal ids: `readonly: true`

The record updater does not change. It already chooses `submitFields` versus load/save from these mappings.

Known field/column mismatches on standard records live in the conventions table so the common ones need no override: transaction `status` (column) writes through `orderstatus` (field); transaction line `id` (column) writes through `line` (field).

## Built-in conventions table

Module `tooling/collect/netsuite-conventions.ts`, plain data, imported by the build step only: record type to table, discriminator, and type tables; field ids that differ from their column; subrecord tables keyed by owner table and field id; sublists keyed by owner table, matched by sublist id or by line table.

Anything missing from the table is a build diagnostic naming the decorator option that supplies it. The table is the only place the library infers a record-side id, and every entry is a documented NetSuite fact.

## Generated output

`<Model>.config.gen.ts` keeps the `QueryConfig` shape, so the runtime, context, and change tracker are untouched except for `include`/`exclude` on the query builder.

`<Model>.types.gen.ts` emits reference, subrecord, and sublist types as declared, importing the target's generated type:

```ts
import type { Customer } from './Customer.types.gen';
export interface SalesOrder {
    customer?: Pick<Customer, 'id' | 'companyName'>;
    lines: TransactionLine[];
}
```

`context.gen.ts` wires every record type, sublist line classes included. Plain classes get a type file but no config and no record set on the context.

## Implementation phases (done)

1. **Conventions collector.** `tooling/collect/property-type-reader.ts` reads every exported class with the type checker: declared type text, scalar field type, optional flag, and for object types the resolved target class, the projected property names, and array-ness. `tooling/collect/model-file-evaluator.ts` evaluates the files in a sandbox for decorator overrides and transform references. `tooling/collect/model-resolver.ts` applies the conventions and reports diagnostics: unmapped type, missing select field for a reference, unknown subrecord table, unknown line table or parent column, a relation decorator on the wrong shape, sublist inside a sublist, projected name not mapped on the target, cycles.
2. **Decorators.** `src/model/decorators.ts` records overrides only; none is required for a property to exist. The fluent API is gone.
3. **Compile.** `tooling/compile/compile-model.ts` resolves relations to `JoinDef`s (aliases from the property path), applies projections, and emits the write mappings from rule 2.
4. **Runtime.** `QueryBuilder.include(name)` and `exclude(name)`; `select` accepts dotted paths; discriminators on every query.
5. **Emitters, scaffold, docs.** Type emitter writes relation types as declared; the scaffold emits the surface above; README rewritten around the vocabulary table, the conventions table, and the three rules.
6. **Validation on the test project.** `C:\src\order-processing-repository-test\api\models` migrated, regenerated, api and client tests rerun.

## Decisions taken

- References, subrecords, and sublists declared on a model load by default. Excluding one is a per-query `exclude()` or `@ExcludeFromDefaultSelect()` on the property. Entity Framework does the opposite (nothing loads without `Include`), but a SuiteQL join costs far less than a second round trip and the declared projection already bounds the width.
- Sublists and subrecords join inner; references join left outer. A sublist or subrecord is part of its record the way an owned type is part of its entity, so the join needs no decorator of its own and `@Join` was dropped. A reference is another record that may be absent, hence left outer (EF Include). A relation nested under a left outer join stays left outer regardless of its kind, because an inner join after an outer join would filter the parent out. The `join` option on the relation decorator overrides any of this.
- The fluent API is removed rather than rebuilt on the conventions.
- Query-level typed narrowing (`select` returning a `Pick`) is deferred.
- `@Field` carries both ids because they coincide almost everywhere in NetSuite; the `column` option is the escape hatch for the few standard mismatches the conventions table does not cover.

## Revision: member decorators mirror NetSuite

Applied 2026-09-03 after the first implementation. The first cut put `@Sublist` and `@Subrecord` on classes, next to `@RecordType`, and added `@Join` and `@UpdaterOptions` as further class-level and property-level decorators. That mixed two ideas: what a class is (a record type, full stop) and what a member is (a field, a subrecord, a sublist, a reference). The revision separates them:

- The only class decorator is `@RecordType`. A sublist line class is a record type reading its line table (`transactionline`), so it also becomes queryable on its own. Subrecord shapes are plain classes, or record types when they have a table of their own.
- `@Field`, `@Subrecord`, `@Sublist`, and `@Reference` are the member decorators, named after NetSuite's own terms. The sublist id and the subrecord field id are declared where NetSuite puts them: on the parent's member.
- `@Join` is gone; the join type follows from the kind (see the decisions above) and the relation decorators accept `join` for the exceptions.
- `@UpdaterOptions` and `@RestMetadata` folded into `@RecordType` as `updater` and `rest`.

Runtime shapes (`QueryConfig`, the record updater, change tracking) did not change; only the registry, the resolver, the scaffold, and the fixtures did.
