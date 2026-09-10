/**
 * Bisects a query NetSuite refuses to render. Paste into the SuiteScript Debugger (API 2.1) and run.
 *
 * `toSuiteQL` costs no governance and fails on the same things `run` does, so the script renders the open-orders
 * query of the order-processing test project piece by piece: every column alone on the root query, every join
 * with one column, every condition alone, and finally everything together. Each attempt records "ok" or the error
 * message, so the first failing piece is visible in one run. Edit the `columns`, `joins`, and `conditions` lists
 * to bisect a different query; the shape mirrors what the runtime builds from the generated config.
 */
require(['N/query', 'N/log'], function (query, log) {
    var CUSTOMER_ID = 0; // any number: nothing runs, so the value never matters

    var results = { columns: {}, joins: {}, conditions: {}, whole: null };

    function message(error) { return error && error.message ? error.message : String(error); }
    function attempt(build) {
        try {
            build().toSuiteQL();
            return 'ok';
        } catch (error) {
            return 'ERR: ' + message(error);
        }
    }
    function display(component, fieldId, alias) { return component.createColumn({ fieldId: fieldId, alias: alias, context: query.FieldContext.DISPLAY }); }
    function plain(component, fieldId, alias) { return component.createColumn({ fieldId: fieldId, alias: alias }); }

    // ---- the joins the query makes; each is a function so every attempt gets a fresh query ------------------------
    function create() {
        var q = query.create({ type: 'salesorder' });
        return {
            q: q,
            lines: function () { return q.joinFrom({ fieldId: 'transaction', source: 'transactionline' }); },
            shippingAddress: function () { return q.autoJoin({ fieldId: 'shippingaddress' }); },
            billingAddress: function () { return q.autoJoin({ fieldId: 'billingaddress' }); },
        };
    }

    // ---- root columns, one attempt each --------------------------------------------------------------------------
    var rootColumns = [
        ['id'], ['transactionnumber'], ['tranid'], ['otherrefnum'], ['status', 'DISPLAY'], ['trandate'], ['custbody_js_req_ship_date'],
        ['custbody_header_notes'], ['entity'], ['location'], ['location', 'DISPLAY'], ['custbody30'], ['custbody30', 'DISPLAY'],
        ['custbody_sps_carrieralphacode'], ['custbody_sps_carrierrouting'], ['custbodyam_so_ship_mode'], ['custbodyam_so_ship_mode', 'DISPLAY'],
        ['custbody_sps_st_addresslocationnumber'], ['shipmethod'],
    ];
    rootColumns.forEach(function (entry) {
        var label = entry[0] + (entry[1] ? '#' + entry[1] : '');
        results.columns['root.' + label] = attempt(function () {
            var built = create();
            built.q.columns = [entry[1] ? display(built.q, entry[0], 'c') : plain(built.q, entry[0], 'c')];
            return built.q;
        });
    });

    // ---- joined columns, one attempt each, each with its join ----------------------------------------------------
    var addressFields = ['nkey', 'addrtext', 'addr1', 'addr2', 'addr3', 'addressee', 'attention', 'city', 'state', 'zip', 'addrphone', 'country'];
    ['shippingAddress', 'billingAddress'].forEach(function (name) {
        addressFields.forEach(function (fieldId) {
            results.columns[name + '.' + fieldId] = attempt(function () {
                var built = create();
                built.q.columns = [plain(built.q, 'id', 'id'), plain(built[name](), fieldId, 'c')];
                return built.q;
            });
        });
    });
    var lineColumns = [
        ['id'], ['transaction'], ['linesequencenumber'], ['uniquekey'], ['item'], ['custcol_sps_linesequencenumber'], ['custcol_sps_bpn'],
        ['iscogs'], ['donotprintline'], ['donotdisplayline'], ['quantity'], ['rate'], ['price'], ['price', 'DISPLAY'], ['custcolskidnotes'],
    ];
    lineColumns.forEach(function (entry) {
        var label = entry[0] + (entry[1] ? '#' + entry[1] : '');
        results.columns['lines.' + label] = attempt(function () {
            var built = create();
            var lines = built.lines();
            built.q.columns = [plain(built.q, 'id', 'id'), entry[1] ? display(lines, entry[0], 'c') : plain(lines, entry[0], 'c')];
            return built.q;
        });
    });
    ['id', 'itemid', 'displayname', 'description', 'itemtype'].forEach(function (fieldId) {
        results.columns['lines.item.' + fieldId] = attempt(function () {
            var built = create();
            var item = built.lines().joinTo({ fieldId: 'item', target: 'item' });
            built.q.columns = [plain(built.q, 'id', 'id'), plain(item, fieldId, 'c')];
            return built.q;
        });
    });

    // ---- joins alone, with the id column of the joined side ------------------------------------------------------
    results.joins['lines (joinFrom transactionline.transaction)'] = attempt(function () {
        var built = create();
        built.q.columns = [plain(built.q, 'id', 'id'), plain(built.lines(), 'id', 'line')];
        return built.q;
    });
    results.joins['lines.item (joinTo item)'] = attempt(function () {
        var built = create();
        built.q.columns = [plain(built.q, 'id', 'id'), plain(built.lines().joinTo({ fieldId: 'item', target: 'item' }), 'id', 'item')];
        return built.q;
    });
    results.joins['lines.item (autoJoin item)'] = attempt(function () {
        var built = create();
        built.q.columns = [plain(built.q, 'id', 'id'), plain(built.lines().autoJoin({ fieldId: 'item' }), 'id', 'item')];
        return built.q;
    });

    // ---- conditions, one attempt each, with the columns they need -------------------------------------------------
    var conditionAttempts = {
        'lines.mainline IS [false]': function (built) { return built.lines().createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }); },
        'entity ANY_OF': function (built) { return built.q.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [CUSTOMER_ID] }); },
        'entity EQUAL': function (built) { return built.q.createCondition({ fieldId: 'entity', operator: query.Operator.EQUAL, values: [CUSTOMER_ID] }); },
        'lines.iscogs IS [false]': function (built) { return built.lines().createCondition({ fieldId: 'iscogs', operator: query.Operator.IS, values: [false] }); },
        'lines.item.itemtype IS': function (built) { return built.lines().joinTo({ fieldId: 'item', target: 'item' }).createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['InvtPart'] }); },
        'lines.item.itemtype ANY_OF': function (built) { return built.lines().joinTo({ fieldId: 'item', target: 'item' }).createCondition({ fieldId: 'itemtype', operator: query.Operator.ANY_OF, values: ['InvtPart', 'Assembly'] }); },
        'lines.item.itemid START_WITH': function (built) { return built.lines().joinTo({ fieldId: 'item', target: 'item' }).createCondition({ fieldId: 'itemid', operator: query.Operator.START_WITH, values: ['SPS Error Item'] }); },
        "status IS ['SalesOrd:A']": function (built) { return built.q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] }); },
        "status ANY_OF ['SalesOrd:A']": function (built) { return built.q.createCondition({ fieldId: 'status', operator: query.Operator.ANY_OF, values: ['SalesOrd:A'] }); },
        "status EQUAL ['SalesOrd:A']": function (built) { return built.q.createCondition({ fieldId: 'status', operator: query.Operator.EQUAL, values: ['SalesOrd:A'] }); },
        'trandate ON_OR_AFTER': function (built) { return built.q.createCondition({ fieldId: 'trandate', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 11, 1)] }); },
        'status#DISPLAY formula IS': function (built) { return built.q.createCondition({ formula: '{status#DISPLAY}', type: query.ReturnType.STRING, operator: query.Operator.IS, values: ['Pending Fulfillment'] }); },
        'status#DISPLAY formula EQUAL': function (built) { return built.q.createCondition({ formula: '{status#DISPLAY}', type: query.ReturnType.STRING, operator: query.Operator.EQUAL, values: ['Pending Fulfillment'] }); },
    };
    Object.keys(conditionAttempts).forEach(function (label) {
        results.conditions[label] = attempt(function () {
            var built = create();
            built.q.columns = [plain(built.q, 'id', 'id')];
            built.q.condition = conditionAttempts[label](built);
            return built.q;
        });
    });

    // ---- sort on the root ------------------------------------------------------------------------------------------
    results.conditions['ORDER BY trandate'] = attempt(function () {
        var built = create();
        var column = plain(built.q, 'trandate', 'trandate');
        built.q.columns = [plain(built.q, 'id', 'id'), column];
        built.q.sort = [built.q.createSort({ column: column, ascending: true })];
        return built.q;
    });

    // ---- everything together, as the runtime builds it -------------------------------------------------------------
    results.whole = attempt(function () {
        var built = create();
        var lines = built.lines();
        var item = lines.joinTo({ fieldId: 'item', target: 'item' });
        var shippingAddress = built.shippingAddress();
        var billingAddress = built.billingAddress();
        var columns = rootColumns.map(function (entry) { return entry[1] ? display(built.q, entry[0], entry[0] + 'Text') : plain(built.q, entry[0], entry[0]); });
        addressFields.forEach(function (fieldId) {
            columns.push(plain(shippingAddress, fieldId, 'shippingAddress_' + fieldId));
            columns.push(plain(billingAddress, fieldId, 'billingAddress_' + fieldId));
        });
        lineColumns.forEach(function (entry) { columns.push(entry[1] ? display(lines, entry[0], 'lines_' + entry[0] + 'Text') : plain(lines, entry[0], 'lines_' + entry[0])); });
        ['id', 'itemid', 'displayname', 'description', 'itemtype'].forEach(function (fieldId) { columns.push(plain(item, fieldId, 'lines_item_' + fieldId)); });
        built.q.columns = columns;
        built.q.condition = built.q.and(
            lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }),
            built.q.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [CUSTOMER_ID] }),
            lines.createCondition({ fieldId: 'iscogs', operator: query.Operator.IS, values: [false] }),
            built.q.or(
                item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['InvtPart'] }),
                item.createCondition({ fieldId: 'itemid', operator: query.Operator.START_WITH, values: ['SPS Error Item'] })
            ),
            built.q.or(
                built.q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] }),
                built.q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:B'] })
            ),
            built.q.createCondition({ fieldId: 'trandate', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 11, 1)] })
        );
        built.q.sort = [built.q.createSort({ column: columns[5], ascending: true })];
        return built.q;
    });

    log.audit('bisect render failure', JSON.stringify(results));
    return JSON.stringify(results, null, 2);
});
