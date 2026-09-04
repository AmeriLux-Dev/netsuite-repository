import { raw } from '../field-path';
import { QueryBuilder } from '../query';
import { defineQueryConfig } from '../types';
import { customerConfig, orderConfig } from './fixtures';
import * as NsQuery from 'N/query';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;

function mockRows(rows: Record<string, unknown>[]) {
    mockRunSuiteQL.mockReturnValue({ asMappedResults: () => rows });
}

beforeEach(() => {
    jest.clearAllMocks();
});

const entityKeys = { sourceForeignKey: 'entity', targetPrimaryKey: 'id' };

describe('QueryBuilder.join() – dynamic joins', () => {
    it('renders an inner join by default with keys read from the root alias', () => {
        const { sql } = QueryBuilder.from(orderConfig).join('customer', 'c', entityKeys).build();
        expect(sql).toContain('INNER JOIN customer c ON txn.entity = c.id');
    });

    it('renders config joins before dynamic joins', () => {
        const { sql } = QueryBuilder.from(orderConfig).leftJoin('customer', 'c', entityKeys).build();
        expect(sql.indexOf('transactionline tl')).toBeLessThan(sql.indexOf('customer c'));
    });

    it('innerJoin, leftJoin, and rightJoin set the join type', () => {
        const inner = QueryBuilder.from(customerConfig).innerJoin('subsidiary', 's', { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'id' }).build().sql;
        const left = QueryBuilder.from(customerConfig).leftJoin('subsidiary', 's', { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'id' }).build().sql;
        const right = QueryBuilder.from(customerConfig).rightJoin('subsidiary', 's', { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'id' }).build().sql;
        expect(inner).toContain('INNER JOIN subsidiary s ON cust.subsidiary = s.id');
        expect(left).toContain('LEFT OUTER JOIN subsidiary s ON cust.subsidiary = s.id');
        expect(right).toContain('RIGHT OUTER JOIN subsidiary s ON cust.subsidiary = s.id');
    });

    it('joins several key pairs with AND', () => {
        const { sql } = QueryBuilder.from(orderConfig)
            .join('customer', 'c', [entityKeys, { sourceForeignKey: 'subsidiary', targetPrimaryKey: 'subsidiary' }])
            .build();
        expect(sql).toContain('ON txn.entity = c.id AND txn.subsidiary = c.subsidiary');
    });

    it('reads keys from another alias with the from option', () => {
        const { sql } = QueryBuilder.from(orderConfig)
            .leftJoin('item', 'itm', { sourceForeignKey: 'item', targetPrimaryKey: 'id' }, { from: 'tl' })
            .build();
        expect(sql).toContain('LEFT OUTER JOIN item itm ON tl.item = itm.id');
    });

    it('renders a raw predicate and binds its parameters before WHERE parameters', () => {
        const built = QueryBuilder.from(customerConfig)
            .leftJoin('transaction', 't', 't.entity = cust.id AND t.mainline = ?', { params: ['F'] })
            .where('id', '=', 7)
            .build();
        expect(built.sql).toContain("LEFT OUTER JOIN transaction t ON t.entity = cust.id AND t.mainline = ?");
        expect(built.params).toEqual(['F', 7]);
    });

    it('binds join parameters in count() and exists()', () => {
        mockRows([{ count: 1 }]);
        const builder = QueryBuilder.from(customerConfig)
            .leftJoin('transaction', 't', 't.entity = cust.id AND t.type = ?', { params: ['SalesOrd'] })
            .where('id', '>', 1);
        builder.count();
        builder.exists();
        expect(mockRunSuiteQL).toHaveBeenNthCalledWith(1, expect.objectContaining({ params: ['SalesOrd', 1] }));
        expect(mockRunSuiteQL).toHaveBeenNthCalledWith(2, expect.objectContaining({ params: ['SalesOrd', 1] }));
    });

    it('throws when the raw predicate placeholder count differs from the parameter count', () => {
        expect(() => QueryBuilder.from(customerConfig).join('transaction', 't', 't.entity = cust.id AND t.type = ?')).toThrow(
            "Join 't' declares 1 placeholder(s) but received 0 parameter(s)."
        );
    });

    it('throws when parameters are given with key pairs', () => {
        expect(() => QueryBuilder.from(customerConfig).join('transaction', 't', entityKeys, { params: ['x'] })).toThrow(
            "Join 't' only accepts parameters with a raw predicate."
        );
    });

    it('throws when the key pair list is empty', () => {
        expect(() => QueryBuilder.from(customerConfig).join('transaction', 't', [])).toThrow("Join 't' requires at least one key pair.");
    });

    it('throws when the alias collides with the root alias, a config join, or a dynamic join', () => {
        expect(() => QueryBuilder.from(orderConfig).join('customer', 'txn', entityKeys)).toThrow("Join alias 'txn' is already used in the query for 'salesorder'.");
        expect(() => QueryBuilder.from(orderConfig).join('customer', 'tl', entityKeys)).toThrow("Join alias 'tl' is already used");
        expect(() => QueryBuilder.from(orderConfig).join('customer', 'c', entityKeys).join('customer', 'c', entityKeys)).toThrow("Join alias 'c' is already used");
    });
});

describe('QueryBuilder.where() and orderBy() – alias-qualified columns', () => {
    it('accepts alias.column for the root alias, config joins, and dynamic joins', () => {
        const built = QueryBuilder.from(orderConfig)
            .leftJoin('customer', 'c', entityKeys)
            .where('c.companyname', 'LIKE', 'Acme%')
            .where(raw('tl.mainline'), '=', 'F')
            .orderByDesc(raw('txn.trandate'))
            .build();
        expect(built.sql).toContain('WHERE c.companyname LIKE ? AND tl.mainline = ?');
        expect(built.sql).toContain('ORDER BY txn.trandate DESC');
        expect(built.params).toEqual(['Acme%', 'F']);
    });

    it('accepts dynamic join aliases inside whereGroup()', () => {
        const built = QueryBuilder.from(orderConfig)
            .leftJoin('customer', 'c', entityKeys)
            .whereGroup((group) => group.where('c.companyname', '=', 'Acme').orWhere('c.email', 'IS NULL'))
            .build();
        expect(built.sql).toContain('WHERE (c.companyname = ? OR c.email IS NULL)');
        expect(built.params).toEqual(['Acme']);
    });

    it('does not double-bind join parameters through whereGroup()', () => {
        const built = QueryBuilder.from(customerConfig)
            .leftJoin('transaction', 't', 't.entity = cust.id AND t.type = ?', { params: ['SalesOrd'] })
            .whereGroup((group) => group.where('id', '=', 1).orWhere('id', '=', 2))
            .build();
        expect(built.params).toEqual(['SalesOrd', 1, 2]);
    });

    it('still rejects unknown aliases and unknown fields', () => {
        expect(() => QueryBuilder.from(orderConfig).where(raw('nope.column'), '=', 1)).toThrow("Field 'nope.column' is not defined in query config for 'salesorder'.");
        expect(() => QueryBuilder.from(orderConfig).orderBy(raw('.column'))).toThrow("Field '.column' is not defined");
    });
});

describe('QueryBuilder.selectRaw() – computed columns', () => {
    it('renders the expression in SELECT and includes it in the field map', () => {
        const built = QueryBuilder.from(customerConfig).selectRaw('UPPER(cust.companyname)', 'upperName').build();
        expect(built.sql).toContain('UPPER(cust.companyname) AS "upperName"');
        expect(built.fieldMap.uppername.key).toBe('upperName');
    });

    it('maps the computed column onto typed results, with coercion and transform options', () => {
        mockRows([{ id: 1, name: 'Acme', email: '', isactive: 'F', score: '1', total: '12.5' }]);
        const results = QueryBuilder.from(customerConfig)
            .selectRaw('SUM(t.amount)', 'total', { type: 'currency', coerce: true, transform: (value) => (value as number) * 2 })
            .executeTyped();
        expect((results[0] as unknown as { total: number }).total).toBe(25);
    });

    it('supports nestPath on computed columns', () => {
        mockRows([{ id: 1, name: 'Acme', email: '', isactive: 'F', score: 1, ordercount: 3 }]);
        const results = QueryBuilder.from(customerConfig)
            .selectRaw('COUNT(t.id)', 'orderCount', { nestPath: 'stats.orders' })
            .executeTyped();
        expect((results[0] as unknown as { stats: { orders: number } }).stats.orders).toBe(3);
    });

    it('is usable in orderBy() and where() by alias', () => {
        const built = QueryBuilder.from(customerConfig)
            .selectRaw('UPPER(cust.companyname)', 'upperName')
            .where('upperName', 'LIKE', 'A%')
            .orderByAsc('upperName')
            .build();
        expect(built.sql).toContain('WHERE UPPER(cust.companyname) LIKE ?');
        expect(built.sql).toContain('ORDER BY UPPER(cust.companyname) ASC');
    });

    it('is always selected even when select() narrows configured fields', () => {
        const { sql } = QueryBuilder.from(customerConfig).select('name').selectRaw('1', 'one').build();
        expect(sql).toContain('1 AS "one"');
        expect(sql).not.toContain('cust.email');
    });

    it('throws when the alias collides with a configured field or another computed column', () => {
        expect(() => QueryBuilder.from(customerConfig).selectRaw('1', 'name')).toThrow("Alias 'name' is already used by a field in query config for 'customer'.");
        expect(() => QueryBuilder.from(customerConfig).selectRaw('1', 'one').selectRaw('2', 'one')).toThrow("Alias 'one' is already used");
    });
});

describe('QueryBuilder.build() – config joins with raw predicates and expressions', () => {
    const rawJoinConfig = defineQueryConfig<{ id: number; customerName: string; label: string }>({
        recordType: 'salesorder',
        query: {
            from: { name: 'transaction', alias: 'txn' },
            joins: [{
                toTable: { name: 'customer', alias: 'c' },
                fromTable: 'txn',
                type: 'leftOuter',
                on: 'c.id = txn.entity AND c.isinactive = ?',
                params: ['F'],
            }],
        },
        fields: {
            id: { queryFieldId: 'id', tableAlias: 'txn', type: 'integer', isPrimary: true },
            customerName: { queryFieldId: 'companyname', tableAlias: 'c', type: 'string' },
            label: { queryFieldId: 'label', tableAlias: 'txn', expression: "txn.tranid || ' / ' || c.companyname" },
        },
    });

    it('renders the raw predicate verbatim and binds its parameters first', () => {
        const built = QueryBuilder.from(rawJoinConfig).where('id', '=', 9).build();
        expect(built.sql).toContain('LEFT OUTER JOIN customer c ON c.id = txn.entity AND c.isinactive = ?');
        expect(built.params).toEqual(['F', 9]);
    });

    it('renders a configured expression in SELECT, WHERE, and ORDER BY', () => {
        const built = QueryBuilder.from(rawJoinConfig).where('label', 'LIKE', 'SO%').orderByAsc('label').build();
        expect(built.sql).toContain(`txn.tranid || ' / ' || c.companyname AS "label"`);
        expect(built.sql).toContain(`WHERE txn.tranid || ' / ' || c.companyname LIKE ?`);
        expect(built.sql).toContain(`ORDER BY txn.tranid || ' / ' || c.companyname ASC`);
    });

    it('throws when a config join has neither a raw predicate nor constraints', () => {
        const brokenConfig = defineQueryConfig<{ id: number }>({
            recordType: 'salesorder',
            query: {
                from: { name: 'transaction', alias: 'txn' },
                joins: [{ toTable: { name: 'customer', alias: 'c' }, fromTable: 'txn', type: 'inner' }],
            },
            fields: { id: { queryFieldId: 'id', tableAlias: 'txn', isPrimary: true } },
        });
        expect(() => QueryBuilder.from(brokenConfig).build()).toThrow("Join 'c' requires an on predicate or at least one constraint.");
    });
});
