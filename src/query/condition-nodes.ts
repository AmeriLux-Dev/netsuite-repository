import type { ConditionNode } from '../types';

/** A condition and how it links to the one before it. */
export interface LinkedCondition {
    node: ConditionNode;
    link: 'AND' | 'OR';
}

/** Folds a flat list of AND/OR-linked conditions with SQL precedence: AND binds tighter than OR. */
export function combineConditions(conditions: LinkedCondition[]): ConditionNode | undefined {
    if (conditions.length === 0) {
        return undefined;
    }
    const orGroups: ConditionNode[][] = [[conditions[0].node]];
    for (const condition of conditions.slice(1)) {
        if (condition.link === 'OR') {
            orGroups.push([condition.node]);
        } else {
            orGroups[orGroups.length - 1].push(condition.node);
        }
    }
    const andNodes = orGroups.map((group) => (group.length === 1 ? group[0] : { kind: 'and' as const, nodes: group }));
    return andNodes.length === 1 ? andNodes[0] : { kind: 'or', nodes: andNodes };
}

export function collectConditionComponents(node: ConditionNode, into: Set<string>): void {
    if (node.kind === 'field') {
        if (node.component !== undefined) into.add(node.component);
    } else if (node.kind === 'not') {
        collectConditionComponents(node.node, into);
    } else if (node.kind !== 'formula') {
        node.nodes.forEach((child) => collectConditionComponents(child, into));
    }
}

/** Moves a condition tree onto a query rooted at `relationPath`: that component becomes the root, deeper paths keep their names. */
export function rerootConditionNode(node: ConditionNode, relationPath: string): ConditionNode {
    if (node.kind === 'field') {
        return node.component === relationPath ? { ...node, component: undefined } : node;
    }
    if (node.kind === 'not') {
        return { kind: 'not', node: rerootConditionNode(node.node, relationPath) };
    }
    if (node.kind === 'formula') {
        return node;
    }
    return { kind: node.kind, nodes: node.nodes.map((child) => rerootConditionNode(child, relationPath)) };
}

