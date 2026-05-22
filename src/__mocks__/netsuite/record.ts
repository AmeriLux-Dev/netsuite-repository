export const submitFields = jest.fn<number, [any]>();
export const load = jest.fn<any, [any]>();

export function createMockRecord(overrides: Partial<{
    id: number;
    getValue: jest.Mock;
    setValue: jest.Mock;
    getSublistValue: jest.Mock;
    setSublistValue: jest.Mock;
    getLineCount: jest.Mock;
    removeLine: jest.Mock;
    save: jest.Mock;
    getSubrecord: jest.Mock;
}> = {}) {
    const mockSubrecord = { setValue: jest.fn() };
    return {
        id: overrides.id ?? 1,
        getValue: overrides.getValue ?? jest.fn().mockReturnValue(null),
        setValue: overrides.setValue ?? jest.fn(),
        getSublistValue: overrides.getSublistValue ?? jest.fn().mockReturnValue(null),
        setSublistValue: overrides.setSublistValue ?? jest.fn(),
        getLineCount: overrides.getLineCount ?? jest.fn().mockReturnValue(0),
        removeLine: overrides.removeLine ?? jest.fn(),
        save: overrides.save ?? jest.fn().mockReturnValue(overrides.id ?? 1),
        getSubrecord: overrides.getSubrecord ?? jest.fn().mockReturnValue(mockSubrecord),
    };
}
