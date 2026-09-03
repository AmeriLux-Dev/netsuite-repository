export const trimText = (value: unknown): unknown => (typeof value === 'string' ? value.trim() : value);
export const uppercaseText = (value: unknown): unknown => (typeof value === 'string' ? value.toUpperCase() : value);
