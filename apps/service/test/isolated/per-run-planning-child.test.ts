import { Database } from 'bun:sqlite';
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
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { PermissionMode } from '../../src/permissions';

const intent = {
  extensionId: planningExtensionId,
  definitionVersion: '1',
  input: { mode: 'plan' },
};
type Call = { name: string; input: Json } | null;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('per_run_plan_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  scenario:
    | 'pending_task'
    | 'pending_job'
    | 'approved'
    | 'ask'
    | 'untrusted'
    | 'head_drift'
    | 'proof_drift'
    | 'next'
    | 'cas_drift',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-per-run-plan-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'original.txt'), 'original Chinese 中文');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'plan' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const normal: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  let step = 0;
  const modelSteps = new Map<string, number>();
  let workId = 'work';
  let mode: PermissionMode = 'full';
  let trusted = true;
  let revision = 0;
  let credentialReads = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>;
      const messages = body.messages as { role: string; content: unknown }[];
      let review = false;
      try {
        const content = messages
          .slice()
          .reverse()
          .find((message) => message.role === 'user')?.content;
        review = JSON.parse(String(content)).purpose === 'authorization_review';
      } catch {}
      const call: Call = review
        ? null
        : await script(String(body.model), modelSteps.get(String(body.model)) ?? 0, f);
      if (!review) {
        modelSteps.set(String(body.model), (modelSteps.get(String(body.model)) ?? 0) + 1);
        step++;
      }
      if (review) reviews.push(body);
      else normal.push(body);
      const chunk = {
        id: `response-${normal.length}-${reviews.length}`,
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
                      id: `call-${workId}-${step}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : {
                  content: review
                    ? JSON.stringify({ decision: 'ask_user', reason: 'independent original call' })
                    : 'finished',
                },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const credentialBackend = {
    kind: 'temporary' as const,
    put: async () => {},
    remove: async () => {},
    resolve: async () => {
      credentialReads++;
      return 'owned-fixture-secret';
    },
  };
  const configuration = {
    modelId: 'parent',
    models: ['parent', 'child'].map((id) => ({
      id,
      provider: 'compatible',
      model: id,
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
    })),
    tools: [
      { id: 'files.read', definitionVersion: '3' },
      { id: 'files.write', definitionVersion: '2' },
      ...['task', 'task_wait', 'task_read'].map((id) => ({ id, definitionVersion: '1' })),
      ...(scenario === 'pending_job'
        ? ['shell.launch', 'validation.define', 'validation.check'].map((id) => ({
            id,
            definitionVersion: '1',
          }))
        : []),
    ],
  };
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend,
    child: [
      { id: 'worker', version: '1', modelId: 'child', toolIds: ['files.read', 'files.write'] },
    ],
    ...(scenario === 'pending_job'
      ? {
          planning: {
            requiredValidation: true,
            commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
          },
          shell: {
            platform: 'darwin' as const,
            configurationId: 'plan-child-shell',
            env: { PATH: '/usr/bin:/bin' },
            supervisorPath: fileURLToPath(
              new URL(
                '../../../../packages/agent/dist/platform/process/shell-supervisor.js',
                import.meta.url,
              ),
            ),
            bunExecutable: process.execPath,
            shellExecutable: '/bin/sh',
          },
        }
      : {}),
    permissionPolicy: {
      readPolicy: () => ({
        mode,
        workspaceTrust: trusted,
        revision: `current-policy-${revision}`,
        allowed: [
          ...['parent', 'child'].map((id) => ({
            kind: 'model' as const,
            definitionId: id,
            definitionVersion: '1',
          })),
          ...[
            'task',
            'task_wait',
            'task_read',
            'shell.launch',
            'validation.define',
            'validation.check',
          ].map((id) => ({ kind: 'tool' as const, definitionId: id, definitionVersion: '1' })),
          { kind: 'job', definitionId: 'agent/worker', definitionVersion: '1' },
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'files.read', definitionVersion: '3' },
          { kind: 'tool', definitionId: 'files.write', definitionVersion: '2' },
          ...['planning.read', 'planning.write', 'planning.review', 'planning.update'].map(
            (id) => ({
              kind: 'tool' as const,
              definitionId: id,
              definitionVersion: '1',
            }),
          ),
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const casReads: string[] = [];
  let casExecutionId: string | null = null;
  const observedStore = new Proxy(store, {
    get(target, property) {
      if (property !== 'markDispatching') return Reflect.get(target, property);
      return async (input: Parameters<typeof store.markDispatching>[0]) => {
        const actual = await store.getExecution(input.executionId);
        if (
          scenario === 'cas_drift' &&
          casExecutionId === null &&
          actual?.sessionId !== 's' &&
          actual?.definitionId === 'files.write'
        ) {
          casExecutionId = actual.id;
          casReads.push(
            ...input.requirements.flatMap((evaluation) =>
              (evaluation.recordReads ?? []).map((read) => read.key),
            ),
          );
          const db = new Database(join(profile.profilePath, 'core.db'));
          try {
            db.run(
              "UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id='s' AND key='plan.current'",
              [planningExtensionId],
            );
          } finally {
            db.close();
          }
        }
        return store.markDispatching(input);
      };
    },
  });
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    ...host,
    store: observedStore,
    workspaceSerialLocks,
    permissions: host.permissions!,
    modelConcurrency: 1,
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'user',
    buildId: 'per-run-plan',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'per Run',
  });
  const f = {
    root,
    workspace,
    profile,
    runtime,
    store,
    client,
    host,
    configuration,
    configurationPath,
    credentialBackend,
    normal,
    reviews,
    expectedStoreId,
    get workId() {
      return workId;
    },
    get credentialReads() {
      return credentialReads;
    },
    policy(nextMode: PermissionMode, nextTrust = true) {
      mode = nextMode;
      trusted = nextTrust;
      revision++;
    },
    async record(key: string) {
      return store.getExtensionRecord({ sessionId: 's', extensionId: planningExtensionId, key });
    },
    async run() {
      const view = await store.getView('s');
      return view.runs.find((run) => run.originCommandId === workId)!;
    },
    async submit(id = 'work', plan = true) {
      workId = id;
      step = 0;
      modelSteps.clear();
      return client.startRun('s', {
        expectedStoreId,
        commandId: id,
        kind: 'run.start',
        content: id,
        ...(plan ? { extensionInputs: [intent] } : {}),
      });
    },
    scenario,
    casReads,
    get casExecutionId() {
      return casExecutionId;
    },
    async approve(definitionId: string) {
      const card = await until(
        async () =>
          (
            await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
          ).interactions.find(
            (card) => card.kind === 'approval' && card.definitionId === definitionId,
          ) ?? null,
      );
      await client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `approve-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      return card;
    },
    async card(kind: 'plan_review' | 'approval') {
      return until(
        async () =>
          (
            await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
          ).interactions.find((card) => card.kind === kind) ?? null,
      );
    },
    async approvePlan(executionMode: 'auto' | 'accept_edits') {
      const card = await f.card('plan_review');
      await client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `plan-answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'plan_review', decision: 'approve', mode: executionMode },
      });
      return card;
    },
    async done() {
      try {
        const command = await runtime.waitForCommand(workId, { timeoutMs: 8000 });
        const run = await f.run();
        if (!run) throw new Error(`original_run_missing:${JSON.stringify(command)}`);
        return run;
      } catch (error) {
        console.error(
          'planning-child-facts',
          JSON.stringify({
            scenario,
            normal: normal.map((row) => row.model),
            commands: await store.getCommand(workId),
            runs: (await store.getView('s')).runs.map((run) => ({
              id: run.id,
              status: run.status,
              originCommandId: run.originCommandId,
            })),
            executions: (await store.listExecutions('s')).map((e) => ({
              id: e.id,
              kind: e.kind,
              definitionId: e.definitionId,
              status: e.status,
              result: e.result,
            })),
            cards: (
              await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
            ).interactions.map((card) => ({
              kind: card.kind,
              definitionId: card.definitionId,
              sessionId: card.sessionId,
            })),
          }),
        );
        throw error;
      }
    },
    async close() {
      await service.close();
      await workspaceSerialLocks.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function script(model: string, step: number, f: Fixture): Promise<Call> {
  if (model === 'child') {
    if (step === 0) return { name: 'files.read', input: { path: 'original.txt' } };
    if (step === 1) {
      if (['ask', 'head_drift', 'proof_drift'].includes(f.scenario)) f.policy('ask');
      if (f.scenario === 'untrusted') f.policy('full', false);
      return {
        name: 'files.write',
        input: { path: 'child.txt', content: 'original child effect', base: null },
      };
    }
    return null;
  }
  if (f.scenario === 'pending_task' || f.workId === 'next')
    return step === 0
      ? {
          name: 'task',
          input: {
            key: f.workId,
            role: 'worker',
            input: { content: 'child' },
            cancellation: 'attached',
          },
        }
      : null;
  if (step === 0)
    return {
      name: 'planning.write',
      input: {
        planId: 'parent-plan',
        expectedVersion: null,
        title: 'Delegate once',
        body: 'Actual child reads and writes once',
        steps: [{ id: 'delegate', title: 'Delegate and wait' }],
      },
    };
  const current = (await f.record('plan.current'))!.value as Record<string, Json>;
  if (f.scenario === 'pending_job') {
    if (step === 1)
      return {
        name: 'validation.define',
        input: {
          runId: (await f.run()).id,
          checks: [
            {
              kind: 'command',
              input: { command: 'printf forbidden > forbidden.txt' },
              expectedExitCode: 0,
            },
          ],
        },
      };
    if (step === 2) return { name: 'validation.check', input: { runId: (await f.run()).id } };
    return null;
  }
  if (step === 1)
    return {
      name: 'planning.review',
      input: { planId: current.planId!, version: current.version!, digest: current.digest! },
    };
  if (step === 2)
    return {
      name: 'task',
      input: {
        key: f.workId,
        role: 'worker',
        input: { content: 'child' },
        cancellation: 'attached',
      },
    };
  if (step === 3) return { name: 'task_wait', input: { taskId: f.workId, timeoutMs: 4000 } };
  if (step === 4 && ['approved', 'next'].includes(f.scenario)) {
    const target = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'task' && e.status === 'succeeded',
    )!;
    return {
      name: 'planning.update',
      input: {
        runId: (await f.run()).id,
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
        expectedProgressRevision: null,
        stepId: 'delegate',
        status: 'completed',
        executionId: target.id,
        completePlan: true,
      },
    };
  }
  return null;
}
async function delegateApprovals(f: Fixture) {
  await f.approvePlan('accept_edits');
  const task = await f.approve('task');
  expect(f.normal.filter((row) => row.model === 'child')).toHaveLength(0);
  const carrier = await f.approve('agent/worker');
  expect(carrier.executionId).not.toBe(task.executionId);
  return { task, carrier };
}
test('pending single-Run planning defeats current Full Task and ordinary Job with zero child or physical start', async () => {
  for (const scenario of ['pending_task', 'pending_job'] as const) {
    const f = await fixture(scenario);
    try {
      await f.submit();
      expect((await f.done()).status).toBe('failed');
      expect(f.normal.filter((row) => row.model === 'child')).toHaveLength(0);
      expect(
        (await f.store.listExecutions('s')).filter((e) => e.childSessionId !== null),
      ).toHaveLength(0);
      expect(existsSync(join(f.workspace, 'forbidden.txt'))).toBe(false);
      if (scenario === 'pending_job')
        expect(
          (await f.store.listExecutions('s')).find(
            (e) => e.kind === 'job' && e.definitionId === 'shell.command',
          )!.status,
        ).toBe('failed');
    } finally {
      await f.close();
    }
  }
}, 15000);
test('approved accept_edits under current Full independently challenges Task/carrier then permits zero-source ordinary child read/write', async () => {
  const f = await fixture('approved');
  try {
    await f.submit();
    await delegateApprovals(f);
    const parent = await f.done();
    expect(parent.status).toBe('completed');
    expect(readFileSync(join(f.workspace, 'child.txt'), 'utf8')).toBe('original child effect');
    const carrier = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'agent/worker',
    )!;
    const child = (await f.store.getView(carrier.childSessionId!)).runs[0]!;
    expect(child.status).toBe('completed');
    expect(child.configuration).toMatchObject({
      snapshot: { configuration: { planning: { intent: null, requirePlan: false } } },
    });
    expect(child.requirements).toEqual(
      parent.requirements.filter((ref) => ref.requirementId === 'plan.required'),
    );
    expect(
      await f.store.getExtensionRecord({
        sessionId: child.sessionId,
        extensionId: planningExtensionId,
        key: `run/${child.id}/plan.required`,
      }),
    ).toBeNull();
    const childModel = (await f.store.listExecutions(child.sessionId)).find(
      (e) => e.kind === 'model',
    )!;
    const originalInput = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: child.sessionId,
      executionId: childModel.id,
    });
    expect(originalInput.metadata.context?.sources).toHaveLength(0);
    const cards = (await f.client.listInteractions('s', { storeId: f.expectedStoreId }))
      .interactions;
    expect(cards.filter((card) => card.kind === 'plan_review')).toHaveLength(1);
    expect(cards.filter((card) => card.kind === 'approval')).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);
test('child dispatch remains parent AND current mode/trust despite accepted parent Full composition', async () => {
  for (const scenario of ['ask', 'untrusted'] as const) {
    const f = await fixture(scenario);
    try {
      await f.submit();
      await delegateApprovals(f);
      if (scenario === 'ask') {
        const card = await f.card('approval');
        expect(card.definitionId).toBe('files.write');
        expect(card.sessionId).not.toBe('s');
        expect(existsSync(join(f.workspace, 'child.txt'))).toBe(false);
        await f.approve('files.write');
      }
      await f.done();
      expect(existsSync(join(f.workspace, 'child.txt'))).toBe(scenario === 'ask');
      const carrier = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'agent/worker',
      )!;
      const write = (await f.store.listExecutions(carrier.childSessionId!)).find(
        (e) => e.definitionId === 'files.write',
      )!;
      expect(write.status).toBe(scenario === 'ask' ? 'succeeded' : 'failed');
    } finally {
      await f.close();
    }
  }
}, 20000);
test('original parent head/proof drift during child approval refuses dispatch and next Run cannot borrow approval', async () => {
  for (const scenario of ['head_drift', 'proof_drift'] as const) {
    const f = await fixture(scenario);
    try {
      await f.submit();
      await delegateApprovals(f);
      const card = await f.card('approval');
      expect(card.definitionId).toBe('files.write');
      const db = new Database(join(f.profile.profilePath, 'core.db'));
      try {
        db.run('PRAGMA busy_timeout=100');
        if (scenario === 'head_drift') {
          const pointer = (await f.record('plan.current'))!.value as Record<string, Json>;
          pointer.digest = '0'.repeat(64);
          db.run(
            "UPDATE extension_record SET json=?,revision=revision+1 WHERE extension_id=? AND scope_id='s' AND key='plan.current'",
            [JSON.stringify(pointer), planningExtensionId],
          );
        } else
          db.run(
            "UPDATE interaction SET accepted_decision_revision=accepted_decision_revision+1 WHERE kind='plan_review' AND session_id='s'",
          );
      } finally {
        db.close();
      }
      await f.approve('files.write');
      await f.done();
      expect(existsSync(join(f.workspace, 'child.txt'))).toBe(false);
    } finally {
      await f.close();
    }
  }
  const f = await fixture('next');
  try {
    await f.submit();
    await delegateApprovals(f);
    expect((await f.done()).status).toBe('completed');
    const prior = (await f.store.listExecutions('s')).filter(
      (e) => e.childSessionId !== null,
    ).length;
    await f.submit('next');
    expect((await f.done()).status).toBe('failed');
    expect(
      (await f.store.listExecutions('s')).filter((e) => e.childSessionId !== null),
    ).toHaveLength(prior);
  } finally {
    await f.close();
  }
}, 25000);

test('actual child preserves original parent condition read-set and final SQLite CAS rejects unchanged-content head revision drift', async () => {
  const f = await fixture('cas_drift');
  try {
    await f.submit();
    await delegateApprovals(f);
    await f.done();
    expect(f.casExecutionId).not.toBeNull();
    expect(f.casReads).toContain('plan.current');
    expect(f.casReads.some((key) => key.includes('/approval/parent-plan/1'))).toBe(true);
    expect(existsSync(join(f.workspace, 'child.txt'))).toBe(false);
    const execution = await f.store.getExecution(f.casExecutionId!);
    expect(execution!.status).toBe('failed');
    expect(JSON.stringify(execution!.result)).toContain('requirement_not_satisfied');
  } finally {
    await f.close();
  }
}, 15000);
