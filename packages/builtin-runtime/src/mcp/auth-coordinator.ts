import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { CredentialHandle } from '@kite-ai/runtime-spi';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { BrowserOpener } from './browser-opener';
import { NativeBrowserOpener } from './browser-opener';
import type { McpServerKey } from './control-types';
import type { BuiltinCredentialBroker } from './credential-broker';
import type { McpCredentialKey, McpCredentialStoreStatus } from './credential-store';
import { KiteMcpOAuthProvider } from './oauth-provider';

export type McpAuthStatus =
  | 'not_required'
  | 'login_required'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'reauth_required'
  | 'revoked'
  | 'error';

export interface McpAuthSnapshot {
  status: McpAuthStatus;
  credentialPresent: boolean;
  storeStatus: McpCredentialStoreStatus;
  flowId?: string;
  authorizationUrl?: string;
  errorCode?:
    | 'credential_store_locked'
    | 'credential_store_unavailable'
    | 'callback_invalid'
    | 'callback_timeout'
    | 'browser_open_failed'
    | 'authorization_failed';
}

export type McpAuthResult =
  | { status: 'authorization_required'; flowId: string; authorizationUrl: string }
  | { status: 'authenticated' }
  | { status: 'cancelled' }
  | { status: 'logged_out' };

export interface McpAuthTarget {
  key: McpServerKey;
  credentialKey: McpCredentialKey;
  credentialHandle?: CredentialHandle;
  serverUrl: URL;
  scopes?: readonly string[];
  clientId?: string;
  clientSecretKey?: McpCredentialKey;
  clientSecretHandle?: CredentialHandle;
  begin(provider: OAuthClientProvider): Promise<'authorization_required' | 'connected'>;
  complete(authorizationCode: string): Promise<void>;
  logout(): Promise<void>;
  revoke?(provider: KiteMcpOAuthProvider): Promise<void>;
}

export interface McpAuthCoordinator {
  register(target: McpAuthTarget): void;
  unregister(key: McpServerKey): void;
  login(key: McpServerKey): Promise<McpAuthResult>;
  resume(key: McpServerKey): Promise<'not_configured' | 'connected' | 'login_required'>;
  completeCallback(flowId: string, url: URL): Promise<McpAuthResult>;
  cancel(flowId: string): Promise<McpAuthResult>;
  logout(key: McpServerKey, revoke: boolean): Promise<McpAuthResult>;
  markLoginRequired(key: McpServerKey): void;
  getSnapshot(key: McpServerKey): Readonly<McpAuthSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface DefaultMcpAuthCoordinatorOptions {
  /** Shared Builtin credential authority. */
  credentialBroker: BuiltinCredentialBroker;
  browserOpener?: BrowserOpener;
  callbackTimeoutMs?: number;
  startCallbackServer?: CallbackServerFactory;
}

export class DefaultMcpAuthCoordinator implements McpAuthCoordinator {
  private readonly credentialBroker: BuiltinCredentialBroker;
  private readonly browserOpener: BrowserOpener;
  private readonly callbackTimeoutMs: number;
  private readonly startCallbackServer: CallbackServerFactory;
  private readonly targets = new Map<string, McpAuthTarget>();
  private readonly snapshots = new Map<string, Readonly<McpAuthSnapshot>>();
  private readonly flows = new Map<string, AuthFlow>();
  private readonly listeners = new Set<() => void>();

  constructor(options: DefaultMcpAuthCoordinatorOptions) {
    this.credentialBroker = options.credentialBroker;
    this.browserOpener = options.browserOpener ?? new NativeBrowserOpener();
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 120_000;
    this.startCallbackServer = options.startCallbackServer ?? startLoopbackCallbackServer;
  }

  register(target: McpAuthTarget): void {
    this.targets.set(serverIdentity(target.key), target);
  }

  unregister(key: McpServerKey): void {
    this.targets.delete(serverIdentity(key));
  }

  markLoginRequired(key: McpServerKey): void {
    const current = this.getSnapshot(key);
    if (current.status === 'authorizing') return;
    this.setSnapshot(key, { ...current, status: 'login_required' });
  }

  async login(key: McpServerKey): Promise<McpAuthResult> {
    const target = this.requireTarget(key);
    const storeStatus = await this.credentialBroker.status();
    if (storeStatus !== 'available') {
      this.setSnapshot(key, {
        status: 'error',
        credentialPresent: false,
        storeStatus,
        errorCode:
          storeStatus === 'locked' ? 'credential_store_locked' : 'credential_store_unavailable',
      });
      throw new Error('Credential store is not available for OAuth.');
    }

    const existing = [...this.flows.values()].find(
      (flow) => serverIdentity(flow.target.key) === serverIdentity(key),
    );
    if (existing) return this.flowResult(existing);

    const flowId = randomBytes(18).toString('base64url');
    const callback = await this.startCallbackServer((url) => {
      void this.completeCallback(flowId, url).catch(() => {});
    });
    const provider = new KiteMcpOAuthProvider({
      credentialBroker: this.credentialBroker,
      credentialKey: target.credentialKey,
      credentialHandle: await this.validHandle(target.credentialHandle, 'mcp.oauth'),
      redirectUrl: callback.redirectUrl,
      scopes: target.scopes,
      clientId: target.clientId,
      clientSecretKey: target.clientSecretKey,
      clientSecretHandle: await this.validHandle(
        target.clientSecretHandle,
        'mcp.oauth.client-secret',
      ),
    });
    const flow: AuthFlow = { id: flowId, target, provider, callback };
    this.flows.set(flowId, flow);
    callback.timeout = setTimeout(() => {
      void this.failFlow(flow, 'callback_timeout');
    }, this.callbackTimeoutMs);
    this.setSnapshot(key, {
      status: 'authorizing',
      credentialPresent: await this.hasCredential(target),
      storeStatus,
      flowId,
    });

    try {
      const result = await target.begin(provider);
      if (result === 'connected') {
        await this.closeFlow(flow);
        this.setSnapshot(key, {
          status: 'authenticated',
          credentialPresent: true,
          storeStatus,
        });
        return { status: 'authenticated' };
      }
      const authorizationUrl = provider.getPendingAuthorizationUrl();
      if (!authorizationUrl) throw new Error('Authorization URL was not provided by the server.');
      this.setSnapshot(key, {
        status: 'authorizing',
        credentialPresent: false,
        storeStatus,
        flowId,
        authorizationUrl: authorizationUrl.toString(),
      });
      try {
        await this.browserOpener.open(authorizationUrl);
      } catch {
        this.setSnapshot(key, {
          ...this.getSnapshot(key),
          errorCode: 'browser_open_failed',
        });
      }
      return {
        status: 'authorization_required',
        flowId,
        authorizationUrl: authorizationUrl.toString(),
      };
    } catch (error) {
      await this.failFlow(flow, 'authorization_failed');
      throw error;
    }
  }

  /** Try stored tokens without starting a callback listener or opening a browser. */
  async resume(key: McpServerKey): Promise<'not_configured' | 'connected' | 'login_required'> {
    const target = this.targets.get(serverIdentity(key));
    if (!target) return 'not_configured';
    if ((await this.credentialBroker.status()) !== 'available') return 'not_configured';
    const credentialHandle = await this.validHandle(target.credentialHandle, 'mcp.oauth');
    const hasTokens = credentialHandle
      ? await this.credentialBroker
          .withHandleMaterial(
            credentialHandle,
            'mcp.oauth',
            (material) => material.kind === 'oauth' && !!material.tokens,
          )
          .catch(() => false)
      : await this.credentialBroker
          .withMaterialForKey(
            target.credentialKey,
            'mcp.oauth.resume',
            (material) => material.kind === 'oauth' && !!material.tokens,
          )
          .catch(() => false);
    if (!hasTokens) return 'not_configured';
    const provider = new KiteMcpOAuthProvider({
      credentialBroker: this.credentialBroker,
      credentialKey: target.credentialKey,
      credentialHandle,
      redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
      scopes: target.scopes,
      clientId: target.clientId,
      clientSecretKey: target.clientSecretKey,
      clientSecretHandle: await this.validHandle(
        target.clientSecretHandle,
        'mcp.oauth.client-secret',
      ),
    });
    this.setSnapshot(key, {
      status: 'refreshing',
      credentialPresent: true,
      storeStatus: 'available',
    });
    try {
      const result = await target.begin(provider);
      if (result === 'connected') {
        this.setSnapshot(key, {
          status: 'authenticated',
          credentialPresent: true,
          storeStatus: 'available',
        });
        return 'connected';
      }
      await provider.invalidateCredentials('verifier');
      this.setSnapshot(key, {
        status: 'reauth_required',
        credentialPresent: true,
        storeStatus: 'available',
      });
      return 'login_required';
    } catch {
      this.setSnapshot(key, {
        status: 'reauth_required',
        credentialPresent: true,
        storeStatus: 'available',
        errorCode: 'authorization_failed',
      });
      return 'login_required';
    }
  }

  async completeCallback(flowId: string, url: URL): Promise<McpAuthResult> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error('OAuth flow is no longer active.');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const callbackError = url.searchParams.get('error');
    if (callbackError || !state || !code || !flow.provider.verifyState(state)) {
      await this.failFlow(flow, 'callback_invalid');
      throw new Error('OAuth callback validation failed.');
    }
    try {
      await flow.target.complete(code);
      await this.closeFlow(flow);
      this.setSnapshot(flow.target.key, {
        status: 'authenticated',
        credentialPresent: true,
        storeStatus: 'available',
      });
      return { status: 'authenticated' };
    } catch (error) {
      await this.failFlow(flow, 'authorization_failed');
      throw error;
    }
  }

  async cancel(flowId: string): Promise<McpAuthResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return { status: 'cancelled' };
    await flow.provider.invalidateCredentials('verifier');
    await this.closeFlow(flow);
    this.setSnapshot(flow.target.key, {
      status: 'login_required',
      credentialPresent: await this.hasCredential(flow.target),
      storeStatus: await this.credentialBroker.status(),
    });
    return { status: 'cancelled' };
  }

  async logout(key: McpServerKey, revoke: boolean): Promise<McpAuthResult> {
    const target = this.requireTarget(key);
    const active = [...this.flows.values()].find(
      (flow) => serverIdentity(flow.target.key) === serverIdentity(key),
    );
    if (active) await this.cancel(active.id);
    const provider = new KiteMcpOAuthProvider({
      credentialBroker: this.credentialBroker,
      credentialKey: target.credentialKey,
      credentialHandle: await this.validHandle(target.credentialHandle, 'mcp.oauth'),
      redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
      scopes: target.scopes,
      clientId: target.clientId,
      clientSecretKey: target.clientSecretKey,
      clientSecretHandle: await this.validHandle(
        target.clientSecretHandle,
        'mcp.oauth.client-secret',
      ),
    });
    if (revoke) await target.revoke?.(provider);
    await provider.invalidateCredentials('all');
    await target.logout();
    this.setSnapshot(key, {
      status: 'revoked',
      credentialPresent: false,
      storeStatus: await this.credentialBroker.status(),
    });
    return { status: 'logged_out' };
  }

  getSnapshot(key: McpServerKey): Readonly<McpAuthSnapshot> {
    return (
      this.snapshots.get(serverIdentity(key)) ??
      Object.freeze({
        status: 'not_required',
        credentialPresent: false,
        storeStatus: 'available',
      })
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireTarget(key: McpServerKey): McpAuthTarget {
    const target = this.targets.get(serverIdentity(key));
    if (!target) throw new Error('MCP OAuth target is not available.');
    return target;
  }

  private hasCredential(target: McpAuthTarget): Promise<boolean> {
    return this.validHandle(target.credentialHandle, 'mcp.oauth').then((handle) =>
      handle
        ? this.credentialBroker.hasForHandle(handle, 'mcp.oauth')
        : this.credentialBroker.hasForKey(target.credentialKey),
    );
  }

  private async validHandle(
    handle: McpAuthTarget['credentialHandle'],
    purpose: string,
  ): Promise<McpAuthTarget['credentialHandle']> {
    if (!handle) return undefined;
    this.credentialBroker.validateHandle(handle, purpose);
    return handle;
  }

  private flowResult(flow: AuthFlow): McpAuthResult {
    const url = flow.provider.getPendingAuthorizationUrl();
    if (!url) throw new Error('OAuth authorization is still being prepared.');
    return { status: 'authorization_required', flowId: flow.id, authorizationUrl: url.toString() };
  }

  private async failFlow(
    flow: AuthFlow,
    errorCode: NonNullable<McpAuthSnapshot['errorCode']>,
  ): Promise<void> {
    await this.closeFlow(flow);
    this.setSnapshot(flow.target.key, {
      status: 'error',
      credentialPresent: false,
      storeStatus: await this.credentialBroker.status(),
      errorCode,
    });
  }

  private async closeFlow(flow: AuthFlow): Promise<void> {
    if (flow.callback.timeout) clearTimeout(flow.callback.timeout);
    await flow.callback.close();
    this.flows.delete(flow.id);
  }

  private setSnapshot(key: McpServerKey, snapshot: McpAuthSnapshot): void {
    this.snapshots.set(serverIdentity(key), Object.freeze({ ...snapshot }));
    for (const listener of this.listeners) listener();
  }
}

interface AuthFlow {
  id: string;
  target: McpAuthTarget;
  provider: KiteMcpOAuthProvider;
  callback: CallbackServer;
}

interface CallbackServer {
  redirectUrl: URL;
  close(): Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
}

export type CallbackServerFactory = (onCallback: (url: URL) => void) => Promise<CallbackServer>;

async function startLoopbackCallbackServer(
  onCallback: (url: URL) => void,
): Promise<CallbackServer> {
  let server: Server;
  server = createServer((request, response) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    response.end('Authorization received. You can return to Kite Code.');
    onCallback(url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to bind OAuth callback server.');
  }
  return {
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function serverIdentity(key: McpServerKey): string {
  return `${key.source}:${key.name}`;
}
