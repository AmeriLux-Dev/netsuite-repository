import { createFakeNQueryModule, describeFakeQuery } from '../testing';

describe('FakeNQueryModule', () => {
    it('answers queued rows to the next matching query only, unless the entry repeats', () => {
        const nsQuery = createFakeNQueryModule();
        nsQuery.queueRows('customer', [{ id: 1 }]);
        nsQuery.queueRows({ type: 'customer', contains: 'name' }, [{ id: 2 }]);
        nsQuery.queueRows((call) => call.type === 'vendor', [{ id: 3 }], { repeat: true });

        const customers = nsQuery.create({ type: 'customer' });
        customers.columns = [customers.createColumn({ fieldId: 'name' })];
        expect(customers.run().asMappedResults()).toEqual([{ id: 1 }]);
        expect(customers.run().asMappedResults()).toEqual([{ id: 2 }]);
        expect(customers.run().asMappedResults()).toEqual([]);

        const vendors = nsQuery.create({ type: 'vendor' });
        vendors.columns = [vendors.createColumn({ fieldId: 'id' })];
        expect(vendors.run().asMappedResults()).toEqual([{ id: 3 }]);
        expect(vendors.run().asMappedResults()).toEqual([{ id: 3 }]);
        expect(nsQuery.calls.map((call) => call.execution)).toEqual(['run', 'run', 'run', 'run', 'run']);

        nsQuery.reset();
        expect(nsQuery.calls).toEqual([]);
        expect(vendors.run().asMappedResults()).toEqual([]);
    });

    it('matches on a joined component path and rejects a relationship joined twice', () => {
        const nsQuery = createFakeNQueryModule();
        nsQuery.queueRows({ component: 'transactionlines' }, [{ id: 1 }]);
        const query = nsQuery.create({ type: 'salesorder' });
        const lines = query.autoJoin({ fieldId: 'transactionlines' });
        query.columns = [lines.createColumn({ fieldId: 'id', alias: 'line' })];
        expect(query.run().asMappedResults()).toEqual([{ id: 1 }]);
        expect(() => query.join({ fieldId: 'transactionlines' })).toThrow("RELATIONSHIP_ALREADY_USED: 'transactionlines' is already joined on 'salesorder'.");
        expect(lines.source).toBeNull();
        expect(lines.target).toBeNull();
        expect(query.child.transactionlines).toBe(lines);
        expect(query.joinTo({ fieldId: 'entity', target: 'customer' }).target).toBe('customer');
        expect(lines.joinFrom({ fieldId: 'line', source: 'child' }).source).toBe('child');
        expect(query.joinFrom({ fieldId: 'transaction', source: 'transactionline' }).path).toBe('transactionline.transaction');
    });

    it('pages queued rows through runPaged', () => {
        const nsQuery = createFakeNQueryModule();
        nsQuery.queueRows('customer', [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }]);
        const query = nsQuery.create({ type: 'customer' });
        query.columns = [query.createColumn({ fieldId: 'id' })];

        const paged = query.runPaged({ pageSize: 5 });
        expect(paged.count).toBe(7);
        expect(paged.pageRanges).toEqual([{ index: 0, size: 5 }, { index: 1, size: 2 }]);
        const first = paged.fetch({ index: 0 });
        expect(first.isFirst).toBe(true);
        expect(first.isLast).toBe(false);
        expect(first.data.asMappedResults()).toHaveLength(5);
        expect(paged.fetch({ index: 1 }).isLast).toBe(true);
        expect(() => paged.fetch({ index: 2 })).toThrow('INVALID_PAGE_INDEX');
        const seen: number[] = [];
        paged.iterator().each((page) => { seen.push(page.value.pageRange.index); return page.value.pageRange.index < 0; });
        expect(seen).toEqual([0]);
        expect(nsQuery.calls[0]).toEqual(expect.objectContaining({ execution: 'runPaged', pageSize: 5 }));
        expect(query.runPaged({ pageSize: 5 }).pageRanges).toEqual([]);
    });

    it('exposes result sets the way N/query does', () => {
        const nsQuery = createFakeNQueryModule();
        nsQuery.queueRows('customer', [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
        const query = nsQuery.create({ type: 'customer' });
        query.columns = [query.createColumn({ fieldId: 'id' }), query.createColumn({ fieldId: 'name' })];
        const resultSet = query.run();
        expect(resultSet.results.map((result) => result.values)).toEqual([[1, 'A'], [2, 'B']]);
        expect(resultSet.results[0].asMap()).toEqual({ id: 1, name: 'A' });
        expect(resultSet.columns).toHaveLength(2);
        expect(resultSet.types).toEqual([]);
        const seen: unknown[] = [];
        resultSet.iterator().each((result) => { seen.push(result.value.asMap()); return false; });
        expect(seen).toEqual([{ id: 1, name: 'A' }]);
    });

    it('describes the tree it was built into, renders it through toSuiteQL, and validates column and condition options', () => {
        const nsQuery = createFakeNQueryModule();
        const query = nsQuery.create({ type: 'salesorder' });
        const lines = query.autoJoin({ fieldId: 'transactionlines' });
        const statusText = query.createColumn({ fieldId: 'status', alias: 'statusText', context: { name: nsQuery.FieldContext.DISPLAY } });
        query.columns = [query.createColumn({ fieldId: 'id' }), statusText, lines.createColumn({ formula: '{quantity} * 2', type: nsQuery.ReturnType.FLOAT, alias: 'double' }), query.createColumn({ fieldId: 'id', aggregate: nsQuery.Aggregate.COUNT, alias: 'count' })];
        query.condition = query.and(
            query.createCondition({ fieldId: 'entity', operator: nsQuery.Operator.EQUAL, values: [1] }),
            query.or(lines.createCondition({ fieldId: 'quantity', operator: nsQuery.Operator.GREATER, values: [0] }), query.not(query.createCondition({ formula: '{id} > 0', type: nsQuery.ReturnType.BOOLEAN }))),
            query.createCondition({ formula: '{status#DISPLAY}', type: nsQuery.ReturnType.STRING, operator: nsQuery.Operator.EQUAL, values: ['x'] }),
        );
        query.sort = [query.createSort({ column: statusText, ascending: false, nullsLast: true }), lines.createSort({ column: lines.createColumn({ formula: '{quantity}' }) })];

        const description = describeFakeQuery(query);
        expect(description).toEqual({
            queryType: 'salesorder',
            components: [{ path: 'transactionlines', join: { kind: 'auto', fieldId: 'transactionlines' }, conditions: [] }],
            columns: [
                { alias: 'id', fieldId: 'id' },
                { alias: 'statusText', fieldId: 'status', context: 'DISPLAY' },
                { alias: 'double', component: 'transactionlines', formula: '{quantity} * 2', formulaType: 'FLOAT' },
                { alias: 'count', fieldId: 'id', aggregate: 'COUNT' },
            ],
            condition: {
                kind: 'and',
                nodes: [
                    { kind: 'field', fieldId: 'entity', operator: 'EQUAL', values: [1] },
                    { kind: 'or', nodes: [{ kind: 'field', component: 'transactionlines', fieldId: 'quantity', operator: 'GREATER', values: [0] }, { kind: 'not', node: { kind: 'formula', formula: '{id} > 0', type: 'BOOLEAN' } }] },
                    { kind: 'formula', formula: '{status#DISPLAY}', type: 'STRING', operator: 'EQUAL', values: ['x'] },
                ],
            },
            sort: [{ fieldId: 'status', context: 'DISPLAY', ascending: false, nullsLast: true }, { component: 'transactionlines', formula: '{quantity}', ascending: true }],
        });
        const rendered = query.toSuiteQL();
        expect(rendered.query).toContain('JOIN auto transactionlines AS transactionlines');
        expect(rendered.type).toBe('salesorder');
        expect(rendered.params).toEqual([]);
        expect(rendered.columns).toHaveLength(4);
        expect(rendered.run().asMappedResults()).toEqual([]);
        expect(rendered.runPaged({ pageSize: 5 }).count).toBe(0);
        expect(nsQuery.calls[0].execution).toBe('toSuiteQL');
        expect(query.toString()).toBe('FakeQuery(salesorder)');
        expect(query.toJSON()).toEqual(description);
        expect(query.id).toBeNull();
        expect(query.name).toBeNull();
        expect(() => query.createColumn({ alias: 'x' })).toThrow('NEITHER_ARGUMENT_DEFINED');
        expect(() => query.createCondition({ operator: 'EQUAL' })).toThrow('MISSING_REQD_ARGUMENT');
        expect(describeFakeQuery(nsQuery.create({ type: 'x' })).columns).toEqual([]);
        const formulaOnly = nsQuery.create({ type: 'x' });
        formulaOnly.columns = [formulaOnly.createColumn({ formula: '1' })];
        expect(describeFakeQuery(formulaOnly).columns).toEqual([{ alias: '1', formula: '1' }]);
    });
});
