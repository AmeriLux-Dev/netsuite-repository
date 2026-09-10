/**
 * Bisects the open-orders root query as the 1.0.0 runtime builds it. Paste into the SuiteScript Debugger (API 2.1) and run.
 *
 * `bisect-render-failure.js` rendered every column and condition of this query alone on a `salesorder` root, and
 * the lines moved to their own query on the `transaction` root. What that run did not cover is what this script
 * renders: the OR group on `status`, a sort on a column object that is not in `query.columns` (the compiler's
 * form before 1.0.0 reused the selected column), a DISPLAY column aliased with its own field id, and the whole
 * root query in both sort forms. The separate line query is rendered too, with its sort in both forms. Set
 * RUN_WHOLE to true to also execute the whole root query with runPaged({ pageSize: 5 }).
 */
require(['N/query', 'N/log'], function (query, log) {
    var CUSTOMER_ID = 0; // any number: nothing runs unless RUN_WHOLE is true
    var RUN_WHOLE = false;

    var results = {};

    function message(error) { return error && error.message ? error.message : String(error); }
    function attempt(label, build) {
        try {
            var q = build();
            var sql = q.toSuiteQL().query;
            results[label] = 'ok: ' + sql;
        } catch (error) {
            results[label] = 'ERR: ' + message(error);
        }
    }
    function display(component, fieldId, alias) { return component.createColumn({ fieldId: fieldId, alias: alias, context: query.FieldContext.DISPLAY }); }
    function plain(component, fieldId, alias) { return component.createColumn({ fieldId: fieldId, alias: alias }); }

    // ---- the root query's pieces, as the runtime builds them ----------------------------------------------------
    var rootColumns = [
        ['id', 'id'], ['transactionnumber', 'transactionNumber'], ['tranid', 'transactionName'], ['otherrefnum', 'poNumber'],
        ['status', 'status', 'DISPLAY'], ['trandate', 'transactionDate'], ['custbody_js_req_ship_date', 'requiredShipDate'],
        ['custbody_header_notes', 'notes'], ['entity', 'customerId'], ['location', 'location'], ['location', 'locationName', 'DISPLAY'],
        ['custbody30', 'subLocation'], ['custbody30', 'subLocationName', 'DISPLAY'], ['custbody_sps_carrieralphacode', 'spsCarrierAlphaCode'],
        ['custbody_sps_carrierrouting', 'spsCarrierRouting'], ['custbodyam_so_ship_mode', 'shipMode'], ['custbodyam_so_ship_mode', 'shipModeName', 'DISPLAY'],
        ['custbody_sps_st_addresslocationnumber', 'shipLocationNumber'], ['shipmethod', 'shipMethod'],
    ];
    var addressFields = ['nkey', 'addrtext', 'addr1', 'addr2', 'addr3', 'addressee', 'attention', 'city', 'state', 'zip', 'addrphone', 'country'];

    function rootQuery(options) {
        var q = query.create({ type: 'salesorder' });
        var columns = rootColumns.map(function (entry) { return entry[2] ? display(q, entry[0], entry[1]) : plain(q, entry[0], entry[1]); });
        if (options.addresses) {
            var billingAddress = q.autoJoin({ fieldId: 'billingaddress' });
            var shippingAddress = q.autoJoin({ fieldId: 'shippingaddress' });
            addressFields.forEach(function (fieldId) { columns.push(plain(shippingAddress, fieldId, 'shippingAddress_' + fieldId)); });
            addressFields.forEach(function (fieldId) { columns.push(plain(billingAddress, fieldId, 'billingAddress_' + fieldId)); });
        }
        q.columns = columns;
        if (options.conditions) {
            q.condition = q.and(
                q.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [CUSTOMER_ID] }),
                q.or(
                    q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] }),
                    q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:B'] })
                ),
                q.createCondition({ fieldId: 'trandate', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 11, 1)] })
            );
        }
        if (options.sort === 'selected') q.sort = [q.createSort({ column: columns[5], ascending: true })];
        if (options.sort === 'fresh') q.sort = [q.createSort({ column: q.createColumn({ fieldId: 'trandate' }), ascending: true })];
        return q;
    }

    // ---- one difference at a time --------------------------------------------------------------------------------
    attempt('sort on the selected trandate column', function () { return rootQuery({ sort: 'selected' }); });
    attempt('sort on a fresh trandate column not in query.columns', function () { return rootQuery({ sort: 'fresh' }); });
    attempt('or(status IS A, status IS B) alone', function () {
        var q = query.create({ type: 'salesorder' });
        q.columns = [plain(q, 'id', 'id')];
        q.condition = q.or(
            q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] }),
            q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:B'] })
        );
        return q;
    });
    attempt('and(entity ANY_OF, or(status IS, status IS), trandate ON_OR_AFTER) with the id column', function () {
        var q = query.create({ type: 'salesorder' });
        q.columns = [plain(q, 'id', 'id')];
        q.condition = q.and(
            q.createCondition({ fieldId: 'entity', operator: query.Operator.ANY_OF, values: [CUSTOMER_ID] }),
            q.or(
                q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] }),
                q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:B'] })
            ),
            q.createCondition({ fieldId: 'trandate', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 11, 1)] })
        );
        return q;
    });
    attempt('status#DISPLAY aliased status, with a status IS condition', function () {
        var q = query.create({ type: 'salesorder' });
        q.columns = [plain(q, 'id', 'id'), display(q, 'status', 'status')];
        q.condition = q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] });
        return q;
    });
    attempt('status#DISPLAY aliased statusText, with a status IS condition', function () {
        var q = query.create({ type: 'salesorder' });
        q.columns = [plain(q, 'id', 'id'), display(q, 'status', 'statusText')];
        q.condition = q.createCondition({ fieldId: 'status', operator: query.Operator.IS, values: ['SalesOrd:A'] });
        return q;
    });
    attempt('all root columns, no addresses, no conditions, no sort', function () { return rootQuery({}); });
    attempt('all root and address columns, no conditions, no sort', function () { return rootQuery({ addresses: true }); });
    attempt('all root and address columns with the conditions, no sort', function () { return rootQuery({ addresses: true, conditions: true }); });

    // ---- the whole root query in both sort forms -----------------------------------------------------------------
    attempt('WHOLE root query, sort on the selected column', function () { return rootQuery({ addresses: true, conditions: true, sort: 'selected' }); });
    attempt('WHOLE root query, sort on a fresh column', function () { return rootQuery({ addresses: true, conditions: true, sort: 'fresh' }); });

    // ---- the separate line query on the transaction root, sort in both forms --------------------------------------
    function lineQuery(sortForm) {
        var q = query.create({ type: 'transaction' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        var item = lines.joinTo({ fieldId: 'item', target: 'item' });
        var columns = [
            plain(lines, 'id', 'lines_id'), plain(lines, 'transaction', 'lines_transactionId'), plain(lines, 'linesequencenumber', 'lines_lineSequenceNumber'),
            plain(lines, 'uniquekey', 'lines_lineUniqueKey'), plain(lines, 'item', 'lines_itemId'), plain(lines, 'custcol_sps_linesequencenumber', 'lines_spsLineSequenceNumber'),
            plain(lines, 'custcol_sps_bpn', 'lines_buyerPartNumber'), plain(lines, 'iscogs', 'lines_isCogs'), plain(lines, 'donotprintline', 'lines_doNotPrintLine'),
            plain(lines, 'donotdisplayline', 'lines_doNotDisplayLine'), plain(lines, 'quantity', 'lines_quantity'), plain(lines, 'rate', 'lines_rate'),
            plain(lines, 'price', 'lines_priceLevel'), display(lines, 'price', 'lines_priceLevelName'), plain(lines, 'custcolskidnotes', 'lines_skidNotes'),
            plain(item, 'id', 'lines_item_id'), plain(item, 'itemid', 'lines_item_name'), plain(item, 'displayname', 'lines_item_displayName'),
            plain(item, 'description', 'lines_item_description'), plain(item, 'itemtype', 'lines_item_type'), plain(q, 'id', '__parentKey'),
        ];
        q.columns = columns;
        q.condition = q.and(
            lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }),
            q.createCondition({ fieldId: 'id', operator: query.Operator.ANY_OF, values: [1, 2] }),
            lines.createCondition({ fieldId: 'iscogs', operator: query.Operator.IS, values: [false] }),
            lines.createCondition({ fieldId: 'donotprintline', operator: query.Operator.IS, values: [false] }),
            lines.createCondition({ fieldId: 'donotdisplayline', operator: query.Operator.IS, values: [false] }),
            q.or(
                q.or(
                    item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['InvtPart'] }),
                    item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['Assembly'] }),
                    item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['Kit'] }),
                    item.createCondition({ fieldId: 'itemtype', operator: query.Operator.IS, values: ['NonInvtPart'] })
                ),
                item.createCondition({ fieldId: 'itemid', operator: query.Operator.START_WITH, values: ['SPS Error Item'] })
            )
        );
        if (sortForm === 'selected') q.sort = [lines.createSort({ column: columns[0], ascending: true })];
        if (sortForm === 'fresh') q.sort = [lines.createSort({ column: lines.createColumn({ fieldId: 'id' }), ascending: true })];
        return q;
    }
    attempt('WHOLE line query, sort on the selected lines.id column', function () { return lineQuery('selected'); });
    attempt('WHOLE line query, sort on a fresh lines.id column', function () { return lineQuery('fresh'); });

    if (RUN_WHOLE) {
        try {
            var paged = rootQuery({ addresses: true, conditions: true, sort: 'selected' }).runPaged({ pageSize: 5 });
            var firstPage = paged.count > 0 ? paged.fetch({ index: 0 }).data.asMappedResults() : [];
            results['RUN whole root query'] = 'ok: count ' + paged.count + ', first row keys ' + (firstPage[0] ? Object.keys(firstPage[0]).join(',') : '(no rows)');
        } catch (error) {
            results['RUN whole root query'] = 'ERR: ' + message(error);
        }
    }

    log.audit('bisect root query', JSON.stringify(results));
    return JSON.stringify(results, null, 2);
});
