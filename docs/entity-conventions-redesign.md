# Conventions redesign: Entity Framework behaviour, NetSuite vocabulary

Status: approved and implemented, 2026-09-03. Target version 0.3.0 (breaking; no compatibility shim before 1.0).

## Goal

Make a model file read like an Entity Framework entity while using the words a NetSuite developer already knows: a class is a **record type**, its properties are **fields**, an object-typed property is a **subrecord**, an array-typed property is a **sublist**, and a property typed as another record class is a **reference** joined through a select field. Decorators exist only to override a convention. Everything the library knows about NetSuite that a developer would otherwise repeat on every model moves into a built-in conventions table.

Three rules drive every decision below:

1. **Every declared property is a mapped field.** `@NotMapped()` opts out.
2. **Every mapped body field is writable.** `@ReadOnly()` opts out. The record field id is the property name lowercased and doubles as the SuiteQL column; `@Field(id)` renames it.
3. **A property whose type is another model class is a reference, subrecord, or sublist.** The build step resolves the join from the declared type and the select field, never from a hand-written `ON` string.

## Vocabulary

| NetSuite term used here | Entity Framework equivalent | Shape in the model |
| --- | --- | --- |
| Record type | Entity | a class with `@RecordType('salesorder')` |
| Internal id | Key | the property `id` |
| Field | Column / property | any declared property |
| Select field | Foreign key | a `number` property holding an internal id, e.g. `customerId` |
| Reference | Reference navigation | a property typed as another record class, e.g. `customer?: Pick<Customer, ...>` |
| Subrecord | Owned type | a property typed as a plain class, e.g. `shippingAddress: TransactionAddress` |
| Sublist | Collection navigation | an array property typed as a `@Sublist` class, e.g. `lines: SalesOrderLine[]` |
| Sublist line | Dependent entity | one element of a sublist |
| Text of a select field | (none) | `@Field('price', { text: true })`, the `getText` value |
| Record set | DbSet | `context.salesOrders` |

The plan, the README, diagnostics, and identifier names in the code use the NetSuite column. "Navigation" survives only as the internal umbrella term for reference, subrecord, and sublist inside the collector.

## The authoring surface after the change

### Class decorators

| Decorator | Meaning | Replaces |
| --- | --- | --- |
| `@RecordType(id, options?)` | A root record. The SuiteQL `table` defaults from the conventions table (`salesorder` maps to `transaction`, `customrecord_x` to itself). `setName` defaults from the class name. `coerce` lives here. | `@Entity({ recordType, table, alias, setName })`, `@Coerce` |
| `@Sublist(id, options?)` | A sublist line class, queried from its own table (`transactionline` by convention for transaction sublists). `where` adds a fixed predicate; the conventions table supplies `mainline = 'F'` for transaction lines. | `@OwnsMany` options plus the entity-level `@Join` for the line table |
| `@Subrecord(options?)` | A subrecord class. Optional; a class used as a non-array property that is neither a `@RecordType` nor a `@Sublist` is a subrecord by convention. Options name the queryable table and key when the conventions table does not know them. | `@OwnsOne` options |
| `@UpdaterOptions(options)` | Unchanged. | |

Removed: `@Entity`, `@Join`, `@OwnsOne`, `@OwnsMany`, `@Related`, `@Coerce`, `@Column`, `@RecordField`, and the fluent API (`defineModel`, `extendModel`, `modelFromEntity`). `@RestMetadata` stays as scaffolding metadata but leaves the documented authoring surface.

`@Record` was rejected as the class decorator name because a value import named `Record` shadows TypeScript's `Record<K, V>` utility type in the same file.

### Property decorators

| Decorator | Meaning |
| --- | --- |
| `@InternalId()` | Marks the internal id when it is not the property named `id`. |
| `@Field(id?, options?)` | Renames the field. `column` overrides the SuiteQL column when it differs from the field id (`@Field('orderstatus', { column: 'status' })`). `type`, `text`, and `coerce` override the inferred settings. Never required. |
| `@ReadOnly()` | Excludes the property from writes. |
| `@Reference(selectFieldProperty, options?)` | On a reference: which property holds the internal id when it is not `<reference>Id`; `join` forces the join type. |
| `@Subrecord(fieldId, options?)` | On a subrecord property whose field id is not the lowercased property name, or whose queryable table and list field to clear are unknown to the conventions table. |
| `@NotMapped()`, `@Transform(fn)`, `@SetFirst()`, `@ExcludeFromDefaultSelect()` | Unchanged. |

### Conventions

| Concern | Convention | Override |
| --- | --- | --- |
| Internal id | property `id`, type integer | `@InternalId()` |
| Field id and SuiteQL column | property name lowercased | `@Field('x')`, `@Field('x', { column: 'y' })` |
| Field type | from the TypeScript type: `string`, `number` (float; integer for internal ids and select fields), `boolean`, `Date`, `string[]`/`number[]` (multiselect) | `@Field({ type })` |
| Read-only by convention | the internal id, `text: true` fields, fields of a referenced record, `@NotMapped` | none for text fields: declare a second property to write the select field itself |
| Table alias | generated from the class or property name; never authored | none, aliases are internal |
| Join type | always left outer, so loading a reference, subrecord, or sublist never filters the parent (EF Include) | `@Join('inner')` on the property |
| Select field for a reference | `<reference>Id` on the same class | `@Reference('entityId')` |
| Subrecord field id | lowercased property name (`shippingaddress`, `billingaddress`) | `@Subrecord('x')` |
| Subrecord queryable table | conventions table (`transaction.shippingaddress` reads `transactionshippingaddress` on `nkey`) | `@Subrecord('x', { table, key })` |
| List field cleared before a subrecord edit | conventions table (`shipaddresslist`, `billaddresslist`) | `@Subrecord('x', { clearListField })` |
| Sublist table and parent select field | conventions table (`transactionline.transaction`, line key column `id` mapped to the sublist field `line`) | `@Sublist('item', { table, where, parentColumn, lineKey })` |
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

The build step sees that `customer` is typed from the `Customer` record class, finds the select field `customerId`, and emits a left outer join on `customer.id = txn.entity` with only the two projected fields selected. The result type is `Pick<Customer, 'id' | 'companyName'>`, so a lookup that needs two fields never pulls the whole record.

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
    shippingAddress!: TransactionAddress;
    billingAddress!: TransactionAddress;
}
```

`shippingAddress` maps to the `shippingaddress` subrecord, queried from `transactionshippingaddress`, cleared through `shipaddresslist`, all from the conventions table. Every address field is writable through the subrecord by rule 2.

### Sublist

```ts
@Sublist('item')
export class SalesOrderLine {
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
    lines!: SalesOrderLine[];                      // inner join because the property is required
}
```

The build step emits the `transactionline` join on `transaction = txn.id AND mainline = 'F'`, then the `item` join from the line alias, and sublist update mappings for every writable line field keyed on `line`. Results nest as `order.lines[].item.itemType`; the runtime mapper already builds dotted paths under array items, so this is a collector change, not a runtime one.

## Inheritance: table per hierarchy

NetSuite already stores its records the way Entity Framework's Table Per Hierarchy strategy does: every transaction type is a row in `transaction` distinguished by the `type` column, every item type a row in `item` distinguished by `itemtype`. Model classes follow the same shape.

```ts
export abstract class Transaction {                       // mapping base: no record set of its own
    id!: number;
    tranId!: string;
    tranDate!: Date;
    @Field('entity') entityId!: number;
    shippingAddress!: TransactionAddress;
}

@RecordType('salesorder')
export class SalesOrder extends Transaction {
    @Field('otherrefnum') poNumber!: string | null;
    lines!: SalesOrderLine[];
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
| Sublist line classes | Inherit the same way (`SalesOrderLine extends TransactionLine`). The `@Sublist` decorator may sit on the base or the derived class. | |

The record updater is unaffected: writes go through the concrete class's record type. Change tracking keys entities by record set, so a sales order and an invoice with the same internal id never collide.

The generated config gains `discriminator?: { column: string; value: string }`, and the query builder adds `<alias>.<column> = ?` to every select, count, and exists built from that config.

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

Rule 2 changes what the compiled `QueryField` carries:

- body field: `recordFieldId = field id` unless `@ReadOnly` removes it
- subrecord field: `recordAccess: 'subrecord'` with the subrecord field id from the property, field id from the line
- sublist field: `updateMapping: { kind: 'sublist', sublistId, fieldId, matchBy }`
- fields of a referenced record, `text: true` fields, internal ids: `readonly: true`

The record updater does not change. It already chooses `submitFields` versus load/save from these mappings.

Known field/column mismatches on standard records live in the conventions table so the common ones need no override: transaction `status` (column) writes through `orderstatus` (field); transaction line `id` (column) writes through `line` (field).

## Built-in conventions table

New module `src/model/netsuite-conventions.ts`, plain data, imported by the build step only:

```ts
{
  tables: { salesorder: 'transaction', purchaseorder: 'transaction', invoice: 'transaction', customer: 'customer', ... },
  fieldIdsByColumn: { transaction: { status: 'orderstatus' } },
  subrecords: {
    transaction: {
      shippingaddress: { table: 'transactionshippingaddress', key: 'nkey', clearListField: 'shipaddresslist' },
      billingaddress:  { table: 'transactionbillingaddress',  key: 'nkey', clearListField: 'billaddresslist' },
    },
  },
  sublists: {
    transaction: { item: { table: 'transactionline', parentSelectField: 'transaction', lineKey: { column: 'id', field: 'line' }, where: "mainline = 'F'" } },
  },
}
```

Anything missing from the table is a build diagnostic naming the decorator option that supplies it. The table is the only place the library infers a record-side id, and every entry is a documented NetSuite fact.

## Generated output

`<Model>.config.gen.ts` keeps the `QueryConfig` shape, so the runtime, context, and change tracker are untouched except for `include`/`exclude` on the query builder.

`<Model>.types.gen.ts` emits reference, subrecord, and sublist types as declared, importing the target's generated type:

```ts
import type { Customer } from './Customer.types.gen';
export interface SalesOrder {
    customer?: Pick<Customer, 'id' | 'companyName'>;
    lines: SalesOrderLine[];
}
```

`context.gen.ts` is unchanged. `@Sublist` and `@Subrecord` classes get a type file but no config and no record set on the context.

## Implementation phases

### Phase 1: conventions collector

- `tooling/collect/property-type-reader.ts` becomes the primary source. For each exported class it returns every instance property with: declared type text, scalar field type, optional flag, and for object types the resolved target class (file path plus class name), the projected property names, and array-ness.
- `tooling/collect/model-file-evaluator.ts` keeps evaluating the files for decorator metadata and transform function references, but its output is treated as overrides merged onto the collected properties. Class identity between the two sources is matched on file path plus export name.
- New `tooling/collect/conventions.ts` applies the table above and the naming rules, producing the existing `EntityModelMetadata` with references, subrecords, and sublists filled in. The metadata's navigation entry gains `kind: 'reference' | 'subrecord' | 'sublist'`, `target` (record class reference), `selectFieldProperty`, `projection` (property names or `all`), and nested entries.
- Diagnostics: unmapped type, missing select field for a reference, unknown subrecord table, sublist inside a sublist, projected name not mapped on the target.

### Phase 2: decorators

- Rewrite `src/model/decorators.ts` to the tables above. Decorators only record overrides; none is required for a property to exist.
- Delete `src/model/fluent.ts` and its tests; remove `modelFromEntity`, `extendModel`, `isEntityModelDefinition` from the runtime API and the evaluator.
- `src/model/metadata.ts`: `recordFieldFollowsColumn` is removed; `readOnly` becomes the opt-out. Rename `owned`/`collection`/`related` kinds to `subrecord`/`sublist`/`reference`.

### Phase 3: compile

- `src/model/compile.ts` resolves references, subrecords, and sublists to `JoinDef`s (aliases generated from the property name with a numeric suffix on collision, chained through `fromTable` for nested ones), applies projections when selecting fields, and emits the write mappings from rule 2.
- Move `compile.ts` and `metadata.ts` under `tooling/` if nothing in `src/` still needs them at runtime; the runtime bundle should carry only the generated config.

### Phase 4: runtime

- `QueryBuilder.include(name)` and `exclude(name)`; `select` accepts dotted paths. Anything excluded from the default select is joined only when included, so the SQL does not carry unused joins.
- Verify the mapper on a reference nested under a sublist (`lines[].item`) and on a subrecord of a referenced record; add tests.

### Phase 5: emitters, scaffold, docs

- Type emitter writes reference, subrecord, and sublist types as declared and imports sibling generated types.
- Scaffold (`tooling/scaffold`) emits the new surface: no `@Field` for conventional names, `@ReadOnly` for non-writable REST fields, `@Subrecord` and `@Sublist` classes from the REST metadata.
- README rewritten around the vocabulary table, the conventions table, and the three rules.

### Phase 6: validation on the test project

- Migrate `C:\src\order-processing-repository-test\api\models` to the new surface, regenerate, and rerun its api and client tests. Expected changes there: `Location`, `SubLocation`, `ShipMode`, `PriceLevel`, `Item`, `Customer` become plain record classes used through projected references instead of `from`-aliased columns; `SalesOrderLine.itemName` becomes `line.item.itemId`; the SPS packing slip models lose their `@Join` declarations.
- Update the direction memory: record-side ids come from the conventions table or an override, never guessed beyond that table.

## Decisions taken in this plan

- References, subrecords, and sublists declared on a model load by default. Excluding one is a per-query `exclude()` or `@ExcludeFromDefaultSelect()` on the property. Entity Framework does the opposite (nothing loads without `Include`), but a SuiteQL join costs far less than a second round trip and the declared projection already bounds the width.
- Every relation joins left outer, exactly like EF's Include. A required-means-inner rule was tried and dropped: `lines!: SalesOrderLine[]` silently hiding orders without lines is the wrong default. `@Join('inner')` opts in.
- The fluent API is removed rather than rebuilt on the conventions. Say so if it should stay.
- Query-level typed narrowing (`select` returning a `Pick`) is deferred.
- `@Field` carries both ids because they coincide almost everywhere in NetSuite; the `column` option is the escape hatch for the few standard mismatches the conventions table does not cover.
