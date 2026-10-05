import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { PermissionPolicySnapshot } from '../../src/permissions';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('Default policy fixture deadline');
    await Bun.sleep(10);
  }
}
async function fixture(
  mode: PermissionPolicySnapshot['mode'] | null,
  trusted = true,
  explicit = false,
  afterFinalToolAuthorization?: () => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-permission-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const calls: ({ name: string; input: unknown } | undefined)[] = [
    { name: 'files.write', input: { path: 'output.txt', content: 'exact first', base: null } },
    undefined,
  ];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      const call = calls[requests.length - 1];
      const payload = {
        id: 'response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : { content: 'done' },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...payload,
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: [{ id: 'files.write' }],
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  let policy: PermissionPolicySnapshot = {
    mode: mode ?? 'ask',
    workspaceTrust: trusted,
    revision: 'host-1',
    allowed: [
      { kind: 'model', definitionId: 'local', definitionVersion: '1' },
      { kind: 'tool', definitionId: 'files.write', definitionVersion: '2' },
      { kind: 'tool', definitionId: 'files.read', definitionVersion: '3' },
    ],
  };
  const host = createDefaultProcessConfiguration({
    profile,
    ...(mode === null
      ? {}
      : {
          permissionPolicy: {
            readPolicy() {
              if (explicit) throw new Error('Explicit Permissions must win');
              return policy;
            },
          },
        }),
    ...(explicit
      ? {
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'trusted-explicit-1' };
            },
          },
        }
      : {}),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    store,
    extensions: host.extensions,
    workspaceSerialLocks,
    permissions: host.permissions!,
    resolveRunConfiguration: async (input) => {
      const binding = await host.resolveRunConfiguration!(input);
      if (!afterFinalToolAuthorization) return binding;
      let toolAuthorizations = 0;
      return {
        ...binding,
        permissions: {
          async authorize(request) {
            const decision = await binding.permissions!.authorize(request);
            if (request.kind === 'tool' && ++toolAuthorizations === 2)
              await afterFinalToolAuthorization();
            return decision;
          },
        },
      };
    },
  });
  const management = host.permissionManagement!(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    beforeResourceClose: () => workspaceSerialLocks.close(),
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'default-policy',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions'],
    },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${workspace}`,
  });
  await client.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'root',
  });
  return {
    root,
    workspace,
    configurationPath,
    configuration,
    runtime,
    store,
    client,
    expectedStoreId,
    requests,
    calls,
    management,
    get policy() {
      return policy;
    },
    set policy(value: PermissionPolicySnapshot) {
      policy = value;
    },
    async run(commandId = 'work') {
      return client.startRun('s', {
        expectedStoreId,
        commandId,
        kind: 'run.start',
        content: 'explicit file task',
      });
    },
    async pending() {
      return until(
        async () =>
          (await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async approve(
      card: Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number],
    ) {
      return client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
    },
    async close() {
      client.disposeNetwork();
      try {
        await service.close();
      } finally {
        await provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('actual default-compatible Model file call uses Ask exact card/once or trusted Accept Edits; Full/default untrusted cannot be approved past trust', async () => {
  for (const mode of ['ask', 'accept_edits', 'full', null] as const) {
    const f = await fixture(mode, mode !== 'full');
    try {
      await f.run();
      if (mode === 'ask') {
        const card = await f.pending();
        expect(card.request).toMatchObject({
          input: { path: 'output.txt', content: 'exact first', base: null },
          policy: { mode: 'ask', effects: ['workspace_write'] },
        });
        expect(existsSync(join(f.workspace, 'output.txt'))).toBe(false);
        await f.approve(card);
      }
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      const allowed = mode === 'ask' || mode === 'accept_edits';
      expect(existsSync(join(f.workspace, 'output.txt'))).toBe(allowed);
      if (allowed)
        expect(readFileSync(join(f.workspace, 'output.txt'), 'utf8')).toBe('exact first');
      else
        expect(
          (await f.client.getView('s')).executions.find((execution) => execution.kind === 'tool')!
            .status,
        ).toBe('failed');
      expect(f.requests).toHaveLength(2);
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId, state: 'pending' }))
          .interactions,
      ).toHaveLength(0);
      const original = await f.client.getCommand('work');
      expect(await f.run()).toEqual(original);
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.close();
    }
  }
}, 15000);

test('old default Run keeps actual selected definitions across JSONC disable, while current programmatic policy narrowing blocks its old card', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture('ask');
    try {
      await f.run();
      const card = await f.pending();
      writeFileSync(f.configurationPath, JSON.stringify({ ...f.configuration, tools: [] }));
      if (revoke) f.policy = { ...f.policy, workspaceTrust: false };
      await f.approve(card);
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(existsSync(join(f.workspace, 'output.txt'))).toBe(!revoke);
      expect(
        (await f.client.getInteraction('s', card.id, { storeId: f.expectedStoreId }))
          .acceptedDecisionRevision === null,
      ).toBe(revoke);
      const oldRun = (await f.store.getView('s')).runs[0]!;
      expect(oldRun.configuration).toMatchObject({
        tools: [{ id: 'files.write', version: '2', extensionId: 'builtin.files' }],
      });
      await f.run('new-work');
      await f.runtime.waitForCommand('new-work', { timeoutMs: 5000 });
      const request = f.requests.at(-1)!;
      expect(request.tools ?? []).toHaveLength(0);
      expect((await f.client.getView('s')).runs.at(-1)!.status).toBe('completed');
    } finally {
      await f.close();
    }
  }
}, 15000);

test('explicit trusted Permissions remains prior to new policy; actual builtin versions reject bad new configuration before Provider IO', async () => {
  const explicit = await fixture('ask', false, true);
  try {
    await explicit.run();
    await explicit.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(readFileSync(join(explicit.workspace, 'output.txt'), 'utf8')).toBe('exact first');
    expect(
      (await explicit.client.listInteractions('s', { storeId: explicit.expectedStoreId }))
        .interactions,
    ).toHaveLength(0);
  } finally {
    await explicit.close();
  }
  const version = await fixture('accept_edits');
  try {
    writeFileSync(
      version.configurationPath,
      JSON.stringify({
        ...version.configuration,
        tools: [{ id: 'files.read', definitionVersion: '1' }],
      }),
    );
    await version.run();
    expect((await version.runtime.waitForCommand('work', { timeoutMs: 5000 })).status).toBe(
      'rejected',
    );
    expect(version.requests).toHaveLength(0);
    expect(existsSync(join(version.workspace, 'output.txt'))).toBe(false);
  } finally {
    await version.close();
  }
}, 15000);

async function setManaged(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: PermissionPolicySnapshot['mode'],
) {
  const identity = { expectedStoreId: f.expectedStoreId, subjectId: 'owner' };
  const current = await f.management.readMode({ ...identity, sessionId: 's' });
  await f.management.setMode({
    ...identity,
    sessionId: 's',
    commandId: `mode-${mode}`,
    mode,
    ifRevision: current.revision,
    makeDefault: true,
    ifDefaultRevision: current.defaultRevision,
  });
  const trust = await f.management.readTrust({ ...identity, workspaceId: 'w' });
  await f.management.setTrust({
    ...identity,
    workspaceId: 'w',
    commandId: 'trust-original',
    trusted: true,
    ifRevision: trust.revision,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
  });
  return identity;
}

test('default Runtime freshly reads durable Accept Edits and actual trusted scope before one real file effect', async () => {
  const f = await fixture(null);
  try {
    expect(
      (
        await f.management.readMode({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
        })
      ).mode,
    ).toBe('auto');
    await setManaged(f, 'accept_edits');
    await f.run();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(readFileSync(join(f.workspace, 'output.txt'), 'utf8')).toBe('exact first');
    expect(f.requests).toHaveLength(2);
    expect(
      (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
    ).toHaveLength(0);
    expect(JSON.parse(readFileSync(f.configurationPath, 'utf8'))).toEqual(f.configuration);
    const execution = (await f.client.getView('s')).executions.find(
      (item) => item.kind === 'tool',
    )!;
    expect(execution.status).toBe('succeeded');
    expect(execution.definitionVersion).toBe('2');
  } finally {
    await f.close();
  }
}, 15000);

test('durable trust revocation invalidates old Ask card and explicit host policy cannot be rewritten through management', async () => {
  const f = await fixture(null);
  try {
    const identity = await setManaged(f, 'ask');
    await f.run();
    const card = await f.pending();
    expect(existsSync(join(f.workspace, 'output.txt'))).toBe(false);
    const trust = await f.management.readTrust({ ...identity, workspaceId: 'w' });
    await f.management.setTrust({
      ...identity,
      workspaceId: 'w',
      commandId: 'revoke-trust',
      trusted: false,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    await f.approve(card);
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(existsSync(join(f.workspace, 'output.txt'))).toBe(false);
    const original = await f.client.getInteraction('s', card.id, { storeId: f.expectedStoreId });
    expect(original.acceptedDecisionRevision).toBeNull();
    const execution = (await f.client.getView('s')).executions.find(
      (item) => item.kind === 'tool',
    )!;
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({
      content: 'permission_denied',
      outcome: 'failed',
      details: { adapterAttempted: false, dispatchCommitted: false },
    });
    expect((await f.management.readTrust({ ...identity, workspaceId: 'w' })).trusted).toBe(false);
  } finally {
    await f.close();
  }
  for (const explicit of [false, true]) {
    const external = await fixture('full', true, explicit);
    try {
      const state = await external.management.readMode({
        expectedStoreId: external.expectedStoreId,
        subjectId: 'owner',
        sessionId: 's',
      });
      let error: unknown;
      try {
        await external.management.setMode({
          expectedStoreId: external.expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
          commandId: 'external-write',
          mode: 'ask',
          makeDefault: false,
          ifRevision: state.revision,
          ifDefaultRevision: state.defaultRevision,
        });
      } catch (value) {
        error = value;
      }
      expect((error as { code: string }).code).toBe('permission_authority_external');
    } finally {
      await external.close();
    }
  }
}, 15000);

test('trust CAS after final authorization but before dispatch SQL rejects the exact old proof with zero file I/O', async () => {
  let reached = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(null, true, false, async () => {
    reached = true;
    await gate;
  });
  try {
    const identity = await setManaged(f, 'accept_edits');
    await f.run();
    await until(async () => (reached ? true : null));
    expect(existsSync(join(f.workspace, 'output.txt'))).toBe(false);
    const trust = await f.management.readTrust({ ...identity, workspaceId: 'w' });
    await f.management.setTrust({
      ...identity,
      workspaceId: 'w',
      commandId: 'revoke-final-gap',
      trusted: false,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(existsSync(join(f.workspace, 'output.txt'))).toBe(false);
    const execution = (await f.client.getView('s')).executions.find(
      (item) => item.kind === 'tool',
    )!;
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({
      content: 'permission_control_changed',
      outcome: 'failed',
      details: { adapterAttempted: false, dispatchCommitted: false },
    });
  } finally {
    release();
    await f.close();
  }
}, 15000);
