import { QueryBuilder } from '../query';
import { customerConfig } from './fixtures';
import * as NsQuery from 'N/query';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;
const mockRunSuiteQLPaged = NsQuery.runSuiteQLPaged as unknown as jest.Mock;

function mockRows(rows: Record<string, unknown>[]) {
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => rows });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('QueryBuilder.build() – OFFSET/FETCH pagination', () => {
    it('emits no pagination clause without limit or offset', () => {
        const { sql } = QueryBuilder.from(customerConfig).build();
        expect(sql).not.toContain('OFFSET');
        expect(sql).not.toContain('TOP');
    });

    it('emits OFFSET without FETCH when only an offset is set', () => {
        const { sql } = QueryBuilder.from(customerConfig).offset(5).build();
        expect(sql).toContain('OFFSET 5 ROWS');
        expect(sql).not.toContain('FETCH NEXT');
    });

    it('places the pagination clause after ORDER BY', () => {
        const { sql } = QueryBuilder.from(customerConfig).orderByAsc('name').page(2, 10).build();
        expect(sql.indexOf('ORDER BY')).toBeLessThan(sql.indexOf('OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY'));
    });

    it('does not slice rows client-side in offsetFetch mode', () => {
        mockRows([{ id: 1 }, { id: 2 }]);
        const result = QueryBuilder.from(customerConfig).limit(2).offset(1).execute();
        expect(result.data).toHaveLength(2);
    });

    it('first() with an offset asks for one row after the offset', () => {
        mockRows([{ id: 4 }]);
        QueryBuilder.from(customerConfig).offset(3).first();
        expect(mockRunSuiteQL).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.stringContaining('OFFSET 3 ROWS FETCH NEXT 1 ROWS ONLY') })
        );
    });
});

describe('QueryBuilder.pagination() – top mode', () => {
    it('emits TOP offset+limit and no OFFSET clause', () => {
        const { sql } = QueryBuilder.from(customerConfig).pagination('top').limit(10).offset(20).build();
        expect(sql).toContain('TOP 30');
        expect(sql).not.toContain('OFFSET');
    });

    it('emits no TOP clause without a limit', () => {
        const { sql } = QueryBuilder.from(customerConfig).pagination('top').offset(20).build();
        expect(sql).not.toContain('TOP');
        expect(sql).not.toContain('OFFSET');
    });

    it('does not slice when no offset is set', () => {
        mockRows([{ id: 1 }, { id: 2 }]);
        const result = QueryBuilder.from(customerConfig).pagination('top').limit(2).execute();
        expect(result.data).toHaveLength(2);
    });
});

describe('QueryBuilder.executePaged() – pagination clauses', () => {
    it('emits neither TOP nor OFFSET in offsetFetch mode', () => {
        mockRunSuiteQLPaged.mockReturnValue({});
        QueryBuilder.from(customerConfig).page(2, 10).executePaged({ pageSize: 50 });
        const passedQuery = mockRunSuiteQLPaged.mock.calls[0][0].query as string;
        expect(passedQuery).not.toContain('OFFSET');
        expect(passedQuery).not.toContain('TOP');
    });

    it('emits neither TOP nor OFFSET in top mode', () => {
        mockRunSuiteQLPaged.mockReturnValue({});
        QueryBuilder.from(customerConfig).pagination('top').page(2, 10).executePaged();
        const passedQuery = mockRunSuiteQLPaged.mock.calls[0][0].query as string;
        expect(passedQuery).not.toContain('OFFSET');
        expect(passedQuery).not.toContain('TOP');
    });
});
