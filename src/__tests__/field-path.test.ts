import { query, raw } from '..';
import type { FieldPath, RelationName } from '..';
import { salesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

describe('typed field paths', () => {
    it('accepts model paths and the aliases a query declares, and turns typos into compile errors', () => {
        const built = query(salesOrderModelConfig)
            .where('memo', '=', 'x')
            .where('lines.itemId', '=', 1)
            .where('shippingAddress.city', '=', 'Dallas')
            .orderByAsc('customer.companyName')
            .leftJoin('transactionline', 'l', 'l.transaction = txn.id')
            .selectRaw('COUNT(l.id)', 'lineCount', { type: 'integer' })
            .where('l.mainline', '=', 'F')
            .orderByDesc('lineCount')
            .build();

        expect(built.sql).toContain('LEFT OUTER JOIN transactionline l ON l.transaction = txn.id');
        expect(built.sql).toContain('l.mainline = ?');
        expect(built.sql).toMatch(/ORDER BY cust\.companyname ASC, \S+ DESC/);

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
            const joined = builder.leftJoin('transactionline', 'l', 'l.transaction = txn.id');
            // @ts-expect-error an alias this query did not declare
            joined.where('x.column', '=', 1);
            joined.where(raw('x.column'), '=', 1);
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
