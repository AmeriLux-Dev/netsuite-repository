import type * as NsQuery from 'N/query';
import type { ComponentJoin, ConditionNode, DescribedColumn, DescribedSort, FieldConditionNode, QueryDescription } from '../types';

export type NQueryModule = typeof import('N/query');

type ConditionOptions = Parameters<NsQuery.Query['createCondition']>[0];
type ColumnOptions = Parameters<NsQuery.Query['createColumn']>[0];

function omitUndefined<T extends object>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry;
        }
    }
    return result as T;
}

/** Reads an enum member off the loaded N/query module by name, so the library never carries NetSuite's values itself. */
export function resolveNQueryEnumValue(enumObject: object, name: string, enumName: string): string {
    const value = (enumObject as Record<string, string | undefined>)[name];
    if (value === undefined) {
        throw new Error(`N/query has no ${enumName} named '${name}'.`);
    }
    return value;
}

function joinComponent(parent: NsQuery.Component, join: ComponentJoin): NsQuery.Component {
    if (join.kind === 'to') {
        return parent.joinTo({ fieldId: join.fieldId, target: join.target as string });
    }
    if (join.kind === 'from') {
        return parent.joinFrom({ fieldId: join.fieldId, source: join.source as string });
    }
    return parent.autoJoin({ fieldId: join.fieldId });
}

function createColumn(component: NsQuery.Component, column: DescribedColumn, nsQuery: NQueryModule): NsQuery.Column {
    const aggregate = column.aggregate === undefined ? undefined : resolveNQueryEnumValue(nsQuery.Aggregate, column.aggregate, 'Aggregate');
    const context = column.context === undefined ? undefined : resolveNQueryEnumValue(nsQuery.FieldContext, column.context, 'FieldContext');
    if (column.formula !== undefined) {
        const type = column.formulaType === undefined ? undefined : resolveNQueryEnumValue(nsQuery.ReturnType, column.formulaType, 'ReturnType');
        return component.createColumn(omitUndefined({ formula: column.formula, type, alias: column.alias, aggregate, context }) as ColumnOptions);
    }
    return component.createColumn(omitUndefined({ fieldId: column.fieldId, alias: column.alias, aggregate, context }) as ColumnOptions);
}

/**
 * The selected column a sort can reuse: same component, field or formula, and context, and no aggregate. N/query
 * sorts only on one of the query's own columns (a column object outside `query.columns` fails to render, sandbox
 * 2026-09-09), so a sort on a field that is not selected gets a hidden column appended to the query instead.
 */
function selectedColumnForSort(sort: DescribedSort, columns: DescribedColumn[], created: NsQuery.Column[]): NsQuery.Column | undefined {
    const index = columns.findIndex((column) =>
        column.component === sort.component && column.aggregate === undefined && column.context === sort.context
        && (sort.formula !== undefined
            ? column.formula === sort.formula && column.formulaType === sort.formulaType
            : column.formula === undefined && column.fieldId === sort.fieldId));
    return index === -1 ? undefined : created[index];
}

/** The hidden column a sort on an unselected field is given; the mapper reads rows by the model's aliases and never sees it. */
export function hiddenSortColumnAlias(index: number): string {
    return `__sort${index}`;
}

function createSortColumn(component: NsQuery.Component, sort: DescribedSort, alias: string, nsQuery: NQueryModule): NsQuery.Column {
    const context = sort.context === undefined ? undefined : resolveNQueryEnumValue(nsQuery.FieldContext, sort.context, 'FieldContext');
    if (sort.formula !== undefined) {
        const type = sort.formulaType === undefined ? undefined : resolveNQueryEnumValue(nsQuery.ReturnType, sort.formulaType, 'ReturnType');
        return component.createColumn(omitUndefined({ formula: sort.formula, type, alias }) as ColumnOptions);
    }
    return component.createColumn(omitUndefined({ fieldId: sort.fieldId, context, alias }) as ColumnOptions);
}

/** Every component's declared conditions, as field nodes on that component. */
function componentConditionNodes(description: QueryDescription): FieldConditionNode[] {
    return description.components.flatMap((component) => component.conditions.map((condition) => omitUndefined({
        kind: 'field' as const,
        component: component.path,
        fieldId: condition.fieldId,
        operator: condition.operator,
        values: condition.values,
    })));
}

/**
 * Builds the N/query Query object a description asks for: the root type, every joined component in parent-first
 * order, the columns with their aliases and contexts, the condition tree (declared component conditions ANDed
 * in front of the query's own), and the sorts. Enum values are read off the module by name.
 */
export function compileQueryDescriptionToNQuery(description: QueryDescription, nsQuery: NQueryModule): NsQuery.Query {
    const query = nsQuery.create({ type: description.queryType });
    const components = new Map<string, NsQuery.Component>();
    const componentAt = (path: string | undefined): NsQuery.Component => {
        if (path === undefined) {
            return query.root;
        }
        const component = components.get(path);
        if (!component) {
            throw new Error(`Component '${path}' is not joined in the query for '${description.queryType}'.`);
        }
        return component;
    };

    for (const component of description.components) {
        components.set(component.path, joinComponent(componentAt(component.parent), component.join));
    }

    const columns = description.columns.map((column) => createColumn(componentAt(column.component), column, nsQuery));

    const compileConditionNode = (node: ConditionNode): NsQuery.Condition => {
        switch (node.kind) {
            case 'field':
                return componentAt(node.component).createCondition(omitUndefined({
                    fieldId: node.fieldId,
                    operator: resolveNQueryEnumValue(nsQuery.Operator, node.operator, 'Operator'),
                    values: node.values,
                }) as ConditionOptions);
            case 'formula':
                return query.createCondition(omitUndefined({
                    formula: node.formula,
                    type: node.type === undefined ? undefined : resolveNQueryEnumValue(nsQuery.ReturnType, node.type, 'ReturnType'),
                    operator: node.operator === undefined ? undefined : resolveNQueryEnumValue(nsQuery.Operator, node.operator, 'Operator'),
                    values: node.values,
                }) as ConditionOptions);
            case 'not':
                return query.not(compileConditionNode(node.node));
            default: {
                const children = node.nodes.map(compileConditionNode);
                return children.length === 1 ? children[0] : node.kind === 'and' ? query.and(...children) : query.or(...children);
            }
        }
    };

    const conditionNodes: ConditionNode[] = [...componentConditionNodes(description), ...(description.condition ? [description.condition] : [])];
    if (conditionNodes.length > 0) {
        query.condition = compileConditionNode(conditionNodes.length === 1 ? conditionNodes[0] : { kind: 'and', nodes: conditionNodes });
    }

    const hiddenSortColumns: NsQuery.Column[] = [];
    const sorts = description.sort.map((sort) => {
        const component = componentAt(sort.component);
        let column = selectedColumnForSort(sort, description.columns, columns);
        if (column === undefined) {
            column = createSortColumn(component, sort, hiddenSortColumnAlias(hiddenSortColumns.length), nsQuery);
            hiddenSortColumns.push(column);
        }
        return component.createSort(omitUndefined({ column, ascending: sort.ascending, nullsLast: sort.nullsLast }));
    });
    query.columns = [...columns, ...hiddenSortColumns];
    query.sort = sorts;

    return query;
}
