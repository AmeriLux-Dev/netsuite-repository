import { normalizeQueryConfig } from '../types';
import type { QueryConfig, QueryConfigInput } from '../types';
import { configFromEntity, isEntityClass } from './decorators';
import type { EntityClass } from './decorators';
import { isEntityModelDefinition } from './fluent';
import type { EntityModelDefinition } from './fluent';

/** Anything the runtime accepts where a model is expected: a raw config, a sectioned config, a decorated class, or a fluent definition. */
export type QueryConfigSource<TResult = unknown, TFieldMeta = unknown> =
    | QueryConfig<TResult, TFieldMeta>
    | QueryConfigInput<TResult, TFieldMeta>
    | EntityClass<TResult>
    | EntityModelDefinition<TResult>;

/** Infers the result type from any QueryConfigSource. */
export type QueryConfigSourceResult<TSource> =
    TSource extends EntityClass<infer TEntity> ? TEntity
    : TSource extends EntityModelDefinition<infer TDefined> ? TDefined
    : TSource extends QueryConfig<infer TResult, any> | QueryConfigInput<infer TResult, any> ? TResult
    : never;

/** Resolves any QueryConfigSource to a normalized QueryConfig. */
export function resolveQueryConfig<TResult, TFieldMeta = unknown>(source: QueryConfigSource<TResult, TFieldMeta>): QueryConfig<TResult, TFieldMeta> {
    if (isEntityClass(source)) {
        return configFromEntity(source as EntityClass<TResult>) as QueryConfig<TResult, TFieldMeta>;
    }
    if (isEntityModelDefinition(source)) {
        return source.compile() as QueryConfig<TResult, TFieldMeta>;
    }
    return normalizeQueryConfig(source as QueryConfig<TResult, TFieldMeta> | QueryConfigInput<TResult, TFieldMeta>);
}
