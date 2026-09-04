import { QueryBuilder, raw } from '..';
import type { QueryConfig } from '..';

interface ActivityModel {
    id: number;
    name: string;
    active: boolean;
    startedOn: Date;
    updatedAt: Date;
}

const activityConfig: QueryConfig<ActivityModel> = {
    recordType: 'customrecord_activity',
    query: { from: { name: 'customrecord_activity', alias: 'activity' } },
    fields: {
        id: { queryFieldId: 'id', tableAlias: 'activity', type: 'integer', isPrimary: true, readonly: true },
        name: { queryFieldId: 'name', tableAlias: 'activity', type: 'string' },
        active: { queryFieldId: 'isinactive', tableAlias: 'activity', type: 'boolean' },
        startedOn: { queryFieldId: 'custrecord_started_on', tableAlias: 'activity', type: 'date' },
        updatedAt: { queryFieldId: 'lastmodified', tableAlias: 'activity', type: 'datetime' },
    },
};

describe('condition values bound from the field type', () => {
    it('binds a Date on a date field through TO_DATE with the local calendar date', () => {
        const built = QueryBuilder.from(activityConfig).where('startedOn', '>=', new Date(2026, 0, 5, 23, 30)).build();
        expect(built.sql).toContain("activity.custrecord_started_on >= TO_DATE(?, 'YYYY-MM-DD')");
        expect(built.params).toEqual(['2026-01-05']);
    });

    it('keeps the time for a datetime field', () => {
        const built = QueryBuilder.from(activityConfig).where('updatedAt', '<', new Date(2026, 11, 31, 8, 5, 9)).build();
        expect(built.sql).toContain("activity.lastmodified < TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')");
        expect(built.params).toEqual(['2026-12-31 08:05:09']);
    });

    it('binds both BETWEEN bounds through TO_DATE', () => {
        const built = QueryBuilder.from(activityConfig).whereBetween('startedOn', new Date(2026, 2, 1), new Date(2026, 2, 31)).build();
        expect(built.sql).toContain("BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD')");
        expect(built.params).toEqual(['2026-03-01', '2026-03-31']);
    });

    it('binds a Date on a raw reference with the time, since the column type is unknown', () => {
        const built = QueryBuilder.from(activityConfig)
            .leftJoin('customrecord_activity_log', 'log', 'log.activity = activity.id')
            .where(raw('log.loggedat'), '>', new Date(2026, 5, 1))
            .build();
        expect(built.sql).toContain("log.loggedat > TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')");
        expect(built.params).toEqual(['2026-06-01 00:00:00']);
    });

    it("binds a boolean on a checkbox field as NetSuite's T/F and accepts the letters as they are", () => {
        const built = QueryBuilder.from(activityConfig).where('active', '=', true).orWhere('active', '=', 'F').build();
        expect(built.sql).toContain('activity.isinactive = ? OR activity.isinactive = ?');
        expect(built.params).toEqual(['T', 'F']);
    });

    it('leaves a boolean alone when the column type is unknown', () => {
        const built = QueryBuilder.from(activityConfig)
            .leftJoin('customrecord_activity_log', 'log', 'log.activity = activity.id')
            .where(raw('log.flag'), '=', true)
            .build();
        expect(built.params).toEqual([true]);
    });

    it('compares against display text with useText whatever the field type', () => {
        const built = QueryBuilder.from(activityConfig).where('id', 'LIKE', 'Ship%', true).where('name', 'IN', ['a', 'b']).build();
        expect(built.sql).toContain('BUILTIN.DF(activity.id) LIKE ?');
        expect(built.sql).toContain('activity.name IN (?, ?)');
        expect(built.params).toEqual(['Ship%', 'a', 'b']);
    });

    it('narrows the operators and the value to the field type', () => {
        // Never executed: these lines exist for the type checker only. ts-jest reports any expectation that stops failing.
        const typeChecks = () => {
            const builder = QueryBuilder.from(activityConfig);
            // @ts-expect-error BETWEEN does not apply to text
            builder.where('name', 'BETWEEN', ['a', 'z']);
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
            // @ts-expect-error whereBetween needs a numeric or date field
            builder.whereBetween('name', 'a', 'z');
            // @ts-expect-error whereIn needs a text or numeric field
            builder.whereIn('startedOn', [new Date()]);
            // @ts-expect-error whereIn values follow the field type
            builder.whereIn('id', ['1']);
            // @ts-expect-error useText compares text, so BETWEEN does not apply
            builder.where('id', 'BETWEEN', [1, 2], true);
            builder.where('id', 'BETWEEN', [1, 2]);
            builder.where('startedOn', 'BETWEEN', [new Date(), new Date()]);
            builder.where('name', 'LIKE', 'A%').where('name', 'IN', ['a']).where('active', '=', 'T').where('id', 'IS NULL');
            builder.whereBetween('id', 1, 2).whereIn('name', ['a']).whereNotIn('id', [1]);
            builder.where(raw('log.amount'), 'BETWEEN', [1, 2]).where(raw('log.note'), 'LIKE', 'x%');
            const joined = builder.leftJoin('customrecord_activity_log', 'log', 'log.activity = activity.id');
            joined.where('log.amount', 'BETWEEN', [1, 2]).whereBetween('log.amount', 1, 2).whereIn('log.kind', ['a']);
            return joined;
        };
        expect(typeChecks).toBeDefined();
    });
});
