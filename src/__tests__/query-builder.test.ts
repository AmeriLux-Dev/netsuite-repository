import { QueryBuilder, query } from '../query';
import { customerConfig, orderConfig, innerJoinConfig, rightJoinConfig } from './fixtures';
import type { QueryConfig, FieldMap } from '../types';

// Helper: build a simple config
function simpleConfig(fields: QueryConfig<any>['fields'] = {}): QueryConfig<any> {
    return {
        recordType: 'test',
        query: { from: { name: 'testrecord', alias: 'r' } },
        fields: {
            id: { queryFieldId: 'id', tableAlias: 'r', isPrimary: true },
            ...fields,
        },
    };
}

describe('QueryBuilder.build() – SELECT clause', () => {
    it('generates a basic SELECT from a flat config', () => {
        const { sql } = QueryBuilder.from(customerConfig).build();
        expect(sql).toContain('SELECT');
        expect(sql).toContain('cust.id AS "id"');
        expect(sql).toContain('cust.companyname AS "name"');
        expect(sql).toContain('FROM customer cust');
    });

    it('uses field alias when provided', () => {
        const { sql } = QueryBuilder.from(innerJoinConfig).build();
        expect(sql).toContain('BUILTIN.DF(dept.name) AS "deptName"');
    });

    it('wraps field in BUILTIN.DF when useText is true', () => {
        const { sql } = QueryBuilder.from(innerJoinConfig).build();
        expect(sql).toContain('BUILTIN.DF(');
    });

    it('throws when no selectable fields exist', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: { name: { queryFieldId: 'name', tableAlias: 't', select: false } },
        };
        expect(() => QueryBuilder.from(cfg).build()).toThrow('At least one selectable field is required');
    });

    it('always includes primary field even when select() filters others', () => {
        const { sql, fieldMap } = QueryBuilder.from(customerConfig).select('name').build();
        expect(sql).toContain('cust.id AS "id"');
        expect(sql).toContain('cust.companyname AS "name"');
        expect(fieldMap).toHaveProperty('id');
        expect(fieldMap).toHaveProperty('name');
        expect(fieldMap).not.toHaveProperty('email');
    });

    it('excludes fields with select: false', () => {
        const cfg = simpleConfig({
            visible: { queryFieldId: 'vis', tableAlias: 'r' },
            hidden:  { queryFieldId: 'hid', tableAlias: 'r', select: false },
        });
        const { sql } = QueryBuilder.from(cfg).build();
        expect(sql).toContain('r.vis');
        expect(sql).not.toContain('r.hid');
    });

    it('selectAll() resets selection to include all fields', () => {
        const { fieldMap } = QueryBuilder.from(customerConfig).select('name').selectAll().build();
        expect(fieldMap).toHaveProperty('email');
    });

    it('distinct() adds DISTINCT keyword', () => {
        const { sql } = QueryBuilder.from(customerConfig).distinct().build();
        expect(sql).toContain('SELECT DISTINCT');
    });
});

describe('QueryBuilder.build() – FROM and JOIN clauses', () => {
    it('generates LEFT OUTER JOIN', () => {
        const { sql } = QueryBuilder.from(orderConfig).build();
        expect(sql).toContain('LEFT OUTER JOIN transactionline tl ON');
    });

    it('generates INNER JOIN', () => {
        const { sql } = QueryBuilder.from(innerJoinConfig).build();
        expect(sql).toContain('INNER JOIN department dept ON');
    });

    it('generates RIGHT OUTER JOIN', () => {
        const { sql } = QueryBuilder.from(rightJoinConfig).build();
        expect(sql).toContain('RIGHT OUTER JOIN bar b ON');
    });

    it('generates ON clause with single constraint', () => {
        const { sql } = QueryBuilder.from(innerJoinConfig).build();
        expect(sql).toContain('emp.department = dept.id');
    });

    it('generates ON clause with multiple constraints', () => {
        const { sql } = QueryBuilder.from(orderConfig).build();
        expect(sql).toContain('txn.id = tl.transaction');
        expect(sql).toContain('AND txn.subsidiary = tl.subsidiary');
    });
});

describe('QueryBuilder.build() – WHERE clause', () => {
    it('generates equality WHERE condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).where('name', '=', 'Acme').build();
        expect(sql).toContain('WHERE cust.companyname = ?');
        expect(params).toEqual(['Acme']);
    });

    it('generates != condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).where('name', '!=', 'Acme').build();
        expect(sql).toContain('cust.companyname != ?');
        expect(params).toEqual(['Acme']);
    });

    it('generates < > <= >= conditions', () => {
        const b = QueryBuilder.from(customerConfig)
            .where('score', '>', 50)
            .where('score', '<', 100)
            .where('score', '>=', 10)
            .where('score', '<=', 90);
        const { sql } = b.build();
        expect(sql).toContain('> ?');
        expect(sql).toContain('< ?');
        expect(sql).toContain('>= ?');
        expect(sql).toContain('<= ?');
    });

    it('generates LIKE and NOT LIKE conditions', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .where('name', 'LIKE', 'Ac%')
            .where('email', 'NOT LIKE', '%@spam%')
            .build();
        expect(sql).toContain('LIKE ?');
        expect(sql).toContain('NOT LIKE ?');
    });

    it('generates IS NULL condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).whereNull('email').build();
        expect(sql).toContain('cust.email IS NULL');
        expect(params).toHaveLength(0);
    });

    it('generates IS NOT NULL condition', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereNotNull('email').build();
        expect(sql).toContain('cust.email IS NOT NULL');
    });

    it('generates IN condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).whereIn('id', [1, 2, 3]).build();
        expect(sql).toContain('cust.id IN (?, ?, ?)');
        expect(params).toEqual([1, 2, 3]);
    });

    it('generates NOT IN condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).whereNotIn('id', [4, 5]).build();
        expect(sql).toContain('cust.id NOT IN (?, ?)');
        expect(params).toEqual([4, 5]);
    });

    it('generates BETWEEN condition', () => {
        const { sql, params } = QueryBuilder.from(customerConfig).whereBetween('score', 10, 90).build();
        expect(sql).toContain('cust.custentity_score BETWEEN ? AND ?');
        expect(params).toEqual([10, 90]);
    });

    it('skips whereIn when values array is empty', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereIn('id', []).build();
        expect(sql).not.toContain('IN');
    });

    it('skips whereIn when values is undefined', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereIn('id', undefined).build();
        expect(sql).not.toContain('IN');
    });

    it('skips whereNotIn when values is empty', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereNotIn('id', []).build();
        expect(sql).not.toContain('NOT IN');
    });

    it('skips whereBetween when min is undefined', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereBetween('score', undefined, 90).build();
        expect(sql).not.toContain('BETWEEN');
    });

    it('skips whereBetween when max is undefined', () => {
        const { sql } = QueryBuilder.from(customerConfig).whereBetween('score', 10, undefined).build();
        expect(sql).not.toContain('BETWEEN');
    });

    it('skips WHERE condition when value is undefined (non-null operators)', () => {
        const { sql } = QueryBuilder.from(customerConfig).where('name', '=', undefined as any).build();
        expect(sql).not.toContain('WHERE');
    });

    it('generates OR conditions with orWhere', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .where('name', '=', 'Acme')
            .orWhere('name', '=', 'Ajax')
            .build();
        expect(sql).toContain('OR cust.companyname = ?');
    });

    it('generates whereRaw SQL fragment', () => {
        const { sql, params } = QueryBuilder.from(customerConfig)
            .whereRaw('cust.id IN (SELECT id FROM approved)', )
            .build();
        expect(sql).toContain('cust.id IN (SELECT id FROM approved)');
        expect(params).toHaveLength(0);
    });

    it('generates orWhereRaw with OR linkType', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .where('name', '=', 'x')
            .orWhereRaw('cust.flag = ?', true)
            .build();
        expect(sql).toContain('OR cust.flag = ?');
    });

    it('generates grouped WHERE with whereGroup', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .whereGroup(b => b.where('name', '=', 'Acme').orWhere('name', '=', 'Ajax'))
            .build();
        expect(sql).toContain('WHERE (cust.companyname = ? OR cust.companyname = ?)');
    });

    it('ignores empty whereGroup callback', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .whereGroup(b => b)
            .build();
        expect(sql).not.toContain('WHERE');
    });

    it('generates orWhereGroup with OR linkType', () => {
        const { sql } = QueryBuilder.from(customerConfig)
            .where('isActive', '=', true)
            .orWhereGroup(b => b.where('name', '=', 'Acme'))
            .build();
        expect(sql).toContain('OR (cust.companyname = ?)');
    });

    it('applies useText wrapping in WHERE clause', () => {
        const { sql } = QueryBuilder.from(innerJoinConfig).where('dept', '=', 'Sales', true).build();
        expect(sql).toContain('BUILTIN.DF(dept.name) = ?');
    });

    it('throws when WHERE references undefined field', () => {
        expect(() =>
            QueryBuilder.from(customerConfig).where('nonexistent' as any, '=', 1).build()
        ).toThrow("Field 'nonexistent' is not defined in query config for 'customer'");
    });

    it('throws when BETWEEN is given a non-array', () => {
        expect(() =>
            (QueryBuilder.from(customerConfig) as any).buildCondition('cust.id', 'BETWEEN', 'bad')
        ).toThrow('BETWEEN requires exactly two values');
    });

    it('throws when BETWEEN array does not have length 2', () => {
        expect(() =>
            (QueryBuilder.from(customerConfig) as any).buildCondition('cust.id', 'BETWEEN', [1])
        ).toThrow('BETWEEN requires exactly two values');
    });

    it('throws when IN is given an empty array via buildCondition directly', () => {
        expect(() =>
            (QueryBuilder.from(customerConfig) as any).buildCondition('cust.id', 'IN', [])
        ).toThrow('IN requires at least one value');
    });

    it('throws when NOT IN is given an empty array', () => {
        expect(() =>
            (QueryBuilder.from(customerConfig) as any).buildCondition('cust.id', 'NOT IN', [])
        ).toThrow('NOT IN requires at least one value');
    });

    it('throws when an array is passed to a scalar operator', () => {
        expect(() =>
            (QueryBuilder.from(customerConfig) as any).buildCondition('cust.id', '=', [1, 2])
        ).toThrow('= does not accept an array value');
    });
});

describe('QueryBuilder.build() – ORDER BY and pagination', () => {
    it('generates ORDER BY ASC', () => {
        const { sql } = QueryBuilder.from(customerConfig).orderBy('name').build();
        expect(sql).toContain('ORDER BY cust.companyname ASC');
    });

    it('generates ORDER BY DESC', () => {
        const { sql } = QueryBuilder.from(customerConfig).orderByDesc('score').build();
        expect(sql).toContain('cust.custentity_score DESC');
    });

    it('orderByAsc generates ASC', () => {
        const { sql } = QueryBuilder.from(customerConfig).orderByAsc('name').build();
        expect(sql).toContain('cust.companyname ASC');
    });

    it('generates TOP N clause from limit()', () => {
        const { sql } = QueryBuilder.from(customerConfig).limit(10).build();
        expect(sql).toContain('TOP 10');
    });

    it('uses limit + offset in TOP clause', () => {
        const { sql } = QueryBuilder.from(customerConfig).limit(10).offset(20).build();
        expect(sql).toContain('TOP 30');
    });

    it('page() sets limit and offset correctly', () => {
        const { sql } = QueryBuilder.from(customerConfig).page(3, 10).build();
        expect(sql).toContain('TOP 30');
    });

    it('clamps limit to 0 minimum', () => {
        const { sql } = QueryBuilder.from(customerConfig).limit(-5).build();
        expect(sql).toContain('TOP 0');
    });

    it('clamps offset to 0 minimum', () => {
        const { sql } = QueryBuilder.from(customerConfig).limit(5).offset(-99).build();
        expect(sql).toContain('TOP 5');
    });

    it('clamps page to minimum of 1', () => {
        const { sql } = QueryBuilder.from(customerConfig).page(-1, 10).build();
        expect(sql).toContain('TOP 10');
    });
});

describe('QueryBuilder.build() – fieldMap', () => {
    it('fieldMap keys are lowercased aliases', () => {
        const { fieldMap } = QueryBuilder.from(innerJoinConfig).build();
        expect(fieldMap).toHaveProperty('deptname');
        expect(fieldMap['deptname'].key).toBe('dept');
    });

    it('fieldMap outputPath is nestPath when defined', () => {
        const { fieldMap } = QueryBuilder.from(orderConfig).build();
        expect(fieldMap['lines_itemid'].outputPath).toBe('lines.itemId');
    });
});

describe('QueryBuilder.toSQL()', () => {
    it('inlines string param with escaped single quotes', () => {
        const sql = QueryBuilder.from(customerConfig).where('name', '=', "O'Brien").toSQL();
        expect(sql).toContain("'O''Brien'");
    });

    it('inlines null param as NULL', () => {
        const sql = QueryBuilder.from(customerConfig).where('name', '=', null).toSQL();
        expect(sql).toContain('NULL');
    });

    it('inlines number param as digits', () => {
        const sql = QueryBuilder.from(customerConfig).where('id', '=', 42).toSQL();
        expect(sql).toContain('42');
    });

    it('inlines boolean param as true/false string', () => {
        const sql = QueryBuilder.from(customerConfig).where('isActive', '=', true).toSQL();
        expect(sql).toContain('true');
    });
});

describe('QueryBuilder.mapResults()', () => {
    it('returns empty array for empty rows', () => {
        expect(QueryBuilder.from(customerConfig).mapResults([], {})).toEqual([]);
    });

    it('maps flat rows to typed objects', () => {
        const { fieldMap } = QueryBuilder.from(customerConfig).build();
        const rows = [{ id: 1, name: 'Acme', email: 'a@acme.com', isinactive: false, custentity_score: 95.5 }];
        const result = QueryBuilder.from(customerConfig).mapResults(rows, fieldMap);
        expect(result[0]).toMatchObject({ id: 1, name: 'Acme' });
    });

    it('applies transform function to field value', () => {
        const cfg: QueryConfig<{ id: number; nameUpper: string }> = {
            recordType: 'customer',
            query: { from: { name: 'customer', alias: 'cust' } },
            fields: {
                id:        { queryFieldId: 'id',          tableAlias: 'cust', isPrimary: true },
                nameUpper: { queryFieldId: 'companyname', tableAlias: 'cust', transform: (v) => String(v).toUpperCase() },
            },
        };
        const { fieldMap } = QueryBuilder.from(cfg).build();
        const result = QueryBuilder.from(cfg).mapResults([{ id: 1, nameupper: 'acme' }], fieldMap);
        expect(result[0].nameUpper).toBe('ACME');
    });

    it('applies postProcess to each result', () => {
        const cfg: QueryConfig<Customer & { _processed?: boolean }> = {
            ...customerConfig,
            postProcess: (row: any) => ({ ...row, _processed: true }),
        } as any;
        const { fieldMap } = QueryBuilder.from(cfg).build();
        const result = QueryBuilder.from(cfg).mapResults([{ id: 1, name: 'x', email: '', isinactive: false, custentity_score: 0 }], fieldMap);
        expect((result[0] as any)._processed).toBe(true);
    });

    it('groups rows by primary key when cardinality:many fields exist', () => {
        const { fieldMap } = QueryBuilder.from(orderConfig).build();
        const rows = [
            { id: 10, entityid: 100, lines_itemid: 1, lines_qty: 2, lines_amount: 50 },
            { id: 10, entityid: 100, lines_itemid: 2, lines_qty: 3, lines_amount: 75 },
        ];
        const result = QueryBuilder.from(orderConfig).mapResults(rows, fieldMap) as Order[];
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(10);
        expect(result[0].lines).toHaveLength(2);
    });

    it('deduplicates identical array items across grouped rows', () => {
        const { fieldMap } = QueryBuilder.from(orderConfig).build();
        const rows = [
            { id: 10, entityid: 100, lines_itemid: 1, lines_qty: 2, lines_amount: 50 },
            { id: 10, entityid: 100, lines_itemid: 1, lines_qty: 2, lines_amount: 50 },
        ];
        const result = QueryBuilder.from(orderConfig).mapResults(rows, fieldMap) as Order[];
        expect(result[0].lines).toHaveLength(1);
    });

    it('skips rows with null primary key in grouped results', () => {
        const { fieldMap } = QueryBuilder.from(orderConfig).build();
        const rows = [
            { id: null,  entity: 100, item: 1, quantity: 2, amount: 50 },
            { id: 10,    entity: 100, item: 2, quantity: 3, amount: 75 },
        ];
        const result = QueryBuilder.from(orderConfig).mapResults(rows, fieldMap);
        expect(result).toHaveLength(1);
    });

    it('uses rows.map() when cardinality:many exists but no primary field', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                items: { queryFieldId: 'item', tableAlias: 't', cardinality: 'many', nestPath: 'items' },
            },
        };
        const { fieldMap } = QueryBuilder.from(cfg).build();
        const result = QueryBuilder.from(cfg).mapResults([{ items: null }], fieldMap);
        expect(result).toHaveLength(1);
    });

    it('skips null/empty array items in mapRowGroup', () => {
        const { fieldMap } = QueryBuilder.from(orderConfig).build();
        const rows = [
            { id: 10, entity: 100, item: null, quantity: null, amount: null },
        ];
        const result = QueryBuilder.from(orderConfig).mapResults(rows, fieldMap) as Order[];
        expect(result[0].lines).toHaveLength(0);
    });

    it('setPath handles nested dot-path', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id: { queryFieldId: 'id', tableAlias: 't', isPrimary: true },
                deep: { queryFieldId: 'deep', tableAlias: 't', nestPath: 'a.b.c' },
            },
        };
        const { fieldMap } = QueryBuilder.from(cfg).build();
        const result = QueryBuilder.from(cfg).mapResults([{ id: 1, deep: 42 }], fieldMap);
        expect((result[0] as any).a.b.c).toBe(42);
    });

    it('setPath overwrites a non-object intermediate value', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {
                id:    { queryFieldId: 'id',    tableAlias: 't', isPrimary: true },
                outer: { queryFieldId: 'outer', tableAlias: 't', nestPath: 'x' },
                inner: { queryFieldId: 'inner', tableAlias: 't', nestPath: 'x.y' },
            },
        };
        const { fieldMap } = QueryBuilder.from(cfg).build();
        const result = QueryBuilder.from(cfg).mapResults([{ id: 1, outer: 'scalar', inner: 'nested' }], fieldMap);
        expect((result[0] as any).x.y).toBe('nested');
    });
});

describe('query() helper', () => {
    it('returns a QueryBuilder instance', () => {
        expect(query(customerConfig)).toBeInstanceOf(QueryBuilder);
    });
});

// ── Coverage: uncovered branches ───────────────────────────────────────────────

describe('QueryBuilder – joinLinkType defaults to AND', () => {
    it('uses AND when joinLinkType is not set on secondary constraint', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: {
                from: { name: 'foo', alias: 'f' },
                joins: [{
                    toTable: { name: 'bar', alias: 'b' },
                    fromTable: 'f',
                    type: 'leftOuter',
                    constraints: [
                        { joinKeys: { sourceForeignKey: 'a', targetPrimaryKey: 'a' } },
                        { joinKeys: { sourceForeignKey: 'c', targetPrimaryKey: 'c' } },
                    ],
                }],
            },
            fields: { id: { queryFieldId: 'id', tableAlias: 'f', isPrimary: true } },
        };
        const { sql } = QueryBuilder.from(cfg).build();
        expect(sql).toContain('AND f.c = b.c');
    });
});

describe('QueryBuilder – setPath overwrites array intermediate', () => {
    it('replaces an array intermediate with an object when setting a nested path', () => {
        const cfg: QueryConfig<any> = {
            recordType: 'test',
            query: { from: { name: 'test', alias: 't' } },
            fields: {},
        };
        const builder = QueryBuilder.from(cfg);
        const fieldMap: FieldMap = {
            arr: { key: 'arr', outputPath: 'items', field: { queryFieldId: 'arr', tableAlias: 't', transform: () => [] } },
            sub: { key: 'sub', outputPath: 'items.count', field: { queryFieldId: 'sub', tableAlias: 't' } },
        };
        const result = builder.mapResults([{ arr: 'x', sub: 5 }], fieldMap);
        expect((result[0] as any).items.count).toBe(5);
    });
});

// Import for type reference in transform test
import type { Customer, Order } from './fixtures';
