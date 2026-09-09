import type { ConditionNode, ConditionParamValue, NQueryOperatorName } from '../types';
import type { TranslatedCondition } from './operator-translation';

/**
 * Builds the condition node for a translated operator: one node, or, when the translation applies its operator per
 * value, one node per value combined the way the translation says.
 */
export function conditionNodeForTranslation(translated: TranslatedCondition, makeNode: (operator: NQueryOperatorName, values: ConditionParamValue[] | undefined) => ConditionNode): ConditionNode {
    if (!translated.combine || !translated.values) {
        return makeNode(translated.operator, translated.values);
    }
    const nodes = translated.values.map((value) => makeNode(translated.operator, [value]));
    return nodes.length === 1 ? nodes[0] : { kind: translated.combine, nodes };
}

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

