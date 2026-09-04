import * as nodePath from 'path';
import { createInMemoryFileSystemAdapter } from '../file-system';
import { buildRecordsCatalogExportScript } from '../scaffold/catalog-script';
import {
    mapRecordFieldKind,
    mapSuiteQlColumnType,
    renderJoinPredicate,
    resolveTableForRecordType,
    resolveTableForSublist,
    resolveTableForSubrecord,
    toCamelCasePropertyName,
    toPascalCaseModelName,
} from '../scaffold/mapping';
import { createSnapshotMetadataProvider, mergeMetadataSnapshots, parseMetadataSnapshot } from '../scaffold/metadata';
import type { MetadataSnapshot, RecordTypeMetadataDescriptor } from '../scaffold/metadata';
import { buildOAuth1AuthorizationHeader } from '../scaffold/oauth1';
import { createRestMetadataProvider, parseRecordJsonSchema } from '../scaffold/rest-provider';
import type { HttpRequest } from '../scaffold/rest-provider';
import { loadMetadataSnapshots, runScaffold, writeRecordMetadataSnapshot } from '../scaffold/scaffold';
import { scaffoldRecordModel } from '../scaffold/stub-emitter';

const cwd = nodePath.resolve('/project');

const salesOrderRecord: RecordTypeMetadataDescriptor = {
    recordType: 'salesorder',
    fields: {
        id: { id: 'id', kind: 'integer', writable: false },
        tranid: { id: 'tranid', kind: 'string', writable: false },
        trandate: { id: 'trandate', kind: 'date', writable: true },
        memo: { id: 'memo', kind: 'string', writable: true },
        entity: { id: 'entity', kind: 'reference', writable: true },
        custbody_approved: { id: 'custbody_approved', kind: 'boolean', writable: true },
        shipmethod: { id: 'shipmethod', kind: 'reference', writable: true },
    },
    sublists: {
        item: { sublistId: 'item', fields: { item: { id: 'item', kind: 'reference', writable: true }, quantity: { id: 'quantity', kind: 'float', writable: true }, amount: { id: 'amount', kind: 'currency', writable: false } } },
        links: { sublistId: 'links', fields: { linkurl: { id: 'linkurl', kind: 'string', writable: false } } },
    },
    subrecords: {
        shippingaddress: { fieldId: 'shippingaddress', fields: { addr1: { id: 'addr1', kind: 'string', writable: true }, city: { id: 'city', kind: 'string', writable: true } } },
        custombox: { fieldId: 'custombox', fields: { size: { id: 'size', kind: 'string', writable: true } }, clearBeforeUpdateFieldId: 'boxlist' },
    },
};

const snapshot: MetadataSnapshot = {
    records: { salesorder: salesOrderRecord },
    tables: {
        transaction: { table: 'transaction', columns: {
            id: { name: 'id', type: 'INTEGER' },
            tranid: { name: 'tranid', type: 'STRING' },
            trandate: { name: 'trandate', type: 'DATE' },
            memo: { name: 'memo', type: 'STRING' },
            entity: { name: 'entity', type: 'INTEGER', joinable: true, targetRecordType: 'customer' },
            custbody_approved: { name: 'custbody_approved', type: 'BOOLEAN' },
            foreigntotal: { name: 'foreigntotal', type: 'CURRENCY' },
        } },
        transactionline: { table: 'transactionline', columns: { item: { name: 'item', type: 'INTEGER', joinable: true }, quantity: { name: 'quantity', type: 'FLOAT' }, amount: { name: 'amount', type: 'CURRENCY' } } },
        transactionshippingaddress: { table: 'transactionshippingaddress', columns: { addr1: { name: 'addr1', type: 'STRING' }, city: { name: 'city', type: 'STRING' } } },
    },
};

describe('mapping helpers', () => {
    it('names models and properties', () => {
        expect(toPascalCaseModelName('salesorder')).toBe('SalesOrder');
        expect(toPascalCaseModelName('customrecord_my_thing')).toBe('CustomrecordMyThing');
        expect(toPascalCaseModelName('customer')).toBe('Customer');
        expect(toCamelCasePropertyName('custbody_ship_method')).toBe('custbodyShipMethod');
        expect(toCamelCasePropertyName('companyname')).toBe('companyname');
        expect(toCamelCasePropertyName('1stfield')).toBe('field_1stfield');
    });

    it('maps SuiteQL column types and record field kinds', () => {
        expect(mapSuiteQlColumnType('INTEGER')).toEqual({ fieldType: 'integer', typeScriptType: 'number' });
        expect(mapSuiteQlColumnType('DOUBLE')).toEqual({ fieldType: 'float', typeScriptType: 'number' });
        expect(mapSuiteQlColumnType('CURRENCY')).toEqual({ fieldType: 'currency', typeScriptType: 'number' });
        expect(mapSuiteQlColumnType('CHECKBOX')).toEqual({ fieldType: 'boolean', typeScriptType: 'boolean' });
        expect(mapSuiteQlColumnType('DATE')).toEqual({ fieldType: 'date', typeScriptType: 'Date' });
        expect(mapSuiteQlColumnType('TIMESTAMP')).toEqual({ fieldType: 'datetime', typeScriptType: 'Date' });
        expect(mapSuiteQlColumnType('MULTISELECT')).toEqual({ fieldType: 'multiselect', typeScriptType: 'number[]' });
        expect(mapSuiteQlColumnType(undefined)).toEqual({ fieldType: 'string', typeScriptType: 'string' });
        expect(mapSuiteQlColumnType('STRING', true)).toEqual({ fieldType: 'key', typeScriptType: 'number' });
        for (const [kind, fieldType] of [['integer', 'integer'], ['float', 'float'], ['currency', 'currency'], ['boolean', 'boolean'], ['date', 'date'], ['datetime', 'datetime'], ['multiselect', 'multiselect'], ['reference', 'key'], ['unknown', 'string']] as const) {
            expect(mapRecordFieldKind(kind).fieldType).toBe(fieldType);
        }
    });

    it('resolves tables for known families and reports unknown ones', () => {
        expect(resolveTableForRecordType('SalesOrder')).toEqual({ table: 'transaction', alias: 'txn' });
        expect(resolveTableForRecordType('inventoryitem')).toEqual({ table: 'item', alias: 'itm' });
        expect(resolveTableForRecordType('customer')).toEqual({ table: 'customer', alias: 'cust' });
        expect(resolveTableForRecordType('customrecord_widget')).toEqual({ table: 'customrecord_widget', alias: 'rec' });
        expect(resolveTableForRecordType('mystery')).toBeUndefined();
        expect(resolveTableForSublist('invoice', 'item')?.table).toBe('transactionline');
        expect(resolveTableForSublist('expensereport', 'expense')?.on).toContain('expenseaccount');
        expect(resolveTableForSublist('customer', 'addressbook')?.table).toBe('entityaddressbook');
        expect(resolveTableForSublist('customer', 'item')).toBeUndefined();
        expect(resolveTableForSubrecord('salesorder', 'shippingaddress')?.clearListField).toBe('shipaddresslist');
        expect(resolveTableForSubrecord('salesorder', 'billingaddress')?.table).toBe('transactionbillingaddress');
        expect(resolveTableForSubrecord('customer', 'shippingaddress')).toBeUndefined();
        expect(renderJoinPredicate('${alias}.x = ${root}.id', 'tl', 'txn')).toBe('tl.x = txn.id');
    });
});

describe('metadata snapshots', () => {
    it('parses, normalizes, and merges snapshots', () => {
        const parsed = parseMetadataSnapshot({ records: { SalesOrder: { recordType: 'salesorder' } }, tables: { Transaction: { table: 'transaction' } } });
        expect(parsed.records.salesorder).toEqual({ recordType: 'salesorder', fields: {}, sublists: {}, subrecords: {} });
        expect(parsed.tables.transaction).toEqual({ table: 'transaction', columns: {} });
        expect(parseMetadataSnapshot({})).toEqual({ records: {}, tables: {} });

        const merged = mergeMetadataSnapshots(parsed, snapshot);
        expect(Object.keys(merged.records)).toEqual(['salesorder']);
        expect(merged.tables.transaction.columns.id).toBeDefined();
    });

    it('rejects malformed snapshots', () => {
        expect(() => parseMetadataSnapshot(null)).toThrow("Metadata snapshot must be a JSON object with 'records' and 'tables'.");
        expect(() => parseMetadataSnapshot([])).toThrow('must be a JSON object');
        expect(() => parseMetadataSnapshot({ records: { bad: {} }, tables: { worse: null } }, 'file')).toThrow('Metadata file is invalid:\n - records.bad must be an object with a recordType.\n - tables.worse must be an object with a table name.');
    });

    it('serves metadata case-insensitively', async () => {
        const provider = createSnapshotMetadataProvider(snapshot);
        expect((await provider.getRecordTypeMetadata('SalesOrder'))?.recordType).toBe('salesorder');
        expect((await provider.getSuiteQlTableMetadata('Transaction'))?.table).toBe('transaction');
        expect(await provider.getRecordTypeMetadata('nope')).toBeUndefined();
    });

    it('loads and merges snapshot files from disk', () => {
        const fileSystem = createInMemoryFileSystemAdapter({
            [nodePath.join(cwd, 'records.json')]: JSON.stringify({ records: snapshot.records }),
            [nodePath.join(cwd, 'tables.json')]: JSON.stringify({ tables: snapshot.tables }),
        });
        const loaded = loadMetadataSnapshots(fileSystem, cwd, ['records.json', 'tables.json']);
        expect(Object.keys(loaded.records)).toEqual(['salesorder']);
        expect(Object.keys(loaded.tables)).toHaveLength(3);
        expect(() => loadMetadataSnapshots(fileSystem, cwd, ['missing.json'])).toThrow('does not exist');
    });
});

describe('buildOAuth1AuthorizationHeader()', () => {
    it('produces a deterministic signature for fixed nonce and timestamp', () => {
        const header = buildOAuth1AuthorizationHeader({
            method: 'get',
            url: 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/salesorder?select=a&x=y z',
            consumerKey: 'ck',
            consumerSecret: 'cs',
            tokenId: 'tk',
            tokenSecret: 'ts',
            realm: '1234567_SB1',
            nonce: 'abc123',
            timestamp: 1700000000,
        });
        expect(header).toBe('OAuth realm="1234567_SB1", oauth_consumer_key="ck", oauth_nonce="abc123", oauth_signature_method="HMAC-SHA256", oauth_timestamp="1700000000", oauth_token="tk", oauth_version="1.0", oauth_signature="QAj5ifWb5Ks2NLAWu6cKVKJtZjgO78obgNF2uMCoKSE%3D"');
    });

    it('generates a nonce and timestamp when none are given', () => {
        const header = buildOAuth1AuthorizationHeader({ method: 'GET', url: 'https://x.suitetalk.api.netsuite.com/a', consumerKey: 'a', consumerSecret: 'b', tokenId: 'c', tokenSecret: 'd', realm: 'r' });
        expect(header).toMatch(/oauth_nonce="[0-9a-f]{32}"/);
        expect(header).toMatch(/oauth_timestamp="\d+"/);
    });
});

describe('REST metadata provider', () => {
    const schema = {
        properties: {
            links: { type: 'array' },
            id: { type: 'string' },
            memo: { type: 'string', title: 'Memo' },
            trandate: { type: 'string', format: 'date' },
            lastmodifieddate: { type: 'string', format: 'date-time', readOnly: true },
            total: { type: 'number' },
            exchangerate: { type: 'number', format: 'double' },
            approved: { type: 'boolean' },
            status: { type: 'string', enum: ['A', 'B'] },
            entity: { $ref: '#/components/schemas/nsResource', type: 'object' },
            department: { type: 'object', properties: { id: { type: 'string' }, refName: { type: 'string' } } },
            shippingaddress: { type: 'object', properties: { addr1: { type: 'string' }, city: { type: 'string' } } },
            // The catalog renders sublists and multiselects as paged collections; sublist lines are objects, multiselect items are references.
            item: { type: 'object', properties: { totalResults: { type: 'integer', readOnly: true }, count: { type: 'integer', readOnly: true }, hasMore: { type: 'boolean', readOnly: true }, offset: { type: 'integer', readOnly: true }, items: { type: 'array', items: { type: 'object', properties: { links: { type: 'array' }, refName: { type: 'string' }, item: { $ref: '#/x' }, quantity: { type: 'number', format: 'double' }, tranDate: { type: 'string', format: 'date' } } } } } },
            custevent15: { type: 'object', properties: { totalResults: { type: 'integer', readOnly: true }, items: { type: 'array', items: { type: 'array', $ref: '/services/rest/record/v1/metadata-catalog/customlist_x' } } } },
            priority: { type: 'object', properties: { id: { type: 'string', enum: ['HIGH', 'LOW'] }, refName: { type: 'string' } } },
            startDate: { type: 'string', format: 'date' },
            createdDate: { type: 'string', format: 'date-time' },
            tags: { type: 'array', items: { type: 'string' } },
            weird: { type: ['null', 'integer'] },
            unknown: {},
        },
    };

    it('parses a record JSON schema into a descriptor', () => {
        const descriptor = parseRecordJsonSchema('salesorder', schema);
        expect(Object.keys(descriptor.fields)).toEqual(['id', 'memo', 'trandate', 'lastmodifieddate', 'total', 'exchangerate', 'approved', 'status', 'entity', 'department', 'custevent15', 'priority', 'startdate', 'createddate', 'tags', 'weird', 'unknown']);
        expect(descriptor.fields.id).toEqual({ id: 'id', kind: 'string', writable: false, label: undefined, targetRecordType: undefined });
        expect(descriptor.fields.memo.label).toBe('Memo');
        expect(descriptor.fields.trandate.kind).toBe('date');
        expect(descriptor.fields.lastmodifieddate.kind).toBe('datetime');
        expect(descriptor.fields.total.kind).toBe('currency');
        expect(descriptor.fields.exchangerate.kind).toBe('float');
        expect(descriptor.fields.approved.kind).toBe('boolean');
        expect(descriptor.fields.status.kind).toBe('select');
        expect(descriptor.fields.entity).toEqual(expect.objectContaining({ kind: 'reference', targetRecordType: 'resource' }));
        expect(descriptor.fields.department.kind).toBe('reference');
        expect(descriptor.fields.tags.kind).toBe('multiselect');
        expect(descriptor.fields.weird.kind).toBe('integer');
        expect(descriptor.fields.unknown.kind).toBe('unknown');
        expect(descriptor.subrecords.shippingaddress.fields.city.kind).toBe('string');
        expect(descriptor.fields.custevent15.kind).toBe('multiselect');
        expect(descriptor.fields.priority.kind).toBe('select');
        expect(descriptor.fields.startdate).toEqual({ id: 'startdate', kind: 'date', writable: true, label: undefined, targetRecordType: undefined, propertyName: 'startDate' });
        expect(descriptor.fields.createddate.writable).toBe(false);
        expect(Object.keys(descriptor.subrecords)).toEqual(['shippingaddress']);
        expect(Object.keys(descriptor.sublists.item.fields)).toEqual(['item', 'quantity', 'trandate']);
        expect(descriptor.sublists.item.fields.item.kind).toBe('reference');
        expect(descriptor.sublists.item.fields.trandate.propertyName).toBe('tranDate');
    });

    it('requests the catalog with token-based or bearer authentication and handles status codes', async () => {
        const requests: HttpRequest[] = [];
        const transport = async (request: HttpRequest) => {
            requests.push(request);
            if (request.url.endsWith('/missing')) return { status: 404, body: '' };
            if (request.url.endsWith('/broken')) return { status: 500, body: 'Internal error' };
            return { status: 200, body: JSON.stringify(schema) };
        };

        const tba = createRestMetadataProvider({ accountId: '1234567_SB1', authentication: { kind: 'tba', credentials: { consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tk', tokenSecret: 'ts', realm: '1234567_SB1' } }, transport });
        const descriptor = await tba.getRecordTypeMetadata('SalesOrder');
        expect(descriptor?.recordType).toBe('salesorder');
        expect(requests[0].url).toBe('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/salesorder');
        expect(requests[0].headers.Accept).toBe('application/schema+json');
        expect(requests[0].headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
        expect(await tba.getSuiteQlTableMetadata('transaction')).toBeUndefined();

        const bearer = createRestMetadataProvider({ accountId: 'acct', authentication: { kind: 'oauth2', accessToken: 'token' }, transport, recordCatalogPath: '/custom' });
        expect(await bearer.getRecordTypeMetadata('missing')).toBeUndefined();
        expect(requests[1].url).toBe('https://acct.suitetalk.api.netsuite.com/custom/missing');
        expect(requests[1].headers.Authorization).toBe('Bearer token');
        await expect(bearer.getRecordTypeMetadata('broken')).rejects.toThrow("Metadata catalog request for 'broken' failed with HTTP 500: Internal error");
    });
});

describe('scaffoldRecordModel()', () => {
    const provider = createSnapshotMetadataProvider(snapshot);

    it('emits a convention-mapped stub with decorators only where the metadata disagrees with the conventions', async () => {
        const scaffolded = await scaffoldRecordModel(provider, { recordType: 'SalesOrder', libraryModule: '@acme/orm', version: '1.0.0' });

        expect(scaffolded.modelName).toBe('SalesOrder');
        expect(scaffolded.content).toContain("import { Field, ReadOnly, RecordType, Sublist, Subrecord } from '@acme/orm';");
        expect(scaffolded.content).toContain("@RecordType('salesorder')\nexport class SalesOrder {\n    id!: number;");
        expect(scaffolded.content).toContain("    @Field('custbody_approved') custbodyApproved!: boolean;");
        expect(scaffolded.content).toContain("    @Field({ type: 'key' }) entity!: number | null;");
        expect(scaffolded.content).toContain("    @Field({ type: 'currency' }) @ReadOnly() foreigntotal!: number | null;");
        expect(scaffolded.content).toContain('    memo!: string | null;\n    trandate!: Date | null;\n    @ReadOnly() tranid!: string | null;');
        expect(scaffolded.content).toContain("    // TODO(scaffold): 'shipmethod' is writable but has no SuiteQL column on 'transaction'; declare it with @Field('shipmethod', { column: '<column>' })");
        expect(scaffolded.content).toContain('export class SalesOrderShippingaddress {\n    addr1!: string | null;\n    city!: string | null;\n}');
        expect(scaffolded.content).toContain("\n    @Subrecord('shippingaddress') shippingaddress!: SalesOrderShippingaddress;\n");
        expect(scaffolded.content).toContain("    // TODO(scaffold): subrecord 'custombox' has no known SuiteQL table. Fill in the table and its key column, then uncomment.\n    // @Subrecord('custombox', { table: '<table>', key: '<key>', clearListField: 'boxlist' })\n    // custombox!: SalesOrderCustombox;");
        expect(scaffolded.content).toContain("@RecordType('transactionline')\nexport class SalesOrderItemLine {\n    id!: number;\n    @Field({ type: 'key' }) item!: number | null;\n    quantity!: number | null;\n    @Field({ type: 'currency' }) @ReadOnly() amount!: number | null;\n}");
        expect(scaffolded.content).toContain("    @Sublist('item') item!: SalesOrderItemLine[];");
        expect(scaffolded.content).toContain("// TODO(scaffold): sublist 'links' has no known SuiteQL line table. Name it with @RecordType('<table>') here or with @Sublist('links', { table }) on the property.\nexport class SalesOrderLinksLine {\n    id!: number;\n    @ReadOnly() linkurl!: string | null;\n}");
        expect(scaffolded.content).toContain("    // TODO(scaffold): uncomment once the line table of 'links' and the column holding the parent id are known.\n    // @Sublist('links', { table: '<table>', parentColumn: '<column>' }) links!: SalesOrderLinksLine[];");
        expect(scaffolded.todos).toEqual([
            "writable field 'shipmethod' has no SuiteQL column",
            "subrecord 'custombox' has no known SuiteQL table; declare it to query it",
            "sublist 'links' has no known SuiteQL line table; declare it to query it",
        ]);
    });

    it('honors include, exclude, model name, and table overrides', async () => {
        const scaffolded = await scaffoldRecordModel(provider, { recordType: 'salesorder', modelName: 'Order', table: 'transaction', include: ['id', 'memo', 'shipmethod'], exclude: ['shipmethod'], libraryModule: '@acme/orm' });
        expect(scaffolded.content).toContain("@RecordType('salesorder')\nexport class Order {\n    id!: number;\n    memo!: string | null;\n");
        expect(scaffolded.content).not.toContain('trandate');
        expect(scaffolded.content).not.toContain("'shipmethod' is writable");

        const elsewhere = await scaffoldRecordModel(provider, { recordType: 'salesorder', table: 'salesorder', include: ['id'], libraryModule: '@acme/orm' });
        expect(elsewhere.content).toContain("@RecordType('salesorder', { table: 'salesorder' })");
    });

    it('falls back to record field ids when the table is unknown or has no column metadata', async () => {
        const customRecord: RecordTypeMetadataDescriptor = { recordType: 'customrecord_widget', fields: { id: { id: 'id', kind: 'integer', writable: false }, name: { id: 'name', kind: 'string', writable: true }, custrecord_size: { id: 'custrecord_size', kind: 'float', writable: true } }, sublists: {}, subrecords: {} };
        const unknownRecord: RecordTypeMetadataDescriptor = { recordType: 'mystery', fields: { id: { id: 'id', kind: 'integer', writable: false } }, sublists: {}, subrecords: {} };
        const sparseProvider = createSnapshotMetadataProvider({ records: { customrecord_widget: customRecord, mystery: unknownRecord }, tables: {} });

        const custom = await scaffoldRecordModel(sparseProvider, { recordType: 'customrecord_widget', libraryModule: '@acme/orm' });
        expect(custom.content).toContain("@RecordType('customrecord_widget')\nexport class CustomrecordWidget {\n    id!: number;\n    @Field('custrecord_size') custrecordSize!: number | null;\n    name!: string | null;\n}");
        expect(custom.todos).toEqual(["no SuiteQL column metadata for table 'customrecord_widget'; column names were taken from record field ids and need review"]);

        const mystery = await scaffoldRecordModel(sparseProvider, { recordType: 'mystery', libraryModule: '@acme/orm' });
        expect(mystery.content).toContain("// TODO(scaffold): confirm the SuiteQL table for 'mystery' (the conventions assume 'mystery').\n@RecordType('mystery')");
        expect(mystery.todos[0]).toContain("the SuiteQL table for record type 'mystery' is not known");

        await expect(scaffoldRecordModel(sparseProvider, { recordType: 'ghost', libraryModule: '@acme/orm' })).rejects.toThrow("No record metadata is available for 'ghost'.");
    });

    it('uses catalog property names, numeric keys, and camel-case nested class names', async () => {
        const taskRecord: RecordTypeMetadataDescriptor = {
            recordType: 'task',
            fields: {
                id: { id: 'id', kind: 'string', writable: false },
                startdate: { id: 'startdate', kind: 'date', writable: true, propertyName: 'startDate' },
                TITLE: { id: 'title', kind: 'string', writable: true },
            },
            sublists: { timeitem: { sublistId: 'timeitem', propertyName: 'timeItem', fields: { trandate: { id: 'trandate', kind: 'date', writable: true, propertyName: 'tranDate' } } } },
            subrecords: { custevent15: { fieldId: 'custevent15', fields: { size: { id: 'size', kind: 'string', writable: true } } } },
        };
        const taskProvider = createSnapshotMetadataProvider({ records: { task: taskRecord }, tables: {} });

        const scaffolded = await scaffoldRecordModel(taskProvider, { recordType: 'task', libraryModule: '@acme/orm' });
        expect(scaffolded.content).toContain("@RecordType('task')\nexport class Task {\n    id!: number;\n    startDate!: Date | null;\n    title!: string | null;");
        expect(scaffolded.content).toContain("export class TaskTimeItemLine {\n    id!: number;\n    tranDate!: Date | null;\n}");
        expect(scaffolded.content).toContain("    // @Sublist('timeitem', { table: '<table>', parentColumn: '<column>' }) timeItem!: TaskTimeItemLine[];");
        expect(scaffolded.content).toContain("export class TaskCustevent15 {\n    size!: string | null;\n}");
        expect(scaffolded.content).toContain("    // @Subrecord('custevent15', { table: '<table>', key: '<key>' })\n    // custevent15!: TaskCustevent15;");
    });
});

describe('runScaffold() and writeRecordMetadataSnapshot()', () => {
    it('writes new stubs, keeps existing files, and reports errors', async () => {
        const fileSystem = createInMemoryFileSystemAdapter({ [nodePath.join(cwd, 'src/models/Existing.ts')]: 'keep me' });
        const provider = createSnapshotMetadataProvider({ ...snapshot, records: { ...snapshot.records, existing: { recordType: 'existing', fields: { id: { id: 'id', kind: 'integer', writable: false } }, sublists: {}, subrecords: {} } } });

        const result = await runScaffold({ provider, records: [{ recordType: 'salesorder' }, { recordType: 'existing' }, { recordType: 'missing' }], outDir: 'src/models', cwd, fileSystem, libraryModule: '@acme/orm' });

        expect(result.writtenFiles).toEqual([nodePath.join(cwd, 'src/models/SalesOrder.ts')]);
        expect(result.skippedFiles).toEqual([nodePath.join(cwd, 'src/models/Existing.ts')]);
        expect(result.errors).toEqual([{ recordType: 'missing', message: "No record metadata is available for 'missing'." }]);
        expect(result.todos.length).toBeGreaterThan(0);
        expect(fileSystem.readTextFile(nodePath.join(cwd, 'src/models/Existing.ts'))).toBe('keep me');

        const forced = await runScaffold({ provider, records: [{ recordType: 'existing' }], outDir: 'src/models', cwd, fileSystem, libraryModule: '@acme/orm', force: true });
        expect(forced.writtenFiles).toHaveLength(1);
        expect(fileSystem.readTextFile(nodePath.join(cwd, 'src/models/Existing.ts'))).toContain('export class Existing {');
    });

    it('writes a sorted record metadata snapshot and reports missing record types', async () => {
        const fileSystem = createInMemoryFileSystemAdapter();
        const provider = createSnapshotMetadataProvider(snapshot);
        const snapshotPath = nodePath.join(cwd, 'meta', 'records.json');

        const result = await writeRecordMetadataSnapshot(provider, ['salesorder', 'nope'], fileSystem, snapshotPath);

        expect(result).toEqual({ records: ['salesorder'], missing: ['nope'] });
        expect(JSON.parse(fileSystem.readTextFile(snapshotPath))).toEqual({ records: { salesorder: salesOrderRecord }, tables: {} });
    });
});

describe('buildRecordsCatalogExportScript()', () => {
    it('embeds the requested tables and targets the Records Catalog endpoint', () => {
        const script = buildRecordsCatalogExportScript(['transaction', 'transactionline']);
        expect(script).toContain('const tables = ["transaction","transactionline"];');
        expect(script).toContain('/app/recordscatalog/rcendpoint.nl?action=getRecordTypeDetail');
        expect(script).toContain("detailType: 'SS_ANAL'");
        expect(script).toContain("link.download = 'netsuite.tables.snapshot.json';");
    });
});
