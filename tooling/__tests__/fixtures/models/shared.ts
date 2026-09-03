export const MAIN_LINE_FILTER = "tl.transaction = txn.id AND tl.mainline = 'F'";

export function trimText(value: unknown): unknown {
    return typeof value === 'string' ? value.trim() : value;
}
