import * as nodePath from 'path';
import { EXIT_PROBLEMS, EXIT_SUCCESS, EXIT_USAGE, runCli } from '../cli/main';
import { DEFAULT_BUILD_CONFIG_FILE_NAME } from '../config';
import { createInMemoryFileSystemAdapter } from '../file-system';
import type { HttpRequest } from '../scaffold/rest-provider';

const cwd = nodePath.resolve('/project');

const recordSnapshot = {
    records: {
        customer: {
            recordType: 'customer',
            fields: { id: { id: 'id', kind: 'integer', writable: false }, companyname: { id: 'companyname', kind: 'string', writable: true } },
            sublists: {},
            subrecords: {},
        },
    },
    tables: { customer: { table: 'customer', columns: { id: { name: 'id', type: 'INTEGER' }, companyname: { name: 'companyname', type: 'STRING' } } } },
};

const tbaEnv = {
    NETSUITE_ACCOUNT_ID: '123_SB1',
    NETSUITE_CONSUMER_KEY: 'ck',
    NETSUITE_CONSUMER_SECRET: 'cs',
    NETSUITE_TOKEN_ID: 'tk',
    NETSUITE_TOKEN_SECRET: 'ts',
};

function createEnvironment(files: Record<string, string> = {}, env: Record<string, string | undefined> = {}) {
    const fileSystem = createInMemoryFileSystemAdapter(files);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: HttpRequest[] = [];
    const transport = async (request: HttpRequest) => {
        requests.push(request);
        if (request.url.endsWith('/vendor')) {
            return { status: 200, body: JSON.stringify({ properties: { id: { type: 'string', readOnly: true }, companyname: { type: 'string' } } }) };
        }
        return { status: 404, body: '' };
    };
    return { environment: { cwd, fileSystem, env, transport, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }, fileSystem, stdout, stderr, requests };
}

describe('runCli() – scaffold', () => {
    it('requires record types and a metadata source', async () => {
        const noRecords = createEnvironment();
        expect(await runCli(['scaffold'], noRecords.environment)).toBe(EXIT_USAGE);
        expect(noRecords.stderr[0]).toContain('scaffold needs at least one record type');

        const noSource = createEnvironment();
        expect(await runCli(['scaffold', 'customer'], noSource.environment)).toBe(EXIT_USAGE);
        expect(noSource.stderr[0]).toContain('scaffold needs a metadata source');

        const badSnapshot = createEnvironment();
        expect(await runCli(['scaffold', '--record', 'customer', '--snapshot', 'missing.json'], badSnapshot.environment)).toBe(EXIT_USAGE);
        expect(badSnapshot.stderr[0]).toContain('does not exist');
    });

    it('writes stubs from a snapshot into the models directory', async () => {
        const { environment, fileSystem, stdout } = createEnvironment({ [nodePath.join(cwd, 'meta.json')]: JSON.stringify(recordSnapshot) });

        expect(await runCli(['scaffold', '--record', 'customer', '--snapshot', 'meta.json'], environment)).toBe(EXIT_SUCCESS);

        const written = nodePath.join(cwd, 'src/models/Customer.ts');
        expect(fileSystem.readTextFile(written)).toContain("@RecordType('customer')\nexport class Customer {");
        expect(stdout[0]).toContain(`wrote ${written}`);

        expect(await runCli(['scaffold', 'customer', '--snapshot', 'meta.json', '--out', 'lib/models'], environment)).toBe(EXIT_SUCCESS);
        expect(fileSystem.fileExists(nodePath.join(cwd, 'lib/models/Customer.ts'))).toBe(true);
        expect(await runCli(['scaffold', 'customer', '--snapshot', 'meta.json'], environment)).toBe(EXIT_SUCCESS);
        expect(stdout[2]).toContain('kept existing');
    });

    it('falls back to the REST catalog for record types the snapshot does not know and reports failures', async () => {
        const { environment, fileSystem, stderr, requests } = createEnvironment({ [nodePath.join(cwd, 'meta.json')]: JSON.stringify(recordSnapshot) }, tbaEnv);

        expect(await runCli(['scaffold', '--record', 'customer,vendor,ghost', '--snapshot', 'meta.json'], environment)).toBe(EXIT_PROBLEMS);

        expect(fileSystem.fileExists(nodePath.join(cwd, 'src/models/Vendor.ts'))).toBe(true);
        expect(requests.map((request) => request.url.split('/').pop())).toEqual(['vendor', 'ghost']);
        expect(stderr[0]).toBe(" - ghost: No record metadata is available for 'ghost'.");
    });

    it('uses the configured models glob for the output directory and supports bearer tokens', async () => {
        const { environment, fileSystem } = createEnvironment({ [nodePath.join(cwd, DEFAULT_BUILD_CONFIG_FILE_NAME)]: JSON.stringify({ models: ['app/models/*.ts'] }) }, { NETSUITE_ACCOUNT_ID: 'acct', NETSUITE_ACCESS_TOKEN: 'token' });
        expect(await runCli(['scaffold', 'vendor', '--force'], environment)).toBe(EXIT_SUCCESS);
        expect(fileSystem.fileExists(nodePath.join(cwd, 'app/models/Vendor.ts'))).toBe(true);
    });
});

describe('runCli() – snapshot', () => {
    it('validates arguments and credentials', async () => {
        const noArguments = createEnvironment();
        expect(await runCli(['snapshot'], noArguments.environment)).toBe(EXIT_USAGE);
        expect(noArguments.stderr[0]).toContain('snapshot needs record types and an output file');

        const noCredentials = createEnvironment({}, { NETSUITE_ACCOUNT_ID: 'acct', NETSUITE_CONSUMER_KEY: 'only' });
        expect(await runCli(['snapshot', 'vendor', '--out', 'meta.json'], noCredentials.environment)).toBe(EXIT_USAGE);
        expect(noCredentials.stderr[0]).toContain('needs the NETSUITE_* credentials');
    });

    it('writes the snapshot and flags missing record types', async () => {
        const { environment, fileSystem, stdout } = createEnvironment({}, tbaEnv);
        expect(await runCli(['snapshot', '--record', 'vendor', '--out', 'meta/records.json'], environment)).toBe(EXIT_SUCCESS);
        expect(JSON.parse(fileSystem.readTextFile(nodePath.join(cwd, 'meta/records.json'))).records.vendor.fields.companyname.writable).toBe(true);
        expect(stdout[0]).toBe('wrote 1 record type(s) to meta/records.json');

        expect(await runCli(['snapshot', 'vendor,ghost', '--out', 'meta/records.json'], environment)).toBe(EXIT_PROBLEMS);
        expect(stdout[1]).toContain(' - not found: ghost');
    });

    it('reports transport failures', async () => {
        const { environment, stderr } = createEnvironment({}, tbaEnv);
        environment.transport = async () => ({ status: 500, body: 'down' });
        expect(await runCli(['snapshot', 'vendor', '--out', 'meta.json'], environment)).toBe(EXIT_PROBLEMS);
        expect(stderr[0]).toContain('failed with HTTP 500');
    });
});

describe('runCli() – catalog-script', () => {
    it('prints the console script for the requested tables', async () => {
        const missing = createEnvironment();
        expect(await runCli(['catalog-script'], missing.environment)).toBe(EXIT_USAGE);

        const { environment, stdout } = createEnvironment();
        expect(await runCli(['catalog-script', '--table', 'transaction,transactionline', 'customer'], environment)).toBe(EXIT_SUCCESS);
        expect(stdout[0]).toContain('const tables = ["transaction","transactionline","customer"];');
    });
});
