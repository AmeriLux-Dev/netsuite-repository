import * as ts from 'typescript';
import type { FieldType } from '../../src/types';
import { toPosixPath } from '../file-system';

/** Identifies a class across the type checker and the evaluator: posix file path plus class name. */
export interface ClassIdentity {
    className: string;
    filePath: string;
}

export function classKeyOf(identity: ClassIdentity): string {
    return `${identity.filePath}#${identity.className}`;
}

/** A property typed as another model class, with the members its declared type keeps. */
export interface DeclaredRelationTarget extends ClassIdentity {
    /** 'all' for the bare class; otherwise the property names of the declared type (Pick, Omit, or an alias of them). */
    projection: string[] | 'all';
}

export interface DeclaredProperty {
    name: string;
    /** Declared with `?`. */
    optional: boolean;
    /** Declared type admits null or undefined; with `optional`, decides whether a relation joins left outer. */
    nullable: boolean;
    isArray: boolean;
    /** Type text as written, used for scalar members of the generated interface. */
    typeText: string;
    /** NetSuite field type inferred from the TypeScript type, when the property is a scalar. */
    scalarType?: FieldType;
    /** Declared on a base class rather than on the class being read. */
    inherited: boolean;
    /** Set when the (element) type resolves to a class; the build step decides whether it is a reference, subrecord, or sublist. */
    target?: DeclaredRelationTarget;
}

export interface DeclaredClass extends ClassIdentity {
    base?: ClassIdentity;
    properties: DeclaredProperty[];
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

function findExportedClass(sourceFile: ts.SourceFile, exportName: string): ts.ClassDeclaration | undefined {
    for (const statement of sourceFile.statements) {
        if (ts.isClassDeclaration(statement) && statement.name?.text === exportName) {
            return statement;
        }
    }
    return undefined;
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

function identityOf(declaration: ts.ClassDeclaration): ClassIdentity | undefined {
    return declaration.name ? { className: declaration.name.text, filePath: toPosixPath(declaration.getSourceFile().fileName) } : undefined;
}

function classDeclarationOfType(type: ts.Type): ts.ClassDeclaration | undefined {
    const declaration = type.getSymbol()?.valueDeclaration;
    return declaration && ts.isClassDeclaration(declaration) ? declaration : undefined;
}

interface ReaderContext {
    checker: ts.TypeChecker;
}

/** Follows `Pick<Customer, ...>`, `Omit<...>`, and aliases of them down to the class they project. */
function classDeclarationOfTypeNode(context: ReaderContext, node: ts.TypeNode | undefined, depth = 0): ts.ClassDeclaration | undefined {
    if (!node || depth > 8) {
        return undefined;
    }
    const direct = classDeclarationOfType(context.checker.getTypeFromTypeNode(node));
    if (direct) {
        return direct;
    }
    if (ts.isTypeReferenceNode(node)) {
        for (const argument of node.typeArguments ?? []) {
            const found = classDeclarationOfTypeNode(context, argument, depth + 1);
            if (found) {
                return found;
            }
        }
        const symbol = context.checker.getSymbolAtLocation(node.typeName);
        const aliasDeclaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
        if (aliasDeclaration) {
            return classDeclarationOfTypeNode(context, aliasDeclaration.type, depth + 1);
        }
    }
    return undefined;
}

/** Last resort for projected types: the class that declares the projected members. */
function classDeclarationOfMembers(context: ReaderContext, type: ts.Type): ts.ClassDeclaration | undefined {
    for (const property of context.checker.getPropertiesOfType(type)) {
        const declaration = property.declarations?.[0];
        if (declaration && ts.isPropertyDeclaration(declaration) && ts.isClassDeclaration(declaration.parent)) {
            return declaration.parent;
        }
    }
    return undefined;
}

function resolveRelationTarget(context: ReaderContext, type: ts.Type, typeNode: ts.TypeNode | undefined): DeclaredRelationTarget | undefined {
    const direct = classDeclarationOfType(type);
    if (direct) {
        const identity = identityOf(direct);
        return identity ? { ...identity, projection: 'all' } : undefined;
    }
    const aliasArguments = type.aliasTypeArguments ?? [];
    const fromAlias = aliasArguments.map(classDeclarationOfType).find((declaration): declaration is ts.ClassDeclaration => Boolean(declaration));
    const declaration = fromAlias ?? classDeclarationOfTypeNode(context, typeNode) ?? classDeclarationOfMembers(context, type);
    const identity = declaration ? identityOf(declaration) : undefined;
    if (!identity) {
        return undefined;
    }
    return { ...identity, projection: context.checker.getPropertiesOfType(type).map((property) => property.name) };
}

function elementTypeNodeOf(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
    if (!node) return undefined;
    if (ts.isArrayTypeNode(node)) return node.elementType;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Array') return node.typeArguments?.[0];
    if (ts.isUnionTypeNode(node)) {
        const member = node.types.find((candidate) => !(ts.isLiteralTypeNode(candidate) && candidate.literal.kind === ts.SyntaxKind.NullKeyword) && candidate.kind !== ts.SyntaxKind.UndefinedKeyword);
        return elementTypeNodeOf(member);
    }
    return undefined;
}

function nonNullTypeNodeOf(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
    if (node && ts.isUnionTypeNode(node)) {
        return node.types.find((candidate) => !(ts.isLiteralTypeNode(candidate) && candidate.literal.kind === ts.SyntaxKind.NullKeyword) && candidate.kind !== ts.SyntaxKind.UndefinedKeyword);
    }
    return node;
}

function includesNullOrUndefined(type: ts.Type): boolean {
    return type.isUnion() && type.types.some((member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0);
}

/** Reads the declared instance properties of an exported class, including inherited ones. Undefined when the class is not found. */
export function readDeclaredClass(program: ts.Program, filePath: string, className: string): DeclaredClass | undefined {
    const sourceFile = program.getSourceFile(toPosixPath(filePath));
    const declaration = sourceFile ? findExportedClass(sourceFile, className) : undefined;
    if (!sourceFile || !declaration?.name) {
        return undefined;
    }

    const checker = program.getTypeChecker();
    const context: ReaderContext = { checker };
    const classSymbol = checker.getSymbolAtLocation(declaration.name);
    const classType = classSymbol ? checker.getDeclaredTypeOfSymbol(classSymbol) : undefined;
    if (!classType) {
        return undefined;
    }

    const extendsExpression = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    const baseDeclaration = extendsExpression ? classDeclarationOfType(checker.getTypeAtLocation(extendsExpression.expression)) : undefined;
    const base = baseDeclaration ? identityOf(baseDeclaration) : undefined;

    const properties: DeclaredProperty[] = [];
    for (const symbol of checker.getPropertiesOfType(classType)) {
        if (symbol.flags & ts.SymbolFlags.Method) {
            continue;
        }
        const propertyDeclaration = symbol.declarations?.find(ts.isPropertyDeclaration);
        if (!propertyDeclaration || propertyDeclaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
            continue;
        }
        const declaredType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
        const nonNullableType = checker.getNonNullableType(declaredType);
        if (nonNullableType.getCallSignatures().length > 0) {
            continue;
        }

        const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
        const printedType = checker.typeToString(declaredType, undefined, ts.TypeFormatFlags.NoTruncation);
        const isArray = checker.isArrayType(nonNullableType);
        const elementType = isArray ? checker.getTypeArguments(nonNullableType as ts.TypeReference)[0] : nonNullableType;
        const scalarFieldType = elementType ? classifyScalarFieldType(elementType) : undefined;
        const property: DeclaredProperty = {
            name: symbol.name,
            optional,
            nullable: includesNullOrUndefined(declaredType),
            isArray,
            typeText: optional ? printedType.replace(/ \| undefined$/, '') : printedType,
            inherited: propertyDeclaration.parent !== declaration,
        };

        if (scalarFieldType !== undefined) {
            property.scalarType = isArray ? (scalarFieldType === 'date' ? undefined : 'multiselect') : scalarFieldType;
        } else if (elementType && elementType.flags & ts.TypeFlags.Object) {
            const typeNode = isArray ? elementTypeNodeOf(propertyDeclaration.type) : nonNullTypeNodeOf(propertyDeclaration.type);
            property.target = resolveRelationTarget(context, elementType, typeNode);
        }

        properties.push(property);
    }

    // Base members first, so generated interfaces and configs read top-down like the class hierarchy.
    properties.sort((left, right) => Number(right.inherited) - Number(left.inherited));
    return { className, filePath: toPosixPath(filePath), base, properties };
}
