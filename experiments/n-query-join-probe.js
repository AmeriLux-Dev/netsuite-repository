/**
 * Probe: what does N/query know about joins, and can it tell us?
 *
 * Paste the whole file into the SuiteScript Debugger (Customization > Scripting > Script Debugger,
 * API version 2.1) and run it. Results are logged at AUDIT level and returned as JSON.
 * To run it as a RESTlet instead, wrap the body of `probeJoins` in a `get` handler.
 *
 * For each pair it records:
 *   - the joined component's `type`, `source`, and `target` (the table N/query resolved)
 *   - the SQL `toSuiteQL()` renders, which carries the join predicate and therefore both key columns
 *   - the error message when the join is refused
 */
require(['N/query', 'N/log'], function (query, log) {
    var probes = [
        // Subrecords: the conventions table says these join transactionshippingaddress/transactionbillingaddress on nkey.
        { method: 'autoJoin', type: 'transaction', fieldId: 'shippingaddress' },
        { method: 'autoJoin', type: 'transaction', fieldId: 'billingaddress' },
        // Same joins with joinTo, which needs only the target table name and no key column.
        { method: 'joinTo', type: 'transaction', fieldId: 'shippingaddress', target: 'transactionshippingaddress' },
        { method: 'joinTo', type: 'transaction', fieldId: 'billingaddress', target: 'transactionbillingaddress' },
        // References: select fields joined to their target record.
        { method: 'autoJoin', type: 'transaction', fieldId: 'entity' },
        { method: 'autoJoin', type: 'transaction', fieldId: 'subsidiary' },
        { method: 'autoJoin', type: 'transaction', fieldId: 'salesrep' },
        // Sublist: transaction lines from the transaction, and the reverse join a line class would need.
        { method: 'autoJoin', type: 'transaction', fieldId: 'transactionlines' },
        { method: 'joinFrom', type: 'transaction', fieldId: 'transaction', source: 'transactionline' },
        // Entity address book, the next subrecord the conventions table does not know.
        { method: 'autoJoin', type: 'customer', fieldId: 'addressbook' },
        { method: 'autoJoin', type: 'customeraddressbook', fieldId: 'addressbookaddress' },
    ];

    function describeComponent(component) {
        return { type: safe(function () { return component.type; }), source: safe(function () { return component.source; }), target: safe(function () { return component.target; }) };
    }

    function safe(read) {
        try { return read(); } catch (error) { return 'ERR: ' + (error && error.message ? error.message : error); }
    }

    function renderSql(parentQuery, joined, withJoinedColumn) {
        var columns = [parentQuery.createColumn({ fieldId: 'id' })];
        if (withJoinedColumn) {
            columns.push(joined.createColumn({ formula: '1', type: query.ReturnType.INTEGER, alias: 'probe' }));
        }
        parentQuery.columns = columns;
        return parentQuery.toSuiteQL().query;
    }

    function runProbe(probe) {
        var result = { probe: probe };
        try {
            var parentQuery = query.create({ type: probe.type });
            var joined = probe.method === 'joinTo'
                ? parentQuery.joinTo({ fieldId: probe.fieldId, target: probe.target })
                : probe.method === 'joinFrom'
                    ? parentQuery.joinFrom({ fieldId: probe.fieldId, source: probe.source })
                    : parentQuery.autoJoin({ fieldId: probe.fieldId });
            result.component = describeComponent(joined);
            result.sqlWithoutJoinedColumn = safe(function () { return renderSql(parentQuery, joined, false); });
            result.sqlWithJoinedColumn = safe(function () { return renderSql(parentQuery, joined, true); });
        } catch (error) {
            result.error = error && error.message ? error.message : String(error);
        }
        return result;
    }

    var results = probes.map(runProbe);
    results.forEach(function (result) {
        log.audit('n-query join probe ' + result.probe.method + ' ' + result.probe.type + '.' + result.probe.fieldId, JSON.stringify(result));
    });
    return JSON.stringify(results, null, 2);
});
