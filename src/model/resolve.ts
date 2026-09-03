import { normalizeQueryConfig } from '../types';
import type { QueryConfig, QueryConfigInput } from '../types';

/** What the runtime accepts where a model is expected: a generated (or hand-written) config, plain or sectioned. */
export type QueryConfigSource<TResult = unknown, TFieldMeta = unknown> =
    | QueryConfig<TResult, TFieldMeta>
    | QueryConfigInput<TResult, TFieldMeta>;

/** Infers the result type from any QueryConfigSource. */
export type QueryConfigSourceResult<TSource> =
    TSource extends QueryConfig<infer TResult, any> | QueryConfigInput<infer TResult, any> ? TResult : never;

/** Resolves any QueryConfigSource to a normalized QueryConfig. */
export function resolveQueryConfig<TResult, TFieldMeta = unknown>(source: QueryConfigSource<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    return normalizeQueryConfig(source);
}
