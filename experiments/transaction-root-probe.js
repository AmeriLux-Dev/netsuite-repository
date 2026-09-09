/**
 * What a `transaction` root exposes and joins. Paste into the SuiteScript Debugger (API 2.1) and run; nothing
 * executes, every attempt only renders with toSuiteQL.
 *
 * Follow-up to sublist-join-probe.js: a `salesorder` root has no join to its lines, a `transaction` root reaches
 * them through `autoJoin('transactionlines')`, so sales order models query through `transaction` with a type
 * filter. This probe checks that root for the fields the models read, the joins below the lines, and the join
 * forms that reach an OP SCAC row's carrier and code. Each attempt records "ok" or the error.
 */
require(['N/query', 'N/log'], function (query, log) {
    var results = { rootColumns: {}, joins: {}, conditions: {} };

    function message(error) { return error && error.message ? error.message : String(error); }
    function attempt(bucket, label, build) {
        try {
            build().toSuiteQL();
            results[bucket][label] = 'ok';
        } catch (error) {
            results[bucket][label] = 'ERR: ' + message(error);
        }
    }
    function column(component, fieldId, alias, context) {
        var options = { fieldId: fieldId, alias: alias };
        if (context) options.context = context;
        return component.createColumn(options);
    }
    function transactionRoot() {
        var q = query.create({ type: 'transaction' });
        q.condition = q.createCondition({ fieldId: 'type', operator: query.Operator.ANY_OF, values: ['SalesOrd'] });
        return q;
    }

    // ---- every field the sales order models read, on the transaction root, with the type filter ------------------
    [
        ['id'], ['transactionnumber'], ['tranid'], ['otherrefnum'], ['status'], ['status', 'DISPLAY'], ['trandate'], ['custbody_js_req_ship_date'],
        ['custbody_header_notes'], ['entity'], ['location'], ['location', 'DISPLAY'], ['custbody30'], ['custbody30', 'DISPLAY'],
        ['custbody_sps_carrieralphacode'], ['custbody_sps_carrierrouting'], ['custbodyam_so_ship_mode'], ['custbodyam_so_ship_mode', 'DISPLAY'],
        ['custbody_sps_st_addresslocationnumber'], ['shipmethod'], ['custbody_sps_routingkey'], ['custbody_sps_vendor'],
        ['custbody_sps_customerordernumber'], ['custbody_sps_ic_contactname'], ['custbody_sps_orderby_address_code'], ['custbody_sps_orderby_address_qualifier'],
    ].forEach(function (entry) {
        attempt('rootColumns', entry[0] + (entry[1] ? '#' + entry[1] : ''), function () {
            var q = transactionRoot();
            q.columns = [column(q, entry[0], 'c', entry[1] ? query.FieldContext.DISPLAY : undefined)];
            return q;
        });
    });

    // ---- joins from the transaction root ------------------------------------------------------------------------------
    attempt('joins', 'shippingaddress + billingaddress (autoJoin)', function () {
        var q = transactionRoot();
        q.columns = [column(q, 'id', 'id'), column(q.autoJoin({ fieldId: 'shippingaddress' }), 'addr1', 'ship'), column(q.autoJoin({ fieldId: 'billingaddress' }), 'addr1', 'bill')];
        return q;
    });
    attempt('joins', 'transactionlines (autoJoin) with mainline IS false and line fields', function () {
        var q = transactionRoot();
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = ['id', 'transaction', 'linesequencenumber', 'uniquekey', 'item', 'custcol_sps_linesequencenumber', 'custcol_sps_bpn', 'iscogs', 'donotprintline', 'donotdisplayline', 'quantity', 'rate', 'price', 'custcolskidnotes', 'location']
            .map(function (fieldId) { return column(lines, fieldId, 'l_' + fieldId); });
        q.columns.push(column(lines, 'price', 'l_priceText', query.FieldContext.DISPLAY));
        q.condition = q.and(q.condition, lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }));
        return q;
    });
    attempt('joins', 'transactionlines > joinTo(item, item)', function () {
        var q = transactionRoot();
        var item = q.autoJoin({ fieldId: 'transactionlines' }).joinTo({ fieldId: 'item', target: 'item' });
        q.columns = [column(q, 'id', 'id'), column(item, 'itemid', 'name'), column(item, 'itemtype', 'type'), column(item, 'displayname', 'display'), column(item, 'description', 'description')];
        return q;
    });
    attempt('joins', 'transactionlines > autoJoin(item)', function () {
        var q = transactionRoot();
        var item = q.autoJoin({ fieldId: 'transactionlines' }).autoJoin({ fieldId: 'item' });
        q.columns = [column(q, 'id', 'id'), column(item, 'itemid', 'name')];
        return q;
    });
    attempt('joins', 'transactionlines > joinTo(location, location) > autoJoin(mainaddress)', function () {
        var q = transactionRoot();
        var location = q.autoJoin({ fieldId: 'transactionlines' }).joinTo({ fieldId: 'location', target: 'location' });
        q.columns = [column(q, 'id', 'id'), column(location, 'id', 'loc'), column(location.autoJoin({ fieldId: 'mainaddress' }), 'city', 'city')];
        return q;
    });
    attempt('joins', 'transactionlines > autoJoin(location) > autoJoin(mainaddress)', function () {
        var q = transactionRoot();
        var location = q.autoJoin({ fieldId: 'transactionlines' }).autoJoin({ fieldId: 'location' });
        q.columns = [column(q, 'id', 'id'), column(location, 'id', 'loc'), column(location.autoJoin({ fieldId: 'mainaddress' }), 'city', 'city')];
        return q;
    });
    attempt('joins', 'location root > autoJoin(mainaddress)', function () {
        var q = query.create({ type: 'location' });
        q.columns = [column(q, 'id', 'id'), column(q.autoJoin({ fieldId: 'mainaddress' }), 'city', 'city')];
        return q;
    });

    // ---- the OP SCAC row's carrier (a ship item) and code (a custom list), every form -----------------------------------
    attempt('joins', 'op_scac joinTo(custrecord_op_scac_carrier, item)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        q.columns = [column(q, 'id', 'id'), column(q.joinTo({ fieldId: 'custrecord_op_scac_carrier', target: 'item' }), 'itemid', 'name')];
        return q;
    });
    attempt('joins', 'op_scac autoJoin(custrecord_op_scac_carrier)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        q.columns = [column(q, 'id', 'id'), column(q.autoJoin({ fieldId: 'custrecord_op_scac_carrier' }), 'itemid', 'name')];
        return q;
    });
    attempt('joins', 'op_scac autoJoin(custrecord_op_scac_code)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        q.columns = [column(q, 'id', 'id'), column(q.autoJoin({ fieldId: 'custrecord_op_scac_code' }), 'name', 'name')];
        return q;
    });
    attempt('joins', 'op_scac custrecord_op_scac_code#DISPLAY (no join)', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        q.columns = [column(q, 'id', 'id'), column(q, 'custrecord_op_scac_code', 'scacName', query.FieldContext.DISPLAY), column(q, 'custrecord_op_scac_carrier', 'carrierName', query.FieldContext.DISPLAY)];
        return q;
    });
    attempt('joins', 'shipitem root columns', function () {
        var q = query.create({ type: 'shipitem' });
        q.columns = [column(q, 'id', 'id'), column(q, 'itemid', 'name'), column(q, 'displayname', 'display'), column(q, 'invt_dispname', 'inventoryDisplay')];
        return q;
    });
    attempt('joins', 'customlistam_scac root columns', function () {
        var q = query.create({ type: 'customlistam_scac' });
        q.columns = [column(q, 'id', 'id'), column(q, 'name', 'name'), column(q, 'isinactive', 'inactive')];
        return q;
    });

    // ---- the root filter and status forms on the transaction root ----------------------------------------------------------
    attempt('conditions', "type ANY_OF ['SalesOrd']", function () { var q = transactionRoot(); q.columns = [column(q, 'id', 'id')]; return q; });
    attempt('conditions', "type IS ['SalesOrd']", function () {
        var q = query.create({ type: 'transaction' });
        q.columns = [column(q, 'id', 'id')];
        q.condition = q.createCondition({ fieldId: 'type', operator: query.Operator.IS, values: ['SalesOrd'] });
        return q;
    });
    attempt('conditions', "status ANY_OF ['SalesOrd:A', 'SalesOrd:B']", function () {
        var q = transactionRoot();
        q.columns = [column(q, 'id', 'id')];
        q.condition = q.and(q.condition, q.createCondition({ fieldId: 'status', operator: query.Operator.ANY_OF, values: ['SalesOrd:A', 'SalesOrd:B'] }));
        return q;
    });
    attempt('conditions', 'entity ANY_OF and trandate ON_OR_AFTER and lines.iscogs IS false and item.itemtype IS', function () {
        var q = transactionRoot();
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        var item = lines.joinTo({ fieldId: 'item', target: 'item' });
        q.columns = [column(q, 'id', 'id'), column(lines, 'id', 'line')];
        q.condition = q.and(
            q.condition,
            q.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [1] }),
            q.createCondition({ fieldId: 'trandate', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 11, 1)] }),
            lines.createCondition({ fieldId: 'iscogs', operator: query.Operator.IS, values: [false] }),
            item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['InvtPart'] })
        );
        return q;
    });

    log.audit('transaction root probe', JSON.stringify(results));
    return JSON.stringify(results, null, 2);
});
