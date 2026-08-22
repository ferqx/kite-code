import { describe, expect, test } from 'bun:test';
import {
  type BrowserOpener,
  type CallbackServerFactory,
  DefaultMcpAuthCoordinator,
  type McpAuthTarget,
  MemoryMcpCredentialStore,
} from '@kite/builtin-runtime/mcp';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

describe('MCP auth coordinator', () => {
  test('does not open a browser until login and completes a state-bound callback', async () => {
    const harness = coordinatorHarness();
    let provider: OAuthClientProvider | undefined;
    let completedCode = '';
    harness.coordinator.register(
      target({
        begin: async (value) => {
          provider = value;
          await value.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
          return 'authorization_required';
        },
        complete: async (code) => {
          completedCode = code;
        },
      }),
    );

    harness.coordinator.markLoginRequired(KEY);
    expect(harness.opened).toEqual([]);
    expect(harness.coordinator.getSnapshot(KEY).status).toBe('login_required');

    const login = await harness.coordinator.login(KEY);
    expect(login.status).toBe('authorization_required');
    expect(harness.opened).toEqual(['https://auth.example.com/authorize']);
    expect(harness.coordinator.getSnapshot(KEY)).toMatchObject({ status: 'authorizing' });

    const state = await provider!.state!();
    const result = await harness.coordinator.completeCallback(
      login.status === 'authorization_required' ? login.flowId : '',
      new URL(`http://127.0.0.1/oauth/callback?code=opaque-code&state=${state}`),
    );
    expect(result).toEqual({ status: 'authenticated' });
    expect(completedCode).toBe('opaque-code');
    expect(harness.closed).toBe(1);
    expect(harness.coordinator.getSnapshot(KEY)).toMatchObject({
      status: 'authenticated',
      credentialPresent: true,
    });
  });

  test('rejects invalid callback state and closes the listener', async () => {
    const harness = coordinatorHarness();
    harness.coordinator.register(
      target({
        begin: async (provider) => {
          await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
          return 'authorization_required';
        },
      }),
    );
    const login = await harness.coordinator.login(KEY);
    await expect(
      harness.coordinator.completeCallback(
        login.status === 'authorization_required' ? login.flowId : '',
        new URL('http://127.0.0.1/oauth/callback?code=opaque-code&state=attacker'),
      ),
    ).rejects.toThrow('validation failed');
    expect(harness.closed).toBe(1);
    expect(harness.coordinator.getSnapshot(KEY)).toMatchObject({
      status: 'error',
      errorCode: 'callback_invalid',
    });
  });

  test('cancels without completing and removes the short-lived verifier', async () => {
    const harness = coordinatorHarness();
    harness.coordinator.register(
      target({
        begin: async (provider) => {
          await provider.saveCodeVerifier('pkce-secret');
          await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
          return 'authorization_required';
        },
      }),
    );
    const login = await harness.coordinator.login(KEY);
    if (login.status !== 'authorization_required') throw new Error('expected flow');
    await expect(harness.coordinator.cancel(login.flowId)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(harness.coordinator.getSnapshot(KEY).status).toBe('login_required');
    expect(harness.closed).toBe(1);
  });

  test('fails closed before connection work when the native store is locked', async () => {
    const harness = coordinatorHarness(new MemoryMcpCredentialStore('locked'));
    let begins = 0;
    harness.coordinator.register(
      target({
        begin: async () => {
          begins += 1;
          return 'authorization_required';
        },
      }),
    );
    await expect(harness.coordinator.login(KEY)).rejects.toThrow('not available');
    expect(begins).toBe(0);
    expect(harness.opened).toEqual([]);
    expect(harness.coordinator.getSnapshot(KEY)).toMatchObject({
      status: 'error',
      storeStatus: 'locked',
      errorCode: 'credential_store_locked',
    });
  });

  test('resumes stored tokens in the background without opening a browser or callback listener', async () => {
    const store = new MemoryMcpCredentialStore();
    await store.put(
      {
        workspaceKey: 'workspace',
        source: 'user',
        server: 'remote',
        profile: 'oauth',
      },
      {
        version: 1,
        kind: 'oauth',
        tokens: { access_token: 'stored-token', token_type: 'Bearer' },
        updatedAt: '2026-07-16T00:00:00.000Z',
      },
    );
    const harness = coordinatorHarness(store);
    let begins = 0;
    harness.coordinator.register(
      target({
        begin: async () => {
          begins += 1;
          return 'connected';
        },
      }),
    );
    await expect(harness.coordinator.resume(KEY)).resolves.toBe('connected');
    expect(begins).toBe(1);
    expect(harness.opened).toEqual([]);
    expect(harness.callback).toBeUndefined();
    expect(harness.coordinator.getSnapshot(KEY)).toMatchObject({
      status: 'authenticated',
      credentialPresent: true,
    });
  });
});

const KEY = { name: 'remote', source: 'user' as const };

function target(
  overrides: Partial<Pick<McpAuthTarget, 'begin' | 'complete' | 'logout'>> = {},
): McpAuthTarget {
  return {
    key: KEY,
    credentialKey: {
      workspaceKey: 'workspace',
      source: 'user',
      server: 'remote',
      profile: 'oauth',
    },
    serverUrl: new URL('https://mcp.example.com/mcp'),
    begin: overrides.begin ?? (async () => 'authorization_required'),
    complete: overrides.complete ?? (async () => {}),
    logout: overrides.logout ?? (async () => {}),
  };
}

function coordinatorHarness(store = new MemoryMcpCredentialStore()) {
  const opened: string[] = [];
  let closed = 0;
  let callback: ((url: URL) => void) | undefined;
  const browserOpener: BrowserOpener = {
    open: async (url) => {
      opened.push(url.toString());
    },
  };
  const startCallbackServer: CallbackServerFactory = async (onCallback) => {
    callback = onCallback;
    return {
      redirectUrl: new URL('http://127.0.0.1:43119/oauth/callback'),
      close: async () => {
        closed += 1;
      },
    };
  };
  const coordinator = new DefaultMcpAuthCoordinator({
    credentialStore: store,
    browserOpener,
    startCallbackServer,
    callbackTimeoutMs: 60_000,
  });
  return {
    coordinator,
    opened,
    get closed() {
      return closed;
    },
    get callback() {
      return callback;
    },
  };
}
