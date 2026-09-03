import type { RestRecordFieldKind } from '../../src/types';
import type { MetadataProvider, RecordFieldMetadataDescriptor, RecordTypeMetadataDescriptor } from './metadata';
import { buildOAuth1AuthorizationHeader } from './oauth1';
import type { OAuth1Credentials } from './oauth1';

export interface HttpRequest {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
}

export interface HttpResponse {
    status: number;
    body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export type RestAuthentication =
    | { kind: 'tba'; credentials: OAuth1Credentials }
    | { kind: 'oauth2'; accessToken: string };

export interface RestMetadataProviderOptions {
    /** NetSuite account id as it appears in the API host, for example `1234567-sb1`. */
    accountId: string;
    authentication: RestAuthentication;
    transport?: HttpTransport;
    /** Defaults to the documented record metadata catalog path. */
    recordCatalogPath?: string;
}

/** JSON Schema shape returned by `GET /services/rest/record/v1/metadata-catalog/{recordType}` with `Accept: application/schema+json`. */
interface RecordJsonSchema {
    properties?: Record<string, JsonSchemaProperty>;
    'x-ns-custom-field'?: boolean;
}

interface JsonSchemaProperty {
    type?: string | string[];
    format?: string;
    title?: string;
    readOnly?: boolean;
    enum?: unknown[];
    items?: JsonSchemaProperty;
    properties?: Record<string, JsonSchemaProperty>;
    $ref?: string;
    'x-ns-filterable'?: boolean;
    'x-ns-custom-field'?: boolean;
}

export const defaultRecordCatalogPath = '/services/rest/record/v1/metadata-catalog';

export function createDefaultHttpTransport(): HttpTransport {
    return async (request) => {
        const response = await fetch(request.url, { method: request.method, headers: request.headers });
        return { status: response.status, body: await response.text() };
    };
}

/** Body fields the catalog never marks read-only but N/record refuses to set. */
const systemReadOnlyFieldIds = new Set(['id', 'createddate', 'datecreated', 'lastmodifieddate', 'lastmodified']);

/** Names the catalog adds to every object that are not record fields. */
const catalogHousekeepingNames = new Set(['links', 'refName', 'externalId']);

/** The catalog renders sublists and multiselect fields as paged collections: `{ totalResults, count, hasMore, offset, items: [] }`. */
function toPagedCollectionKind(property: JsonSchemaProperty): RestRecordFieldKind | undefined {
    const items = property.properties?.items;
    if (items?.type !== 'array') {
        return undefined;
    }
    return items.items?.properties ? 'sublist' : 'multiselect';
}

function toFieldKind(property: JsonSchemaProperty): RestRecordFieldKind {
    const type = Array.isArray(property.type) ? property.type.find((candidate) => candidate !== 'null') : property.type;
    const pagedCollectionKind = toPagedCollectionKind(property);
    if (pagedCollectionKind) {
        return pagedCollectionKind;
    }
    if (property.$ref || (property.properties && 'id' in property.properties && Object.keys(property.properties).length <= 3)) {
        return property.properties?.id?.enum ? 'select' : 'reference';
    }
    if (property.properties) {
        return 'object';
    }
    switch (type) {
        case 'integer':
            return 'integer';
        case 'number':
            return property.format === 'double' || property.format === 'float' ? 'float' : 'currency';
        case 'boolean':
            return 'boolean';
        case 'string':
            if (property.format === 'date') return 'date';
            if (property.format === 'date-time') return 'datetime';
            return property.enum ? 'select' : 'string';
        case 'array':
            return property.items?.properties ? 'sublist' : 'multiselect';
        default:
            return 'unknown';
    }
}

/** The catalog names fields in camel case (`tranDate`); N/record ids are the same name lowercased (`trandate`). */
function toFieldDescriptor(catalogName: string, property: JsonSchemaProperty): RecordFieldMetadataDescriptor {
    const kind = toFieldKind(property);
    const id = catalogName.toLowerCase();
    return {
        id,
        kind,
        writable: property.readOnly !== true && !systemReadOnlyFieldIds.has(id),
        label: property.title,
        targetRecordType: kind === 'reference' && property.$ref ? property.$ref.split('/').pop()?.replace(/^ns/, '').toLowerCase() : undefined,
        ...(catalogName !== id ? { propertyName: catalogName } : {}),
    };
}

function toNestedFieldDescriptors(properties: Record<string, JsonSchemaProperty>): Record<string, RecordFieldMetadataDescriptor> {
    const fields: Record<string, RecordFieldMetadataDescriptor> = {};
    for (const [catalogName, property] of Object.entries(properties)) {
        if (!catalogHousekeepingNames.has(catalogName)) {
            fields[catalogName.toLowerCase()] = toFieldDescriptor(catalogName, property);
        }
    }
    return fields;
}

/** Translates the REST JSON schema of a record type into the descriptor the scaffold consumes. */
export function parseRecordJsonSchema(recordType: string, schema: RecordJsonSchema): RecordTypeMetadataDescriptor {
    const descriptor: RecordTypeMetadataDescriptor = { recordType, fields: {}, sublists: {}, subrecords: {} };

    for (const [catalogName, property] of Object.entries(schema.properties ?? {})) {
        if (catalogHousekeepingNames.has(catalogName)) {
            continue;
        }
        const id = catalogName.toLowerCase();
        const propertyName = catalogName !== id ? { propertyName: catalogName } : {};
        const kind = toFieldKind(property);
        if (kind === 'sublist') {
            const lineProperties = property.properties?.items?.items?.properties ?? property.items?.properties ?? {};
            descriptor.sublists[id] = { sublistId: id, fields: toNestedFieldDescriptors(lineProperties), ...propertyName };
        } else if (kind === 'object') {
            descriptor.subrecords[id] = { fieldId: id, fields: toNestedFieldDescriptors(property.properties ?? {}), ...propertyName };
        } else {
            descriptor.fields[id] = toFieldDescriptor(catalogName, property);
        }
    }

    return descriptor;
}

/** Reads record metadata from the documented SuiteTalk REST metadata catalog. SuiteQL table metadata is not available from REST. */
export function createRestMetadataProvider(options: RestMetadataProviderOptions): MetadataProvider {
    const transport = options.transport ?? createDefaultHttpTransport();
    const host = `https://${options.accountId.toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
    const catalogPath = options.recordCatalogPath ?? defaultRecordCatalogPath;

    const authorize = (method: 'GET', url: string): string => {
        if (options.authentication.kind === 'oauth2') {
            return `Bearer ${options.authentication.accessToken}`;
        }
        return buildOAuth1AuthorizationHeader({ ...options.authentication.credentials, method, url });
    };

    return {
        async getRecordTypeMetadata(recordType) {
            const url = `${host}${catalogPath}/${encodeURIComponent(recordType.toLowerCase())}`;
            const response = await transport({ method: 'GET', url, headers: { Accept: 'application/schema+json', Authorization: authorize('GET', url) } });
            if (response.status === 404) {
                return undefined;
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Metadata catalog request for '${recordType}' failed with HTTP ${response.status}: ${response.body.slice(0, 200)}`);
            }
            return parseRecordJsonSchema(recordType.toLowerCase(), JSON.parse(response.body) as RecordJsonSchema);
        },
        async getSuiteQlTableMetadata() {
            return undefined;
        },
    };
}
