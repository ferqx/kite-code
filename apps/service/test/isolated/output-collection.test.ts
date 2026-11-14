import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime, prepareOutputDirectory } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type {
  AuthorizationRequest,
  JobDefinition,
  JobHandle,
  PermissionDecision,
} from '@kite-ai/agent/extensions';
import type { PermissionMode } from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createShellExtension } from '@kite-ai/agent/shell';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { AgentClient } from '@kite-ai/client';
import { launchIdentityAsync } from '../../../../packages/agent/src/jobs/launch-identity';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createPermissionManagement } from '../../src/permission-management';

type Fault = 'forged-operation' | 'wrong-attempt' | 'revoke-trust' | 'injected-deny';
async function fixture(mode: PermissionMode, fault?: Fault) {
  const root = await mkdtemp(join(tmpdir(), 'kite-default-output-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const base = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  let runtime!: AgentRuntime;
  let management!: ReturnType<typeof createPermissionManagement>;
  let starts = 0;
  let revoked = false;
  const decisions: PermissionDecision[] = [];
  const probes: PermissionDecision[] = [];
  const tasks = new WeakMap<JobHandle, Promise<number>>();
  // Only the producer is a subprocess fixture. The collector registration and
  // runless authorizer below are the real default Service composition.
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Exact fixture producer',
    inputSchema: { type: 'object' },
    async start(input, context) {
      starts++;
      const directory = await mkdtemp(join(root, 'producer-'));
      const allocation = await runtime.prepareOutputCollection(
        context,
        await launchIdentityAsync(directory),
      );
      const handle = { reference: {} };
      tasks.set(
        handle,
        new Promise((resolve, reject) => {
          const process = spawn('/bin/bash', ['-c', (input as { command: string }).command], {
            env: { ...globalThis.process.env, ...allocation.env },
            stdio: 'ignore',
          });
          process.once('error', reject);
          process.once('exit', (code) => resolve(code ?? 1));
        }),
      );
      return handle;
    },
    async *observe(handle) {
      const code = await tasks.get(handle);
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: code === 0 ? 'succeeded' : 'failed',
          content: 'created',
          details: { exitCode: code ?? 1, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'unknown' };
    },
    async dispose() {},
  };
  const shell = createShellExtension({ job });
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: createTemporaryCredentialBackend(),
    ...(fault === 'injected-deny'
      ? {
          permissions: {
            async authorize(request: AuthorizationRequest) {
              return request.definitionId === 'builtin.files/collect'
                ? {
                    allowed: false as const,
                    revision: 'injected-ceiling',
                    reason: 'fixture_collector_denied',
                  }
                : { allowed: true as const, revision: 'injected-ceiling' };
            },
          },
        }
      : {}),
  });
  const extensions = host.extensions!.map((extension) => {
    if (
      extension.id !== 'builtin.files' ||
      !['forged-operation', 'wrong-attempt'].includes(fault ?? '')
    )
      return extension;
    return {
      ...extension,
      actions: extension.actions!.map((action) =>
        action.id !== 'collect-outputs'
          ? action
          : {
              ...action,
              async execute(
                input: Parameters<typeof action.execute>[0],
                context: Parameters<typeof action.execute>[1],
              ) {
                const v = input as { collectionId: string; attempt: number };
                await context.operations.ensure({
                  key:
                    fault === 'forged-operation'
                      ? 'forged-collector'
                      : `collect/${v.collectionId}/${v.attempt}`,
                  cancellation: 'detached',
                  request: {
                    kind: 'job',
                    definitionId: 'builtin.files/collect',
                    definitionVersion: '1',
                    input: fault === 'wrong-attempt' ? { ...v, attempt: v.attempt + 1 } : input,
                  },
                });
                return { outcome: 'succeeded' as const, content: 'fixture_forged' };
              },
            },
      ),
    };
  });
  const finish = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  } as const;
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        name: 'shell_execute',
        id: 'produce',
        arguments: JSON.stringify({ command: 'printf report > "$KITE_OUTPUT_DIR/report.txt"' }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Done' }, finish],
  ]);
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ store, profile }),
    extensions,
    outputCollections: {
      prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
    },
    permissions: {
      async authorize(request) {
        if (request.definitionId === 'builtin.files/collect') {
          if (fault === 'revoke-trust' && !revoked) {
            revoked = true;
            const trust = await management.readTrust({ ...base, workspaceId: 'w' });
            await management.setTrust({
              ...base,
              workspaceId: 'w',
              commandId: 'revoke-trust',
              trusted: false,
              ifRevision: trust.revision,
              canonicalIdentity: trust.canonicalIdentity,
              externalReadScopeDigest: trust.externalReadScopeDigest,
            });
          }
          if (!fault && !probes.length) {
            probes.push(
              await host.permissions!.authorize({
                ...request,
                input: { ...(request.input as object), attempt: 999 },
              }),
            );
            probes.push(await host.permissions!.authorize({ ...request, runId: 'forged-run' }));
            const view = await store.getView('s');
            const producer = view.executions.find((e) => e.definitionId === 'shell.command')!;
            probes.push(
              await host.permissions!.authorize({ ...request, executionId: producer.id }),
            );
          }
          const decision = await host.permissions!.authorize(request);
          decisions.push(decision);
          return decision;
        }
        return host.permissions!.authorize(request);
      },
    },
    // Fixed model and producer are the only Run capabilities in this fixture.
    // The collector must leave this Run and pass the unchanged global policy.
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      snapshot: {},
      extensions: [shell],
      toolIds: ['shell.execute'],
      permissions: {
        async authorize(request) {
          const allowed =
            (request.kind === 'model' && request.definitionId === 'fixed') ||
            (request.kind === 'tool' && request.definitionId === 'shell.execute') ||
            (request.kind === 'job' && request.definitionId === 'shell.command');
          return { allowed, revision: 'exact-fixture-producer' };
        },
      },
    }),
  });
  management = host.permissionManagement!(runtime);
  await runtime.createWorkspace({
    expectedStoreId: base.expectedStoreId,
    id: 'w',
    name: 'work',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'outputs' });
  // Use the actual current controls, including when an injected authority is a ceiling.
  const controls = createPermissionManagement({ runtime, profile });
  const state = await controls.readMode(base);
  await controls.setMode({
    ...base,
    commandId: 'mode',
    mode,
    makeDefault: false,
    ifRevision: state.revision,
    ifDefaultRevision: state.defaultRevision,
  });
  const trust = await controls.readTrust({ ...base, workspaceId: 'w' });
  await controls.setTrust({
    ...base,
    workspaceId: 'w',
    commandId: 'trust',
    trusted: true,
    ifRevision: trust.revision,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
  });
  const service = await startService({
    runtime,
    subjectId: 'owner',
    buildId: 'default-output-fixture',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    permissionManagement: management,
  });
  const client = new AgentClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      apiMajor: 1,
      requiredCapabilities: ['commands', 'output_files'],
    },
  });
  await client.connect();
  return {
    runtime,
    store,
    base,
    model,
    client,
    decisions,
    probes,
    get starts() {
      return starts;
    },
    async run() {
      await client.startRun('s', {
        expectedStoreId: base.expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: 'Create report',
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
    },
    async wait() {
      for (let i = 0; i < 500; i++) {
        const view = await store.getView('s');
        const collector = view.executions.find((e) => e.definitionId === 'builtin.files/collect');
        if (collector && ['succeeded', 'failed'].includes(collector.status))
          return {
            view,
            collector,
            page: await client.queryOutputFiles({
              scope: { storeId: base.expectedStoreId, sessionId: 's' },
            }),
          };
        await Bun.sleep(10);
      }
      throw new Error(JSON.stringify(await store.getView('s')));
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const mode of ['auto', 'accept_edits', 'full'] as const)
  test(`default Service ${mode} archives the proven host collector without extra model or approval`, async () => {
    const f = await fixture(mode);
    try {
      await f.run();
      const { page, collector } = await f.wait();
      expect(collector.status).toBe('succeeded');
      expect(page.items).toHaveLength(1);
      expect(page.collections[0]?.state).toBe('ready');
      expect(
        (await f.client.listInteractions('s', { storeId: f.base.expectedStoreId })).interactions,
      ).toEqual([]);
      expect(f.model.requests).toHaveLength(2);
      expect(f.starts).toBe(1);
      expect(f.decisions.length).toBeGreaterThanOrEqual(2);
      expect(f.decisions.every((d) => d.allowed === true)).toBe(true);
      expect(f.probes).toHaveLength(3);
      expect(f.probes.every((d) => d.allowed === false)).toBe(true);
      const result = await f.client.readOutputFileStream(page.items[0]!);
      let bytes = '';
      try {
        for await (const chunk of result.content) bytes += new TextDecoder().decode(chunk);
      } finally {
        await result.cancel();
      }
      expect(bytes).toBe('report');
    } finally {
      await f.close();
    }
  }, 20000);

for (const fault of ['forged-operation', 'wrong-attempt', 'revoke-trust', 'injected-deny'] as const)
  test(`default Service rejects ${fault} before collector dispatch`, async () => {
    const f = await fixture(fault === 'injected-deny' ? 'full' : 'auto', fault);
    try {
      await f.run();
      const { page, collector } = await f.wait();
      expect(collector.status).toBe('failed');
      expect(collector.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'permission_denied', adapterAttempted: false },
      });
      expect(page.items).toEqual([]);
      expect(f.decisions.every((d) => d.allowed === false)).toBe(true);
      expect(f.model.requests).toHaveLength(2);
      expect(f.starts).toBe(1);
      if (fault === 'revoke-trust' || fault === 'injected-deny') {
        expect(page.collections[0]).toMatchObject({
          state: 'failed',
          errorCode: 'output_collection_permission_denied',
          publishedCount: 0,
          expectedCount: null,
        });
        expect(page.collections[0]?.retryUntil).toBeUndefined();
        await expect(
          f.runtime.retryOutputCollection({
            ...f.base,
            collectionId: page.collections[0]!.collectionId,
            expectedRevision: page.collections[0]!.revision,
          }),
        ).rejects.toMatchObject({ code: 'output_retry_unavailable' });
      }
    } finally {
      await f.close();
    }
  }, 20000);
