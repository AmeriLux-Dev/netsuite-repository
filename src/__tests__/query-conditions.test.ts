import { QueryBuilder } from '..';
import type { QueryConfig } from '..';

interface ActivityModel {
    id: number;
    name: string;
    active: boolean;
    startedOn: Date;
    updatedAt: Date;
    kind: string;
}

const activityConfig: QueryConfig<ActivityModel> = {
    recordType: 'customrecord_activity',
    fields: {
        id: { queryFieldId: 'id', type: 'integer', isPrimary: true, readonly: true },
        name: { queryFieldId: 'name', type: 'string' },
        active: { queryFieldId: 'isinactive', type: 'boolean' },
        startedOn: { queryFieldId: 'custrecord_started_on', type: 'date' },
        updatedAt: { queryFieldId: 'lastmodified', type: 'datetime' },
        kind: { queryFieldId: 'custrecord_kind', type: 'string', fieldContext: 'DISPLAY', readonly: true },
    },
};

function conditionOf(builder: QueryBuilder<ActivityModel, any>) {
    return builder.describe().condition;
}

describe('condition operators translated from the field type', () => {
    it('compares dates with the date operators and keeps the Date value', () => {
        const day = new Date(2026, 0, 5, 23, 30);
        expect(conditionOf(QueryBuilder.from(activityConfig).where('startedOn', '>=', day))).toEqual({ kind: 'field', fieldId: 'custrecord_started_on', operator: 'ON_OR_AFTER', values: [day] });
        expect(conditionOf(QueryBuilder.from(activityConfig).where('updatedAt', '<', day))).toEqual({ kind: 'field', fieldId: 'lastmodified', operator: 'BEFORE', values: [day] });
        expect(conditionOf(QueryBuilder.from(activityConfig).where('startedOn', '=', day))).toEqual({ kind: 'field', fieldId: 'custrecord_started_on', operator: 'ON', values: [day] });
    });

    it('binds both BETWEEN bounds', () => {
        const from = new Date(2026, 2, 1);
        const to = new Date(2026, 2, 31);
        expect(conditionOf(QueryBuilder.from(activityConfig).whereBetween('startedOn', from, to))).toEqual({ kind: 'field', fieldId: 'custrecord_started_on', operator: 'BETWEEN', values: [from, to] });
    });

    it("compares a checkbox with IS and accepts NetSuite's letters as they are", () => {
        expect(conditionOf(QueryBuilder.from(activityConfig).where('active', '=', true).orWhere('active', '=', 'F'))).toEqual({
            kind: 'or',
            nodes: [
                { kind: 'field', fieldId: 'isinactive', operator: 'IS', values: [true] },
                { kind: 'field', fieldId: 'isinactive', operator: 'IS', values: [false] },
            ],
        });
    });

    it('compares against display text with useText, and always for a DISPLAY field', () => {
        expect(conditionOf(QueryBuilder.from(activityConfig).where('id', 'LIKE', 'Ship%', true))).toEqual({ kind: 'formula', formula: '{id#DISPLAY}', type: 'STRING', operator: 'START_WITH', values: ['Ship'] });
        expect(conditionOf(QueryBuilder.from(activityConfig).where('kind', '=', 'order'))).toEqual({ kind: 'formula', formula: '{custrecord_kind#DISPLAY}', type: 'STRING', operator: 'EQUAL', values: ['order'] });
        expect(conditionOf(QueryBuilder.from(activityConfig).where('name', 'IN', ['a', 'b']))).toEqual({ kind: 'or', nodes: [{ kind: 'field', fieldId: 'name', operator: 'EQUAL', values: ['a'] }, { kind: 'field', fieldId: 'name', operator: 'EQUAL', values: ['b'] }] });
    });

    it('accepts N/query operator names directly', () => {
        expect(conditionOf(QueryBuilder.from(activityConfig).where('name', 'CONTAIN', 'ship'))).toEqual({ kind: 'field', fieldId: 'name', operator: 'CONTAIN', values: ['ship'] });
        expect(conditionOf(QueryBuilder.from(activityConfig).where('startedOn', 'WITHIN', [new Date(2026, 0, 1), new Date(2026, 0, 31)]))).toEqual(expect.objectContaining({ operator: 'WITHIN' }));
        expect(conditionOf(QueryBuilder.from(activityConfig).where('name', 'EMPTY'))).toEqual({ kind: 'field', fieldId: 'name', operator: 'EMPTY' });
    });

    it('narrows the operators and the value to the field type', () => {
        // Never executed: these lines exist for the type checker only. ts-jest reports any expectation that stops failing.
        const typeChecks = () => {
            const builder = QueryBuilder.from(activityConfig);
            // @ts-expect-error LIKE does not apply to a number
            builder.where('id', 'LIKE', '1%');
            // @ts-expect-error a number field takes a number
            builder.where('id', '=', '1');
            // @ts-expect-error a date field takes a Date, not a string
            builder.where('startedOn', '>=', '2026-01-01');
            // @ts-expect-error a checkbox takes a boolean or T/F
            builder.where('active', '=', 'yes');
            // @ts-expect-error a checkbox is not compared by order
            builder.where('active', '>', true);
            // @ts-expect-error IN takes a list
            builder.where('id', 'IN', 1);
            // @ts-expect-error BETWEEN takes a pair
            builder.where('id', 'BETWEEN', [1]);
            // @ts-expect-error null is not a comparison value; use whereNull()
            builder.where('name', '=', null);
            // @ts-expect-error whereIn needs a text or numeric field
            builder.whereIn('startedOn', [new Date()]);
            // @ts-expect-error whereIn values follow the field type
            builder.whereIn('id', ['1']);
            // @ts-expect-error useText compares text, so BETWEEN does not apply
            builder.where('id', 'BETWEEN', [1, 2], true);
            builder.where('id', 'BETWEEN', [1, 2]);
            builder.where('startedOn', 'BETWEEN', [new Date(), new Date()]);
            builder.where('name', 'LIKE', 'A%').where('name', 'IN', ['a']).where('active', '=', 'T').where('id', 'IS NULL');
            builder.where('name', 'START_WITH', 'A').where('id', 'ANY_OF', [1, 2]).where('active', 'IS', true).where('startedOn', 'WITHIN', [new Date(), new Date()]);
            builder.whereBetween('id', 1, 2).whereIn('name', ['a']).whereNotIn('id', [1]);
            const widened = builder.selectFormula('{amount}', 'amount', { fieldType: 'float' });
            widened.where('amount', 'BETWEEN', [1, 2]).whereBetween('amount', 1, 2).whereIn('amount', [1]);
            return widened;
        };
        expect(typeChecks).toBeDefined();
    });
});
