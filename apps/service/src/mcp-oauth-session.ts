import {
  createMcpOAuthProvider,
  McpCredentialError,
  McpOAuthError,
  type McpOAuthProviderOptions,
} from '@kite-ai/agent/mcp';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  selectResourceURL,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createMcpOAuthNetwork, type McpOAuthNetworkOptions } from './mcp-oauth-network';

export class McpOAuthSessionError extends McpCredentialError {
  constructor(code: string) {
    super(code);
    this.name = 'McpOAuthSessionError';
  }
}

export interface McpOAuthSessionOptions {
  readonly vault: McpOAuthProviderOptions['vault'];
  readonly scope: McpOAuthProviderOptions['scope'];
  readonly serverUrl: string;
  readonly scopes?: readonly string[];
  /** Actual 401 observation from the pinned MCP peer, never caller input. */
  readonly resourceMetadataUrl?: string;
  readonly clientId?: string;
  readonly clientSecretRef?: string;
  readonly signal: AbortSignal;
  readonly assertFresh: () => void;
  readonly openBrowser: (url: URL, signal: AbortSignal) => Promise<void>;
  readonly network?: Pick<
    McpOAuthNetworkOptions,
    'resolveAddresses' | 'allowLoopbackForTests' | 'limits'
  >;
  readonly callbackTimeoutMs?: number;
  readonly now?: () => number;
  readonly onPhase?: (phase: 'authorizing' | 'refreshing') => Promise<void>;
}

/** One admitted operation's private protocol state. It is not an MCP transport or execution owner. */
export function createMcpOAuthSession(options: McpOAuthSessionOptions) {
  const signal = options.signal;
  const now = options.now ?? Date.now;
  const assertFresh = () => {
    signal.throwIfAborted();
    options.assertFresh();
  };
  const timeout = options.callbackTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000)
    throw new McpOAuthSessionError('mcp_oauth_configuration_invalid');
  const fail = (code: string): never => {
    throw new McpOAuthSessionError(code);
  };
  const makeProvider = (redirectUrl: URL, operationSignal = signal, fresh = assertFresh) =>
    createMcpOAuthProvider({
      vault: options.vault,
      scope: options.scope,
      redirectUrl,
      signal: operationSignal,
      assertFresh: fresh,
      now,
      ...(options.scopes ? { scopes: options.scopes } : {}),
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.clientSecretRef ? { clientSecretRef: options.clientSecretRef } : {}),
    });
  const available = async () => {
    assertFresh();
    const status = await options.vault.statusOwned(options.scope);
    assertFresh();
    if (status !== 'available')
      fail(
        status === 'locked' ? 'mcp_credential_store_locked' : 'mcp_credential_store_unavailable',
      );
  };
  const metadata = async (
    provider: ReturnType<typeof makeProvider>,
    network: ReturnType<typeof createMcpOAuthNetwork>,
    fresh = assertFresh,
  ) => {
    fresh();
    const cached = await provider.discoveryState();
    fresh();
    const resourceMetadataUrl = options.resourceMetadataUrl ?? cached?.resourceMetadataUrl;
    let fetchFailure: unknown;
    const info = await discoverOAuthServerInfo(new URL(options.serverUrl), {
      ...(resourceMetadataUrl ? { resourceMetadataUrl: new URL(resourceMetadataUrl) } : {}),
      async fetchFn(input, init) {
        // The SDK supports a protocol 404 fallback; a host policy/network failure must stay failed.
        if (fetchFailure) throw fetchFailure;
        try {
          return await network.fetch(input, init);
        } catch (error) {
          fetchFailure = error;
          throw error;
        }
      },
    });
    if (fetchFailure) fail('mcp_oauth_discovery_failed');
    fresh();
    const resource = await selectResourceURL(
      new URL(options.serverUrl),
      provider,
      info.resourceMetadata,
    );
    fresh();
    await provider.saveDiscoveryState({
      authorizationServerUrl: String(info.authorizationServerUrl),
      resourceMetadata: info.resourceMetadata,
      authorizationServerMetadata: info.authorizationServerMetadata,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    });
    return { ...info, resource };
  };
  const client = async (
    provider: ReturnType<typeof makeProvider>,
  ): Promise<OAuthClientInformationMixed> => {
    const information = await provider.clientInformation();
    assertFresh();
    if (!information) return fail('mcp_oauth_client_unavailable');
    return information;
  };

  async function login(): Promise<void> {
    await available();
    const local = new AbortController();
    const flowSignal = AbortSignal.any([signal, local.signal]);
    const flowFresh = () => {
      flowSignal.throwIfAborted();
      assertFresh();
    };
    const network = createMcpOAuthNetwork({
      ...options.network,
      signal: flowSignal,
      assertFresh: flowFresh,
    });
    let provider: ReturnType<typeof makeProvider> | undefined;
    let listener: ReturnType<typeof Bun.serve> | undefined;
    let browser: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accept!: (code: string) => void;
    let reject!: (error: Error) => void;
    let claimed = false;
    const callback = new Promise<string>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // Register immediately: opener/discovery failure must not leave a rejected callback unobserved.
    void callback.catch(() => {});
    const aborted = () => reject(new McpOAuthSessionError('mcp_oauth_cancelled'));
    flowSignal.addEventListener('abort', aborted, { once: true });
    try {
      flowFresh();
      timer = setTimeout(() => {
        reject(new McpOAuthSessionError('mcp_oauth_timeout'));
        local.abort();
      }, timeout);
      listener = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const values = [...url.searchParams.keys()];
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          if (
            claimed ||
            flowSignal.aborted ||
            request.method !== 'GET' ||
            request.headers.get('host') !== `127.0.0.1:${listener?.port}` ||
            url.pathname !== '/oauth/callback' ||
            url.hash ||
            values.length !== 2 ||
            new Set(values).size !== 2 ||
            !values.includes('code') ||
            !values.includes('state') ||
            !code ||
            code.length > 8192 ||
            [...code].some((character) => {
              const value = character.charCodeAt(0);
              return value < 32 || value === 127;
            }) ||
            !state ||
            state.length > 256
          )
            return new Response('Invalid authorization callback.', { status: 400 });
          try {
            if (!provider?.verifyState(state))
              return new Response('Invalid authorization callback.', { status: 400 });
            flowFresh();
          } catch {
            reject(new McpOAuthSessionError('mcp_oauth_scope_changed'));
            return new Response('Authorization is no longer available.', { status: 409 });
          }
          claimed = true;
          accept(code);
          return new Response('Authorization received. You may close this page.', {
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          });
        },
      });
      provider = makeProvider(
        new URL(`http://127.0.0.1:${listener.port}/oauth/callback`),
        flowSignal,
        flowFresh,
      );
      await options.onPhase?.('authorizing');
      const discovered = await metadata(provider, network, flowFresh);
      let information = await provider.clientInformation();
      flowFresh();
      if (!information) {
        // Only explicit login may register; the resume/refresh path never falls back to registration.
        information = await registerClient(discovered.authorizationServerUrl, {
          metadata: discovered.authorizationServerMetadata,
          clientMetadata: provider.clientMetadata,
          scope: options.scopes?.join(' '),
          fetchFn: network.fetch,
        });
        flowFresh();
        await provider.saveClientInformation(information);
      }
      const authorization = await startAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.authorizationServerMetadata,
        clientInformation: information,
        redirectUrl: provider.redirectUrl!,
        scope:
          options.scopes?.join(' ') || discovered.resourceMetadata?.scopes_supported?.join(' '),
        state: provider.state(),
        resource: discovered.resource,
      });
      flowFresh();
      await provider.saveCodeVerifier(authorization.codeVerifier);
      const url = authorization.authorizationUrl;
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(
            options.network?.allowLoopbackForTests &&
            url.protocol === 'http:' &&
            url.hostname === '127.0.0.1'
          ))
      )
        fail('mcp_oauth_authorization_url_invalid');
      flowFresh();
      try {
        browser = Promise.resolve().then(() => options.openBrowser(new URL(url), flowSignal));
        await Promise.race([
          browser,
          callback.then(
            () => {},
            (error) => {
              throw error;
            },
          ),
        ]);
      } catch (error) {
        if (flowSignal.aborted) await callback;
        if (error instanceof McpOAuthSessionError) throw error;
        fail('mcp_oauth_browser_unavailable');
      }
      const code = await callback;
      flowFresh();
      const tokens = await exchangeAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.authorizationServerMetadata,
        clientInformation: information,
        authorizationCode: code,
        codeVerifier: await provider.codeVerifier(),
        redirectUri: provider.redirectUrl!,
        resource: discovered.resource,
        fetchFn: network.fetch,
      });
      flowFresh();
      await provider.saveTokens(tokens);
    } catch (error) {
      if (error instanceof McpOAuthSessionError) throw error;
      if (error instanceof McpOAuthError) throw new McpOAuthSessionError(error.code);
      if (flowSignal.aborted) await callback;
      fail(signal.aborted ? 'mcp_oauth_cancelled' : 'mcp_oauth_login_failed');
    } finally {
      if (timer) clearTimeout(timer);
      flowSignal.removeEventListener('abort', aborted);
      local.abort();
      provider?.cancel();
      const cleanup = await Promise.allSettled([
        (async () => {
          if (!listener) return;
          // Allow the finite callback response to flush before forcing any remaining connections.
          const stopped = listener.stop();
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            const confirmed = await Promise.race([
              stopped.then(() => true),
              new Promise<false>((resolve) => {
                deadline = setTimeout(() => resolve(false), 1000);
              }),
            ]);
            if (!confirmed) await listener.stop(true);
            await stopped;
          } finally {
            if (deadline) clearTimeout(deadline);
          }
        })(),
        network.close(),
        browser?.catch((error: unknown) => {
          if (error instanceof McpOAuthSessionError && error.code.endsWith('_unknown')) throw error;
        }) ?? Promise.resolve(),
      ]);
      if (cleanup.some((value) => value.status === 'rejected')) fail('mcp_oauth_cleanup_unknown');
    }
  }

  async function refresh(): Promise<void> {
    await available();
    const provider = makeProvider(new URL('http://127.0.0.1/oauth/callback'));
    const network = createMcpOAuthNetwork({ ...options.network, signal, assertFresh });
    try {
      const tokens = await provider.tokens();
      assertFresh();
      if (!tokens?.refresh_token) return fail('mcp_oauth_reauth_required');
      await options.onPhase?.('refreshing');
      const discovered = await metadata(provider, network);
      const next = await refreshAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.authorizationServerMetadata,
        clientInformation: await client(provider),
        refreshToken: tokens.refresh_token,
        resource: discovered.resource,
        fetchFn: network.fetch,
      });
      assertFresh();
      await provider.saveTokens(next);
    } catch (error) {
      if (error instanceof McpOAuthSessionError) throw error;
      if (error instanceof McpOAuthError) throw new McpOAuthSessionError(error.code);
      fail(signal.aborted ? 'mcp_oauth_cancelled' : 'mcp_oauth_reauth_required');
    } finally {
      provider.cancel();
      try {
        await network.close();
      } catch {
        fail('mcp_oauth_cleanup_unknown');
      }
    }
  }

  async function credential(): Promise<{ tokenRevision: string; expiresAt: number | null } | null> {
    await available();
    const provider = makeProvider(new URL('http://127.0.0.1/oauth/callback'));
    try {
      const state = await provider.getTokenState();
      assertFresh();
      if (!state.present) return null;
      if (state.expiresAt !== null && state.expiresAt <= now() + 5000) await refresh();
      const current = await provider.getTokenState();
      const tokens = await provider.tokens();
      assertFresh();
      if (!tokens?.access_token || tokens.token_type.toLowerCase() !== 'bearer')
        return fail('mcp_oauth_reauth_required');
      if (!current.tokenRevision) return fail('mcp_oauth_reauth_required');
      return { tokenRevision: current.tokenRevision, expiresAt: current.expiresAt };
    } finally {
      provider.cancel();
    }
  }

  async function clear(): Promise<void> {
    await available();
    assertFresh();
    try {
      await options.vault.removeOwned(options.scope);
      assertFresh();
    } catch {
      fail('mcp_oauth_publication_unknown');
    }
  }

  async function revoke(): Promise<'completed' | 'not_supported'> {
    await available();
    const provider = makeProvider(new URL('http://127.0.0.1/oauth/callback'));
    const network = createMcpOAuthNetwork({ ...options.network, signal, assertFresh });
    let revocationStarted = false;
    let localRemovalStarted = false;
    try {
      const tokens = await provider.tokens();
      const information = await client(provider);
      const discovered = await metadata(provider, network);
      const endpoint = (
        discovered.authorizationServerMetadata as unknown as Record<string, unknown>
      )?.revocation_endpoint;
      if (typeof endpoint !== 'string') return 'not_supported';
      if (!tokens) return fail('mcp_oauth_reauth_required');
      const body = new URLSearchParams({
        token: tokens.refresh_token ?? tokens.access_token,
        token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
        client_id: information.client_id,
      });
      if ('client_secret' in information && information.client_secret)
        body.set('client_secret', information.client_secret);
      assertFresh();
      revocationStarted = true;
      const response = await network.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) fail('mcp_oauth_revocation_unknown');
      await response.arrayBuffer();
      assertFresh();
      localRemovalStarted = true;
      await options.vault.removeOwned(options.scope);
      assertFresh();
      return 'completed';
    } catch (error) {
      if (localRemovalStarted) return fail('mcp_oauth_publication_unknown');
      if (revocationStarted) return fail('mcp_oauth_revocation_unknown');
      if (error instanceof McpOAuthSessionError) throw error;
      if (error instanceof McpOAuthError) throw new McpOAuthSessionError(error.code);
      return fail(signal.aborted ? 'mcp_oauth_cancelled' : 'mcp_oauth_revocation_unknown');
    } finally {
      provider.cancel();
      try {
        await network.close();
      } catch {
        fail('mcp_oauth_cleanup_unknown');
      }
    }
  }
  return { login, refresh, credential, clear, revoke };
}
