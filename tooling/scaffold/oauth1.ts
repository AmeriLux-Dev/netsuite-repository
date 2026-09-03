import { createHmac, randomBytes } from 'crypto';

export interface OAuth1Credentials {
    consumerKey: string;
    consumerSecret: string;
    tokenId: string;
    tokenSecret: string;
    /** NetSuite account id, sent as the realm (for example `1234567_SB1`). */
    realm: string;
}

export interface OAuth1SignatureInput extends OAuth1Credentials {
    method: string;
    url: string;
    nonce?: string;
    timestamp?: number;
}

function percentEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Builds the `Authorization` header for NetSuite token-based authentication (OAuth 1.0a, HMAC-SHA256). */
export function buildOAuth1AuthorizationHeader(input: OAuth1SignatureInput): string {
    const nonce = input.nonce ?? randomBytes(16).toString('hex');
    const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
    const url = new URL(input.url);
    const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;

    const oauthParameters: Record<string, string> = {
        oauth_consumer_key: input.consumerKey,
        oauth_nonce: nonce,
        oauth_signature_method: 'HMAC-SHA256',
        oauth_timestamp: timestamp,
        oauth_token: input.tokenId,
        oauth_version: '1.0',
    };

    const allParameters: Array<[string, string]> = [
        ...Object.entries(oauthParameters),
        ...Array.from(url.searchParams.entries()),
    ];
    const normalizedParameters = allParameters
        .map(([key, value]) => [percentEncode(key), percentEncode(value)] as [string, string])
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => (leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');

    const signatureBase = [input.method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalizedParameters)].join('&');
    const signingKey = `${percentEncode(input.consumerSecret)}&${percentEncode(input.tokenSecret)}`;
    const signature = createHmac('sha256', signingKey).update(signatureBase).digest('base64');

    const headerParameters = { realm: input.realm, ...oauthParameters, oauth_signature: signature };
    return `OAuth ${Object.entries(headerParameters).map(([key, value]) => `${key}="${percentEncode(value)}"`).join(', ')}`;
}
