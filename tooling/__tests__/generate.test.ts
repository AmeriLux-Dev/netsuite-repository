import * as nodeFileSystem from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as ts from 'typescript';
import { defaultBuildConfig } from '../config';
import type { BuildConfig } from '../config';
import { createNodeFileSystemAdapter, toPosixPath } from '../file-system';
import { checkGenerated, planGeneration, runGenerate, toEntitySetName } from '../generate';
import { createModelTypeProgram, readCompilerOptionsFromTsconfig, readModelTypes } from '../collect/property-type-reader';

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

describe('toEntitySetName()', () => {
    it('camel-cases and pluralizes model names', () => {
        expect(toEntitySetName('SalesOrder')).toBe('salesOrders');
        expect(toEntitySetName('Category')).toBe('categories');
        expect(toEntitySetName('Day')).toBe('days');
        expect(toEntitySetName('Address')).toBe('addresses');
        expect(toEntitySetName('Box')).toBe('boxes');
    });
});

describe('planGeneration() – decorated and fluent fixtures', () => {
    const outDir = createTemporaryOutDir();
    temporaryDirectories.push(outDir);
    const plan = planGeneration({
        config: buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir),
        cwd: repositoryRoot,
        fileSystem,
        compilerOptions,
        version: '0.0.0-test',
    });
    const fileByName = new Map(plan.files.map((file) => [nodePath.basename(file.path), file.content]));

    it('reports no diagnostics and both models', () => {
        expect(plan.diagnostics).toEqual([]);
        expect(plan.models).toEqual([
            expect.objectContaining({ modelName: 'Customer', setName: 'customers', source: 'definition' }),
            expect.objectContaining({ modelName: 'SalesOrder', setName: 'salesOrders', source: 'class' }),
        ]);
        expect(Array.from(fileByName.keys()).sort()).toEqual(['Customer.config.gen.ts', 'Customer.types.gen.ts', 'SalesOrder.config.gen.ts', 'SalesOrder.types.gen.ts', 'context.gen.ts']);
    });

    it('infers field types from the class declaration and keeps explicit types', () => {
        const config = fileByName.get('SalesOrder.config.gen.ts') as string;
        expect(config).toContain("        id: {\n            queryFieldId: 'id',\n            tableAlias: 'txn',\n            type: 'integer',");
        expect(config).toMatch(/tranDate: \{[^}]*type: 'date'/);
        expect(config).toMatch(/approved: \{[^}]*type: 'boolean'/);
        expect(config).toMatch(/customerId: \{[^}]*type: 'float'[^}]*setFirst: true/);
        expect(config).toMatch(/lines_itemId: \{[^}]*type: 'key'/);
        expect(config).toMatch(/lines_quantity: \{[^}]*type: 'float'/);
        expect(config).toMatch(/lines_line: \{[^}]*type: 'float'[^}]*readonly: true/);
        expect(config).toMatch(/shippingAddress_city: \{[^}]*type: 'string'/);
        expect(config).toContain("on: 'tl.transaction = txn.id AND tl.mainline = \\'F\\''");
        expect(config).toContain('coerce: true,');
    });

    it('imports transforms by name from the module that exports them', () => {
        const salesOrderConfig = fileByName.get('SalesOrder.config.gen.ts') as string;
        const customerConfig = fileByName.get('Customer.config.gen.ts') as string;
        expect(salesOrderConfig).toMatch(/import \{ uppercaseText \} from '.*fixtures\/models\/SalesOrder';/);
        expect(salesOrderConfig).toContain('transform: uppercaseText,');
        expect(customerConfig).toMatch(/import \{ trimText \} from '.*fixtures\/models\/shared';/);
        expect(customerConfig).toContain('transform: trimText,');
    });

    it('emits plain interfaces for the class model, including nested classes and optional members', () => {
        const types = fileByName.get('SalesOrder.types.gen.ts') as string;
        expect(types).toContain('export interface ShippingAddress {\n    addr1: string | null;\n    city: string | null;\n}');
        expect(types).toContain('export interface SalesOrderLine {\n    line: number;\n    itemId: number;\n    quantity: number;\n    amount: number;\n}');
        expect(types).toContain('export interface CustomerLookup {\n    companyName: string;\n}');
        expect(types).toContain('export interface SalesOrder {\n    id: number;\n    tranId: string;\n    tranDate: Date;\n    memo?: string | null;\n    approved: boolean;\n    customerId: number;\n    customerName: string;\n    shippingAddress: ShippingAddress;\n    lines: SalesOrderLine[];\n    customer: CustomerLookup;\n}');
        expect(types).toContain('export type SalesOrderPatch = RecordGraphPatch<SalesOrder>;');
    });

    it('emits the interface behind a fluent definition with inline object types verbatim', () => {
        const types = fileByName.get('Customer.types.gen.ts') as string;
        const config = fileByName.get('Customer.config.gen.ts') as string;
        expect(types).toContain('export interface Customer {\n    id: number;\n    companyName: string;\n    email: string | null;\n    isInactive: boolean;\n    categoryIds: number[];\n    billingAddress: { addr1: string | null; city: string | null; };\n}');
        expect(types).not.toContain('CustomerBillingAddress');
        expect(config).toMatch(/categoryIds: \{[^}]*type: 'multiselect'/);
        expect(config).toMatch(/isInactive: \{[^}]*type: 'boolean'/);
        expect(config).toMatch(/billingAddress_city: \{[^}]*type: 'string'[^}]*recordAccessId: 'billingaddress'/);
    });

    it('emits the context wiring both models', () => {
        const context = fileByName.get('context.gen.ts') as string;
        expect(context).toContain('export const AppSchema = {\n    customers: CustomerConfig,\n    salesOrders: SalesOrderConfig,\n};');
        expect(context).toContain('export function createAppContext(');
    });
});

describe('runGenerate() and checkGenerated()', () => {
    const outDir = createTemporaryOutDir();
    temporaryDirectories.push(outDir);
    const options = { config: buildConfig(['tooling/__tests__/fixtures/models/**/*.ts'], outDir), cwd: repositoryRoot, fileSystem, compilerOptions, version: '0.0.0-test' };

    it('writes every file once and reports them unchanged on the second run', () => {
        const first = runGenerate(options);
        expect(first.writtenFiles).toHaveLength(5);
        expect(first.unchangedFiles).toEqual([]);
        expect(nodeFileSystem.existsSync(nodePath.join(outDir, 'SalesOrder.config.gen.ts'))).toBe(true);

        const second = runGenerate(options);
        expect(second.writtenFiles).toEqual([]);
        expect(second.unchangedFiles).toHaveLength(5);
    });

    it('detects drift and missing files without writing', () => {
        const contextPath = nodePath.join(outDir, 'context.gen.ts');
        const typesPath = nodePath.join(outDir, 'Customer.types.gen.ts');
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

    it('reports properties whose TypeScript type has no NetSuite field type', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/Unmappable.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'Unmappable', message: "Property 'Unmappable.extra' has type 'Map<string, string>', which does not map to a NetSuite field type. Declare it with @Column({ type }) or hasType()." }),
        ]);
        expect(plan.files.map((file) => nodePath.basename(file.path))).toEqual(['Unmappable.types.gen.ts', 'Unmappable.config.gen.ts', 'context.gen.ts']);
    });

    it('reports transforms that are not exported', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/HiddenFunction.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'HiddenFunction', message: expect.stringContaining("Function at '$.fields.name.transform' must be exported") }),
        ]);
    });

    it('reports model validation errors from the compiler', () => {
        const plan = planFor(['tooling/__tests__/fixtures/broken/InvalidModel.ts']);
        expect(plan.diagnostics).toEqual([
            expect.objectContaining({ exportName: 'InvalidModel', message: expect.stringContaining("Model 'InvalidModel' is invalid") }),
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

describe('readModelTypes()', () => {
    const modelFile = nodePath.join(fixturesRoot, 'models', 'SalesOrder.ts');
    const program = createModelTypeProgram([modelFile, nodePath.join(fixturesRoot, 'models', 'Customer.ts')], compilerOptions);

    it('returns undefined for unknown files and exports', () => {
        expect(readModelTypes(program, nodePath.join(fixturesRoot, 'models', 'Missing.ts'), 'SalesOrder', 'SalesOrder')).toBeUndefined();
        expect(readModelTypes(program, modelFile, 'NotExported', 'NotExported')).toBeUndefined();
        expect(readModelTypes(program, modelFile, 'uppercaseText', 'uppercaseText')).toBeUndefined();
    });

    it('describes nested shapes with their field types', () => {
        const types = readModelTypes(program, modelFile, 'SalesOrder', 'SalesOrder');
        expect(types?.root.properties.find((property) => property.name === 'lines')).toEqual({ name: 'lines', typeText: 'SalesOrderLine[]', optional: false, isArray: true, nestedShapeName: 'SalesOrderLine' });
        expect(types?.nested.map((shape) => shape.name)).toEqual(['ShippingAddress', 'SalesOrderLine', 'CustomerLookup']);
    });
});
