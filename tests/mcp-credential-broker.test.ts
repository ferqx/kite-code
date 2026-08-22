import { describe, expect, test } from 'bun:test';
import {
  createBuiltinCredentialBrokerV1,
  type McpCredentialKey,
  MemoryMcpCredentialStore,
} from '@kite/builtin-runtime/mcp';

const KEY: McpCredentialKey = {
  workspaceKey: '/workspace/project',
  source: 'user',
  server: 'docs',
  profile: 'default',
};

describe('Builtin credential broker', () => {
  test('binds access to an opaque purpose handle and keeps material out of it', async () => {
    const store = new MemoryMcpCredentialStore();
    await store.put(KEY, {
      version: 1,
      kind: 'bearer',
      secret: 'broker-secret',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const broker = createBuiltinCredentialBrokerV1({ store });
    const handle = await broker.issueForKey(KEY, { purpose: 'mcp.transport' });

    expect(JSON.stringify(handle)).not.toContain('broker-secret');
    await expect(broker.withHandleMaterial(handle, 'mcp.other', () => undefined)).rejects.toThrow(
      'purpose mismatch',
    );
    await expect(
      broker.withHandleMaterial(handle, 'mcp.transport', (material) => {
        expect(material.kind).toBe('bearer');
        expect(material.kind === 'bearer' ? material.secret : '').toBe('broker-secret');
      }),
    ).resolves.toBeUndefined();
  });

  test('fails closed after revocation and expiry', async () => {
    const store = new MemoryMcpCredentialStore();
    await store.put(KEY, {
      version: 1,
      kind: 'bearer',
      secret: 'secret',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const broker = createBuiltinCredentialBrokerV1({ store, now: () => now });
    const handle = await broker.issueForKey(KEY, {
      purpose: 'mcp.transport',
      expiresAt: new Date(now + 30_000).toISOString(),
      revocationRevision: 1,
    });
    broker.revoke(handle.handleId, 1);
    await expect(
      broker.withHandleMaterial(handle, 'mcp.transport', () => undefined),
    ).rejects.toThrow('revoked');

    const fresh = await broker.issueForKey(KEY, { purpose: 'mcp.transport' });
    now += 16 * 60 * 1000;
    await expect(
      broker.withHandleMaterial(fresh, 'mcp.transport', () => undefined),
    ).rejects.toThrow('expired');
  });
});
