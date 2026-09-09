import { QueryBuilder, query } from '../query';
import { customerConfig, employeeConfig, orderConfig } from './fixtures';
import type { QueryConfig } from '../types';

function simpleConfig(fields: QueryConfig<any>['fields'] = {}): QueryConfig<any> {
    return { recordType: 'test', fields: { id: { queryFieldId: 'id', isPrimary: true }, ...fields } };
}

describe('QueryBuilder.describe() – columns', () => {
    it('selects every field of a flat config as an aliased column', () => {
        const description = QueryBuilder.from(customerConfig).describe();
        expect(description.queryType).toBe('customer');
        expect(description.components).toEqual([]);
        expect(description.columns).toEqual([
            { alias: 'id', fieldId: 'id' },
            { alias: 'name', fieldId: 'companyname' },
            { alias: 'email', fieldId: 'email' },
            { alias: 'isActive', fieldId: 'isinactive' },
            { alias: 'score', fieldId: 'custentity_score' },
        ]);
        expect(description.separateLoads).toEqual([]);
    });

    it('keeps the field alias and reads display text through the DISPLAY context', () => {
        const description = QueryBuilder.from(employeeConfig).describe();
        expect(description.columns).toContainEqual({ alias: 'departmentName', fieldId: 'department', context: 'DISPLAY' });
        expect(description.components).toEqual([{ path: 'department', join: { kind: 'to', fieldId: 'department', target: 'department' }, conditions: [] }]);
        expect(description.columns).toContainEqual({ alias: 'department_name', component: 'department', fieldId: 'name' });
    });

    it('throws when no selectable fields exist', () => {
        const cfg: QueryConfig<any> = { recordType: 'test', fields: { name: { queryFieldId: 'name', select: false } } };
        expect(() => QueryBuilder.from(cfg).describe()).toThrow('At least one selectable field is required');
    });

    it('always includes the primary field even when select() filters others', () => {
        const description = QueryBuilder.from(customerConfig).select('name').describe();
        expect(description.columns.map((column) => column.alias)).toEqual(['id', 'name']);
    });

    it('excludes fields with select: false and selectAll() resets a selection', () => {
        const cfg = simpleConfig({ visible: { queryFieldId: 'vis' }, hidden: { queryFieldId: 'hid', select: false } });
        expect(QueryBuilder.from(cfg).describe().columns.map((column) => column.alias)).toEqual(['id', 'visible']);
        expect(QueryBuilder.from(customerConfig).select('name').selectAll().describe().columns).toHaveLength(5);
    });

    it('adds formula columns usable in where() and orderBy() by alias', () => {
        const description = QueryBuilder.from(customerConfig)
            .selectFormula('{custentity_score} * 2', 'doubled', { type: 'FLOAT', fieldType: 'float' })
            .where('doubled', '>', 10)
            .orderByDesc('doubled')
            .describe();
        expect(description.columns).toContainEqual({ alias: 'doubled', formula: '{custentity_score} * 2', formulaType: 'FLOAT' });
        expect(description.condition).toEqual({ kind: 'formula', formula: '{custentity_score} * 2', type: 'FLOAT', operator: 'GREATER', values: [10] });
        expect(description.sort).toEqual([{ formula: '{custentity_score} * 2', formulaType: 'FLOAT', ascending: false }]);
    });

    it('lets a group condition use a formula alias declared outside the group', () => {
        const description = QueryBuilder.from(customerConfig).selectFormula('{custentity_score} * 2', 'doubled', { fieldType: 'float' }).whereGroup((builder) => builder.where('doubled', '>', 1).orWhere('id', '=', 3)).describe();
        expect(description.condition).toEqual({ kind: 'or', nodes: [{ kind: 'formula', formula: '{custentity_score} * 2', operator: 'GREATER', values: [1] }, { kind: 'field', fieldId: 'id', operator: 'ANY_OF', values: [3] }] });
    });

    it('rejects a formula alias that clashes with a field or another formula', () => {
        expect(() => QueryBuilder.from(customerConfig).selectFormula('1', 'name')).toThrow("Alias 'name' is already used by a field in query config for 'customer'.");
        expect(() => QueryBuilder.from(customerConfig).selectFormula('1', 'x').selectFormula('2', 'x')).toThrow("Alias 'x' is already used");
    });
});

describe('QueryBuilder.describe() – conditions', () => {
    const condition = (builder: QueryBuilder<any, any>) => builder.describe().condition;

    it('translates SQL-style operators', () => {
        expect(condition(QueryBuilder.from(customerConfig).where('name', '=', 'Acme'))).toEqual({ kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['Acme'] });
        expect(condition(QueryBuilder.from(customerConfig).where('name', '!=', 'Acme'))).toEqual({ kind: 'field', fieldId: 'companyname', operator: 'IS_NOT', values: ['Acme'] });
        expect(condition(QueryBuilder.from(customerConfig).where('score', '>', 50).where('score', '<', 100).where('score', '>=', 10).where('score', '<=', 90))).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'custentity_score', operator: 'GREATER', values: [50] },
                { kind: 'field', fieldId: 'custentity_score', operator: 'LESS', values: [100] },
                { kind: 'field', fieldId: 'custentity_score', operator: 'GREATER_OR_EQUAL', values: [10] },
                { kind: 'field', fieldId: 'custentity_score', operator: 'LESS_OR_EQUAL', values: [90] },
            ],
        });
        expect(condition(QueryBuilder.from(customerConfig).where('name', 'LIKE', 'Ac%').where('email', 'NOT LIKE', '%@spam%'))).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'companyname', operator: 'START_WITH', values: ['Ac'] },
                { kind: 'field', fieldId: 'email', operator: 'CONTAIN_NOT', values: ['@spam'] },
            ],
        });
        expect(condition(QueryBuilder.from(customerConfig).whereNull('email'))).toEqual({ kind: 'field', fieldId: 'email', operator: 'EMPTY' });
        expect(condition(QueryBuilder.from(customerConfig).whereNotNull('email'))).toEqual({ kind: 'field', fieldId: 'email', operator: 'EMPTY_NOT' });
        expect(condition(QueryBuilder.from(customerConfig).whereIn('id', [1, 2, 3]))).toEqual({ kind: 'field', fieldId: 'id', operator: 'ANY_OF', values: [1, 2, 3] });
        expect(condition(QueryBuilder.from(customerConfig).whereNotIn('id', [4, 5]))).toEqual({ kind: 'field', fieldId: 'id', operator: 'ANY_OF_NOT', values: [4, 5] });
        expect(condition(QueryBuilder.from(customerConfig).whereBetween('score', 10, 90))).toEqual({ kind: 'field', fieldId: 'custentity_score', operator: 'BETWEEN', values: [10, 90] });
        expect(condition(QueryBuilder.from(customerConfig).where('name', 'START_WITH', 'A'))).toEqual({ kind: 'field', fieldId: 'companyname', operator: 'START_WITH', values: ['A'] });
    });

    it('skips conditions with nothing to compare', () => {
        expect(condition(QueryBuilder.from(customerConfig).whereIn('id', []))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).whereIn('id', undefined))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).whereNotIn('id', []))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).whereBetween('score', undefined, 90))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).whereBetween('score', 10, undefined))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).where('name', '=', undefined as any))).toBeUndefined();
        expect(condition(QueryBuilder.from(customerConfig).whereGroup((builder) => builder))).toBeUndefined();
    });

    it('folds AND and OR with SQL precedence and nests groups', () => {
        expect(condition(QueryBuilder.from(customerConfig).where('name', '=', 'a').orWhere('name', '=', 'b').where('email', 'IS NULL'))).toEqual({
            kind: 'or',
            nodes: [
                { kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['a'] },
                { kind: 'and', nodes: [{ kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['b'] }, { kind: 'field', fieldId: 'email', operator: 'EMPTY' }] },
            ],
        });
        expect(condition(QueryBuilder.from(customerConfig).where('isActive', '=', true).whereGroup((builder) => builder.where('name', '=', 'Acme').orWhere('name', '=', 'Ajax')))).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'isinactive', operator: 'IS', values: [true] },
                { kind: 'or', nodes: [{ kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['Acme'] }, { kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['Ajax'] }] },
            ],
        });
        expect(condition(QueryBuilder.from(customerConfig).where('isActive', '=', true).orWhereGroup((builder) => builder.where('name', '=', 'Acme')))).toEqual({
            kind: 'or',
            nodes: [{ kind: 'field', fieldId: 'isinactive', operator: 'IS', values: [true] }, { kind: 'field', fieldId: 'companyname', operator: 'IS', values: ['Acme'] }],
        });
    });

    it('adds formula conditions with and without an operator', () => {
        expect(condition(QueryBuilder.from(customerConfig).whereFormula('{datecreated} > SYSDATE - 30'))).toEqual({ kind: 'formula', formula: '{datecreated} > SYSDATE - 30', type: 'BOOLEAN' });
        expect(condition(QueryBuilder.from(customerConfig).where('id', '=', 1).orWhereFormula('{score}', 'FLOAT', 'GREATER', 5))).toEqual({
            kind: 'or',
            nodes: [{ kind: 'field', fieldId: 'id', operator: 'ANY_OF', values: [1] }, { kind: 'formula', formula: '{score}', type: 'FLOAT', operator: 'GREATER', values: [5] }],
        });
        expect(condition(QueryBuilder.from(customerConfig).whereFormula('{tags}', 'STRING', 'ANY_OF', ['a', 'b']))).toEqual({ kind: 'formula', formula: '{tags}', type: 'STRING', operator: 'ANY_OF', values: ['a', 'b'] });
    });

    it('compares display text through a DISPLAY formula', () => {
        expect(condition(QueryBuilder.from(employeeConfig).where('deptName', '=', 'Sales'))).toEqual({ kind: 'formula', formula: '{department#DISPLAY}', type: 'STRING', operator: 'IS', values: ['Sales'] });
        expect(condition(QueryBuilder.from(employeeConfig).where('department.name', '=', 'Sales', true))).toEqual({ kind: 'formula', formula: '{department.name#DISPLAY}', type: 'STRING', operator: 'IS', values: ['Sales'] });
    });

    it('throws when a condition references an unknown field', () => {
        expect(() => QueryBuilder.from(customerConfig).where('nonexistent' as any, '=', 1)).toThrow("Field 'nonexistent' is not defined in query config for 'customer'");
    });
});

describe('QueryBuilder.describe() – ordering and paging', () => {
    it('records sorts with their direction and context', () => {
        expect(QueryBuilder.from(customerConfig).orderBy('name').orderByDesc('score').orderByAsc('email').describe().sort).toEqual([
            { fieldId: 'companyname', ascending: true },
            { fieldId: 'custentity_score', ascending: false },
            { fieldId: 'email', ascending: true },
        ]);
        expect(QueryBuilder.from(employeeConfig).orderBy('deptName').orderBy('department.name', 'DESC').describe().sort).toEqual([
            { fieldId: 'department', context: 'DISPLAY', ascending: true },
            { component: 'department', fieldId: 'name', ascending: false },
        ]);
    });

    it('records the page window from limit(), offset(), and page(), clamped to sensible values', () => {
        expect(QueryBuilder.from(customerConfig).describe().page).toBeUndefined();
        expect(QueryBuilder.from(customerConfig).limit(10).describe().page).toEqual({ offset: 0, limit: 10 });
        expect(QueryBuilder.from(customerConfig).limit(10).offset(20).describe().page).toEqual({ offset: 20, limit: 10 });
        expect(QueryBuilder.from(customerConfig).page(3, 10).describe().page).toEqual({ offset: 20, limit: 10 });
        expect(QueryBuilder.from(customerConfig).limit(-5).describe().page).toEqual({ offset: 0, limit: 0 });
        expect(QueryBuilder.from(customerConfig).limit(5).offset(-99).describe().page).toEqual({ offset: 0, limit: 5 });
        expect(QueryBuilder.from(customerConfig).page(-1, 10).describe().page).toEqual({ offset: 0, limit: 10 });
        expect(QueryBuilder.from(customerConfig).offset(7).describe().page).toEqual({ offset: 7 });
    });
});

describe('QueryBuilder.describeText()', () => {
    it('renders the whole query as readable text', () => {
        const text = QueryBuilder.from(orderConfig).where('entityId', '=', 7).whereIn('lines.itemId', [1, 2]).orderByDesc('lines.qty').page(2, 25).describeText();
        expect(text).toBe([
            'FROM salesorder',
            'JOIN from transactionline.transaction AS lines WHERE lines.mainline IS [false]',
            'SELECT id AS id, entity AS entityId, lines.item AS lines_itemId, lines.quantity AS lines_qty, lines.amount AS lines_amount',
            'WHERE entity ANY_OF [7] AND lines.item ANY_OF [1, 2]',
            'ORDER BY lines.quantity DESC',
            'PAGE offset 25 limit 25',
        ].join('\n'));
    });
});

describe('query() helper', () => {
    it('returns a QueryBuilder instance', () => {
        expect(query(customerConfig)).toBeInstanceOf(QueryBuilder);
    });
});
