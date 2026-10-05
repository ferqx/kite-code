import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend, type McpSourceReadSet } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { createMcpOAuthActions } from '../../src/mcp-oauth-actions';
import { McpOAuthSessionError } from '../../src/mcp-oauth-session';

const digest = 'a'.repeat(64);
const readSet: McpSourceReadSet = {
  scopeDigest: digest,
  user: {
    identity: { kind: 'user', pathDigest: digest, rootIdentity: digest },
    etag: digest,
    error: null,
  },
  workspace: null,
  approvalEtag: null,
  bindingEtag: null,
  variablesDigest: digest,
};
const obj = (value: unknown): Record<string, Json> => value as Record<string, Json>;
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(5);
  }
  throw Error('oauth_action_deadline');
}

/** Real public Runtime/Service C/E; only the admitted OAuth protocol target is controlled. */
async function fixture(
  options: {
    outcome?: 'unknown' | 'failed';
    releaseFails?: boolean;
    observer?: string;
    deny?: boolean;
    acquireFault?: boolean;
    defaultSource?: boolean;
    waitForCancel?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-oauth-actions-')));
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  const userSource = join(profile.profilePath, 'mcp.json');
  if (options.defaultSource)
    writeFileSync(
      userSource,
      JSON.stringify({
        mcpServers: {
          owned: { type: 'http', url: 'https://controlled.invalid/mcp', auth: { type: 'oauth' } },
        },
      }),
      { mode: 0o600 },
    );
  let vaultReads = 0,
    vaultWrites = 0,
    vaultRemoves = 0;
  const backend = createTemporaryCredentialBackend();
  const defaultHost = options.defaultSource
    ? createDefaultProcessConfiguration({
        profile,
        observerSubjectId: 'owner',
        credentialBackend: {
          kind: backend.kind,
          async put(id, value) {
            vaultWrites++;
            await backend.put(id, value);
          },
          async resolve(id) {
            vaultReads++;
            return backend.resolve(id);
          },
          async remove(id) {
            vaultRemoves++;
            await backend.remove(id);
          },
        },
        permissionPolicy: {
          readPolicy: (request) => ({
            mode: 'full',
            workspaceTrust: true,
            revision: 'owned-oauth-default',
            allowed: [
              {
                kind: request.kind,
                definitionId: request.definitionId,
                definitionVersion: request.definitionVersion,
              },
            ],
          }),
        },
      })
    : null;
  const locks = defaultHost ? createWorkspaceSerialLocks(profile) : undefined;
  if (locks) defaultHost!.bindWorkspaceSerialLocks!(locks);
  let runtime!: AgentRuntime;
  let resolves = 0,
    statuses = 0,
    effects = 0,
    releases = 0;
  let removed = false;
  const effect = async (signal?: AbortSignal) => {
    effects++;
    if (options.waitForCancel && signal) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new McpOAuthSessionError('mcp_oauth_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (options.outcome)
      throw new McpOAuthSessionError(
        options.outcome === 'unknown'
          ? 'mcp_oauth_publication_unknown'
          : 'mcp_oauth_reauth_required',
      );
  };
  const leaf = createMcpOAuthActions({
    runtime: () => runtime,
    observerSubjectId: options.observer ?? 'owner',
    readSetSchema: { type: 'object' },
    async resolve() {
      resolves++;
      if (removed) throw Error('source_removed');
      return {
        workspaceId: 'w',
        loginAllowed: true,
        async acquire() {
          if (options.acquireFault) {
            const db = new Database(profile.databasePath);
            try {
              db.run('UPDATE command SET request_digest=? WHERE id=?', [
                'b'.repeat(64),
                'original',
              ]);
            } finally {
              db.close();
            }
          }
          return () => {
            releases++;
            if (options.releaseFails) throw Error('owned_release_failure');
          };
        },
        assertFresh() {},
        session: (signal) => ({
          login: () => effect(signal),
          refresh: () => effect(signal),
          clear: () => effect(signal),
          revoke: async () => {
            await effect(signal);
            return 'completed';
          },
          credential: async () => null,
        }),
        async status() {
          statuses++;
          return { policy: 'oauth', status: 'available', credentialPresent: true };
        },
      };
    },
  });
  runtime = createRuntime({
    store,
    ...(locks ? { workspaceSerialLocks: locks } : {}),
    extensions: defaultHost?.extensions ?? [
      { id: 'builtin.mcp.sources', version: '1', apiMajor: 1, ...leaf },
    ],
    ...(defaultHost
      ? {
          conditions: defaultHost.conditions,
          initializeRunRequirements: defaultHost.initializeRunRequirements,
          resolveRunConfiguration: defaultHost.resolveRunConfiguration,
        }
      : {}),
    permissions: defaultHost?.permissions ?? {
      async authorize() {
        return { allowed: !options.deny, revision: 'owned-oauth' };
      },
    },
  });
  defaultHost?.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'owned',
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    subjectId: 'owner',
    buildId: 'oauth-actions-owned',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['extension_queries', 'extensions_actions'],
    },
  });
  await client.connect();
  return {
    root,
    profile,
    store,
    runtime,
    client,
    storeId,
    counts: () => ({ resolves, statuses, effects, releases }),
    vaultCounts: () => ({ vaultReads, vaultWrites, vaultRemoves }),
    removeSource() {
      removed = true;
      if (options.defaultSource) rmSync(userSource);
      rmSync(workspace, { recursive: true });
    },
    async invoke(actionId = 'mcp.auth.clear') {
      let input: Json = {
        serverId: `mcp-${digest}`,
        expectedReadSet: JSON.parse(JSON.stringify(readSet)),
      };
      if (options.defaultSource) {
        const view = await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {});
        const payload = obj(view[0]!.payload),
          entry = obj((payload.items as Json[])[0]);
        input = { serverId: entry.id!, expectedReadSet: payload.readSet! };
      }
      await client.invokeExtension('s', {
        kind: 'extension.invoke',
        expectedStoreId: storeId,
        commandId: 'original',
        extensionId: 'builtin.mcp.sources',
        actionId,
        definitionVersion: '1',
        input,
      });
      return until(async () => {
        const command = await runtime.getCommand('original');
        const id = obj(command?.receipt).executionId;
        if (typeof id !== 'string') return null;
        const execution = await runtime.getExecution(id);
        return execution && !['planned', 'dispatching', 'running'].includes(execution.status)
          ? { command: command!, execution }
          : null;
      });
    },
    async history() {
      const value = await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.auth.result', {
        commandId: 'original',
      });
      expect(value).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(16384);
      expect(value[0]!.artifactRefs).toEqual([]);
      expect(value[0]!.actions).toEqual([]);
      return obj(value[0]!.payload);
    },
    rawHistory() {
      return runtime.queryExtension({
        sessionId: 's',
        extensionId: 'builtin.mcp.sources',
        queryId: 'mcp.auth.result',
        input: { commandId: 'original' },
        subjectId: 'owner',
        expectedStoreId: storeId,
      });
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await locks?.close();
      await store.close();
      rmSync(root, { recursive: true });
    },
  };
}

test('ordinary auth Action original C/E proof survives removed source and Workspace with GET-only history', async () => {
  const f = await fixture();
  try {
    const original = await f.invoke();
    expect(original.execution.kind).toBe('job');
    expect(original.execution.runId).toBeNull();
    expect(original.execution.parentExecutionId).toBeNull();
    expect(original.execution.originCommandId).toBe('original');
    expect(original.execution.status).toBe('succeeded');
    const before = await f.store.getMetadata();
    const counts = f.counts();
    f.removeSource();
    const result = await f.history();
    expect(result.phase).toBe('completed');
    expect(result.authStatus).toBe('revoked');
    expect(result.effectAttempted).toBe(true);
    expect(obj(result.execution).id).toBe(original.execution.id);
    expect(f.counts()).toEqual(counts);
    expect(await f.store.getMetadata()).toEqual(before);
    expect((await f.runtime.getView('s')).runs).toEqual([]);
  } finally {
    await f.close();
  }
}, 10000);

for (const action of ['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.revoke'])
  test(`ordinary ${action} publishes only its original scoped result`, async () => {
    const f = await fixture();
    try {
      const original = await f.invoke(action);
      expect(original.execution.definitionId).toBe(`builtin.mcp.sources/${action}`);
      expect(original.execution.originStoreId).toBe(f.storeId);
      const result = await f.history();
      expect(result.phase).toBe('completed');
      expect(result.authStatus).toBe(action === 'mcp.auth.revoke' ? 'revoked' : 'authenticated');
      expect(f.counts()).toEqual({ resolves: 1, statuses: 0, effects: 1, releases: 1 });
    } finally {
      await f.close();
    }
  }, 10000);

test('original Command digest drift while acquiring coordinator refuses before OAuth effect', async () => {
  const f = await fixture({ acquireFault: true });
  try {
    const original = await f.invoke();
    expect(original.execution.status).toBe('failed');
    expect(f.counts()).toEqual({ resolves: 1, statuses: 0, effects: 0, releases: 1 });
  } finally {
    await f.close();
  }
}, 10000);

test('ordinary permission denial never reaches OAuth target', async () => {
  const f = await fixture({ deny: true });
  try {
    const original = await f.invoke();
    expect(original.execution.status).toBe('failed');
    expect(f.counts()).toEqual({ resolves: 0, statuses: 0, effects: 0, releases: 0 });
    expect((await f.runtime.getView('s')).runs).toEqual([]);
  } finally {
    await f.close();
  }
}, 10000);

test('ordinary original Command cancellation reaches its admitted OAuth signal and releases coordinator', async () => {
  const f = await fixture({ waitForCancel: true });
  try {
    const work = f.invoke('mcp.auth.login');
    await until(async () => (f.counts().effects === 1 ? true : null));
    const pending = await f.history();
    expect(pending.phase).toBe('pending');
    expect(pending.authStatus).toBe('unknown');
    await f.client.cancelCommand('s', {
      kind: 'command.cancel',
      expectedStoreId: f.storeId,
      commandId: 'cancel-original',
      targetCommandId: 'original',
    });
    const original = await work;
    expect(original.execution.status).toBe('cancelled');
    const result = await f.history();
    expect(result.phase).toBe('cancelled');
    expect(result.authStatus).toBe('cancelled');
    expect(result.effectAttempted).toBe(true);
    expect(f.counts()).toEqual({ resolves: 1, statuses: 0, effects: 1, releases: 1 });
  } finally {
    await f.close();
  }
}, 10000);

for (const outcome of ['unknown', 'failed'] as const)
  test(`auth ${outcome} preserves original effect attempt and independent status`, async () => {
    const f = await fixture({ outcome });
    try {
      await f.invoke();
      const result = await f.history();
      expect(result.phase).toBe(outcome === 'unknown' ? 'outcome_unknown' : 'failed');
      expect(result.effectAttempted).toBe(true);
      expect(result.authStatus).toBe(outcome === 'unknown' ? 'unknown' : 'reauth_required');
      expect(f.counts()).toEqual({ resolves: 1, statuses: 0, effects: 1, releases: 1 });
    } finally {
      await f.close();
    }
  }, 10000);

for (const fault of [
  'finalization',
  'input',
  'parent',
  'missing_execution',
  'command_kind',
  'request_digest',
] as const)
  test(`history refuses applied Command with ${fault} proof fault`, async () => {
    const f = await fixture();
    try {
      const original = await f.invoke();
      const db = new Database(f.profile.databasePath);
      try {
        if (fault === 'finalization') {
          const receipt = obj(original.command.receipt);
          db.run('UPDATE command SET receipt_json=? WHERE id=?', [
            JSON.stringify({ ...receipt, finalizationDigest: 'b'.repeat(64) }),
            'original',
          ]);
        } else if (fault === 'input')
          db.run('UPDATE execution SET intent_json=? WHERE id=?', ['{}', original.execution.id]);
        else if (fault === 'parent')
          db.run('UPDATE execution SET parent_execution_id=? WHERE id=?', [
            original.execution.id,
            original.execution.id,
          ]);
        else if (fault === 'command_kind')
          db.run('UPDATE command SET kind=? WHERE id=?', ['input.followup', 'original']);
        else if (fault === 'request_digest')
          db.run('UPDATE command SET request_digest=? WHERE id=?', ['b'.repeat(64), 'original']);
        else {
          const receipt = obj(original.command.receipt);
          db.run('UPDATE command SET receipt_json=? WHERE id=?', [
            JSON.stringify({ ...receipt, executionId: 'missing' }),
            'original',
          ]);
        }
      } finally {
        db.close();
      }
      const counts = f.counts();
      try {
        if (fault === 'request_digest' || fault === 'command_kind') {
          let rejected: unknown;
          try {
            await f.rawHistory();
          } catch (error) {
            rejected = error;
          }
          expect(rejected).toMatchObject({ code: 'operation_unverifiable' });
        } else expect((await f.history()).phase).toBe('outcome_unknown');
        expect(f.counts()).toEqual(counts);
      } finally {
        // Remove only this fixture's deliberate corruption before normal Runtime shutdown.
        const db = new Database(f.profile.databasePath);
        try {
          db.run('UPDATE command SET kind=?,request_digest=?,receipt_json=? WHERE id=?', [
            original.command.kind,
            original.command.requestDigest,
            JSON.stringify(original.command.receipt),
            'original',
          ]);
          db.run('UPDATE execution SET intent_json=?,parent_execution_id=? WHERE id=?', [
            JSON.stringify(original.execution.input),
            original.execution.parentExecutionId,
            original.execution.id,
          ]);
        } finally {
          db.close();
        }
      }
    } finally {
      await f.close();
    }
  }, 10000);

test('wrong trusted observer never resolves or attempts OAuth effect', async () => {
  const f = await fixture({ observer: 'other' });
  try {
    await f.invoke();
    expect((await f.history()).phase).toBe('outcome_unknown');
    expect(f.counts()).toEqual({ resolves: 0, statuses: 0, effects: 0, releases: 0 });
  } finally {
    await f.close();
  }
}, 10000);

test('post-effect owned release error must retain outcome_unknown and effectAttempted', async () => {
  const f = await fixture({ releaseFails: true });
  try {
    const original = await f.invoke();
    expect(f.counts()).toEqual({ resolves: 1, statuses: 0, effects: 1, releases: 1 });
    expect(original.execution.status).toBe('outcome_unknown');
    const result = await f.history();
    expect(result.phase).toBe('outcome_unknown');
    expect(result.effectAttempted).toBe(true);
  } finally {
    await f.close();
  }
}, 10000);

test('actual default Source OAuth clear uses shared vault and historical result reads no source or vault', async () => {
  const f = await fixture({ defaultSource: true });
  try {
    const original = await f.invoke();
    expect(obj(original.execution.result).content).toBe('mcp_oauth_credentials_cleared');
    expect(original.execution.status).toBe('succeeded');
    expect(f.vaultCounts().vaultRemoves).toBe(1);
    expect(f.vaultCounts().vaultWrites).toBe(0);
    const before = await f.store.getMetadata(),
      counts = f.vaultCounts();
    f.removeSource();
    const result = await f.history();
    expect(result.phase).toBe('completed');
    expect(result.authStatus).toBe('revoked');
    expect(result.effectAttempted).toBe(true);
    expect(f.vaultCounts()).toEqual(counts);
    expect(await f.store.getMetadata()).toEqual(before);
    expect((await f.runtime.getView('s')).runs).toEqual([]);
  } finally {
    await f.close();
  }
}, 10000);
