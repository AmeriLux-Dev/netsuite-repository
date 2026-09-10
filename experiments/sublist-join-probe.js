/**
 * Which join forms reach a sales order's lines and the line's item? Paste into the SuiteScript Debugger (API 2.1)
 * and run; nothing executes, every attempt only renders with toSuiteQL.
 *
 * Follow-up to bisect-render-failure.js, which showed that `joinFrom({ fieldId: 'transaction', source:
 * 'transactionline' })` has no reverse join on a `salesorder` root ("Record Join 'transaction<transactionline'
 * for record 'salesOrder' was not found"). Each attempt records "ok" plus the rendered join predicate, or the error.
 */
require(['N/query', 'N/log'], function (query, log) {
    var results = {};

    function message(error) { return error && error.message ? error.message : String(error); }
    function joinPredicates(sql) {
        var matches = sql.match(/\bON\b[^\n]*|\(\+\)[^,]*|"[A-Z_]+"\.[a-z_]+ = [A-Za-z_.]+\(\+\)?/g);
        return matches ? matches.slice(0, 4) : sql.slice(0, 400);
    }
    function attempt(label, build) {
        try {
            var sql = build().toSuiteQL().query;
            results[label] = { ok: true, joins: joinPredicates(sql) };
        } catch (error) {
            results[label] = { ok: false, error: message(error) };
        }
    }
    function column(component, fieldId, alias) { return component.createColumn({ fieldId: fieldId, alias: alias }); }

    // ---- lines from a salesorder root ---------------------------------------------------------------------------
    attempt('salesorder autoJoin(transactionlines)', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [column(q, 'id', 'id'), column(lines, 'id', 'lineId'), column(lines, 'linesequencenumber', 'seq')];
        q.condition = lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] });
        return q;
    });
    attempt('salesorder joinFrom(transactionline.transaction)', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.joinFrom({ fieldId: 'transaction', source: 'transactionline' });
        q.columns = [column(q, 'id', 'id'), column(lines, 'id', 'lineId')];
        return q;
    });
    attempt('transaction joinFrom(transactionline.transaction)', function () {
        var q = query.create({ type: 'transaction' });
        var lines = q.joinFrom({ fieldId: 'transaction', source: 'transactionline' });
        q.columns = [column(q, 'id', 'id'), column(lines, 'id', 'lineId')];
        return q;
    });
    attempt('transaction autoJoin(transactionlines)', function () {
        var q = query.create({ type: 'transaction' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [column(q, 'id', 'id'), column(lines, 'id', 'lineId')];
        return q;
    });

    // ---- the item from the line component ---------------------------------------------------------------------------
    attempt('salesorder autoJoin(transactionlines) > joinTo(item, item)', function () {
        var q = query.create({ type: 'salesorder' });
        var item = q.autoJoin({ fieldId: 'transactionlines' }).joinTo({ fieldId: 'item', target: 'item' });
        q.columns = [column(q, 'id', 'id'), column(item, 'itemid', 'itemName'), column(item, 'itemtype', 'itemType')];
        return q;
    });
    attempt('salesorder autoJoin(transactionlines) > autoJoin(item)', function () {
        var q = query.create({ type: 'salesorder' });
        var item = q.autoJoin({ fieldId: 'transactionlines' }).autoJoin({ fieldId: 'item' });
        q.columns = [column(q, 'id', 'id'), column(item, 'itemid', 'itemName')];
        return q;
    });

    // ---- the line's location and its main address, as the SPS header reads them ------------------------------------
    attempt('salesorder autoJoin(transactionlines) > joinTo(location, location) > autoJoin(mainaddress)', function () {
        var q = query.create({ type: 'salesorder' });
        var location = q.autoJoin({ fieldId: 'transactionlines' }).joinTo({ fieldId: 'location', target: 'location' });
        var address = location.autoJoin({ fieldId: 'mainaddress' });
        q.columns = [column(q, 'id', 'id'), column(location, 'id', 'locationId'), column(address, 'city', 'city')];
        return q;
    });

    // ---- references the other models make -----------------------------------------------------------------------------
    attempt('customrecord_op_scac joinTo(custrecord_op_scac_carrier, shipitem)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        var carrier = q.joinTo({ fieldId: 'custrecord_op_scac_carrier', target: 'shipitem' });
        q.columns = [column(q, 'id', 'id'), column(carrier, 'itemid', 'carrierName')];
        return q;
    });
    attempt('customrecord_op_scac joinTo(custrecord_op_scac_code, customlistam_scac)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        var scac = q.joinTo({ fieldId: 'custrecord_op_scac_code', target: 'customlistam_scac' });
        q.columns = [column(q, 'id', 'id'), column(scac, 'name', 'scacName')];
        return q;
    });
    attempt('customrecord_op_form_status joinTo(custrecord_op_fs_transaction_id, transaction)', function () {
        var q = query.create({ type: 'customrecord_op_form_status' });
        var transaction = q.joinTo({ fieldId: 'custrecord_op_fs_transaction_id', target: 'transaction' });
        q.columns = [column(q, 'id', 'id'), column(transaction, 'tranid', 'name')];
        q.condition = transaction.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [1] });
        return q;
    });

    log.audit('sublist join probe', JSON.stringify(results));
    return JSON.stringify(results, null, 2);
});
