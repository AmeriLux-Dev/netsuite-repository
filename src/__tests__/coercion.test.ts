import { coerceQueryResultValueByFieldType } from '../coercion';
import * as NsFormat from 'N/format';

const mockParse = NsFormat.parse as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('coerceQueryResultValueByFieldType() – passthrough', () => {
    it('returns null for null values', () => {
        expect(coerceQueryResultValueByFieldType(null, 'integer')).toBeNull();
    });

    it('returns null for undefined values', () => {
        expect(coerceQueryResultValueByFieldType(undefined as unknown as null, 'integer')).toBeNull();
    });

    it('returns the value unchanged when no type is declared', () => {
        expect(coerceQueryResultValueByFieldType('12', undefined)).toBe('12');
    });

    it('returns the value unchanged for string-like types', () => {
        expect(coerceQueryResultValueByFieldType('12', 'string')).toBe('12');
        expect(coerceQueryResultValueByFieldType('12', 'select')).toBe('12');
        expect(coerceQueryResultValueByFieldType('1,2', 'multiselect')).toBe('1,2');
    });
});

describe('coerceQueryResultValueByFieldType() – numeric types', () => {
    it('converts numeric strings for integer, float, currency, and key', () => {
        expect(coerceQueryResultValueByFieldType('12', 'integer')).toBe(12);
        expect(coerceQueryResultValueByFieldType(' 10.5 ', 'float')).toBe(10.5);
        expect(coerceQueryResultValueByFieldType('99.99', 'currency')).toBe(99.99);
        expect(coerceQueryResultValueByFieldType('123', 'key')).toBe(123);
    });

    it('leaves non-numeric strings unchanged', () => {
        expect(coerceQueryResultValueByFieldType('ABC-1', 'key')).toBe('ABC-1');
        expect(coerceQueryResultValueByFieldType('', 'integer')).toBe('');
    });

    it('leaves numbers unchanged', () => {
        expect(coerceQueryResultValueByFieldType(7, 'integer')).toBe(7);
    });
});

describe('coerceQueryResultValueByFieldType() – boolean types', () => {
    it('converts NetSuite T/F flags and true/false strings', () => {
        expect(coerceQueryResultValueByFieldType('T', 'boolean')).toBe(true);
        expect(coerceQueryResultValueByFieldType('true', 'checkbox')).toBe(true);
        expect(coerceQueryResultValueByFieldType('F', 'boolean')).toBe(false);
        expect(coerceQueryResultValueByFieldType(' FALSE ', 'checkbox')).toBe(false);
    });

    it('leaves other strings and booleans unchanged', () => {
        expect(coerceQueryResultValueByFieldType('yes', 'boolean')).toBe('yes');
        expect(coerceQueryResultValueByFieldType(true, 'boolean')).toBe(true);
    });
});

describe('coerceQueryResultValueByFieldType() – date types', () => {
    it('parses date strings through N/format with the DATE type', () => {
        const parsed = new Date(2024, 0, 15);
        mockParse.mockReturnValue(parsed);
        expect(coerceQueryResultValueByFieldType('1/15/2024', 'date')).toBe(parsed);
        expect(mockParse).toHaveBeenCalledWith({ value: '1/15/2024', type: NsFormat.Type.DATE });
    });

    it('parses datetime strings through N/format with the DATETIME type', () => {
        const parsed = new Date(2024, 0, 15, 10, 30);
        mockParse.mockReturnValue(parsed);
        expect(coerceQueryResultValueByFieldType('1/15/2024 10:30 am', 'datetime')).toBe(parsed);
        expect(mockParse).toHaveBeenCalledWith({ value: '1/15/2024 10:30 am', type: NsFormat.Type.DATETIME });
    });

    it('returns the raw string when N/format returns an invalid date', () => {
        mockParse.mockReturnValue(new Date('not a date'));
        expect(coerceQueryResultValueByFieldType('garbage', 'date')).toBe('garbage');
    });

    it('returns the raw string when N/format returns a non-date', () => {
        mockParse.mockReturnValue('1/15/2024');
        expect(coerceQueryResultValueByFieldType('1/15/2024', 'date')).toBe('1/15/2024');
    });

    it('returns the raw string when N/format throws', () => {
        mockParse.mockImplementation(() => {
            throw new Error('unsupported');
        });
        expect(coerceQueryResultValueByFieldType('1/15/2024', 'date')).toBe('1/15/2024');
    });

    it('leaves non-string and empty values unchanged', () => {
        expect(coerceQueryResultValueByFieldType(20240115, 'date')).toBe(20240115);
        expect(coerceQueryResultValueByFieldType('  ', 'date')).toBe('  ');
        expect(mockParse).not.toHaveBeenCalled();
    });
});
