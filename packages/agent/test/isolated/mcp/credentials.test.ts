import { expect, test } from 'bun:test';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { createMcpCredentialBroker, type McpCredentialIdentity } from '@kite-ai/agent/mcp';

const identity: McpCredentialIdentity = {
  profileId: 'profile',
  originalStoreId: 'store',
  workspaceId: 'w',
  workspaceIdentity: 'file:///trusted',
  sessionId: 's',
  connectionExecutionId: 'job',
  source: { kind: 'programmatic', id: 'host', revision: '1' },
  serverId: 'server',
  configDigest: 'digest',
  authProfileId: 'work',
  policyRevision: 'policy-1',
};
async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code: string }).code;
  }
}
function gate() {
  let release!: () => void, entered!: () => void;
  return {
    wait: new Promise<void>((resolve) => (release = resolve)),
    seen: new Promise<void>((resolve) => (entered = resolve)),
    release: () => release(),
    enter: () => entered(),
  };
}
test('opaque transport handles bind every identity/purpose/expiry/revision without reading vault at issue', async () => {
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    reference = await vault.put('temporary-test-secret');
  let reads = 0,
    now = 1000;
  const broker = createMcpCredentialBroker({
    vault: {
      resolve: async (ref) => {
        reads++;
        return vault.resolve(ref);
      },
    },
    now: () => now,
  });
  const ref = broker.issue({
    credentialRef: reference.id,
    identity,
    purpose: 'mcp.http',
    expiresAt: 2000,
    revocationRevision: 1,
  });
  expect(reads).toBe(0);
  let uses = 0;
  const use = {
    identity,
    purpose: 'mcp.http' as const,
    revocationRevision: 1,
    signal: new AbortController().signal,
  };
  for (const field of [
    'profileId',
    'originalStoreId',
    'workspaceId',
    'workspaceIdentity',
    'sessionId',
    'connectionExecutionId',
    'serverId',
    'configDigest',
    'authProfileId',
    'policyRevision',
  ] as const)
    expect(
      await code(
        broker.withHeaders(
          ref,
          { ...use, identity: { ...identity, [field]: 'different' } },
          () => uses++,
        ),
      ),
    ).toBe('mcp_credential_scope_mismatch');
  expect(
    await code(
      broker.withHeaders(
        ref,
        { ...use, identity: { ...identity, source: { ...identity.source, revision: 'changed' } } },
        () => uses++,
      ),
    ),
  ).toBe('mcp_credential_scope_mismatch');
  expect(
    await code(broker.withHeaders(ref, { ...use, purpose: 'other' as 'mcp.http' }, () => uses++)),
  ).toBe('mcp_credential_purpose_invalid');
  expect(await code(broker.withHeaders({ id: 'forged' }, use, () => uses++))).toBe(
    'mcp_credential_unavailable',
  );
  expect(await code(broker.withHeaders(ref, { ...use, revocationRevision: 2 }, () => uses++))).toBe(
    'mcp_credential_revoked',
  );
  now = 2000;
  expect(await code(broker.withHeaders(ref, use, () => uses++))).toBe('mcp_credential_expired');
  expect(reads).toBe(0);
  expect(uses).toBe(0);
});
test('revocation and abort while lookup waits prevent late use; distinct Session handles and dispatched facts remain independent', async () => {
  const backend = createTemporaryCredentialBackend(),
    vault = createCredentialVault({ backend }),
    reference = await vault.put('private-temporary-material');
  let barrier: ReturnType<typeof gate> | undefined;
  const broker = createMcpCredentialBroker({
    vault: {
      resolve: async (ref) => {
        const pending = barrier;
        if (pending) {
          pending.enter();
          await pending.wait;
        }
        return vault.resolve(ref);
      },
    },
  });
  const issue = (sessionId: string) =>
    broker.issue({
      credentialRef: reference.id,
      identity: { ...identity, sessionId },
      purpose: 'mcp.http',
      expiresAt: Date.now() + 60000,
      revocationRevision: 0,
    });
  const a = issue('s'),
    b = issue('other');
  const use = {
    identity,
    purpose: 'mcp.http' as const,
    revocationRevision: 0,
    signal: new AbortController().signal,
  };
  let uses = 0;
  barrier = gate();
  const pending = broker.withHeaders(a, use, () => uses++);
  await barrier.seen;
  broker.revoke(a);
  barrier.release();
  expect(await code(pending)).toBe('mcp_credential_revoked');
  expect(uses).toBe(0);
  barrier = undefined;
  expect(
    await broker.withHeaders(
      b,
      { ...use, identity: { ...identity, sessionId: 'other' } },
      (headers) => {
        expect(headers.authorization).toBe('Bearer private-temporary-material');
        return ++uses;
      },
    ),
  ).toBe(1);
  broker.revoke(b);
  expect(uses).toBe(1);
  const c = issue('s'),
    abort = new AbortController();
  barrier = gate();
  const stopped = broker.withHeaders(c, { ...use, signal: abort.signal }, () => uses++);
  await barrier.seen;
  abort.abort();
  expect(await code(stopped)).toBe('mcp_credential_aborted');
  barrier.release();
  expect(uses).toBe(1);
});

test('owned reader shares manual handle capacity and exact identity checks without reading at issue; cancellation gives zero late header use', async () => {
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    reference = await vault.put('manual');
  let reads = 0,
    uses = 0;
  const broker = createMcpCredentialBroker({ vault, maxHandles: 2 });
  const barrier = gate(),
    controller = new AbortController();
  const owned = broker.issueOwned({
    identity,
    purpose: 'mcp.http',
    expiresAt: Date.now() + 60000,
    revocationRevision: 0,
    async resolve(signal) {
      reads++;
      expect(signal).toBe(controller.signal);
      barrier.enter();
      await barrier.wait;
      return 'private-owned';
    },
  });
  const manual = broker.issue({
    identity,
    purpose: 'mcp.http',
    expiresAt: Date.now() + 60000,
    revocationRevision: 0,
    credentialRef: reference.id,
  });
  expect(reads).toBe(0);
  expect(() =>
    broker.issueOwned({
      identity,
      purpose: 'mcp.http',
      expiresAt: Date.now() + 60000,
      revocationRevision: 0,
      async resolve() {
        return 'unread';
      },
    }),
  ).toThrow('mcp_credential_capacity');
  const use = {
    identity,
    purpose: 'mcp.http' as const,
    revocationRevision: 0,
    signal: controller.signal,
  };
  expect(
    await code(
      broker.withHeaders(
        owned,
        { ...use, identity: { ...identity, sessionId: 'foreign' } },
        () => uses++,
      ),
    ),
  ).toBe('mcp_credential_scope_mismatch');
  expect(
    await code(broker.withHeaders(owned, { ...use, purpose: 'wrong' as 'mcp.http' }, () => uses++)),
  ).toBe('mcp_credential_purpose_invalid');
  expect(reads).toBe(0);
  const pending = broker.withHeaders(owned, use, () => uses++);
  await barrier.seen;
  controller.abort();
  barrier.release();
  expect(await code(pending)).toBe('mcp_credential_aborted');
  expect(uses).toBe(0);
  broker.revoke(owned);
  expect(
    await code(
      broker.withHeaders(owned, { ...use, signal: new AbortController().signal }, () => uses++),
    ),
  ).toBe('mcp_credential_revoked');
  expect(
    await broker.withHeaders(
      manual,
      { ...use, signal: new AbortController().signal },
      (headers) => headers.authorization,
    ),
  ).toBe('Bearer manual');
});

test('owned OAuth original tokenRevision handle cannot read newly logged-in material after clear; a new handle uses only its captured revision', async () => {
  const { createMcpOAuthProvider } = await import('@kite-ai/agent/mcp');
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    controller = new AbortController();
  const scope = { namespace: 'mcp.oauth' as const, ownerDigest: 'c'.repeat(64) };
  const provider = createMcpOAuthProvider({
    vault,
    scope,
    signal: controller.signal,
    assertFresh() {},
    redirectUrl: new URL('http://127.0.0.1:43211/oauth/callback'),
  });
  const broker = createMcpCredentialBroker({ vault });
  let uses = 0,
    reads = 0;
  const use = {
    identity,
    purpose: 'mcp.http' as const,
    revocationRevision: 0,
    signal: controller.signal,
  };
  const issue = (tokenRevision: string) =>
    broker.issueOwned({
      identity,
      purpose: 'mcp.http',
      expiresAt: Date.now() + 60000,
      revocationRevision: 0,
      async resolve(signal) {
        reads++;
        expect(signal).toBe(controller.signal);
        return provider.readAccessToken(tokenRevision);
      },
    });
  try {
    await provider.saveTokens({ access_token: 'old-private-access', token_type: 'Bearer' });
    const oldRevision = (await provider.getTokenState()).tokenRevision!,
      old = issue(oldRevision);
    expect(reads).toBe(0);
    expect(
      await broker.withHeaders(old, use, (headers) => {
        uses++;
        return headers.authorization;
      }),
    ).toBe('Bearer old-private-access');
    await provider.invalidateCredentials('all');
    await provider.saveTokens({ access_token: 'new-private-access', token_type: 'Bearer' });
    const newRevision = (await provider.getTokenState()).tokenRevision!;
    expect(newRevision).not.toBe(oldRevision);
    expect(await code(broker.withHeaders(old, use, () => uses++))).toBe(
      'mcp_credential_unavailable',
    );
    expect(uses).toBe(1);
    const current = issue(newRevision);
    expect(
      await broker.withHeaders(current, use, (headers) => {
        uses++;
        return headers.authorization;
      }),
    ).toBe('Bearer new-private-access');
    broker.revoke(current);
    expect(await code(broker.withHeaders(current, use, () => uses++))).toBe(
      'mcp_credential_revoked',
    );
    expect(uses).toBe(2);
  } finally {
    provider.cancel();
  }
});

test('actual owned material read held across clear and relogin rejects the old header before wire', async () => {
  const { createMcpOAuthProvider } = await import('@kite-ai/agent/mcp');
  const backend = createTemporaryCredentialBackend(),
    barrier = gate();
  let hold = false;
  const vault = createCredentialVault({
    backend: {
      ...backend,
      async resolve(key) {
        const captured = await backend.resolve(key);
        if (hold) {
          barrier.enter();
          await barrier.wait;
        }
        return captured;
      },
    },
  });
  const controller = new AbortController(),
    scope = { namespace: 'mcp.oauth' as const, ownerDigest: 'd'.repeat(64) };
  const provider = createMcpOAuthProvider({
    vault,
    scope,
    signal: controller.signal,
    assertFresh() {},
    redirectUrl: new URL('http://127.0.0.1:43212/oauth/callback'),
  });
  const broker = createMcpCredentialBroker({ vault });
  let uses = 0;
  try {
    await provider.saveTokens({ access_token: 'original-private', token_type: 'Bearer' });
    const original = (await provider.getTokenState()).tokenRevision!;
    const old = broker.issueOwned({
      identity,
      purpose: 'mcp.http',
      expiresAt: Date.now() + 60000,
      revocationRevision: 0,
      resolve: () => provider.readAccessToken(original),
    });
    hold = true;
    const pending = broker.withHeaders(
      old,
      { identity, purpose: 'mcp.http', revocationRevision: 0, signal: controller.signal },
      () => uses++,
    );
    void pending.catch(() => {});
    await barrier.seen;
    await provider.invalidateCredentials('all');
    await provider.saveTokens({ access_token: 'replacement-private', token_type: 'Bearer' });
    hold = false;
    barrier.release();
    expect(await code(pending)).toBe('mcp_oauth_credential_unavailable');
    expect(uses).toBe(0);
    const actual = (await provider.getTokenState()).tokenRevision!;
    expect(actual).not.toBe(original);
    expect(await provider.readAccessToken(actual)).toBe('replacement-private');
  } finally {
    hold = false;
    barrier.release();
    provider.cancel();
  }
});
