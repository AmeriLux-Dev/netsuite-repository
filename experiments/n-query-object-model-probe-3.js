/**
 * Probe 3: everything the 1.0.0 object-model rewrite needs to know from N/query before code is written.
 *
 * Paste into the SuiteScript Debugger (API 2.1) and run. Fill in the ids at the top first.
 * Results are logged at AUDIT level (one entry per probe) and returned as JSON; save the JSON as
 * experiments/n-query-object-model-probe-3.results.json. Rendering costs nothing; each probe that
 * runs is bounded to a handful of rows through runPaged.
 */
require(['N/query', 'N/log'], function (query, log) {
    // ---- account-specific inputs -------------------------------------------------------------
    var KNOWN_SALES_ORDER_ID = 0;        // an existing sales order with lines and a shipping address
    var KNOWN_CUSTOMER_ID = 0;           // the entity on that order
    var KNOWN_OP_SCAC_ID = 0;            // a customrecord_op_scac record
    var CUSTOM_PARENT_TYPE = '';         // optional: a custom record with a child record (probe a3)
    var CUSTOM_CHILD_TYPE = '';          //           its child record type
    var CUSTOM_CHILD_PARENT_FIELD = '';  //           the child field holding the parent id
    var SCAC_CODE_LIST_TYPE = 'customlistam_scac';
    var STATUS_DISPLAY_TEXT = 'Pending Fulfillment';

    var results = {};

    function message(error) { return error && error.message ? error.message : String(error); }
    function safe(read) { try { return read(); } catch (error) { return 'ERR: ' + message(error); } }
    function render(parentQuery) { return parentQuery.toSuiteQL().query; }
    function runFew(parentQuery, pageSize) {
        var paged = parentQuery.runPaged({ pageSize: pageSize || 5 });
        var rows = paged.pageRanges.length ? paged.fetch({ index: 0 }).data.asMappedResults() : [];
        return { count: paged.count, rows: rows };
    }
    function column(component, fieldId, alias, context) {
        var options = { fieldId: fieldId, alias: alias || fieldId };
        if (context) options.context = context;
        return component.createColumn(options);
    }
    function idCondition(parentQuery) {
        return parentQuery.createCondition({ fieldId: 'id', operator: query.Operator.EQUAL, values: [KNOWN_SALES_ORDER_ID] });
    }
    function renderAndRun(parentQuery, pageSize) {
        return { sql: safe(function () { return render(parentQuery); }), run: safe(function () { return runFew(parentQuery, pageSize); }) };
    }
    function record(id, build) {
        var started = Date.now();
        var outcome;
        try { outcome = build(); } catch (error) { outcome = { error: message(error) }; }
        outcome.elapsedMs = Date.now() - started;
        results[id] = outcome;
        log.audit('probe3 ' + id, JSON.stringify(outcome));
    }

    // ---- a1: record type as query type --------------------------------------------------------
    var salesOrderFields = ['id', 'tranid', 'otherrefnum', 'status', 'trandate', 'entity', 'location', 'shipmethod', 'custbody30', 'custbodyam_so_ship_mode', 'custbody_sps_carrieralphacode', 'custbody_js_req_ship_date'];
    record('a1_salesorder_root_all_fields', function () {
        var q = query.create({ type: 'salesorder' });
        q.columns = salesOrderFields.map(function (f) { return column(q, f); });
        q.condition = idCondition(q);
        return renderAndRun(q);
    });
    record('a1_salesorder_root_per_field', function () {
        var perField = {};
        salesOrderFields.forEach(function (f) {
            var q = query.create({ type: 'salesorder' });
            q.columns = [column(q, f)];
            q.condition = idCondition(q);
            perField[f] = safe(function () { return runFew(q, 5).rows[0]; });
        });
        return { perField: perField };
    });
    record('a1_transaction_root_same_fields', function () {
        var q = query.create({ type: 'transaction' });
        q.columns = salesOrderFields.map(function (f) { return column(q, f); });
        q.condition = idCondition(q);
        return renderAndRun(q);
    });

    // ---- a2: the sublist join forms -----------------------------------------------------------
    var lineFields = ['id', 'item', 'quantity', 'mainline', 'linesequencenumber'];
    function lineProbe(joinLine, filterVariant) {
        var q = query.create({ type: 'salesorder' });
        var lines = joinLine(q);
        q.columns = [column(q, 'id', 'order_id')].concat(lineFields.map(function (f) { return column(lines, f, 'line_' + f); }));
        var conditions = [idCondition(q)];
        if (filterVariant === 'IS_false') conditions.push(lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }));
        if (filterVariant === 'EQUAL_false') conditions.push(lines.createCondition({ fieldId: 'mainline', operator: query.Operator.EQUAL, values: [false] }));
        if (filterVariant === 'EQUAL_F') conditions.push(lines.createCondition({ fieldId: 'mainline', operator: query.Operator.EQUAL, values: ['F'] }));
        q.condition = conditions.length > 1 ? q.and.apply(q, conditions) : conditions[0];
        return renderAndRun(q, 50);
    }
    var lineJoinForms = {
        joinFrom_transaction: function (q) { return q.joinFrom({ fieldId: 'transaction', source: 'transactionline' }); },
        autoJoin_item: function (q) { return q.autoJoin({ fieldId: 'item' }); },
        autoJoin_transactionlines: function (q) { return q.autoJoin({ fieldId: 'transactionlines' }); },
    };
    Object.keys(lineJoinForms).forEach(function (form) {
        ['none', 'IS_false', 'EQUAL_false', 'EQUAL_F'].forEach(function (filterVariant) {
            record('a2_' + form + '_filter_' + filterVariant, function () { return lineProbe(lineJoinForms[form], filterVariant); });
        });
    });

    // ---- a3: custom parent > child through joinFrom ------------------------------------------
    record('a3_custom_child_joinFrom', function () {
        if (!CUSTOM_PARENT_TYPE) return { skipped: 'CUSTOM_PARENT_TYPE not set' };
        var q = query.create({ type: CUSTOM_PARENT_TYPE });
        var child = q.joinFrom({ fieldId: CUSTOM_CHILD_PARENT_FIELD, source: CUSTOM_CHILD_TYPE });
        q.columns = [column(q, 'id', 'parent_id'), column(child, 'id', 'child_id')];
        return renderAndRun(q);
    });

    // ---- b: reference joins -------------------------------------------------------------------
    function referenceProbe(rootType, join, columns, rootCondition) {
        var q = query.create({ type: rootType });
        var target = join(q);
        q.columns = [column(q, 'id', 'root_id')].concat(columns.map(function (f) { return column(target, f, 'ref_' + f); }));
        if (rootCondition) q.condition = rootCondition(q);
        return renderAndRun(q);
    }
    record('b1_entity_autoJoin', function () { return referenceProbe('salesorder', function (q) { return q.autoJoin({ fieldId: 'entity' }); }, ['id', 'companyname'], idCondition); });
    record('b1_entity_joinTo_customer', function () { return referenceProbe('salesorder', function (q) { return q.joinTo({ fieldId: 'entity', target: 'customer' }); }, ['id', 'companyname'], idCondition); });
    record('b1_entity_joinTo_entity', function () { return referenceProbe('salesorder', function (q) { return q.joinTo({ fieldId: 'entity', target: 'entity' }); }, ['id', 'entityid'], idCondition); });
    record('b1_salesrep_joinTo_employee', function () { return referenceProbe('salesorder', function (q) { return q.joinTo({ fieldId: 'salesrep', target: 'employee' }); }, ['id', 'entityid'], idCondition); });
    record('b1_location_joinTo_location', function () { return referenceProbe('salesorder', function (q) { return q.joinTo({ fieldId: 'location', target: 'location' }); }, ['id', 'name'], idCondition); });

    function lineItemProbe(joinLine, joinItem) {
        var q = query.create({ type: 'salesorder' });
        var lines = joinLine(q);
        var item = joinItem(lines);
        q.columns = [column(q, 'id', 'order_id'), column(lines, 'id', 'line_id'), column(item, 'itemid', 'item_itemid'), column(item, 'itemtype', 'item_itemtype'), column(item, 'displayname', 'item_displayname')];
        q.condition = idCondition(q);
        return renderAndRun(q, 50);
    }
    record('b2_lines_item_autoJoin', function () { return lineItemProbe(lineJoinForms.autoJoin_transactionlines, function (lines) { return lines.autoJoin({ fieldId: 'item' }); }); });
    record('b2_lines_item_joinTo', function () { return lineItemProbe(lineJoinForms.autoJoin_transactionlines, function (lines) { return lines.joinTo({ fieldId: 'item', target: 'item' }); }); });
    record('b2_joinFrom_lines_item_joinTo', function () { return lineItemProbe(lineJoinForms.joinFrom_transaction, function (lines) { return lines.joinTo({ fieldId: 'item', target: 'item' }); }); });

    function scacCondition(q) { return q.createCondition({ fieldId: 'id', operator: query.Operator.EQUAL, values: [KNOWN_OP_SCAC_ID] }); }
    record('b3_scac_code_autoJoin', function () { return referenceProbe('customrecord_op_scac', function (q) { return q.autoJoin({ fieldId: 'custrecord_op_scac_code' }); }, ['id', 'name'], scacCondition); });
    record('b3_scac_code_joinTo', function () { return referenceProbe('customrecord_op_scac', function (q) { return q.joinTo({ fieldId: 'custrecord_op_scac_code', target: SCAC_CODE_LIST_TYPE }); }, ['id', 'name'], scacCondition); });
    record('b3_scac_carrier_autoJoin', function () { return referenceProbe('customrecord_op_scac', function (q) { return q.autoJoin({ fieldId: 'custrecord_op_scac_carrier' }); }, ['id', 'itemid'], scacCondition); });
    record('b3_scac_carrier_joinTo_shipitem', function () { return referenceProbe('customrecord_op_scac', function (q) { return q.joinTo({ fieldId: 'custrecord_op_scac_carrier', target: 'shipitem' }); }, ['id', 'itemid'], scacCondition); });
    record('b3_formstatus_transaction_autoJoin', function () { return referenceProbe('customrecord_op_form_status', function (q) { return q.autoJoin({ fieldId: 'custrecord_op_fs_transaction_id' }); }, ['id', 'tranid', 'entity']); });
    record('b3_formstatus_transaction_joinTo', function () { return referenceProbe('customrecord_op_form_status', function (q) { return q.joinTo({ fieldId: 'custrecord_op_fs_transaction_id', target: 'transaction' }); }, ['id', 'tranid', 'entity']); });
    record('b3_folder_parent_autoJoin', function () { return referenceProbe('mediaitemfolder', function (q) { return q.autoJoin({ fieldId: 'parent' }); }, ['id', 'name']); });
    record('b3_folder_parent_joinTo', function () { return referenceProbe('mediaitemfolder', function (q) { return q.joinTo({ fieldId: 'parent', target: 'mediaitemfolder' }); }, ['id', 'name']); });

    // ---- c1: display context columns ----------------------------------------------------------
    record('c1_display_columns', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [
            column(q, 'id', 'order_id'),
            column(q, 'status', 'status_raw'),
            column(q, 'status', 'status_text', query.FieldContext.DISPLAY),
            column(q, 'entity', 'entity_raw'),
            column(q, 'entity', 'entity_text', query.FieldContext.DISPLAY),
            column(q, 'custbodyam_so_ship_mode', 'shipmode_text', query.FieldContext.DISPLAY),
            column(lines, 'item', 'line_item_text', query.FieldContext.DISPLAY),
        ];
        q.condition = idCondition(q);
        return renderAndRun(q);
    });
    record('c1_display_custom_list_field', function () {
        var q = query.create({ type: 'customrecord_inventory_allocation' });
        q.columns = [column(q, 'id'), column(q, 'custrecord_alloc_type', 'type_raw'), column(q, 'custrecord_alloc_type', 'type_text', query.FieldContext.DISPLAY)];
        return renderAndRun(q);
    });

    // ---- c2: conditions on display text -------------------------------------------------------
    function textConditionProbe(makeCondition) {
        var q = query.create({ type: 'salesorder' });
        q.columns = [column(q, 'id'), column(q, 'status', 'status_text', query.FieldContext.DISPLAY)];
        q.condition = q.and(idCondition(q), makeCondition(q));
        return renderAndRun(q);
    }
    record('c2_formula_display_operator', function () { return textConditionProbe(function (q) { return q.createCondition({ formula: '{status#DISPLAY}', type: query.ReturnType.STRING, operator: query.Operator.EQUAL, values: [STATUS_DISPLAY_TEXT] }); }); });
    record('c2_formula_display_boolean', function () { return textConditionProbe(function (q) { return q.createCondition({ formula: "{status#DISPLAY} = '" + STATUS_DISPLAY_TEXT + "'", type: query.ReturnType.BOOLEAN }); }); });
    record('c2_formula_builtin_df_boolean', function () { return textConditionProbe(function (q) { return q.createCondition({ formula: "BUILTIN.DF({status}) = '" + STATUS_DISPLAY_TEXT + "'", type: query.ReturnType.BOOLEAN }); }); });
    record('c2_custom_list_display_boolean', function () {
        var q = query.create({ type: 'customrecord_inventory_allocation' });
        q.columns = [column(q, 'id'), column(q, 'custrecord_alloc_type', 'type_text', query.FieldContext.DISPLAY)];
        q.condition = q.createCondition({ formula: "{custrecord_alloc_type#DISPLAY} = 'order'", type: query.ReturnType.BOOLEAN });
        return renderAndRun(q);
    });

    // ---- c3: formula condition with a subquery ------------------------------------------------
    record('c3_formula_exists_subquery', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [column(q, 'id', 'order_id'), column(lines, 'id', 'line_id')];
        q.condition = q.and(idCondition(q), q.createCondition({ formula: 'EXISTS (SELECT 1 FROM customrecord_inventory_allocation a WHERE a.custrecord_alloc_sales_order = {id} AND a.custrecord_alloc_item = {transactionlines.item})', type: query.ReturnType.BOOLEAN }));
        return renderAndRun(q);
    });

    // ---- d: operators per field type ----------------------------------------------------------
    var operatorProbes = {
        status_EQUAL_prefixed: { fieldId: 'status', operator: 'EQUAL', values: ['SalesOrd:A'] },
        status_EQUAL_bare: { fieldId: 'status', operator: 'EQUAL', values: ['A'] },
        status_ANY_OF_prefixed: { fieldId: 'status', operator: 'ANY_OF', values: ['SalesOrd:A', 'SalesOrd:B'] },
        status_ANY_OF_bare: { fieldId: 'status', operator: 'ANY_OF', values: ['A', 'B'] },
        entity_EQUAL: { fieldId: 'entity', operator: 'EQUAL', values: [KNOWN_CUSTOMER_ID] },
        entity_ANY_OF: { fieldId: 'entity', operator: 'ANY_OF', values: [KNOWN_CUSTOMER_ID] },
        trandate_ON_OR_AFTER: { fieldId: 'trandate', operator: 'ON_OR_AFTER', values: [new Date(2025, 0, 1)] },
        trandate_AFTER: { fieldId: 'trandate', operator: 'AFTER', values: [new Date(2025, 0, 1)] },
        trandate_BETWEEN: { fieldId: 'trandate', operator: 'BETWEEN', values: [new Date(2025, 0, 1), new Date(2026, 11, 31)] },
        trandate_WITHIN: { fieldId: 'trandate', operator: 'WITHIN', values: [new Date(2025, 0, 1), new Date(2026, 11, 31)] },
        trandate_ON: { fieldId: 'trandate', operator: 'ON', values: [new Date(2026, 0, 15)] },
        trandate_GREATER_OR_EQUAL: { fieldId: 'trandate', operator: 'GREATER_OR_EQUAL', values: [new Date(2025, 0, 1)] },
        shipdate_ON_OR_AFTER: { fieldId: 'custbody_js_req_ship_date', operator: 'ON_OR_AFTER', values: [new Date(2025, 0, 1)] },
        tranid_START_WITH: { fieldId: 'tranid', operator: 'START_WITH', values: ['SO'] },
        tranid_CONTAIN: { fieldId: 'tranid', operator: 'CONTAIN', values: ['1'] },
        tranid_ENDWITH: { fieldId: 'tranid', operator: 'ENDWITH', values: ['1'] },
        tranid_EQUAL: { fieldId: 'tranid', operator: 'EQUAL', values: ['SO1'] },
        id_GREATER: { fieldId: 'id', operator: 'GREATER', values: [0] },
        id_GREATER_OR_EQUAL: { fieldId: 'id', operator: 'GREATER_OR_EQUAL', values: [1] },
        otherrefnum_EMPTY: { fieldId: 'otherrefnum', operator: 'EMPTY', values: [] },
        otherrefnum_EMPTY_NOT: { fieldId: 'otherrefnum', operator: 'EMPTY_NOT', values: [] },
        routingkey_ANY_OF_strings: { fieldId: 'custbody_sps_routingkey', operator: 'ANY_OF', values: ['x', 'y'] },
        routingkey_ANY_OF_NOT: { fieldId: 'custbody_sps_routingkey', operator: 'ANY_OF_NOT', values: ['x', 'y'] },
    };
    Object.keys(operatorProbes).forEach(function (name) {
        record('d_' + name, function () {
            var spec = operatorProbes[name];
            var q = query.create({ type: 'salesorder' });
            q.columns = [column(q, 'id'), column(q, spec.fieldId, 'value')];
            var options = { fieldId: spec.fieldId, operator: query.Operator[spec.operator] };
            if (spec.values.length) options.values = spec.values;
            q.condition = q.createCondition(options);
            return renderAndRun(q);
        });
    });
    var booleanProbes = { IS_false: { operator: 'IS', values: [false] }, EQUAL_false: { operator: 'EQUAL', values: [false] }, EQUAL_F: { operator: 'EQUAL', values: ['F'] }, IS_true: { operator: 'IS', values: [true] } };
    Object.keys(booleanProbes).forEach(function (name) {
        record('d_line_iscogs_' + name, function () {
            var spec = booleanProbes[name];
            var q = query.create({ type: 'salesorder' });
            var lines = q.autoJoin({ fieldId: 'transactionlines' });
            q.columns = [column(q, 'id', 'order_id'), column(lines, 'iscogs', 'line_iscogs')];
            q.condition = q.and(idCondition(q), lines.createCondition({ fieldId: 'iscogs', operator: query.Operator[spec.operator], values: spec.values }));
            return renderAndRun(q);
        });
    });

    // ---- e: paging and mapped result keys -----------------------------------------------------
    function joinedOrderQuery() {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        var ship = q.autoJoin({ fieldId: 'shippingaddress' });
        q.columns = [
            column(q, 'id', 'id'), column(q, 'trandate', 'transactionDate'), column(q, 'entity', 'customerId'), column(q, 'status', 'status', query.FieldContext.DISPLAY),
            column(lines, 'id', 'lines_id'), column(lines, 'iscogs', 'lines_isCogs'), column(lines, 'quantity', 'lines_quantity'),
            column(ship, 'addr1', 'shippingAddress_addr1'),
        ];
        q.condition = idCondition(q);
        return q;
    }
    record('e_runPaged_5', function () {
        var q = joinedOrderQuery();
        var paged = q.runPaged({ pageSize: 5 });
        var page = paged.pageRanges.length ? paged.fetch({ index: 0 }) : null;
        var rows = page ? page.data.asMappedResults() : [];
        var first = rows[0] || {};
        return {
            count: paged.count, pageSize: paged.pageSize, pageRanges: paged.pageRanges.length, isLast: page ? page.isLast : null,
            keys: Object.keys(first),
            valueTypes: Object.keys(first).reduce(function (acc, key) { acc[key] = typeof first[key] + ':' + String(first[key]); return acc; }, {}),
            resultSetTypes: page ? page.data.types : null,
            columnAliases: page ? page.data.columns.map(function (c) { return c.alias; }) : null,
        };
    });
    record('e_runPaged_1', function () { var q = joinedOrderQuery(); return { run: safe(function () { return { count: q.runPaged({ pageSize: 1 }).count }; }) }; });
    record('e_runPaged_2', function () { var q = joinedOrderQuery(); return { run: safe(function () { return { count: q.runPaged({ pageSize: 2 }).count }; }) }; });
    record('e_run_keys', function () {
        var q = joinedOrderQuery();
        var resultSet = q.run();
        var rows = resultSet.asMappedResults();
        return { rowCount: rows.length, keys: Object.keys(rows[0] || {}), types: resultSet.types, rawFirst: resultSet.results[0] ? resultSet.results[0].values : null };
    });

    // ---- f: grouping and condition-only joins -------------------------------------------------
    record('f_or_and_not', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [column(q, 'id', 'order_id'), column(lines, 'id', 'line_id')];
        var rootA = q.createCondition({ fieldId: 'id', operator: query.Operator.EQUAL, values: [KNOWN_SALES_ORDER_ID] });
        var rootB = q.createCondition({ fieldId: 'tranid', operator: query.Operator.START_WITH, values: ['ZZZ'] });
        var lineCondition = lines.createCondition({ fieldId: 'quantity', operator: query.Operator.GREATER, values: [0] });
        q.condition = q.and(q.or(rootA, rootB), q.not(q.createCondition({ fieldId: 'otherrefnum', operator: query.Operator.EQUAL, values: ['nope'] })), lineCondition);
        return renderAndRun(q, 50);
    });
    record('f_condition_only_join', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        q.columns = [column(q, 'id', 'order_id')];
        q.condition = q.and(idCondition(q), lines.createCondition({ fieldId: 'quantity', operator: query.Operator.GREATER, values: [0] }));
        return renderAndRun(q, 50);
    });

    // ---- g: root types -------------------------------------------------------------------------
    var rootTypeProbes = { transactionline: ['id', 'transaction', 'item'], customlistam_scac: ['id', 'name', 'isinactive'], customrecord_inventory_allocation: ['id', 'custrecord_alloc_type'], shipitem: ['id', 'itemid'], file: ['id', 'name', 'folder'], mediaitemfolder: ['id', 'name'], customrecord_op_scac: ['id', 'custrecord_op_scac_code'], customer: ['id', 'companyname'], employee: ['id', 'entityid'] };
    Object.keys(rootTypeProbes).forEach(function (type) {
        record('g_root_' + type, function () {
            var q = query.create({ type: type });
            q.columns = rootTypeProbes[type].map(function (f) { return column(q, f); });
            return renderAndRun(q);
        });
    });

    // ---- h: aggregates -------------------------------------------------------------------------
    ['COUNT', 'COUNT_DISTINCT'].forEach(function (aggregate) {
        record('h_' + aggregate + '_with_line_join', function () {
            var q = query.create({ type: 'salesorder' });
            var lines = q.autoJoin({ fieldId: 'transactionlines' });
            q.columns = [q.createColumn({ fieldId: 'id', aggregate: query.Aggregate[aggregate], alias: 'count' })];
            q.condition = q.and(q.createCondition({ fieldId: 'entity', operator: query.Operator.EQUAL, values: [KNOWN_CUSTOMER_ID] }), lines.createCondition({ fieldId: 'mainline', operator: query.Operator.IS, values: [false] }));
            return renderAndRun(q);
        });
    });

    // ---- i: ANY_OF list sizes ------------------------------------------------------------------
    [200, 500, 1000, 2000].forEach(function (size) {
        record('i_ANY_OF_' + size, function () {
            var ids = [];
            for (var i = 1; i <= size; i += 1) ids.push(i);
            var q = query.create({ type: 'salesorder' });
            q.columns = [column(q, 'id')];
            q.condition = q.createCondition({ fieldId: 'id', operator: query.Operator.ANY_OF, values: ids });
            return { run: safe(function () { return runFew(q, 5).count; }) };
        });
    });

    // ---- k: sorting ----------------------------------------------------------------------------
    record('k_sort_line_field_and_display', function () {
        var q = query.create({ type: 'salesorder' });
        var lines = q.autoJoin({ fieldId: 'transactionlines' });
        var statusText = column(q, 'status', 'status_text', query.FieldContext.DISPLAY);
        var lineSequence = column(lines, 'linesequencenumber', 'line_sequence');
        q.columns = [column(q, 'id', 'order_id'), statusText, lineSequence];
        q.condition = idCondition(q);
        q.sort = [q.createSort({ column: statusText, ascending: true, nullsLast: true }), lines.createSort({ column: lineSequence, ascending: false })];
        return renderAndRun(q, 50);
    });

    // ---- l: datetime operators -----------------------------------------------------------------
    record('l_datetime_ON_OR_AFTER', function () {
        var q = query.create({ type: 'customrecord_op_form_status' });
        q.columns = [column(q, 'id'), column(q, 'created')];
        q.condition = q.createCondition({ fieldId: 'created', operator: query.Operator.ON_OR_AFTER, values: [new Date(2025, 0, 1)] });
        return renderAndRun(q);
    });
    record('l_datetime_WITHIN', function () {
        var q = query.create({ type: 'customrecord_op_form_status' });
        q.columns = [column(q, 'id'), column(q, 'created')];
        q.condition = q.createCondition({ fieldId: 'created', operator: query.Operator.WITHIN, values: [new Date(2025, 0, 1), new Date(2026, 11, 31)] });
        return renderAndRun(q);
    });
    record('l_datetime_GREATER_OR_EQUAL', function () {
        var q = query.create({ type: 'customrecord_op_form_status' });
        q.columns = [column(q, 'id'), column(q, 'created')];
        q.condition = q.createCondition({ fieldId: 'created', operator: query.Operator.GREATER_OR_EQUAL, values: [new Date(2025, 0, 1)] });
        return renderAndRun(q);
    });

    return JSON.stringify(results, null, 2);
});
