import * as nodePath from 'path';
import { createModelTypeProgram, readDeclaredClass } from '../collect/property-type-reader';
import { toPosixPath } from '../file-system';

const shapesFile = nodePath.join(__dirname, 'fixtures', 'typing', 'Shapes.ts');
const program = createModelTypeProgram([shapesFile]);
const declared = readDeclaredClass(program, shapesFile, 'Shapes');
const target = { className: 'Target', filePath: toPosixPath(shapesFile) };

function property(name: string) {
    return declared?.properties.find((candidate) => candidate.name === name);
}

describe('readDeclaredClass() – declaration shapes', () => {
    it('skips methods, static members, constructor parameter properties, and callable properties', () => {
        expect(declared?.properties.map((candidate) => candidate.name)).toEqual(['id', 'status', 'mixed', 'aliased', 'mapped', 'genericArray', 'nullableArray', 'aliasedArray', 'projectedList', 'nullableTarget']);
    });

    it('classifies a union of one scalar kind and leaves a mixed union unclassified', () => {
        expect(property('status')).toEqual(expect.objectContaining({ scalarType: 'string', typeText: '"open" | "closed"' }));
        expect(property('mixed')).toEqual(expect.objectContaining({ typeText: 'string | number' }));
        expect(property('mixed')?.scalarType).toBeUndefined();
        expect(property('mixed')?.target).toBeUndefined();
    });

    it('follows an alias of Pick to the class it projects', () => {
        expect(property('aliased')?.target).toEqual({ ...target, projection: ['id'] });
    });

    it('falls back to the class declaring the projected members for a mapped type', () => {
        expect(property('mapped')?.target).toEqual({ ...target, projection: ['id', 'name'] });
    });

    it('reads array element targets from Array<T>, a nullable array, and an aliased array', () => {
        for (const name of ['genericArray', 'nullableArray', 'aliasedArray']) {
            expect(property(name)).toEqual(expect.objectContaining({ isArray: true, target: { ...target, projection: 'all' } }));
        }
        expect(property('nullableArray')?.nullable).toBe(true);
        expect(property('projectedList')).toEqual(expect.objectContaining({ isArray: true, target: { ...target, projection: ['id', 'name'] } }));
    });

    it('reads a nullable class property through its non-null member', () => {
        expect(property('nullableTarget')).toEqual(expect.objectContaining({ nullable: true, isArray: false, target: { ...target, projection: 'all' } }));
    });
});
