/**
 * Probe 2: make N/query render the join.
 *
 * Run 1 showed that autoJoin accepts subrecord, sublist, and reference fields, but that a formula column on the joined
 * component is not enough for toSuiteQL() to emit the join, and that Component.target is null for auto joins.
 * This run references a real field on the joined side, both as a column and as a condition, and walks nested joins
 * (transaction > transactionlines > item, customer > addressbook > addressbookaddress).
 *
 * Paste into the SuiteScript Debugger (API 2.1). Results are logged at AUDIT level and returned as JSON.
 */
require(['N/query', 'N/log'], function (query, log) {
    // Each step is a relationship field on the previous component plus candidate field ids on the joined component.
    var probes = [
        { type: 'transaction', path: [{ fieldId: 'shippingaddress', fields: ['addr1', 'city', 'nkey'] }] },
        { type: 'transaction', path: [{ fieldId: 'billingaddress', fields: ['addr1', 'city', 'nkey'] }] },
        { type: 'transaction', path: [{ fieldId: 'entity', fields: ['id', 'entityid'] }] },
        { type: 'transaction', path: [{ fieldId: 'subsidiary', fields: ['id', 'name'] }] },
        { type: 'transaction', path: [{ fieldId: 'salesrep', fields: ['id', 'entityid'] }] },
        { type: 'transaction', path: [{ fieldId: 'transactionlines', fields: ['id', 'quantity', 'item'] }] },
        { type: 'transaction', path: [{ fieldId: 'transactionlines', fields: ['id'] }, { fieldId: 'item', fields: ['id', 'itemid'] }] },
        { type: 'customer', path: [{ fieldId: 'addressbook', fields: ['id', 'label'] }] },
        { type: 'customer', path: [{ fieldId: 'addressbook', fields: ['id'] }, { fieldId: 'addressbookaddress', fields: ['addr1', 'city', 'nkey'] }] },
        { type: 'salesorder', path: [{ fieldId: 'shippingaddress', fields: ['addr1'] }] },
    ];

    function message(error) {
        return error && error.message ? error.message : String(error);
    }

    function firstWorkingColumn(component, fields, alias) {
        var attempts = [];
        for (var index = 0; index < fields.length; index += 1) {
            try {
                var column = component.createColumn({ fieldId: fields[index], alias: alias + '_' + fields[index] });
                return { column: column, fieldId: fields[index], attempts: attempts };
            } catch (error) {
                attempts.push(fields[index] + ': ' + message(error));
            }
        }
        return { column: null, attempts: attempts };
    }

    function runProbe(probe) {
        var result = { probe: probe, steps: [] };
        try {
            var parentQuery = query.create({ type: probe.type });
            var component = parentQuery.root;
            var columns = [parentQuery.createColumn({ fieldId: 'id' })];
            var lastJoined = null;
            var lastFieldId = null;
            probe.path.forEach(function (step, depth) {
                var joined = component.autoJoin({ fieldId: step.fieldId });
                var picked = firstWorkingColumn(joined, step.fields, 'j' + depth);
                result.steps.push({ fieldId: step.fieldId, componentType: joined.type, columnField: picked.fieldId || null, columnAttempts: picked.attempts });
                if (picked.column) columns.push(picked.column);
                lastJoined = joined;
                lastFieldId = picked.fieldId;
                component = joined;
            });
            parentQuery.columns = columns;
            result.sqlWithColumn = parentQuery.toSuiteQL().query;

            // Condition variant: keep only the root column and put a predicate on the deepest joined component.
            if (lastJoined && lastFieldId) {
                parentQuery.columns = [parentQuery.createColumn({ fieldId: 'id' })];
                parentQuery.condition = lastJoined.createCondition({ fieldId: lastFieldId, operator: query.Operator.EMPTY_NOT });
                result.sqlWithCondition = parentQuery.toSuiteQL().query;
            }
        } catch (error) {
            result.error = message(error);
        }
        return result;
    }

    var results = probes.map(runProbe);
    results.forEach(function (result) {
        var label = result.probe.type + ' > ' + result.probe.path.map(function (step) { return step.fieldId; }).join(' > ');
        log.audit('n-query join probe 2 ' + label, JSON.stringify(result));
    });
    return JSON.stringify(results, null, 2);
});
