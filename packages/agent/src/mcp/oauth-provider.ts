import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthClientMetadata,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  type OAuthTokens,
  OAuthTokensSchema,
  OpenIdProviderMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OwnedCredentialScope, OwnedCredentialStatus } from '../config/credentials';
import { McpCredentialError } from './credentials';

export interface McpOAuthVault {
  readOwned(scope: OwnedCredentialScope): Promise<string | null>;
  writeOwned(scope: OwnedCredentialScope, value: string): Promise<void>;
  removeOwned(scope: OwnedCredentialScope): Promise<void>;
  statusOwned(scope: OwnedCredentialScope): Promise<OwnedCredentialStatus>;
  resolve(ref: string): Promise<string>;
}
export interface McpOAuthProviderOptions {
  vault: McpOAuthVault;
  scope: OwnedCredentialScope;
  redirectUrl: URL;
  signal: AbortSignal;
  assertFresh(): void;
  clientId?: string;
  scopes?: readonly string[];
  clientSecretRef?: string;
  now?: () => number;
  onAuthorization?(url: URL): void | Promise<void>;
}
interface Material {
  version: 1;
  kind: 'mcp.oauth';
  ownerDigest: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenRevision?: string;
  issuedAt?: number;
  expiresAt?: number | null;
  discoveryState?: OAuthDiscoveryState;
}
export class McpOAuthError extends McpCredentialError {
  constructor(code: string) {
    super(code);
    this.name = 'McpOAuthError';
  }
}
function fail(code: string): never {
  throw new McpOAuthError(code);
}
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return fail('mcp_oauth_material_invalid');
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('mcp_oauth_material_invalid');
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('mcp_oauth_material_invalid');
}
function url(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      fail('mcp_oauth_url_invalid');
    return parsed.href;
  } catch {
    return fail('mcp_oauth_url_invalid');
  }
}
function discovery(value: unknown): OAuthDiscoveryState {
  const v = object(value);
  closed(v, [
    'authorizationServerUrl',
    'authorizationServerMetadata',
    'resourceMetadata',
    'resourceMetadataUrl',
  ]);
  if (typeof v.authorizationServerUrl !== 'string') fail('mcp_oauth_material_invalid');
  return {
    authorizationServerUrl: url(v.authorizationServerUrl),
    ...(v.authorizationServerMetadata === undefined
      ? {}
      : {
          authorizationServerMetadata: OAuthMetadataSchema.or(OpenIdProviderMetadataSchema).parse(
            v.authorizationServerMetadata,
          ),
        }),
    ...(v.resourceMetadata === undefined
      ? {}
      : { resourceMetadata: OAuthProtectedResourceMetadataSchema.parse(v.resourceMetadata) }),
    ...(v.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: url(String(v.resourceMetadataUrl)) }),
  };
}
function client(value: unknown): OAuthClientInformationMixed {
  try {
    const v = object(value);
    const parsed = Object.hasOwn(v, 'redirect_uris')
      ? OAuthClientInformationFullSchema.parse(v)
      : OAuthClientInformationSchema.parse(v);
    if (!parsed.client_id) fail('mcp_oauth_material_invalid');
    return parsed;
  } catch {
    return fail('mcp_oauth_material_invalid');
  }
}
function token(value: unknown): OAuthTokens {
  try {
    const parsed = OAuthTokensSchema.parse(value);
    // This authority supplies the existing Broker's Bearer HTTP header consumer.
    if (
      parsed.token_type.toLowerCase() !== 'bearer' ||
      parsed.access_token.length > 8000 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(parsed.access_token)
    )
      fail('mcp_oauth_material_invalid');
    return parsed;
  } catch {
    return fail('mcp_oauth_material_invalid');
  }
}
const tokenRevisionPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function material(value: string, ownerDigest: string): Material {
  try {
    const v = object(JSON.parse(value));
    closed(v, [
      'version',
      'kind',
      'ownerDigest',
      'clientInformation',
      'tokens',
      'tokenRevision',
      'issuedAt',
      'expiresAt',
      'discoveryState',
    ]);
    if (v.version !== 1 || v.kind !== 'mcp.oauth' || v.ownerDigest !== ownerDigest)
      fail('mcp_oauth_material_invalid');
    const tokens = v.tokens === undefined ? undefined : token(v.tokens);
    if (
      tokens &&
      (typeof v.tokenRevision !== 'string' || !tokenRevisionPattern.test(v.tokenRevision))
    )
      fail('mcp_oauth_material_invalid');
    if (
      tokens &&
      (!Number.isSafeInteger(v.issuedAt) ||
        Number(v.issuedAt) < 0 ||
        (v.expiresAt !== null &&
          (!Number.isSafeInteger(v.expiresAt) || Number(v.expiresAt) < Number(v.issuedAt))))
    )
      fail('mcp_oauth_material_invalid');
    if (
      tokens &&
      v.expiresAt !==
        (tokens.expires_in === undefined ? null : Number(v.issuedAt) + tokens.expires_in * 1000)
    )
      fail('mcp_oauth_material_invalid');
    if (
      !tokens &&
      (v.issuedAt !== undefined || v.expiresAt !== undefined || v.tokenRevision !== undefined)
    )
      fail('mcp_oauth_material_invalid');
    return {
      version: 1,
      kind: 'mcp.oauth',
      ownerDigest,
      ...(v.clientInformation === undefined
        ? {}
        : { clientInformation: client(v.clientInformation) }),
      ...(tokens === undefined
        ? {}
        : {
            tokens,
            tokenRevision: String(v.tokenRevision),
            issuedAt: Number(v.issuedAt),
            expiresAt: v.expiresAt === null ? null : Number(v.expiresAt),
          }),
      ...(v.discoveryState === undefined ? {} : { discoveryState: discovery(v.discoveryState) }),
    };
  } catch {
    return fail('mcp_oauth_material_invalid');
  }
}

/** Host leaf only. No browser, listener, fetch or remote Tool retry is created here. */
export function createMcpOAuthProvider(input: McpOAuthProviderOptions) {
  const options = { ...input };
  const scope = Object.freeze({ ...options.scope }),
    redirectUrl = new URL(options.redirectUrl);
  if (
    Object.keys(scope).length !== 2 ||
    scope.namespace !== 'mcp.oauth' ||
    !/^[a-f0-9]{64}$/.test(scope.ownerDigest) ||
    redirectUrl.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(redirectUrl.hostname) ||
    redirectUrl.pathname !== '/oauth/callback' ||
    redirectUrl.search ||
    redirectUrl.hash ||
    redirectUrl.username ||
    redirectUrl.password ||
    (options.clientSecretRef !== undefined &&
      (!options.clientId || !/^credential:[0-9a-f-]{36}$/.test(options.clientSecretRef)))
  )
    fail('mcp_oauth_configuration_invalid');
  const scopes = options.scopes ? [...options.scopes] : undefined;
  if (
    scopes?.some(
      (s) =>
        typeof s !== 'string' ||
        !s ||
        s.length > 128 ||
        /\s/u.test(s) ||
        Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    ) ||
    (options.clientId !== undefined && (!options.clientId || options.clientId.length > 1024))
  )
    fail('mcp_oauth_configuration_invalid');
  const state = randomBytes(32).toString('base64url'),
    now = options.now ?? Date.now;
  let cancelled = false,
    flowEpoch = 0,
    verifier: string | undefined,
    authorizationUrl: URL | undefined;
  let chain: Promise<void> = Promise.resolve();
  const fresh = (observed = flowEpoch) => {
    if (cancelled || options.signal.aborted || observed !== flowEpoch) fail('mcp_oauth_cancelled');
    try {
      options.assertFresh();
    } catch {
      fail('mcp_oauth_scope_changed');
    }
  };
  const read = async (): Promise<Material> => {
    const observed = flowEpoch;
    fresh(observed);
    let bytes: string | null;
    try {
      bytes = await options.vault.readOwned(scope);
    } catch {
      return fail('mcp_oauth_credential_unavailable');
    }
    fresh(observed);
    return bytes === null
      ? { version: 1, kind: 'mcp.oauth', ownerDigest: scope.ownerDigest }
      : material(bytes, scope.ownerDigest);
  };
  const update = (change: (v: Material) => Material) => {
    const observed = flowEpoch;
    const task = chain.then(async () => {
      fresh(observed);
      const previous = await read();
      fresh(observed);
      const next = change(previous);
      let bytes: string;
      try {
        bytes = JSON.stringify(next);
      } catch {
        return fail('mcp_oauth_material_invalid');
      }
      if (Buffer.byteLength(bytes, 'utf8') > 65536) fail('mcp_oauth_material_invalid');
      material(bytes, scope.ownerDigest);
      fresh(observed);
      try {
        await options.vault.writeOwned(scope, bytes);
      } catch {
        fail('mcp_oauth_publication_unknown');
      }
      try {
        fresh(observed);
      } catch {
        fail('mcp_oauth_publication_unknown');
      }
    });
    chain = task.catch(() => {});
    return task;
  };
  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUrl.href],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Kite Code',
    ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
  };
  const provider = {
    get redirectUrl() {
      return new URL(redirectUrl);
    },
    get clientMetadata() {
      return structuredClone(clientMetadata);
    },
    state() {
      fresh();
      return state;
    },
    verifyState(received: string) {
      fresh();
      if (typeof received !== 'string' || received.length !== state.length) return false;
      const expected = Buffer.from(state),
        actual = Buffer.from(received);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
    async clientInformation() {
      fresh();
      if (options.clientId) {
        if (!options.clientSecretRef) return { client_id: options.clientId };
        const observed = flowEpoch;
        let secret: string;
        try {
          secret = await options.vault.resolve(options.clientSecretRef);
        } catch {
          return fail('mcp_oauth_credential_unavailable');
        }
        fresh(observed);
        return { client_id: options.clientId, client_secret: secret };
      }
      return structuredClone((await read()).clientInformation);
    },
    saveClientInformation(value: OAuthClientInformationMixed) {
      const captured = client(clone(value));
      return update((v) => ({ ...v, clientInformation: captured }));
    },
    async tokens() {
      return structuredClone((await read()).tokens);
    },
    async getTokenState() {
      const value = await read();
      return {
        present: value.tokens !== undefined,
        expiresAt: value.expiresAt ?? null,
        tokenRevision: value.tokenRevision ?? null,
      };
    },
    async readAccessToken(expectedTokenRevision: string): Promise<string | null> {
      if (
        typeof expectedTokenRevision !== 'string' ||
        !tokenRevisionPattern.test(expectedTokenRevision)
      )
        fail('mcp_oauth_configuration_invalid');
      const value = await read();
      return value.tokenRevision === expectedTokenRevision
        ? (value.tokens?.access_token ?? null)
        : null;
    },
    saveTokens(value: OAuthTokens) {
      const captured = token(clone(value));
      let issuedAt: number;
      try {
        issuedAt = now();
      } catch {
        return fail('mcp_oauth_clock_unavailable');
      }
      const seconds = captured.expires_in;
      const expiresAt = seconds === undefined ? null : issuedAt + seconds * 1000;
      if (
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < 0 ||
        (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < issuedAt))
      )
        fail('mcp_oauth_material_invalid');
      const tokenRevision = randomUUID();
      return update((v) => {
        verifier = undefined;
        return { ...v, tokens: captured, tokenRevision, issuedAt, expiresAt };
      });
    },
    async redirectToAuthorization(value: URL) {
      const observed = flowEpoch;
      fresh(observed);
      const selected = new URL(url(value.href));
      authorizationUrl = selected;
      try {
        await options.onAuthorization?.(new URL(selected));
      } catch {
        fail('mcp_oauth_authorization_failed');
      }
      fresh(observed);
    },
    getPendingAuthorizationUrl() {
      fresh();
      return authorizationUrl ? new URL(authorizationUrl) : undefined;
    },
    saveCodeVerifier(value: string) {
      fresh();
      if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value))
        fail('mcp_oauth_verifier_invalid');
      verifier = value;
    },
    codeVerifier() {
      fresh();
      if (!verifier) fail('mcp_oauth_verifier_unavailable');
      return verifier;
    },
    async saveDiscoveryState(value: OAuthDiscoveryState) {
      let captured: OAuthDiscoveryState;
      try {
        captured = discovery(clone(value));
      } catch {
        return fail('mcp_oauth_material_invalid');
      }
      await update((v) => ({ ...v, discoveryState: captured }));
    },
    async discoveryState() {
      return structuredClone((await read()).discoveryState);
    },
    async invalidateCredentials(kind: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
      const observed = flowEpoch;
      fresh(observed);
      if (kind === 'verifier') {
        verifier = undefined;
        return;
      }
      if (kind === 'all') {
        const task = chain.then(async () => {
          fresh(observed);
          try {
            await options.vault.removeOwned(scope);
            fresh(observed);
          } catch {
            fail('mcp_oauth_publication_unknown');
          }
          verifier = undefined;
          authorizationUrl = undefined;
        });
        chain = task.catch(() => {});
        await task;
        return;
      }
      await update((v) => {
        const next = { ...v };
        if (kind === 'client') delete next.clientInformation;
        else if (kind === 'tokens') {
          delete next.tokens;
          delete next.tokenRevision;
          delete next.issuedAt;
          delete next.expiresAt;
        } else if (kind === 'discovery') delete next.discoveryState;
        else fail('mcp_oauth_configuration_invalid');
        return next;
      });
    },
    cancel() {
      cancelled = true;
      flowEpoch++;
      verifier = undefined;
      authorizationUrl = undefined;
      options.signal.removeEventListener('abort', abort);
    },
  } satisfies OAuthClientProvider & {
    verifyState(received: string): boolean;
    getPendingAuthorizationUrl(): URL | undefined;
    cancel(): void;
    getTokenState(): Promise<{
      present: boolean;
      expiresAt: number | null;
      tokenRevision: string | null;
    }>;
    readAccessToken(expectedTokenRevision: string): Promise<string | null>;
  };
  const abort = () => provider.cancel();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) provider.cancel();
  return provider;
}
export type McpOAuthProvider = ReturnType<typeof createMcpOAuthProvider>;
