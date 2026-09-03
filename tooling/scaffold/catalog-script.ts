/**
 * Browser console script that exports SuiteQL table metadata from the NetSuite Records Catalog.
 * The Records Catalog endpoint is undocumented and only works inside a logged-in browser session,
 * which is why the scaffold reads its output from a snapshot file instead of calling it directly.
 */
export function buildRecordsCatalogExportScript(tables: string[]): string {
    return [
        '(async () => {',
        `    const tables = ${JSON.stringify(tables)};`,
        '    const output = { records: {}, tables: {} };',
        '    for (const table of tables) {',
        "        const data = encodeURIComponent(JSON.stringify({ scriptId: table, detailType: 'SS_ANAL' }));",
        "        const response = await fetch('/app/recordscatalog/rcendpoint.nl?action=getRecordTypeDetail&data=' + data, { credentials: 'include' });",
        '        const detail = await response.json();',
        '        const columns = {};',
        '        for (const field of (detail.data && detail.data.fields) || []) {',
        '            columns[String(field.id).toLowerCase()] = {',
        '                name: String(field.id).toLowerCase(),',
        '                type: field.dataType || field.type,',
        '                joinable: Boolean(field.isJoinable || field.joinable),',
        '                targetRecordType: field.joinRecordType || undefined,',
        '            };',
        '        }',
        '        output.tables[table.toLowerCase()] = { table: table.toLowerCase(), columns };',
        '    }',
        "    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });",
        "    const link = document.createElement('a');",
        '    link.href = URL.createObjectURL(blob);',
        "    link.download = 'netsuite.tables.snapshot.json';",
        '    link.click();',
        '})();',
    ].join('\n');
}
