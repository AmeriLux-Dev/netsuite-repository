import { Column, Entity, Key, NotMapped, OwnsOne, RecordField, RestMetadata, compileEntityModel, configFromEntity, isEntityClass, isRootEntityClass, resolveDecoratedEntityMetadata, resolveQueryConfig } from '../model';
import { customerConfig } from './fixtures';
import { DecoratedCustomer, DecoratedSalesOrder, DecoratedSalesOrderLine, buildSalesOrderMetadata, uppercaseTransform } from './model-fixtures';

describe('configFromEntity() – decorated classes', () => {
    it('compiles the decorated sales order to the same config as the hand-built metadata', () => {
        expect(configFromEntity(DecoratedSalesOrder)).toEqual(compileEntityModel(buildSalesOrderMetadata()));
    });

    it('caches the compiled config per class', () => {
        expect(configFromEntity(DecoratedSalesOrder)).toBe(configFromEntity(DecoratedSalesOrder));
    });

    it('applies the remaining decorators and inherits base-class properties', () => {
        const config = configFromEntity(DecoratedCustomer);

        expect(config.recordType).toBe('customer');
        expect(config.query.from).toEqual({ name: 'customer', alias: 'customer' });
        expect(config.coerce).toBe(false);
        expect(config.updaterOptions).toEqual({ requireFastPath: true });
        expect(config.fields.id).toEqual({ queryFieldId: 'id', tableAlias: 'customer', type: 'integer', isPrimary: true, readonly: true });
        expect(config.fields.companyName).toEqual({ queryFieldId: 'companyname', tableAlias: 'customer', type: 'string', alias: 'name', recordFieldId: 'companyname', setFirst: true });
        expect(config.fields.status).toEqual({ queryFieldId: 'entitystatus', tableAlias: 'customer', type: 'string', useText: true, transform: uppercaseTransform, select: false, readonly: true });
        expect(config.fields.lastModified).toEqual({ queryFieldId: 'lastmodifieddate', tableAlias: 'customer', type: 'date', readonly: true });
        expect(config.fields.cachedLabel).toBeUndefined();
    });

    it('names the metadata after the class and keeps the explicit set name separate', () => {
        expect(resolveDecoratedEntityMetadata(DecoratedCustomer).name).toBe('DecoratedCustomer');
        expect(resolveDecoratedEntityMetadata(DecoratedCustomer).setName).toBeUndefined();
        expect(resolveDecoratedEntityMetadata(DecoratedSalesOrder).name).toBe('DecoratedSalesOrder');
        expect(resolveDecoratedEntityMetadata(DecoratedSalesOrder).setName).toBe('salesOrders');
    });

    it('distinguishes root entity classes from nested classes', () => {
        expect(isRootEntityClass(DecoratedSalesOrder)).toBe(true);
        expect(isRootEntityClass(DecoratedSalesOrderLine)).toBe(false);
        expect(isRootEntityClass(customerConfig)).toBe(false);
    });

    it('rejects classes without @Entity', () => {
        class Plain {}
        expect(() => configFromEntity(Plain)).toThrow("Class 'Plain' is not decorated with @Entity.");
        expect(() => configFromEntity(DecoratedSalesOrderLine)).toThrow("Class 'DecoratedSalesOrderLine' is not decorated with @Entity.");
    });

    it('rejects navigations pointing at classes without decorated properties', () => {
        class EmptyAddress {}

        @Entity({ recordType: 'salesorder', table: 'transaction' })
        class Broken {
            @Key() id!: number;
            @OwnsOne(() => EmptyAddress, { subrecord: 'shippingaddress', from: 'transaction' }) shippingAddress!: EmptyAddress;
        }

        expect(() => configFromEntity(Broken)).toThrow("Class 'EmptyAddress' used by 'Broken.shippingAddress' declares no decorated properties.");
    });

    it('rejects symbol property keys', () => {
        const symbolKey = Symbol('hidden');
        expect(() => {
            class WithSymbol {
                [symbolKey]!: string;
            }
            Column('x')(WithSymbol.prototype, symbolKey);
        }).toThrow("Symbol properties cannot be mapped on 'WithSymbol'.");
    });

    it('surfaces compiler validation for decorated classes', () => {
        @Entity({ recordType: 'customer', table: 'customer' })
        @RestMetadata({ recordType: 'customer' })
        class NoKey {
            @Column('companyname') @RecordField() companyName!: string;
        }

        expect(() => configFromEntity(NoKey)).toThrow("Model 'NoKey' is invalid");
        expect(resolveDecoratedEntityMetadata(NoKey).restRecordMetadata).toEqual({ recordType: 'customer' });
    });

    it('lets a subclass override an inherited navigation and add nested fields via additional mappings', () => {
        class Address {
            @RecordField('addr1') addr1!: string;
        }

        @Entity({ recordType: 'vendorbill', table: 'transaction', alias: 'txn' })
        class Bill {
            @Key() id!: number;
            @OwnsOne(() => Address, { subrecord: 'billingaddress', from: 'txn', fields: { line1: 'billingAddress_addr1' } }) billingAddress!: Address;
        }

        class BillWithReload extends Bill {
            @OwnsOne(() => Address, { subrecord: 'billingaddress', clearListField: 'billaddresslist', from: 'txn' }) billingAddress!: Address;
        }

        expect(configFromEntity(Bill).relationships?.billingAddress).toEqual({ kind: 'owned', recordAccessId: 'billingaddress', fields: { addr1: 'billingAddress_addr1', line1: 'billingAddress_addr1' } });
        expect(configFromEntity(BillWithReload).relationships?.billingAddress).toEqual({ kind: 'owned', recordAccessId: 'billingaddress', fields: { addr1: 'billingAddress_addr1' }, reload: { listFieldToClear: 'billaddresslist' } });
    });
});

describe('isEntityClass() and resolveQueryConfig()', () => {
    it('recognizes decorated classes only', () => {
        expect(isEntityClass(DecoratedSalesOrder)).toBe(true);
        expect(isEntityClass(class Plain {})).toBe(false);
        expect(isEntityClass(customerConfig)).toBe(false);
        expect(isEntityClass(null)).toBe(false);
    });

    it('resolves classes through configFromEntity and configs through normalizeQueryConfig', () => {
        expect(resolveQueryConfig(DecoratedSalesOrder)).toBe(configFromEntity(DecoratedSalesOrder));
        expect(resolveQueryConfig(customerConfig)).toEqual(customerConfig);
        expect(resolveQueryConfig({ ...customerConfig, fields: { id: { query: { queryFieldId: 'id', tableAlias: 'cust' }, common: { isPrimary: true } } } }).fields.id).toEqual({ queryFieldId: 'id', tableAlias: 'cust', isPrimary: true });
    });
});

describe('@NotMapped() on nested classes', () => {
    it('excludes ignored nested properties from the navigation', () => {
        class Address {
            @RecordField('addr1') addr1!: string;
            @NotMapped() formatted!: string;
        }

        @Entity({ recordType: 'vendorbill', table: 'transaction', alias: 'txn' })
        class Bill {
            @Key() id!: number;
            @OwnsOne(() => Address, { subrecord: 'billingaddress', from: 'txn' }) billingAddress!: Address;
        }

        const config = configFromEntity(Bill);
        expect(Object.keys(config.fields)).toEqual(['id', 'billingAddress_addr1']);
    });
});
