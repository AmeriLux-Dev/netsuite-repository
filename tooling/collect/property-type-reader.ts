import * as ts from 'typescript';
import type { FieldType } from '../../src/types';
import { toPosixPath } from '../file-system';

export interface PropertyTypeInfo {
    name: string;
    /** Type text as written for the generated interface. */
    typeText: string;
    optional: boolean;
    /** NetSuite field type inferred from the TypeScript type, when one applies. */
    fieldType?: FieldType;
    /** Name of a nested shape when the property holds an object or an array of objects. */
    nestedShapeName?: string;
    isArray: boolean;
}

export interface ModelTypeShape {
    name: string;
    properties: PropertyTypeInfo[];
}

export interface ModelTypeInfo {
    root: ModelTypeShape;
    /** Named object shapes referenced by the root, emitted as their own interfaces. */
    nested: ModelTypeShape[];
}

export const defaultModelCompilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
};

export function createModelTypeProgram(filePaths: string[], compilerOptions: ts.CompilerOptions = {}): ts.Program {
    return ts.createProgram({ rootNames: filePaths.map(toPosixPath), options: { ...defaultModelCompilerOptions, ...compilerOptions, noEmit: true } });
}

/** Reads compiler options from a tsconfig file so model files type-check the way the consumer's project does. */
export function readCompilerOptionsFromTsconfig(tsconfigPath: string): ts.CompilerOptions {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
        throw new Error(`Could not read tsconfig '${tsconfigPath}': ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, toPosixPath(tsconfigPath).replace(/\/[^/]+$/, ''));
    return parsed.options;
}

function findExportedDeclaration(sourceFile: ts.SourceFile, exportName: string): ts.ClassDeclaration | ts.VariableDeclaration | undefined {
    for (const statement of sourceFile.statements) {
        if (ts.isClassDeclaration(statement) && statement.name?.text === exportName) {
            return statement;
        }
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === exportName);
            if (declaration) {
                return declaration;
            }
        }
    }
    return undefined;
}

function isUserDeclaredNamedType(type: ts.Type, program: ts.Program): boolean {
    const symbol = type.getSymbol();
    if (!symbol || symbol.name.startsWith('__')) {
        return false;
    }
    return (symbol.declarations ?? []).some((declaration) => !program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
}

function classifyScalarFieldType(type: ts.Type): FieldType | undefined {
    if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
    if (type.flags & ts.TypeFlags.NumberLike) return 'float';
    if (type.flags & ts.TypeFlags.StringLike) return 'string';
    if (type.getSymbol()?.name === 'Date') return 'date';
    if (type.isUnion()) {
        const memberTypes = type.types.map(classifyScalarFieldType);
        const first = memberTypes[0];
        return first !== undefined && memberTypes.every((member) => member === first) ? first : undefined;
    }
    return undefined;
}

function toPascalCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

interface TypeReaderContext {
    program: ts.Program;
    checker: ts.TypeChecker;
    nested: Map<string, ModelTypeShape>;
}

function readShapeProperties(context: TypeReaderContext, type: ts.Type, location: ts.Node, shapeName: string, allowNested: boolean): PropertyTypeInfo[] {
    const { checker, program } = context;
    const properties: PropertyTypeInfo[] = [];

    for (const symbol of checker.getPropertiesOfType(type)) {
        if (symbol.flags & ts.SymbolFlags.Method) {
            continue;
        }
        const declaredType = checker.getTypeOfSymbolAtLocation(symbol, location);
        const nonNullableType = checker.getNonNullableType(declaredType);
        if (nonNullableType.getCallSignatures().length > 0) {
            continue;
        }

        const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
        const printedType = checker.typeToString(declaredType, undefined, ts.TypeFormatFlags.NoTruncation);
        const info: PropertyTypeInfo = {
            name: symbol.name,
            // Optional members already imply undefined; drop the union member the checker adds for them.
            typeText: optional ? printedType.replace(/ \| undefined$/, '') : printedType,
            optional,
            isArray: checker.isArrayType(nonNullableType),
        };

        const elementType = info.isArray ? checker.getTypeArguments(nonNullableType as ts.TypeReference)[0] : nonNullableType;
        const scalarFieldType = elementType ? classifyScalarFieldType(elementType) : undefined;

        if (info.isArray) {
            if (scalarFieldType !== undefined && scalarFieldType !== 'date') {
                info.fieldType = 'multiselect';
            } else if (elementType && allowNested && (elementType.flags & ts.TypeFlags.Object)) {
                info.nestedShapeName = registerNestedShape(context, elementType, location, shapeName, symbol.name);
            }
        } else if (scalarFieldType !== undefined) {
            info.fieldType = scalarFieldType;
        } else if (allowNested && (nonNullableType.flags & ts.TypeFlags.Object) && isUserDeclaredNamedType(nonNullableType, program)) {
            info.nestedShapeName = registerNestedShape(context, nonNullableType, location, shapeName, symbol.name);
        } else if (allowNested && (nonNullableType.flags & ts.TypeFlags.Object)) {
            // Anonymous inline object: its members are read for field types but the text is emitted verbatim.
            info.nestedShapeName = registerNestedShape(context, nonNullableType, location, shapeName, symbol.name, `${shapeName}${toPascalCase(symbol.name)}`);
        }

        properties.push(info);
    }

    return properties;
}

function registerNestedShape(context: TypeReaderContext, type: ts.Type, location: ts.Node, ownerShapeName: string, propertyName: string, anonymousName?: string): string {
    const symbolName = type.getSymbol()?.name;
    const isNamed = symbolName !== undefined && !symbolName.startsWith('__') && isUserDeclaredNamedType(type, context.program);
    const shapeName = isNamed ? symbolName : anonymousName ?? `${ownerShapeName}${toPascalCase(propertyName)}`;

    if (!context.nested.has(shapeName)) {
        const shape: ModelTypeShape = { name: shapeName, properties: [] };
        context.nested.set(shapeName, shape);
        shape.properties = readShapeProperties(context, type, location, shapeName, false);
        if (!isNamed) {
            (shape as ModelTypeShape & { anonymous?: boolean }).anonymous = true;
        }
    }
    return shapeName;
}

/**
 * Reads the declared TypeScript types of a model export: instance properties of a decorated class,
 * or the interface behind a fluent definition. Returns undefined when the export cannot be found.
 */
export function readModelTypes(program: ts.Program, filePath: string, exportName: string, modelName: string): ModelTypeInfo | undefined {
    const sourceFile = program.getSourceFile(toPosixPath(filePath));
    if (!sourceFile) {
        return undefined;
    }

    const declaration = findExportedDeclaration(sourceFile, exportName);
    if (!declaration) {
        return undefined;
    }

    const checker = program.getTypeChecker();
    const context: TypeReaderContext = { program, checker, nested: new Map() };
    let rootType: ts.Type | undefined;

    if (ts.isClassDeclaration(declaration)) {
        const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
        rootType = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
    } else {
        const definitionType = checker.getTypeAtLocation(declaration.name);
        const resultSymbol = definitionType.getProperty('__result');
        rootType = resultSymbol ? checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(resultSymbol, declaration)) : undefined;
    }

    if (!rootType) {
        return undefined;
    }

    const root: ModelTypeShape = { name: modelName, properties: readShapeProperties(context, rootType, declaration, modelName, true) };
    return { root, nested: Array.from(context.nested.values()) };
}

/** Whether a nested shape came from an anonymous inline object type (its text is emitted verbatim on the parent). */
export function isAnonymousShape(shape: ModelTypeShape): boolean {
    return (shape as ModelTypeShape & { anonymous?: boolean }).anonymous === true;
}
