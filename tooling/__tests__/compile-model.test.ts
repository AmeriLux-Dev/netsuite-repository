import type { ResolvedClass, ResolvedField, ResolvedRelation } from '../collect/model-resolver';
import { ModelValidationError, compileModel } from '../compile/compile-model';

function field(name: string, overrides: Partial<ResolvedField> = {}): ResolvedField {
    return { name, queryFieldId: name.toLowerCase(), recordFieldId: name.toLowerCase(), readOnly: false, type: 'string', typeText: 'string', optional: false, inherited: false, ...overrides };
}

const internalId = field('id', { type: 'key', readOnly: true });

function model(overrides: Partial<ResolvedClass> = {}): ResolvedClass {
    return {
        className: 'Widget',
        filePath: '/models/Widget.ts',
        exportName: 'Widget',
        recordType: 'customrecord_widget',
        queryType: 'customrecord_widget',
        keyProperty: 'id',
        fields: [internalId, field('name')],
        relations: [],
        unmapped: [],
        ...overrides,
    };
}

describe('compileModel() – validation', () => {
    it('rejects a class with no record type and no internal id property, listing every problem', () => {
        let thrown: unknown;
        try {
            compileModel(model({ recordType: undefined, fields: [field('name')] }));
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(ModelValidationError);
        const error = thrown as ModelValidationError;
        expect(error.name).toBe('ModelValidationError');
        expect(error.className).toBe('Widget');
        expect(error.problems).toEqual(['a record type is required (@RecordType).', "internal id property 'id' is not declared."]);
        expect(error.message).toBe("Model 'Widget' is invalid:\n - a record type is required (@RecordType).\n - internal id property 'id' is not declared.");
    });

    it('rejects two properties that produce the same field key', () => {
        const owner: ResolvedRelation = {
            name: 'owner',
            kind: 'reference',
            optional: true,
            inherited: false,
            load: 'join',
            targetClassName: 'Owner',
            projection: 'all',
            fields: [internalId],
            relations: [],
            join: { kind: 'auto', fieldId: 'owner' },
        };

        expect(() => compileModel(model({ fields: [internalId, field('owner_id')], relations: [owner] }))).toThrow("Model 'Widget' is invalid:\n - field key 'owner_id' is produced twice; rename one of the properties.");
    });

    it('compiles a valid model, dropping undefined field facts', () => {
        const config = compileModel(model());
        expect(config.recordType).toBe('customrecord_widget');
        expect(config.fields.id).toEqual({ queryFieldId: 'id', type: 'key', isPrimary: true, readonly: true });
        expect(config.fields.name).toEqual({ queryFieldId: 'name', type: 'string', recordFieldId: 'name' });
    });
});
