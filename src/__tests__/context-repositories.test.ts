import { RecordSet, applySpecifications, createNetSuiteContext } from '../context';
import type { Specification } from '../context';
import { customerConfig, salesOrderConfig } from './fixtures';
import type { Customer } from './fixtures';
import { salesOrderModelConfig, separateLinesSalesOrderModelConfig } from './model-fixtures';
import { fakeNQuery } from '../testing';

const named = (name: string): Specification<Customer> => (query) => query.where('name', '=', name);
const withEmail = (): Specification<Customer> => (query) => query.where('email', 'IS NOT NULL');

/** A repository the way a consumer writes one: a subclass with domain queries built from specifications. */
class CustomerRepository extends RecordSet<Customer> {
    findByName(name: string): Customer | null {
        return this.first(named(name));
    }

    listContactable(): Customer[] {
        return this.list(withEmail());
    }
}

beforeEach(() => {
    jest.clearAllMocks();
    fakeNQuery.reset();
});

describe('specifications', () => {
    it('apply in order and compose on one query', () => {
        const set = new RecordSet<Customer>(customerConfig);
        const text = applySpecifications(set.query(), [named('Acme'), withEmail()]).describeText();
        expect(text).toContain("WHERE companyname IS ['Acme'] AND email EMPTY_NOT");
    });

    it('drive list(), first(), count(), and exists() on a record set', () => {
        const set = new RecordSet<Customer>(customerConfig);

        fakeNQuery.queueRows('customer', [{ id: 1, name: 'Acme', email: 'a@x' }, { id: 2, name: 'Bolt', email: 'b@x' }]);
        expect(set.list(withEmail())).toHaveLength(2);
        expect(fakeNQuery.calls[0].text).toContain('email EMPTY_NOT');

        fakeNQuery.queueRows('customer', [{ id: 1, name: 'Acme', email: 'a@x' }]);
        expect(set.first(named('Acme'))).toMatchObject({ id: 1, name: 'Acme' });
        expect(fakeNQuery.calls[1].execution).toBe('runPaged');
        expect(fakeNQuery.calls[1].pageSize).toBe(5);

        fakeNQuery.queueRows('customer', [{ count: '3' }]);
        expect(set.count(named('Acme'))).toBe(3);
        expect(fakeNQuery.calls[2].text).toContain('SELECT COUNT(id) AS count');
        expect(fakeNQuery.calls[2].text).toContain("WHERE companyname IS ['Acme']");

        fakeNQuery.queueRows('customer', [{ id: 1 }]);
        expect(set.exists(named('Acme'), withEmail())).toBe(true);
        expect(set.exists()).toBe(false);
    });

    it('reads every row for first() and find() on a model with a joined sublist, so the record keeps all its lines', () => {
        const orders = new RecordSet(salesOrderModelConfig);
        const lineRows = [
            { id: 9, tranid: 'SO9', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: 1, lines_itemid: 5, lines_quantity: 2, customer_companyname: 'Acme' },
            { id: 9, tranid: 'SO9', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', lines_line: 2, lines_itemid: 6, lines_quantity: 1, customer_companyname: 'Acme' },
        ];

        fakeNQuery.queueRows('salesorder', lineRows);
        const first = orders.first((query) => query.where('memo', 'IS NULL'));
        expect(first?.lines).toHaveLength(2);
        expect(fakeNQuery.calls[0].execution).toBe('run');

        // A fresh set, so find() has nothing tracked and must query.
        fakeNQuery.queueRows('salesorder', lineRows);
        expect(new RecordSet(salesOrderModelConfig).find(9)?.lines.map((line) => line.line)).toEqual([1, 2]);
        expect(fakeNQuery.calls[1].execution).toBe('run');
    });

    it('pages over records when the lines load separately', () => {
        const orders = new RecordSet(separateLinesSalesOrderModelConfig);
        fakeNQuery.queueRows({ type: 'salesorder', contains: 'shippingaddress' }, [{ id: 9, tranid: 'SO9', memo: null, customername: 'Acme', shippingaddress_addr1: '1 Main', shippingaddress_city: 'Dallas', customer_companyname: 'Acme' }]);
        fakeNQuery.queueRows({ type: 'salesorder', contains: '__parentKey' }, [{ __parentkey: 9, lines_line: 1, lines_itemid: 5, lines_quantity: 2 }]);

        const first = orders.first();

        expect(first?.lines).toEqual([{ line: 1, itemId: 5, quantity: 2 }]);
        expect(fakeNQuery.calls[0].execution).toBe('runPaged');
        expect(fakeNQuery.calls[1].text).toContain('id ANY_OF [9]');
    });
});

describe('repository registration', () => {
    const schema = { customers: customerConfig, salesOrders: salesOrderConfig };

    it('constructs the registered subclass for its set and a plain RecordSet for the others', () => {
        const db = createNetSuiteContext(schema, { repositories: { customers: CustomerRepository } });
        expect(db.customers).toBeInstanceOf(CustomerRepository);
        expect(db.salesOrders).toBeInstanceOf(RecordSet);
        expect(db.salesOrders).not.toBeInstanceOf(CustomerRepository);
        expect(db.set('customers')).toBe(db.customers);

        fakeNQuery.queueRows('customer', [{ id: 7, name: 'Acme', email: 'a@x' }]);
        expect(db.customers.findByName('Acme')).toMatchObject({ id: 7 });
        expect(db.customers.listContactable()).toEqual([]);
    });

    it('shares the context change tracker with a registered repository', () => {
        const db = createNetSuiteContext(schema, { repositories: { customers: CustomerRepository } });
        expect(db.customers.changeTracker).toBe(db.changeTracker);
        expect(db.customers.name).toBe('customers');

        fakeNQuery.queueRows('customer', [{ id: 7, name: 'Acme', email: 'a@x' }]);
        const customer = db.customers.findByName('Acme') as Customer;
        expect(db.entry(customer)).toBeDefined();
        expect(db.customers.find(7)).toBe(customer);
    });

    it('honours tracking: false alongside repositories', () => {
        const db = createNetSuiteContext(schema, { tracking: false, repositories: { customers: CustomerRepository } });
        fakeNQuery.queueRows('customer', [{ id: 7, name: 'Acme', email: 'a@x' }]);
        const customer = db.customers.findByName('Acme') as Customer;
        expect(db.entry(customer)).toBeUndefined();
        expect(db.options).toEqual({ tracking: false });
    });
});
