import { query } from '..';
import type { FieldPath, RelationName } from '..';
import { salesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

describe('typed field paths', () => {
    it('accepts model paths and the aliases a query declares, and turns typos into compile errors', () => {
        const description = query(salesOrderModelConfig)
            .where('memo', '=', 'x')
            .where('lines.itemId', '=', 1)
            .where('shippingAddress.city', '=', 'Dallas')
            .orderByAsc('customer.companyName')
            .selectFormula('{lines.quantity} * 2', 'doubled', { type: 'FLOAT', fieldType: 'float' })
            .where('doubled', '>', 1)
            .orderByDesc('doubled')
            .describe();

        expect(description.columns).toContainEqual({ alias: 'doubled', formula: '{lines.quantity} * 2', formulaType: 'FLOAT' });
        expect(description.condition).toEqual({
            kind: 'and',
            nodes: [
                { kind: 'field', fieldId: 'memo', operator: 'IS', values: ['x'] },
                { kind: 'field', component: 'lines', fieldId: 'item', operator: 'ANY_OF', values: [1] },
                { kind: 'field', component: 'shippingAddress', fieldId: 'city', operator: 'IS', values: ['Dallas'] },
                { kind: 'formula', formula: '{lines.quantity} * 2', type: 'FLOAT', operator: 'GREATER', values: [1] },
            ],
        });
        expect(description.sort).toEqual([
            { component: 'customer', fieldId: 'companyname', ascending: true },
            { formula: '{lines.quantity} * 2', formulaType: 'FLOAT', ascending: false },
        ]);

        const path: FieldPath<SalesOrderModel> = 'lines.quantity';
        const relation: RelationName<SalesOrderModel> = 'lines';
        expect([path, relation]).toEqual(['lines.quantity', 'lines']);

        // Never executed: these lines exist for the type checker only. ts-jest reports any expectation that stops failing.
        const typeChecks = () => {
            const builder = query(salesOrderModelConfig);
            // @ts-expect-error a misspelled property is not a field path
            builder.where('memoo', '=', 'x');
            // @ts-expect-error a misspelled relation member is not a field path
            builder.orderByAsc('lines.quantityy');
            // @ts-expect-error a relation name is not a field path of its own members' type
            builder.select('customer.ghost');
            const widened = builder.selectFormula('{id}', 'copy');
            // @ts-expect-error an alias this query did not declare
            widened.where('other', '=', 1);
            widened.where('copy', '=', 1);
            // @ts-expect-error only relations can be included
            builder.include('memo');
            builder.include('lines');
            // @ts-expect-error the customer reference is projected to companyName only
            const notAPath: FieldPath<SalesOrderModel> = 'customer.email';
            return notAPath;
        };
        expect(typeChecks).toBeDefined();
    });
});
