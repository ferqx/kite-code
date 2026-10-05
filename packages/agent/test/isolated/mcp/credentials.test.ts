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
