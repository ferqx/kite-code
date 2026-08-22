import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialHandleV1 } from '@kite/runtime-spi';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { BuiltinCredentialBrokerV1 } from './credential-broker';
import type { McpCredentialKey, McpOAuthCredentialMaterial } from './credential-store';

export interface KiteMcpOAuthProviderOptions {
  /** Shared Builtin credential authority used by production composition. */
  credentialBroker: BuiltinCredentialBrokerV1;
  credentialKey: McpCredentialKey;
  /** Opaque handle issued by the shared Builtin broker. */
  credentialHandle?: CredentialHandleV1;
  redirectUrl: URL;
  scopes?: readonly string[];
  clientId?: string;
  clientSecretKey?: McpCredentialKey;
  clientSecretHandle?: CredentialHandleV1;
  onAuthorization?: (authorizationUrl: URL) => void | Promise<void>;
  state?: string;
}

/** SDK OAuth provider backed by the OS credential vault. It never opens a browser itself. */
export class KiteMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly credentialBroker: BuiltinCredentialBrokerV1;
  private readonly credentialKey: McpCredentialKey;
  private readonly credentialHandle: CredentialHandleV1 | undefined;
  private readonly configuredClientId: string | undefined;
  private readonly clientSecretKey: McpCredentialKey | undefined;
  private readonly clientSecretHandle: CredentialHandleV1 | undefined;
  private readonly onAuthorization: ((authorizationUrl: URL) => void | Promise<void>) | undefined;
  private readonly flowState: string;
  private authorizationUrl: URL | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: KiteMcpOAuthProviderOptions) {
    assertLoopbackRedirect(options.redirectUrl);
    this.credentialBroker = options.credentialBroker;
    this.credentialKey = options.credentialKey;
    this.credentialHandle = options.credentialHandle;
    this.redirectUrl = new URL(options.redirectUrl);
    this.configuredClientId = options.clientId;
    this.clientSecretKey = options.clientSecretKey;
    this.clientSecretHandle = options.clientSecretHandle;
    this.onAuthorization = options.onAuthorization;
    this.flowState = options.state ?? randomBytes(32).toString('base64url');
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Kite Code',
      software_id: 'kite-code',
      software_version: '0.1.0',
      ...(options.scopes?.length ? { scope: [...options.scopes].join(' ') } : {}),
    };
  }

  state(): string {
    return this.flowState;
  }

  verifyState(received: string): boolean {
    const expected = Buffer.from(this.flowState);
    const actual = Buffer.from(received);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.configuredClientId) {
      if (!this.clientSecretKey) return { client_id: this.configuredClientId };
      return this.withMaterial(
        this.clientSecretHandle,
        this.clientSecretKey,
        'mcp.oauth.client-secret',
        (secret) => {
          if (secret.kind !== 'bearer') {
            throw new Error('OAuth client secret reference is unavailable.');
          }
          return {
            client_id: this.configuredClientId!,
            client_secret: secret.secret,
          } as OAuthClientInformationMixed;
        },
      );
    }
    return (await this.readMaterial())?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.updateMaterial((material) => ({ ...material, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readMaterial())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updateMaterial((material) => ({
      ...material,
      tokens,
      codeVerifier: undefined,
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = new URL(authorizationUrl);
    await this.onAuthorization?.(new URL(authorizationUrl));
  }

  getPendingAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl ? new URL(this.authorizationUrl) : undefined;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.updateMaterial((material) => ({ ...material, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.readMaterial())?.codeVerifier;
    if (!verifier) throw new Error('OAuth PKCE verifier is unavailable.');
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.updateMaterial((material) => ({ ...material, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.readMaterial())?.discoveryState;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      if (this.credentialHandle) {
        await this.credentialBroker.deleteForHandle(
          this.credentialHandle,
          this.credentialHandle.purpose,
        );
      } else {
        await this.credentialBroker.deleteForKey(this.credentialKey, 'mcp.oauth.logout');
      }
      this.authorizationUrl = undefined;
      return;
    }
    await this.updateMaterial((material) => ({
      ...material,
      ...(scope === 'client' ? { clientInformation: undefined } : {}),
      ...(scope === 'tokens' ? { tokens: undefined } : {}),
      ...(scope === 'verifier' ? { codeVerifier: undefined } : {}),
      ...(scope === 'discovery' ? { discoveryState: undefined } : {}),
    }));
  }

  private async readMaterial(): Promise<McpOAuthCredentialMaterial | null> {
    try {
      return await this.withMaterial(
        this.credentialHandle,
        this.credentialKey,
        'mcp.oauth.read',
        (material) => {
          if (material.kind !== 'oauth') {
            throw new Error('Credential reference does not contain OAuth material.');
          }
          return structuredClone(material);
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'Credential reference is unavailable.') {
        return null;
      }
      throw error;
    }
  }

  private async updateMaterial(
    update: (material: McpOAuthCredentialMaterial) => McpOAuthCredentialMaterial,
  ): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const current =
        (await this.readMaterial()) ??
        ({
          version: 1,
          kind: 'oauth',
          updatedAt: new Date().toISOString(),
        } satisfies McpOAuthCredentialMaterial);
      const updated = {
        ...update(current),
        version: 1,
        kind: 'oauth',
        updatedAt: new Date().toISOString(),
      } satisfies McpOAuthCredentialMaterial;
      if (this.credentialHandle) {
        await this.credentialBroker.putForHandle(
          this.credentialHandle,
          this.credentialHandle.purpose,
          updated,
        );
      } else {
        await this.credentialBroker.putForKey(this.credentialKey, 'mcp.oauth.write', updated);
      }
    });
    this.writeChain = operation.catch(() => {});
    await operation;
  }

  private withMaterial<T>(
    handle: CredentialHandleV1 | undefined,
    key: McpCredentialKey,
    purpose: string,
    operation: (material: import('./credential-store').McpCredentialMaterial) => Promise<T> | T,
  ): Promise<T> {
    return handle
      ? this.credentialBroker.withHandleMaterial(handle, handle.purpose, operation)
      : this.credentialBroker.withMaterialForKey(key, purpose, operation);
  }
}

function assertLoopbackRedirect(url: URL): void {
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== '::1')
  ) {
    throw new Error('OAuth callback must use an HTTP loopback address.');
  }
}
