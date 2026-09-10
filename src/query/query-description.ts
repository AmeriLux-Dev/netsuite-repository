import type { ComponentCondition, ComponentJoin, ConditionNode, ConditionParamValue, DescribedColumn, DescribedSort, QueryDescription } from '../types';

/**
 * Renders a query description as stable, readable text: one clause per line, relation paths as the model names
 * them. It is what tests assert on and what the fake N/query records; it is not SQL and never executes.
 */
export function renderQueryDescription(description: QueryDescription, indent = ''): string {
    const lines: string[] = [`FROM ${description.queryType}`];
    for (const component of description.components) {
        const conditions = component.conditions.length > 0 ? ` WHERE ${component.conditions.map((condition) => renderComponentCondition(component.path, condition)).join(' AND ')}` : '';
        lines.push(`JOIN ${renderComponentJoin(component.join)} AS ${component.path}${conditions}`);
    }
    lines.push(`SELECT ${description.columns.map(renderDescribedColumn).join(', ')}`);
    if (description.condition) {
        lines.push(`WHERE ${renderConditionNode(description.condition, true)}`);
    }
    if (description.sort.length > 0) {
        lines.push(`ORDER BY ${description.sort.map(renderDescribedSort).join(', ')}`);
    }
    if (description.page) {
        lines.push(`PAGE offset ${description.page.offset}${description.page.limit === undefined ? '' : ` limit ${description.page.limit}`}`);
    }
    for (const load of description.separateLoads ?? []) {
        lines.push(`SEPARATE ${load.relationship} BY ${load.batchFieldId}:`);
        lines.push(renderQueryDescription(load.description, `${indent}    `));
    }
    return lines.map((line) => `${indent}${line}`).join('\n');
}

function renderComponentJoin(join: ComponentJoin): string {
    if (join.kind === 'to') return `to ${join.target} ON ${join.fieldId}`;
    if (join.kind === 'from') return `from ${join.source}.${join.fieldId}`;
    return `auto ${join.fieldId}`;
}

function renderComponentCondition(path: string, condition: ComponentCondition): string {
    return `${path}.${condition.fieldId} ${condition.operator}${renderValues(condition.values)}`;
}

function renderDescribedColumn(column: DescribedColumn): string {
    const source = column.formula !== undefined
        ? `formula(${column.formula})${column.formulaType ? `:${column.formulaType}` : ''}`
        : `${column.component ? `${column.component}.` : ''}${column.fieldId}${column.context ? `#${column.context}` : ''}`;
    const aggregated = column.aggregate ? `${column.aggregate}(${source})` : source;
    return `${aggregated} AS ${column.alias}`;
}

function renderDescribedSort(sort: DescribedSort): string {
    const source = sort.formula !== undefined
        ? `formula(${sort.formula})`
        : `${sort.component ? `${sort.component}.` : ''}${sort.fieldId}${sort.context ? `#${sort.context}` : ''}`;
    return `${source} ${sort.ascending ? 'ASC' : 'DESC'}${sort.nullsLast === undefined ? '' : sort.nullsLast ? ' NULLS LAST' : ' NULLS FIRST'}`;
}

/** Renders a condition tree with SQL precedence made explicit: nested groups are parenthesized, the top level is not. */
export function renderConditionNode(node: ConditionNode, topLevel = false): string {
    switch (node.kind) {
        case 'field':
            return `${node.component ? `${node.component}.` : ''}${node.fieldId} ${node.operator}${renderValues(node.values)}`;
        case 'formula':
            return `formula(${node.formula})${node.type ? `:${node.type}` : ''}${node.operator ? ` ${node.operator}${renderValues(node.values)}` : ''}`;
        case 'not':
            return `NOT (${renderConditionNode(node.node, true)})`;
        default: {
            const inner = node.nodes.map((child) => renderConditionNode(child)).join(` ${node.kind.toUpperCase()} `);
            return topLevel ? inner : `(${inner})`;
        }
    }
}

function renderValues(values: ConditionParamValue[] | undefined): string {
    return values === undefined ? '' : ` [${values.map(renderValue).join(', ')}]`;
}

function renderValue(value: ConditionParamValue): string {
    if (value instanceof Date) return renderDate(value);
    return typeof value === 'string' ? `'${value}'` : String(value);
}

/** A Date in the account's local calendar, with the time only when it is not midnight. */
export function renderDate(value: Date): string {
    const twoDigits = (part: number): string => (part < 10 ? '0' : '') + part;
    const date = `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
    const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
    return hasTime ? `${date} ${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}:${twoDigits(value.getSeconds())}` : date;
}
