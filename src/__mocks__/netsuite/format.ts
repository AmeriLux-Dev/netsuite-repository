export enum Type {
    DATE = 'date',
    DATETIME = 'datetime',
    DATETIMETZ = 'datetimetz',
}

export const parse = jest.fn<any, [any]>();
