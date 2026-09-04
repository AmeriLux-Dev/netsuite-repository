/**
 * Typed field references for queries. A `FieldPath<T>` is every property of the model plus every dotted path
 * into its references, subrecords, and sublists (`'customer.companyName'`, `'lines.item.type'`), so a typo in a
 * `where()` or `orderBy()` is a compile error. Aliases declared per query (`leftJoin`, `selectRaw`) widen the
 * accepted paths on the builder that declared them; anything else goes through `raw()`.
 */

type Primitive = string | number | boolean | bigint | symbol | Date | null | undefined;

/** The element type of an array, else the type itself, with null and undefined stripped. */
type Unwrap<T> = NonNullable<T> extends ReadonlyArray<infer TElement> ? TElement : NonNullable<T>;

type Shorter = [never, 0, 1, 2, 3, 4];

/** Every field and dotted relation path of `T`, up to five segments deep. `string` when `T` is unknown. */
export type FieldPath<T, TDepth extends number = 5> = unknown extends T
    ? string
    : TDepth extends 0
        ? never
        : {
            [K in keyof T & string]: Unwrap<T[K]> extends Primitive
                ? K
                : Unwrap<T[K]> extends object
                    ? K | `${K}.${FieldPath<Unwrap<T[K]>, Shorter[TDepth]>}`
                    : K;
        }[keyof T & string];

/** The properties of `T` that are references, subrecords, or sublists. `string` when `T` is unknown. */
export type RelationName<T> = unknown extends T
    ? string
    : { [K in keyof T & string]: Unwrap<T[K]> extends Primitive ? never : Unwrap<T[K]> extends object ? K : never }[keyof T & string];

declare const rawFieldBrand: unique symbol;

/** A column or alias reference the model does not know about, produced by raw(). */
export type RawFieldReference = string & { readonly [rawFieldBrand]: true };

/** Marks a field reference the type checker cannot verify: an alias from a hand-written join, or a column of one. */
export function raw(reference: string): RawFieldReference {
    return reference as RawFieldReference;
}

/** What a query method accepts as a field: a model path, an alias this builder declared, or a raw() reference. */
export type FieldReference<T, TDeclared extends string = never> = FieldPath<T> | TDeclared | RawFieldReference;
