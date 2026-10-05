import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { type PlanningOptions, planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';

const policy: NonNullable<PlanningOptions['automaticValidation']> = {
  mutations: [
    { definitionId: 'files.write', definitionVersion: '2', effects: ['workspace_write'] },
    { definitionId: 'files.edit', definitionVersion: '2', effects: ['workspace_write'] },
  ],
  fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
};
type Call = { name: string; input: Json } | null;
async function fixture(options: {
  enabled?: boolean;
  automaticValidation?: NonNullable<PlanningOptions['automaticValidation']>;
  tools?: string[];
  script?: (step: number, f: Fixture) => Promise<Call>;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-automatic-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      const call = options.script
        ? await options.script(requests.length - 1, f)
        : requests.length === 1
          ? { name: 'files.write', input: { path: 'result.txt', content: 'first', base: null } }
          : null;
      const chunk = {
        id: 'local',
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
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input),
                      },
                    },
                  ],
                }
              : { content: 'finished' },
            finish_reason: null,
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const tools = options.tools ?? ['files.write', 'files.read', 'validation.auto_check'];
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [
        {
          id: 'local',
          provider: 'compatible',
          model: 'local',
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
        },
      ],
      tools: tools.map((id) => ({
        id,
        definitionVersion: id === 'files.read' ? '3' : id === 'files.write' ? '2' : '1',
      })),
      // This document is deliberately not an authority to enable requirements.
      planning: { automaticValidation: policy },
    }),
  );
  const trustedPolicy = structuredClone(options.automaticValidation ?? policy);
  let host = createDefaultProcessConfiguration({
    profile,
    ...(options.enabled === false ? {} : { planning: { automaticValidation: trustedPolicy } }),
  });
  // The actual per-Run sealed policy must survive later changes to caller-owned data.
  (trustedPolicy.mutations as unknown as unknown[]).length = 0;
  trustedPolicy.fileHashChecker.definitionVersion = 'wrong';
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    workspaceSerialLocks,
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: (input) => host.resolveRunConfiguration!(input),
    modelConcurrency: 1,
  });
  let management = host.permissionManagement!(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'automatic',
  });
  const mode = await management.readMode(base);
  await management.setMode({
    ...base,
    commandId: 'mode',
    mode: 'full',
    ifRevision: mode.revision,
    makeDefault: false,
    ifDefaultRevision: mode.defaultRevision,
  });
  const trust = await management.readTrust({ ...base, workspaceId: 'w' });
  await management.setTrust({
    ...base,
    workspaceId: 'w',
    commandId: 'trust',
    trusted: true,
    ifRevision: trust.revision,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
  });
  const f = {
    root,
    workspace,
    requests,
    runtime,
    store,
    base,
    async runId() {
      return (
        (await store.listExecutions('s')).find(
          (x) => x.originCommandId === 'work' && x.runId !== null,
        )?.runId ?? null
      );
    },
    async head() {
      const runId = await f.runId();
      return runId
        ? store.getExtensionRecord({
            sessionId: 's',
            extensionId: planningExtensionId,
            key: `run/${runId}/mutation.current`,
          })
        : null;
    },
    async submit() {
      return runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'real governed file work' },
      });
    },
    async done() {
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      return store.getRun((await f.runId())!);
    },
    unload() {
      host = createDefaultProcessConfiguration({ profile });
      management = host.permissionManagement!(runtime);
    },
    async revoke() {
      const observed = await management.readTrust({ ...base, workspaceId: 'w' });
      return management.setTrust({
        ...base,
        workspaceId: 'w',
        commandId: 'revoke',
        trusted: false,
        ifRevision: observed.revision,
        canonicalIdentity: observed.canonicalIdentity,
        externalReadScopeDigest: observed.externalReadScopeDigest,
      });
    },
    async close() {
      await runtime.close();
      await workspaceSerialLocks.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('trusted automatic validation initializes without plan flags, runs the real selected nested checker and seals caller-independent mapping', async () => {
  const f = await fixture({
    script: async (step, current): Promise<Call> => {
      if (step === 0) {
        const run = await current.store.getRun((await current.runId())!);
        expect(run!.requirements.some((value) => value.requirementId === 'mutation.required')).toBe(
          true,
        );
        expect(
          await current.store.getExtensionRecord({
            sessionId: 's',
            extensionId: planningExtensionId,
            key: `run/${run!.id}/mutation.required`,
          }),
        ).not.toBeNull();
        return { name: 'files.write', input: { path: 'result.txt', content: 'first', base: null } };
      }
      return null;
    },
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run?.status).toBe('completed');
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('first');
    const executions = await f.store.listExecutions('s');
    expect(
      executions.filter(
        (x) => x.definitionId === 'validation.auto_check' && x.status === 'succeeded',
      ),
    ).toHaveLength(1);
    const read = executions.find((x) => x.definitionId === 'files.read')!;
    const check = executions.find((x) => x.definitionId === 'validation.auto_check')!;
    expect(read.status).toBe('succeeded');
    expect(read.parentExecutionId).toBe(check.id);
    expect(read.definitionVersion).toBe('3');
    const configuration = run!.configuration as Record<string, Json>;
    const planning = (configuration.snapshot as Record<string, Json>).planning as Record<
      string,
      Json
    >;
    expect(planning.requirePlan).toBe(false);
    expect(planning.requiredValidation).toBe(false);
    expect((planning.automaticValidation as Record<string, Json>).fileHashChecker).toEqual(
      policy.fileHashChecker,
    );
    expect((planning.automaticValidation as Record<string, Json>).selected).toMatchObject({
      checker: true,
      autoCheck: true,
      mutations: [
        {
          definitionId: 'files.write',
          definitionVersion: '2',
          effects: ['workspace_write'],
          actualEffects: ['workspace_write'],
          selected: true,
        },
        {
          definitionId: 'files.edit',
          definitionVersion: '2',
          selected: false,
          actualEffects: null,
        },
      ],
    });
    const obligation = run!.requirements.find((x) => x.requirementId === 'mutation.required')!;
    expect(obligation.originStoreId).toBe(f.base.expectedStoreId);
    const record = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: planningExtensionId,
      key: obligation.recordKey,
    });
    expect((record!.value as Record<string, Json>).definitions).toEqual(
      policy.mutations.map((x) => ({
        id: x.definitionId,
        version: x.definitionVersion,
        effects: [...x.effects],
      })),
    );
    expect((await f.head())!.value).toMatchObject({ lastOutcome: 'passed' });
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('default off ignores JSONC governance and ordinary chat has no mutation obligation', async () => {
  const f = await fixture({ enabled: false, tools: [], script: async () => null });
  try {
    await f.submit();
    const run = await f.done();
    expect(run?.status).toBe('completed');
    expect(run?.requirements).toHaveLength(0);
    expect(
      ((run!.configuration as Record<string, Json>).snapshot as Record<string, Json>).planning,
    ).toMatchObject({
      automaticValidation: null,
    });
    expect(await f.head()).toBeNull();
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('missing selected checker stays inconclusive and unloading the factory cannot erase the original required policy', async () => {
  const f = await fixture({
    tools: ['files.write', 'validation.auto_check'],
    script: async (step, current): Promise<Call> => {
      if (step === 0)
        return { name: 'files.write', input: { path: 'result.txt', content: 'first', base: null } };
      if (step === 2) current.unload();
      return null;
    },
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run?.status).not.toBe('completed');
    expect(run?.requirements.some((x) => x.requirementId === 'mutation.required')).toBe(true);
    expect((await f.head())!.value).toMatchObject({ lastOutcome: 'inconclusive' });
    expect(
      (await f.store.listExecutions('s')).filter(
        (x) => x.definitionId === 'files.read' && x.status === 'succeeded',
      ),
    ).toHaveLength(0);
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('first');
  } finally {
    await f.close();
  }
});

test('a second mutation invalidates the first passed head and requires another original-scope check', async () => {
  let passedRevision: string | null = null;
  const f = await fixture({
    script: async (step, current): Promise<Call> => {
      if (step === 0)
        return { name: 'files.write', input: { path: 'result.txt', content: 'first', base: null } };
      if (step === 1) {
        const executions = await current.store.listExecutions('s');
        const runId = (await current.runId())!;
        const head = (await current.head())!;
        return {
          name: 'validation.auto_check',
          input: {
            runId,
            mutationExecutionId: executions.find((x) => x.definitionId === 'files.write')!.id,
            headRevision: head.revision,
            seq: '1',
          },
        };
      }
      if (step === 2) {
        const head = (await current.head())!;
        expect(head.value).toMatchObject({ lastOutcome: 'passed' });
        passedRevision = head.revision;
        const executions = await current.store.listExecutions('s');
        const body = JSON.parse(
          String(
            (
              executions.find((x) => x.definitionId === 'files.write')!.result as Record<
                string,
                Json
              >
            ).content,
          ),
        ) as Record<string, Json>;
        return {
          name: 'files.write',
          input: { path: 'result.txt', content: 'second', base: body.baseline! },
        };
      }
      if (step === 3) {
        const head = (await current.head())!;
        expect(head.revision).not.toBe(passedRevision);
        expect((head.value as Record<string, Json>).lastOutcome).not.toBe('passed');
      }
      return null;
    },
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run?.status).toBe('completed');
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('second');
    const executions = await f.store.listExecutions('s');
    expect(
      executions.filter(
        (x) => x.definitionId === 'validation.auto_check' && x.status === 'succeeded',
      ),
    ).toHaveLength(2);
    expect(
      executions.filter((x) => x.definitionId === 'files.read' && x.status === 'succeeded'),
    ).toHaveLength(2);
    expect((await f.head())!.value).toMatchObject({ lastOutcome: 'passed', checkedThrough: '2' });
  } finally {
    await f.close();
  }
});

test('revoking persistent trust after the actual mutation denies the checker and never records a passed result', async () => {
  const f = await fixture({
    script: async (step, current): Promise<Call> => {
      if (step === 0)
        return { name: 'files.write', input: { path: 'result.txt', content: 'first', base: null } };
      if (step === 1) await current.revoke();
      return null;
    },
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run?.status).not.toBe('completed');
    expect(run?.requirements.some((x) => x.requirementId === 'mutation.required')).toBe(true);
    expect(readFileSync(join(f.workspace, 'result.txt'), 'utf8')).toBe('first');
    const executions = await f.store.listExecutions('s');
    expect(
      executions.filter((x) => x.definitionId === 'files.read' && x.status === 'succeeded'),
    ).toHaveLength(0);
    expect(
      executions.filter(
        (x) => x.definitionId === 'validation.auto_check' && x.status === 'succeeded',
      ),
    ).toHaveLength(0);
    expect((await f.head())!.value).not.toMatchObject({ lastOutcome: 'passed' });
    expect(
      (await f.store.listInteractions({ expectedStoreId: f.base.expectedStoreId, sessionId: 's' }))
        .interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a selected mutation with a mismatched host definition or effect cannot silently bypass its obligation', async () => {
  for (const mutation of [
    { definitionId: 'files.write', definitionVersion: '1', effects: ['workspace_write'] as const },
    { definitionId: 'files.write', definitionVersion: '2', effects: ['unknown'] as const },
  ]) {
    const f = await fixture({
      automaticValidation: { mutations: [mutation], fileHashChecker: policy.fileHashChecker },
    });
    try {
      await f.submit();
      const command = await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(command.status).toBe('rejected');
      expect(command.receipt).toMatchObject({
        reason: 'automatic_validation_definition_unavailable',
      });
      expect(f.requests).toHaveLength(0);
      expect(await f.runId()).toBeNull();
    } finally {
      await f.close();
    }
  }
});
