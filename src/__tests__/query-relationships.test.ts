import { raw } from '../field-path';
import * as NsQuery from 'N/query';
import { query } from '../query';
import type { QueryConfig } from '../types';
import { salesOrderModelConfig } from './model-fixtures';
import type { SalesOrderModel } from './model-fixtures';

const mockRunSuiteQL = NsQuery.runSuiteQL as unknown as jest.Mock;

const discriminated: QueryConfig<SalesOrderModel> = { ...salesOrderModelConfig, discriminator: { column: 'type', value: 'SalesOrd' } };

const onDemandCustomer: QueryConfig<SalesOrderModel> = {
    ...salesOrderModelConfig,
    relationships: {
        ...salesOrderModelConfig.relationships,
        customer: { kind: 'reference', fields: { companyName: 'customer_companyName' }, joinAliases: ['cust'], selectByDefault: false },
    },
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('QueryBuilder – include() and exclude()', () => {
    it('drops an excluded relationship\'s fields and joins', () => {
        const built = query(salesOrderModelConfig).exclude('lines', 'shippingAddress').build();
        expect(built.sql).not.toContain('transactionline');
        expect(built.sql).not.toContain('transactionshippingaddress');
        expect(built.sql).not.toContain('lines_quantity');
        expect(built.sql).toContain('customer_companyName');
        expect(built.params).toEqual([]);
    });

    it('keeps an excluded relationship\'s join when a condition still reads its alias', () => {
        const built = query(salesOrderModelConfig).exclude('lines').whereRaw('tl.quantity > ?', 1).build();
        expect(built.sql).toContain('INNER JOIN transactionline tl');
        expect(built.sql).not.toContain('lines_quantity');
    });

    it('leaves a relationship that is not selected by default out until include() asks for it', () => {
        const withoutCustomer = query(onDemandCustomer).build();
        expect(withoutCustomer.sql).not.toContain('customer_companyName');
        expect(withoutCustomer.sql).not.toContain('JOIN customer cust');

        const withCustomer = query(onDemandCustomer).include('customer').build();
        expect(withCustomer.sql).toContain('customer_companyName');
        expect(withCustomer.sql).toContain('LEFT OUTER JOIN customer cust');
    });

    it('lets include() win over a previous exclude() and the reverse', () => {
        expect(query(salesOrderModelConfig).exclude('lines').include('lines').build().sql).toContain('lines_quantity');
        expect(query(salesOrderModelConfig).include('lines').exclude('lines').build().sql).not.toContain('lines_quantity');
    });

    it('rejects unknown relationship names', () => {
        expect(() => query(salesOrderModelConfig).include('ghost' as never)).toThrow("Relationship 'ghost' is not defined in query config for 'salesorder'.");
        expect(() => query(salesOrderModelConfig).exclude('ghost' as never)).toThrow("Relationship 'ghost' is not defined");
    });
});

describe('QueryBuilder – dotted field keys', () => {
    it('accepts dotted paths for nested fields in select, where, and orderBy', () => {
        const built = query(salesOrderModelConfig)
            .select('tranId', 'customer.companyName')
            .where('lines.quantity', '>', 2)
            .orderByDesc('shippingAddress.city')
            .build();
        expect(built.sql).toContain('cust.companyname AS "customer_companyName"');
        expect(built.sql).not.toContain('AS "memo"');
        expect(built.sql).toContain('tl.quantity > ?');
        expect(built.sql).toContain('ORDER BY shipaddr.city DESC');
    });

    it('still rejects unknown dotted paths', () => {
        expect(() => query(salesOrderModelConfig).where(raw('customer.ghost'), '=', 1)).toThrow("Field 'customer.ghost' is not defined in query config for 'salesorder'.");
    });
});

describe('QueryBuilder – discriminator', () => {
    it('adds the discriminator on its own when there are no conditions', () => {
        const built = query(discriminated).build();
        expect(built.sql).toContain('WHERE txn.type = ?');
        expect(built.params).toEqual(['F', 'SalesOrd']);
    });

    it('wraps user conditions so an OR cannot escape the discriminator', () => {
        const built = query(discriminated).where('memo', '=', 'a').orWhere('memo', '=', 'b').build();
        expect(built.sql).toContain('WHERE txn.type = ? AND (txn.memo = ? OR txn.memo = ?)');
        expect(built.params).toEqual(['F', 'SalesOrd', 'a', 'b']);
    });

    it('applies to count() and exists()', () => {
        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [{ count: 3 }] });
        expect(query(discriminated).count()).toBe(3);
        expect(mockRunSuiteQL).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining('WHERE txn.type = ?'), params: ['F', 'SalesOrd'] }));

        mockRunSuiteQL.mockReturnValue({ asMappedResults: () => [] });
        expect(query(discriminated).exists()).toBe(false);
        expect(mockRunSuiteQL).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.stringContaining('WHERE txn.type = ?') }));
    });
});
