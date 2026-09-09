/**
 * Smoke test for the 1.0.0 runtime: the N/query calls the compiled configs make, written out by hand so they can
 * run in the SuiteScript Debugger (API 2.1) before the bundled scripts are deployed.
 *
 * Three queries, each rendered with toSuiteQL first and then run through runPaged with a small page:
 *   1. an order header with its item lines (joinFrom with the model-declared `mainline IS false` filter), both
 *      address subrecords (autoJoin), the line's item (joinTo), DISPLAY-context text columns, the customer
 *      condition, and the raw status ANY_OF its search-style values, sorted by date: what `SalesOrderConfig`
 *      compiles to;
 *   2. the separate load of a reference matched on a code column: the OP SCAC rows whose carrier code is ANY_OF the
 *      codes on a batch of orders, with their carrier and SCAC references joined and the code aliased `__parentKey`;
 *   3. a datetime condition on a custom record (`created ON_OR_AFTER`), as the form-status history reads.
 *
 * Fill in the ids at the top, run, and compare the row counts and keys with what the 0.4.0 build returned for the
 * same customer. Results are logged at AUDIT level and returned as JSON. No account data is written.
 */
require(['N/query', 'N/log'], function (query, log) {
    // ---- account-specific inputs -------------------------------------------------------------
    var CUSTOMER_ID = 0;                     // the customer whose open orders the page lists
    var CARRIER_CODES = ['FDEG'];            // SPS carrier codes present on those orders
    var FORM_STATUS_TYPE = 'customrecord_op_form_status';
    var FORM_STATUS_SINCE = new Date(new Date().getFullYear(), 0, 1);
    var PAGE_SIZE = 5;

    var results = {};

    function message(error) { return error && error.message ? error.message : String(error); }
    function safe(read) { try { return read(); } catch (error) { return 'ERR: ' + message(error); } }
    function runFew(parentQuery) {
        var paged = parentQuery.runPaged({ pageSize: PAGE_SIZE });
        var rows = paged.pageRanges.length ? paged.fetch({ index: 0 }).data.asMappedResults() : [];
        return { count: paged.count, rowCount: rows.length, keys: Object.keys(rows[0] || {}), first: rows[0] || null };
    }
    function column(component, fieldId, alias, context) {
        var options = { fieldId: fieldId, alias: alias };
        if (context) options.context = context;
        return component.createColumn(options);
    }
    function renderAndRun(parentQuery) {
        return { sql: safe(function () { return parentQuery.toSuiteQL().query; }), run: safe(function () { return runFew(parentQuery); }) };
    }
    function record(id, build) {
        var started = Date.now();
        var outcome;
        try { outcome = build(); } catch (error) { outcome = { error: message(error) }; }
        outcome.elapsedMs = Date.now() - started;
        results[id] = outcome;
        log.audit('smoke 1.0.0 ' + id, JSON.stringify(outcome));
    }

    // ---- 1: the open-orders query as SalesOrderConfig compiles it ------------------------------
    record('sales_order_with_lines_and_addresses', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.joinFrom({ fieldId: 'transaction', source: 'transactionline' });
        var item = lines.joinTo({ fieldId: 'item', target: 'item' });
        var shippingAddress = q.autoJoin({ fieldId: 'shippingaddress' });
        var billingAddress = q.autoJoin({ fieldId: 'billingaddress' });

        q.columns = [
            column(q, 'id', 'id'),
            column(q, 'tranid', 'transactionName'),
            column(q, 'status', 'status', query.FieldContext.DISPLAY),
            column(q, 'trandate', 'transactionDate'),
            column(q, 'entity', 'customerId'),
            column(q, 'location', 'location'),
            column(q, 'location', 'locationName', query.FieldContext.DISPLAY),
            column(q, 'shipmethod', 'shipMethod'),
            column(shippingAddress, 'addr1', 'shippingAddress_addr1'),
            column(shippingAddress, 'city', 'shippingAddress_city'),
            column(billingAddress, 'addressee', 'billingAddress_addressee'),
            column(lines, 'id', 'lines_id'),
            column(lines, 'linesequencenumber', 'lines_lineSequenceNumber'),
            column(lines, 'item', 'lines_itemId'),
            column(lines, 'quantity', 'lines_quantity'),
            column(lines, 'price', 'lines_priceLevel'),
            column(lines, 'price', 'lines_priceLevelName', query.FieldContext.DISPLAY),
            column(item, 'itemid', 'lines_item_name'),
            column(item, 'itemtype', 'lines_item_type'),
        ];
        q.condition = q.and(
            lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }),
            q.createCondition({ fieldId: 'entity', operator: query.Operator.EQUAL, values: [CUSTOMER_ID] }),
            lines.createCondition({ fieldId: 'iscogs', operator: query.Operator.IS, values: [false] }),
            q.or(
                item.createCondition({ fieldId: 'itemtype', operator: query.Operator.ANY_OF, values: ['InvtPart', 'Assembly', 'Kit', 'NonInvtPart'] }),
                item.createCondition({ fieldId: 'itemid', operator: query.Operator.START_WITH, values: ['SPS Error Item'] })
            ),
            q.createCondition({ fieldId: 'status', operator: query.Operator.ANY_OF, values: ['SalesOrd:A', 'SalesOrd:B'] })
        );
        q.sort = [q.createSort({ column: column(q, 'trandate', 'sort_trandate'), ascending: true })];
        return renderAndRun(q);
    });

    // ---- 2: the separate load of a reference matched on a code column ----------------------------
    record('op_scac_by_carrier_code', function () {
        var q = query.create({ type: 'customrecord_op_scac' });
        var carrier = q.joinTo({ fieldId: 'custrecord_op_scac_carrier', target: 'shipitem' });
        var scac = q.joinTo({ fieldId: 'custrecord_op_scac_code', target: 'customlistam_scac' });
        q.columns = [
            column(q, 'id', 'carrierScac_id'),
            column(carrier, 'id', 'carrierScac_carrier_id'),
            column(carrier, 'displayname', 'carrierScac_carrier_displayName'),
            column(carrier, 'invt_dispname', 'carrierScac_carrier_inventoryDisplayName'),
            column(scac, 'id', 'carrierScac_scac_id'),
            column(scac, 'name', 'carrierScac_scac_name'),
            column(q, 'custrecord_op_scac_sps_carrier_code', '__parentKey'),
        ];
        q.condition = q.createCondition({ fieldId: 'custrecord_op_scac_sps_carrier_code', operator: query.Operator.ANY_OF, values: CARRIER_CODES });
        return renderAndRun(q);
    });

    // ---- 3: a datetime condition on a custom record ------------------------------------------------
    record('form_status_created_on_or_after', function () {
        var q = query.create({ type: FORM_STATUS_TYPE });
        var transaction = q.joinTo({ fieldId: 'custrecord_op_fs_transaction_id', target: 'transaction' });
        q.columns = [
            column(q, 'id', 'id'),
            column(q, 'custrecord_op_fs_transaction_id', 'transactionId'),
            column(transaction, 'tranid', 'transaction_name'),
            column(q, 'created', 'createdDate'),
        ];
        q.condition = q.and(
            transaction.createCondition({ fieldId: 'entity', operator: query.Operator.EQUAL, values: [CUSTOMER_ID] }),
            q.createCondition({ fieldId: 'created', operator: query.Operator.ON_OR_AFTER, values: [FORM_STATUS_SINCE] })
        );
        q.sort = [q.createSort({ column: column(q, 'created', 'sort_created'), ascending: false })];
        return renderAndRun(q);
    });

    return JSON.stringify(results, null, 2);
});
