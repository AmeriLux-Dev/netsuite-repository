/**
 * Typed field references for queries. A `FieldPath<T>` is every property of the model plus every dotted path
 * into its references, subrecords, and sublists (`'customer.companyName'`, `'lines.item.type'`), so a typo in a
 * `where()` or `orderBy()` is a compile error. Aliases declared per query (`selectFormula`) widen the accepted
 * paths on the builder that declared them.
 *
 * The declared type of the property behind a path narrows the condition too: `OperatorFor` keeps the SQL-style
 * operators that make sense for it (no `BETWEEN` on text, no `LIKE` on a number) and `ParamFor` the values it
 * compares to. Any N/query operator name is accepted on any path; NetSuite validates those itself.
 */
import type { ConditionParamValue, NQueryOperatorName, QueryOperator } from './types';

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

/** What a query method accepts as a field: a model path or an alias this builder declared. */
export type FieldReference<T, TDeclared extends string = never> = FieldPath<T> | TDeclared;

/**
 * The declared type of the property a field path points at, arrays unwrapped along the way (`'lines.quantity'` on
 * a sales order is the line's `quantity`). `unknown` for a path the model does not know: a declared alias.
 */
export type FieldValue<T, TPath> = unknown extends T
    ? unknown
    : TPath extends `${infer THead}.${infer TRest}`
        ? THead extends keyof T ? FieldValue<Unwrap<T[THead]>, TRest> : unknown
        : TPath extends keyof T ? T[TPath] : unknown;

export type EqualityOperator = '=' | '!=' | '<>';
export type ComparisonOperator = '>' | '>=' | '<' | '<=';
export type PatternOperator = 'LIKE' | 'NOT LIKE';
export type MembershipOperator = 'IN' | 'NOT IN';
export type NullOperator = 'IS NULL' | 'IS NOT NULL';

/** Text compares for equality, by pattern, and by membership. */
export type TextOperator = EqualityOperator | PatternOperator | MembershipOperator | NullOperator | NQueryOperatorName;
/** Numbers compare for equality, by order, by membership, and by range. */
export type NumericOperator = EqualityOperator | ComparisonOperator | MembershipOperator | NullOperator | 'BETWEEN' | NQueryOperatorName;
/** Dates compare for equality, by order, and by range. */
export type DateOperator = EqualityOperator | ComparisonOperator | NullOperator | 'BETWEEN' | NQueryOperatorName;
/** A checkbox is set or not. */
export type BooleanOperator = EqualityOperator | NullOperator | NQueryOperatorName;

/** The operators that make sense for a property of the given declared type; every operator when the type is unknown. */
export type OperatorFor<TValue> = unknown extends TValue
    ? QueryOperator
    : [NonNullable<TValue>] extends [boolean]
        ? BooleanOperator
        : [NonNullable<TValue>] extends [number]
            ? NumericOperator
            : [NonNullable<TValue>] extends [Date]
                ? DateOperator
                : [NonNullable<TValue>] extends [string]
                    ? TextOperator
                    : QueryOperator;

/**
 * What a condition binds for a property of the given declared type. A checkbox takes a boolean or NetSuite's own
 * `'T'`/`'F'`; a date takes a `Date`. An unknown type takes any condition value.
 * `null` is never a comparison value: use `whereNull()` and `whereNotNull()`.
 */
export type ParamFor<TValue> = unknown extends TValue
    ? ConditionParamValue
    : [NonNullable<TValue>] extends [boolean]
        ? boolean | 'T' | 'F'
        : [NonNullable<TValue>] extends [number]
            ? number
            : [NonNullable<TValue>] extends [Date]
                ? Date
                : [NonNullable<TValue>] extends [string]
                    ? string
                    : ConditionParamValue;

/** The value argument a condition takes: none for the null checks, a list for IN, a pair for BETWEEN, one value otherwise. */
export type ConditionValue<TValue, TOperator extends QueryOperator> = TOperator extends NullOperator | 'EMPTY' | 'EMPTY_NOT'
    ? undefined
    : TOperator extends MembershipOperator
        ? ParamFor<TValue>[]
        : TOperator extends 'BETWEEN'
            ? [ParamFor<TValue>, ParamFor<TValue>]
            : TOperator extends NQueryOperatorName
                ? ParamFor<TValue> | ParamFor<TValue>[]
                : ParamFor<TValue>;

/** The field paths of `T` whose declared type accepts the operator. */
export type FieldPathFor<T, TOperator extends QueryOperator> = {
    [P in FieldPath<T>]: TOperator extends OperatorFor<FieldValue<T, P>> ? P : never;
}[FieldPath<T>];

/** A field reference restricted to the paths that accept the operator; declared aliases always qualify. */
export type FieldReferenceFor<T, TDeclared extends string, TOperator extends QueryOperator> = FieldPathFor<T, TOperator> | TDeclared;
