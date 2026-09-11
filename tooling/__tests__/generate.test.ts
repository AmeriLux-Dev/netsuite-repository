import * as nodeFileSystem from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as ts from 'typescript';
import { defaultBuildConfig } from '../config';
import type { BuildConfig } from '../config';
import { createNodeFileSystemAdapter, toPosixPath } from '../file-system';
import { checkGenerated, planGeneration, runGenerate, toRecordSetName } from '../generate';
import { createModelTypeProgram, readCompilerOptionsFromTsconfig, readDeclaredClass } from '../collect/property-type-reader';

const repositoryRoot = nodePath.resolve(__dirname, '..', '..');
const fixturesRoot = nodePath.join(__dirname, 'fixtures');
const fileSystem = createNodeFileSystemAdapter();
const compilerOptions: ts.CompilerOptions = {
    baseUrl: repositoryRoot,
    paths: { '@amerilux/netsuite-repository': ['src/index.ts'], 'N/*': ['node_modules/@hitc/netsuite-types/N/*'] },
};

function createTemporaryOutDir(): string {
    return nodeFileSystem.mkdtempSync(nodePath.join(os.tmpdir(), 'netsuite-repository-generate-'));
}

function buildConfig(models: string[], outDir: string, overrides: Partial<BuildConfig> = {}): BuildConfig {
    return { ...defaultBuildConfig, context: { ...defaultBuildConfig.context }, models, outDir, ...overrides };
}

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        nodeFileSystem.rmSync(directory, { recursive: true, force: true });
    }
});

describe('toRecordSetName()', () => {
    it('camel-cases and pluralizes model names', () => {
        expect(toRecordSetName('SalesOrder')).toBe('salesOrders');
        expect(toRecordSetName('Category')).toBe('categories');
        expect(toRecordSetName('Day')).toBe('days');
        expect(toRecordSetName('Address')).toBe('addresses');
        expect(toRecordSetName('Box')).toBe('boxes');
    });
});

describe('planGeneration() – model fixtures', () => {
    const outDir = createTemporaryOutDir();
    temporaryDirectories.push(outDir);
    const plan = planGeneration({
        config: buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir, { repositories: 'classes' }),
        cwd: repositoryRoot,
        fileSystem,
        compilerOptions,
        version: '0.0.0-test',
    });
    const fileByName = new Map(plan.files.map((file) => [nodePath.basename(file.path), file.content]));
    const salesOrderConfig = fileByName.get('SalesOrder.gen.ts') as string;

    it('reports no diagnostics, one record set per @RecordType class, and one generated file per class', () => {
        expect(plan.diagnostics).toEqual([]);
        expect(plan.models).toEqual([
            expect.objectContaining({ modelName: 'Customer', setName: 'customers' }),
            expect.objectContaining({ modelName: 'InventoryItem', setName: 'inventoryItems' }),
            expect.objectContaining({ modelName: 'SalesOrder', setName: 'salesOrders' }),
            expect.objectContaining({ modelName: 'TransactionLine', setName: 'transactionLines' }),
        ]);
        expect(Array.from(fileByName.keys()).sort()).toEqual([
            'Customer.gen.ts', 'InventoryItem.gen.ts', 'SalesOrder.gen.ts',
            'Transaction.gen.ts', 'TransactionAddress.gen.ts', 'TransactionLine.gen.ts',
            'context.gen.ts', 'types.gen.ts',
        ]);
    });

    it('emits a type-only barrel: every interface, plus the helper types of record types, sorted by class name', () => {
        const types = fileByName.get('types.gen.ts') as string;
        expect(types).toContain("export type { Customer, CustomerCreate, CustomerPatch } from './Customer.gen';\nexport type { InventoryItem, InventoryItemCreate, InventoryItemPatch } from './InventoryItem.gen';\nexport type { SalesOrder, SalesOrderCreate, SalesOrderPatch } from './SalesOrder.gen';\nexport type { Transaction } from './Transaction.gen';\nexport type { TransactionAddress } from './TransactionAddress.gen';\nexport type { TransactionLine, TransactionLineCreate, TransactionLinePatch } from './TransactionLine.gen';\n");
        expect(types).not.toContain('import ');
        expect(types).not.toContain('Config');
    });

    it('leaves the type barrel out when the config switches it off', () => {
        const config = buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir);
        const withoutBarrel = planGeneration({ config: { ...config, types: { ...config.types, emit: false } }, cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' });
        expect(withoutBarrel.diagnostics).toEqual([]);
        expect(withoutBarrel.files.some((file) => file.path.endsWith('types.gen.ts'))).toBe(false);
        expect(withoutBarrel.files.some((file) => file.path.endsWith('context.gen.ts'))).toBe(true);
    });

    it('maps every property from the model: lowercased field id, query field id equal to it, type from the declaration', () => {
        expect(salesOrderConfig).toContain("recordType: 'salesorder',\n    queryType: 'salesorder',");
        expect(salesOrderConfig).toMatch(/id: \{\n\s+queryFieldId: 'id',\n\s+type: 'key',\n\s+isPrimary: true,\n\s+readonly: true,/);
        expect(salesOrderConfig).toMatch(/tranDate: \{[^}]*queryFieldId: 'trandate'[^}]*type: 'date'[^}]*recordFieldId: 'trandate'/);
        expect(salesOrderConfig).toMatch(/memo: \{[^}]*queryFieldId: 'memo'[^}]*recordFieldId: 'memo'/);
        expect(salesOrderConfig).toMatch(/approved: \{[^}]*queryFieldId: 'custbody_approved'[^}]*type: 'boolean'[^}]*recordFieldId: 'custbody_approved'/);
        // The select field behind a reference is a select; the internal id a key; both compare through ANY_OF.
        expect(salesOrderConfig).toMatch(/customerId: \{[^}]*queryFieldId: 'entity'[^}]*type: 'select'[^}]*recordFieldId: 'entity'/);
        expect(salesOrderConfig).toMatch(/shipMethodId: \{[^}]*queryFieldId: 'shipmethod'[^}]*type: 'float'[^}]*recordFieldId: 'shipmethod'/);
        expect(salesOrderConfig).toMatch(/tranId: \{[^}]*transform: uppercaseText,\n\s+recordFieldId: 'tranid'/);
        expect(salesOrderConfig).toMatch(/import \{ trimText, uppercaseText \} from '.*fixtures\/models\/shared';/);
        expect(salesOrderConfig).not.toMatch(/cachedLabel: \{/);
        expect(salesOrderConfig).toContain('    cachedLabel?: string;');
        expect(salesOrderConfig).not.toContain('discriminator');
        expect(salesOrderConfig).not.toContain('tableAlias');
        expect(fileByName.get('InventoryItem.gen.ts')).toContain("recordType: 'inventoryitem',\n    queryType: 'inventoryitem',");
    });

    it('applies the opt-outs: @ReadOnly, text fields, and the internal id are read-only, and text reads in DISPLAY context', () => {
        expect(salesOrderConfig).toMatch(/total: \{[^}]*queryFieldId: 'foreigntotal'[^}]*readonly: true/);
        expect(salesOrderConfig).not.toMatch(/total: \{[^}]*recordFieldId/);
        expect(salesOrderConfig).toMatch(/statusText: \{[^}]*queryFieldId: 'status'[^}]*fieldContext: 'DISPLAY'[^}]*readonly: true/);
    });

    it('joins a projected reference through its select field with joinTo and selects only the projected read-only fields', () => {
        expect(salesOrderConfig).toContain("        customer: {\n            path: 'customer',\n            relationship: 'customer',\n            load: 'join',\n            join: {\n                kind: 'to',\n                fieldId: 'entity',\n                target: 'customer',\n            },\n        },");
        expect(salesOrderConfig).toMatch(/customer_companyName: \{[^}]*component: 'customer'[^}]*transform: trimText[^}]*nestPath: 'customer.companyName'[^}]*readonly: true/);
        expect(salesOrderConfig).not.toContain('customer_email');
        expect(salesOrderConfig).toContain("customer: {\n            kind: 'reference',\n            fields: {\n                id: 'customer_id',\n                companyName: 'customer_companyName',\n            },\n            components: [\n                'customer',\n            ],\n            load: 'join',\n        },");
    });

    it('maps both subrecords from one class, with the field id from the property, the join left to N/query, and the list field declared', () => {
        expect(salesOrderConfig).toContain("        shippingAddress: {\n            path: 'shippingAddress',\n            relationship: 'shippingAddress',\n            load: 'join',\n            join: {\n                kind: 'auto',\n                fieldId: 'shippingaddress',\n            },\n        },");
        expect(salesOrderConfig).toContain("        billingAddress: {\n            path: 'billingAddress',\n            relationship: 'billingAddress',\n            load: 'join',\n            join: {\n                kind: 'auto',\n                fieldId: 'billingaddress',\n            },\n        },");
        expect(salesOrderConfig).toMatch(/shippingAddress_state: \{[^}]*setFirst: true,\n\s+nestPath: 'shippingAddress.state',\n\s+recordFieldId: 'state',\n\s+recordAccess: 'subrecord',\n\s+recordAccessId: 'shippingaddress',\n\s+subrecordNeedsReload: true,\n\s+subrecordListFieldToClear: 'shipaddresslist'/);
        expect(salesOrderConfig).toMatch(/billingAddress_city: \{[^}]*recordAccessId: 'billingaddress'[^}]*subrecordListFieldToClear: 'billaddresslist'/);
        expect(salesOrderConfig).toContain("shippingAddress: {\n            kind: 'subrecord',\n            recordAccessId: 'shippingaddress',");
        expect(salesOrderConfig).toContain("reload: {\n                listFieldToClear: 'billaddresslist',\n            },");
        expect(salesOrderConfig).not.toContain('nkey');
    });

    it('maps the sublist through the line class parent id, with the declared filter, the line key, and a nested reference under it', () => {
        expect(salesOrderConfig).toContain("        lines: {\n            path: 'lines',\n            relationship: 'lines',\n            load: 'join',\n            join: {\n                kind: 'from',\n                fieldId: 'transaction',\n                source: 'transactionline',\n            },\n            conditions: [\n                {\n                    fieldId: 'mainline',\n                    operator: 'IS',\n                    values: [\n                        false,\n                    ],\n                },\n            ],\n            lineOrderFieldId: 'id',\n        },");
        expect(salesOrderConfig).toContain("        'lines.item': {\n            path: 'lines.item',\n            parent: 'lines',\n            relationship: 'lines',\n            load: 'join',\n            join: {\n                kind: 'to',\n                fieldId: 'item',\n                target: 'inventoryitem',\n            },\n        },");
        expect(salesOrderConfig).toMatch(/lines_id: \{[^}]*queryFieldId: 'id',\n\s+component: 'lines',[^}]*cardinality: 'many',\n\s+recordFieldId: 'line',\n\s+recordAccess: 'sublist',\n\s+recordAccessId: 'item',\n\s+updateMapping: \{\n\s+kind: 'sublist',\n\s+sublistId: 'item',\n\s+fieldId: 'line',\n\s+matchBy: 'line',/);
        expect(salesOrderConfig).toMatch(/lines_quantity: \{[^}]*recordFieldId: 'quantity'[^}]*updateMapping: \{[^}]*fieldId: 'quantity',\n\s+matchBy: 'line'/);
        expect(salesOrderConfig).toMatch(/lines_amount: \{[^}]*readonly: true,\n\s+recordAccess: 'sublist'/);
        expect(salesOrderConfig).toMatch(/lines_transactionId: \{[^}]*queryFieldId: 'transaction'[^}]*readonly: true/);
        expect(salesOrderConfig).toMatch(/lines_notes: \{[^}]*select: false/);
        expect(salesOrderConfig).toMatch(/lines_item_displayName: \{[^}]*component: 'lines.item'[^}]*nestPath: 'lines.item.displayName',\n\s+cardinality: 'many',\n\s+readonly: true/);
        expect(salesOrderConfig).toContain("lines: {\n            kind: 'sublist',\n            recordAccessId: 'item',\n            fields: {\n                id: 'lines_id',\n                transactionId: 'lines_transactionId',\n                itemId: 'lines_itemId',\n                quantity: 'lines_quantity',\n                amount: 'lines_amount',\n                notes: 'lines_notes',\n                'item.itemId': 'lines_item_itemId',\n                'item.displayName': 'lines_item_displayName',\n            },\n            components: [\n                'lines',\n                'lines.item',\n            ],\n            load: 'join',\n            matchField: 'id',\n        },");
    });

    it('carries separate loads, a reference matched on a code field, and a subrecord loaded on its own', () => {
        const joins = planGeneration({ config: buildConfig(['tooling/__tests__/fixtures/joins/*.ts'], outDir), cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' });
        expect(joins.diagnostics).toEqual([]);
        const invoiceConfig = joins.files.find((file) => file.path.endsWith('Invoice.gen.ts'))?.content as string;
        const warehouseConfig = joins.files.find((file) => file.path.endsWith('Warehouse.gen.ts'))?.content as string;
        expect(invoiceConfig).toContain("        carrier: {\n            path: 'carrier',\n            relationship: 'carrier',\n            load: 'separate',\n            join: {\n                kind: 'to',\n                fieldId: 'custbody_carrier_code',\n                target: 'customrecord_carrier',\n            },\n            separate: {\n                queryType: 'customrecord_carrier',\n                parentKeyField: 'carrierCode',\n                targetKeyFieldId: 'custrecord_carrier_code',\n                targetKeyFieldType: 'string',\n            },\n        },");
        expect(invoiceConfig).toMatch(/lines: \{\n\s+path: 'lines',\n\s+relationship: 'lines',\n\s+load: 'separate',/);
        expect(invoiceConfig).toContain("        'lines.location': {\n            path: 'lines.location',\n            parent: 'lines',\n            relationship: 'lines',\n            load: 'separate',");
        expect(invoiceConfig).toContain("        'lines.location.mainAddress': {\n            path: 'lines.location.mainAddress',\n            parent: 'lines.location',\n            relationship: 'lines',\n            load: 'separate',\n            join: {\n                kind: 'auto',\n                fieldId: 'mainaddress',\n            },\n        },");
        expect(invoiceConfig).toMatch(/billingAddress: \{\n\s+path: 'billingAddress',\n\s+relationship: 'billingAddress',\n\s+load: 'separate',/);
        // A sublist with a query type of its own: autoJoin on that root, matched to the owner by internal id.
        expect(invoiceConfig).toContain("        expenses: {\n            path: 'expenses',\n            relationship: 'expenses',\n            load: 'separate',\n            join: {\n                kind: 'auto',\n                fieldId: 'transactionlines',\n            },\n            separate: {\n                queryType: 'transaction',\n                parentKeyField: 'id',\n                targetKeyFieldId: 'id',\n                targetKeyFieldType: 'key',\n            },");
        expect(invoiceConfig).toMatch(/carrier: \{\n\s+kind: 'reference',[\s\S]*?load: 'separate',/);
        // A reference by internal id that asks to load separately matches the target's id against the select field values.
        expect(invoiceConfig).toContain("        location: {\n            path: 'location',\n            relationship: 'location',\n            load: 'separate',\n            join: {\n                kind: 'to',\n                fieldId: 'location',\n                target: 'location',\n            },\n            separate: {\n                queryType: 'location',\n                parentKeyField: 'locationId',\n                targetKeyFieldId: 'id',\n                targetKeyFieldType: 'key',\n            },\n        },");
        expect(warehouseConfig).toContain("        mainAddress: {\n            path: 'mainAddress',\n            relationship: 'mainAddress',\n            load: 'join',\n            join: {\n                kind: 'auto',\n                fieldId: 'mainaddress',\n            },\n        },");
        // A has-many joined from the child's @ParentId() field and loaded separately runs on the child's type, batched on that field.
        expect(invoiceConfig).toContain("        shipments: {\n            path: 'shipments',\n            relationship: 'shipments',\n            load: 'separate',\n            join: {\n                kind: 'from',\n                fieldId: 'custrecord_shipment_invoice',\n                source: 'customrecord_shipment',\n            },\n            separate: {\n                queryType: 'customrecord_shipment',\n                parentKeyField: 'id',\n                targetKeyFieldId: 'custrecord_shipment_invoice',\n                targetKeyFieldType: 'select',\n            },\n            lineOrderFieldId: 'id',\n        },");
    });

    it('emits one interface per class, extending the base and importing referenced types', () => {
        expect(salesOrderConfig).toContain('//   Generated type, config, field paths, base repository for the SalesOrder model.');
        expect(salesOrderConfig).toContain("import { RecordSet } from '@amerilux/netsuite-repository';\nimport type { EntityCreate, EntityPatch, QueryConfig, QueryConfigSource, RecordSetOptions } from '@amerilux/netsuite-repository';\nimport type { Customer } from './Customer.gen';\nimport type { Transaction } from './Transaction.gen';\nimport type { TransactionLine } from './TransactionLine.gen';");
        expect(salesOrderConfig).toContain([
            'export interface SalesOrder extends Transaction {',
            '    poNumber: string | null;',
            '    approved: boolean;',
            '    shipMethodId: number | null;',
            '    total: number;',
            '    cachedLabel?: string;',
            "    customer?: Pick<Customer, 'id' | 'companyName'>;",
            '    lines: TransactionLine[];',
            '}',
            '',
            '/** What `update()` takes for a SalesOrder: a deep partial; subrecords merge, sublists take { update, add, remove }. */',
            'export type SalesOrderPatch = EntityPatch<SalesOrder>;',
            '/** What `create()` takes for a SalesOrder: a deep partial with sublists as arrays of partial lines. */',
            'export type SalesOrderCreate = EntityCreate<SalesOrder>;',
        ].join('\n'));
        expect(fileByName.get('Transaction.gen.ts')).toContain("import type { TransactionAddress } from './TransactionAddress.gen';\n\nexport interface Transaction {\n    id: number;\n    tranId: string;\n    tranDate: Date;\n    memo?: string | null;\n    customerId: number;\n    statusText: string;\n    shippingAddress: TransactionAddress;\n    billingAddress?: TransactionAddress;\n}\n");
        expect(fileByName.get('Transaction.gen.ts')).not.toContain('EntityPatch');
        expect(fileByName.get('TransactionAddress.gen.ts')).toContain('export interface TransactionAddress {\n    addr1: string | null;\n    city: string | null;\n    state: string | null;\n}');
        expect(fileByName.get('TransactionLine.gen.ts')).toContain("export interface TransactionLine {\n    id: number;\n    transactionId: number;\n    itemId: number;\n    quantity: number;\n    amount: number;\n    notes: string | null;\n    item?: Pick<InventoryItem, 'itemId' | 'displayName'>;\n}");
        expect(fileByName.get('Customer.gen.ts')).toContain('export interface Customer {\n    id: number;\n    companyName: string;\n    email: string | null;\n    isInactive: boolean;\n    categoryIds: number[];\n}');
        expect(fileByName.get('Customer.gen.ts')).toMatch(/categoryIds: \{[^}]*type: 'multiselect'/);
    });

    it('emits the context wiring every record type', () => {
        const context = fileByName.get('context.gen.ts') as string;
        expect(context).toContain('export const AppSchema = {\n    customers: CustomerConfig,\n    inventoryItems: InventoryItemConfig,\n    salesOrders: SalesOrderConfig,\n    transactionLines: TransactionLineConfig,\n};');
        expect(context).toContain('export const AppRepositories = {\n    customers: CustomerRepositoryBase,\n    inventoryItems: InventoryItemRepositoryBase,\n    salesOrders: SalesOrderRepositoryBase,\n    transactionLines: TransactionLineRepositoryBase,\n};');
        expect(context).toContain('export type AppContext<TRepositories extends AppRepositoryMap = {}> = NetSuiteContextInstance<typeof AppSchema, MergeRepositories<typeof AppRepositories, TRepositories>>;');
        expect(context).toContain('export function createAppContext<TRepositories extends AppRepositoryMap = {}>(options: ContextFactoryOptions<TRepositories> = {}): AppContext<TRepositories> {');
        expect(context).toContain('export const dbContext: DbContext = {\n    get customers() { return getReadOnlyAppContext().customers; },\n    get inventoryItems() { return getReadOnlyAppContext().inventoryItems; },\n    get salesOrders() { return getReadOnlyAppContext().salesOrders; },\n    get transactionLines() { return getReadOnlyAppContext().transactionLines; },\n    withTracking,\n};');
        expect(context).not.toContain('UnitOfWork');
    });

    it('emits a fields constant per record type with the path of every field, nested by relation', () => {
        expect(salesOrderConfig).toContain([
            'export const SalesOrderFields = {',
            "    id: 'id',",
            "    tranId: 'tranId',",
            "    tranDate: 'tranDate',",
            "    memo: 'memo',",
            "    customerId: 'customerId',",
            "    statusText: 'statusText',",
            "    poNumber: 'poNumber',",
            "    approved: 'approved',",
            "    shipMethodId: 'shipMethodId',",
            "    total: 'total',",
            '    shippingAddress: {',
            "        addr1: 'shippingAddress.addr1',",
            "        city: 'shippingAddress.city',",
            "        state: 'shippingAddress.state',",
            '    },',
            '    billingAddress: {',
            "        addr1: 'billingAddress.addr1',",
            "        city: 'billingAddress.city',",
            "        state: 'billingAddress.state',",
            '    },',
            '    customer: {',
            "        id: 'customer.id',",
            "        companyName: 'customer.companyName',",
            '    },',
            '    lines: {',
            "        id: 'lines.id',",
            "        transactionId: 'lines.transactionId',",
            "        itemId: 'lines.itemId',",
            "        quantity: 'lines.quantity',",
            "        amount: 'lines.amount',",
            "        notes: 'lines.notes',",
            '        item: {',
            "            itemId: 'lines.item.itemId',",
            "            displayName: 'lines.item.displayName',",
            '        },',
            '    },',
            '} as const;',
        ].join('\n'));
        expect(salesOrderConfig).not.toContain("cachedLabel: 'cachedLabel'");
    });

    it('leaves the repository bases out by default and emits the plain context factory', () => {
        const plain = planGeneration({ config: buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir), cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' });
        expect(plain.diagnostics).toEqual([]);
        expect(plain.files.find((file) => file.path.endsWith('SalesOrder.gen.ts'))?.content).not.toContain('RepositoryBase');
        const context = plain.files.find((file) => file.path.endsWith('context.gen.ts'))?.content as string;
        expect(context).toContain('export type AppContext = NetSuiteContextInstance<typeof AppSchema>;');
        expect(context).toContain('export function createAppContext(options?: NetSuiteContextOptions): AppContext {\n    return createNetSuiteContext(AppSchema, options);\n}');
        expect(context).toContain("withTracking(options?: Omit<NetSuiteContextOptions, 'tracking'>): AppContext;");
        expect(context).toContain('export const dbContext: DbContext = {');
        expect(context).not.toContain('UnitOfWork');
        expect(context).not.toContain('AppRepositories');
    });

    it('emits a base repository per record type, bound to its config, when the config asks for classes', () => {
        expect(salesOrderConfig).toContain([
            'export class SalesOrderRepositoryBase extends RecordSet<SalesOrder> {',
            '    constructor(source: QueryConfigSource<SalesOrder> = SalesOrderConfig, options?: RecordSetOptions) {',
            '        super(source, options);',
            '    }',
            '}',
        ].join('\n'));
        expect(fileByName.get('Transaction.gen.ts')).not.toContain('RepositoryBase');
    });
});

describe('runGenerate() and checkGenerated()', () => {
    const outDir = createTemporaryOutDir();
    temporaryDirectories.push(outDir);
    const options = { config: buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir, { repositories: 'classes' }), cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' };

    it('writes every file once and reports them unchanged on the second run', () => {
        const first = runGenerate(options);
        expect(first.writtenFiles).toHaveLength(8);
        expect(first.unchangedFiles).toEqual([]);
        expect(nodeFileSystem.existsSync(nodePath.join(outDir, 'SalesOrder.gen.ts'))).toBe(true);

        const second = runGenerate(options);
        expect(second.writtenFiles).toEqual([]);
        expect(second.unchangedFiles).toHaveLength(8);
    });

    it('detects drift and missing files without writing', () => {
        const contextPath = nodePath.join(outDir, 'context.gen.ts');
        const typesPath = nodePath.join(outDir, 'Customer.gen.ts');
        nodeFileSystem.writeFileSync(contextPath, '// edited by hand\n');
        nodeFileSystem.unlinkSync(typesPath);

        const result = checkGenerated(options);

        expect(result.driftedFiles).toEqual([contextPath]);
        expect(result.missingFiles).toEqual([typesPath]);
        expect(nodeFileSystem.readFileSync(contextPath, 'utf8')).toBe('// edited by hand\n');
    });

    it('produces generated files that the TypeScript compiler accepts against the runtime', () => {
        runGenerate(options);
        const generatedFiles = nodeFileSystem.readdirSync(outDir).map((name) => nodePath.join(outDir, name));
        const program = ts.createProgram({
            rootNames: generatedFiles.map(toPosixPath),
            options: { ...compilerOptions, target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, strict: true, skipLibCheck: true, noEmit: true, experimentalDecorators: true },
        });
        const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        expect(diagnostics).toEqual([]);
    });

    it('resolves compiler options from a tsconfig when configured', () => {
        const tsconfigOptions = readCompilerOptionsFromTsconfig(nodePath.join(repositoryRoot, 'tsconfig.json'));
        expect(tsconfigOptions.experimentalDecorators).toBe(true);
        expect(() => readCompilerOptionsFromTsconfig(nodePath.join(repositoryRoot, 'does-not-exist.json'))).toThrow('Could not read tsconfig');

        const withTsconfig = planGeneration({ ...options, config: { ...options.config, tsconfig: 'tsconfig.json' } });
        expect(withTsconfig.diagnostics).toEqual([]);
    });
});

describe('planGeneration() – diagnostics', () => {
    const outDir = createTemporaryOutDir();
    temporaryDirectories.push(outDir);

    function planFor(models: string[]) {
        return planGeneration({ config: buildConfig(models, outDir), cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' });
    }

    it('rejects Node imports and unresolved relative imports in model files', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/BadImport.ts', 'tooling/__tests__/fixtures/broken/MissingRelative.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ filePath: expect.stringContaining('BadImport.ts'), message: "Model files may only import '@amerilux/netsuite-repository' or relative model files; found 'fs'." }),
            expect.objectContaining({ filePath: expect.stringContaining('MissingRelative.ts'), message: expect.stringContaining("Cannot resolve relative import './does-not-exist'") }),
        ]);
        expect(plan.files).toEqual([]);
    });

    it('reports properties whose TypeScript type is neither a field type nor a model class, and still emits the rest', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/Unmappable.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'Unmappable', message: "Property 'Unmappable.extra' has type 'Map<string, string>', which does not map to a NetSuite field type. Declare it with @Field({ type }), type it as a model class, or mark it @NotMapped()." }),
        ]);
        expect(plan.files.map((file) => nodePath.basename(file.path))).toEqual(['Unmappable.gen.ts', 'types.gen.ts']);
    });

    it('reports transforms that are not exported', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/HiddenFunction.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'HiddenFunction', message: expect.stringContaining("Function at '$.fields.name.transform' must be exported") }),
        ]);
    });

    it('reports a record type without an internal id', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/InvalidModel.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'InvalidModel', message: "Record type 'InvalidModel' has no internal id property; declare 'id' or mark one with @InternalId()." }),
        ]);
        expect(plan.models).toEqual([]);
    });

    it('reports every way a reference, subrecord, or sublist can be declared wrong', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/BadRelations.ts']);
        expect(plan.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "Property 'BadRelations.ghostParent' has type 'Map<string, string>', which does not map to a NetSuite field type. Declare it with @Field({ type }), type it as a model class, or mark it @NotMapped().",
            "Property 'BadRelations.ghostParent' is marked @ParentId() but is not a mapped field.",
            "Sublist 'BadRelations.notes' ('notes') is typed as 'Note', which has no @RecordType; a line class names its record type, or the property names the relationship with @Sublist('notes', { relationship }).",
            "Sublist 'BadRelations.children' ('children') has no way back to its parent: mark the property of 'ChildLine' holding the parent's internal id with @ParentId(), or name the relationship with @Sublist('children', { relationship }).",
            "Reference 'BadRelations.owner' needs a select field: declare 'ownerId', name one with @Reference('<property>'), or mark the property @Subrecord() if it is one.",
            "Reference 'BadRelations.detail' targets 'Note', which has no @RecordType; a reference needs a query type.",
            "Property 'BadRelations.line' is marked @Sublist() but is not an array.",
            "Property 'BadRelations.tags' is an array; use @Sublist() on it, @Subrecord() and @Reference() apply to object properties.",
            "Sublist 'BadRelationsOwner.parents' ('parents') has no way back to its parent: mark the property of 'BadRelations' holding the parent's internal id with @ParentId(), or name the relationship with @Sublist('parents', { relationship }).",
            "Reference 'BadRelationsOwner.parent' needs a select field: declare 'parentId', name one with @Reference('<property>'), or mark the property @Subrecord() if it is one.",
            "Sublist 'BadRelationsOwner.joinedElsewhere' ('lines') names a query type ('transaction') for its own query, which cannot be joined into the owner's. Remove load: 'join'.",
            "Reference 'BadTargetKey.owner' matches on 'BadRelationsOwner.ghost', which is not a mapped field.",
            "Reference 'BadTargetKey.joined' matches on 'BadRelationsOwner.id' and must load separately; N/query joins only through the target's internal id. Remove load: 'join'.",
        ]);
    });

    it('reports a reference that loads its own class without a projection', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/Cycle.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'CycleCustomer', message: "Property 'CycleCustomer.parent' brings 'CycleCustomer' back into itself; project it with Pick<CycleCustomer, ...> to cut the cycle." }),
        ]);
    });

    it('reports duplicate model names across files', () => {
        const plan = planFor(['tooling/__tests__/fixtures/duplicates/*.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ filePath: expect.stringContaining('Second.ts'), message: expect.stringContaining("Model name 'Duplicate' is already used in") }),
        ]);
        expect(plan.models).toHaveLength(1);
    });

    it('reports a diagnostic instead of silently producing nothing when no model files match', () => {
        const plan = planFor(['tooling/__tests__/fixtures/none/**/*.ts']);
        expect(plan.files).toEqual([]);
        expect(plan.models).toEqual([]);
        expect(plan.diagnostics).toEqual([
            { filePath: repositoryRoot, message: expect.stringContaining("No model files matched the 'models' globs (tooling/__tests__/fixtures/none/**/*.ts)") },
        ]);
    });
});

describe('readDeclaredClass()', () => {
    const modelFile = nodePath.join(fixturesRoot, 'models', 'SalesOrder.ts');
    const program = createModelTypeProgram([modelFile, nodePath.join(fixturesRoot, 'models', 'Customer.ts')], compilerOptions);

    it('returns undefined for unknown files and exports', () => {
        expect(readDeclaredClass(program, nodePath.join(fixturesRoot, 'models', 'Missing.ts'), 'SalesOrder')).toBeUndefined();
        expect(readDeclaredClass(program, modelFile, 'NotExported')).toBeUndefined();
    });

    it('describes inherited members, projected relation targets, and array element targets', () => {
        const declared = readDeclaredClass(program, modelFile, 'SalesOrder');
        expect(declared?.base).toEqual({ className: 'Transaction', filePath: toPosixPath(nodePath.join(fixturesRoot, 'models', 'Transaction.ts')) });
        expect(declared?.properties.map((property) => property.name)).toEqual(['id', 'tranId', 'tranDate', 'memo', 'customerId', 'statusText', 'shippingAddress', 'billingAddress', 'poNumber', 'approved', 'shipMethodId', 'total', 'customer', 'lines', 'cachedLabel']);
        expect(declared?.properties.find((property) => property.name === 'memo')).toEqual({ name: 'memo', optional: true, nullable: true, isArray: false, typeText: 'string | null', scalarType: 'string', inherited: true });
        expect(declared?.properties.find((property) => property.name === 'customer')).toEqual(expect.objectContaining({ optional: true, isArray: false, inherited: false, target: expect.objectContaining({ className: 'Customer', projection: ['id', 'companyName'] }) }));
        expect(declared?.properties.find((property) => property.name === 'lines')).toEqual(expect.objectContaining({ isArray: true, target: expect.objectContaining({ className: 'TransactionLine', projection: 'all' }) }));
        expect(declared?.properties.find((property) => property.name === 'shippingAddress')?.target).toEqual(expect.objectContaining({ className: 'TransactionAddress', projection: 'all' }));
    });
});
