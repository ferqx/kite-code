import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import {
  createDefaultAfterTurnPolicy,
  type DefaultAfterTurnInput,
} from '../../src/after-turn-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';

function original(phase: 'request' | 'apply' = 'request'): DefaultAfterTurnInput {
  // Minimal owner facts for the pure policy; real records are exercised below through SQLite.
  const scope = {
    sessionId: 's',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
  };
  return {
    phase,
    signal: new AbortController().signal,
    command: {
      ...scope,
      id: 'work',
      kind: 'run.start',
      subjectId: 'user',
      cancelRequestedAt: null,
      seq: '2',
      request: { kind: 'run.start', content: 'work' },
      requestDigest: 'digest',
      status: phase === 'request' ? 'accepted' : 'applied',
      receipt: {},
    },
    run: {
      contextSelectionId: 'selection',
      ...scope,
      id: 'run',
      originCommandId: 'work',
      status: phase === 'request' ? 'running' : 'completed',
      isActive: phase === 'request',
      configuration: {},
      requirements: [],
      createdAt: 1,
      deadlineAt: null,
      finishedAt: phase === 'request' ? null : 2,
      reason: null,
      waitingForResults: [],
    },
    session: {
      id: 's',
      rootSessionId: 's',
      deletedAt: null,
      workspaceId: 'w',
      parentSessionId: null,
      title: 'original',
      controlRevision: '1',
      contextSelectionId: 'context',
      ownerInstanceId: 'owner',
      ownerGeneration: '1',
      nextSeq: '3',
    },
    execution: {
      ...scope,
      id: 'tool',
      runId: 'run',
      originCommandId: 'work',
      kind: 'tool',
      definitionId: 'task',
      definitionVersion: '1',
      status: phase === 'request' ? 'running' : 'succeeded',
      cancelRequestedAt: null,
      input: { role: 'worker' },
      resultAcceptance: null,
      interactionBinding: null,
      childSessionId: null,
      childConfiguration: null,
      parentExecutionId: null,
      cancelWithParent: true,
      stepId: 'step',
      callId: 'call',
      attempt: 1,
      decisionSource: {},
      result: {},
      ownerGeneration: '1',
      resultRevision: '1',
      reference: {},
      delivery: null,
      deliveryReason: null,
      deliveryTargetSessionId: null,
      contextSelectionId: 'context',
      requirements: [],
    },
    configuration: {
      id: 'worker',
      version: '1',
      snapshot: {
        modelId: 'parent',
        snapshot: { roleId: 'worker', roleVersion: '1' },
        tools: [],
        extensions: [],
      },
    },
  };
}
test('finite default policy binds original scope, freezes roles and rechecks current facts without granting dispatch', async () => {
  const roles = [{ id: 'worker', version: '1' }];
  let revision = 'current-1',
    trusted = true,
    reads = 0;
  const policy = createDefaultAfterTurnPolicy({
    roles,
    async readCurrent(input) {
      reads++;
      expect(input.execution.id).toBe('tool');
      return {
        workspaceTrust: trusted,
        revision,
        controlReads: [{ kind: 'workspace.trust', scope: 'workspace:w', revision }],
      };
    },
  });
  roles[0]!.version = 'forged';
  const first = await policy.authorize(original());
  expect(first.allowed).toBe(true);
  expect(Object.isFrozen(first.controlReads)).toBe(true);
  expect(await policy.authorize(original('apply'))).toEqual(first);
  const waiting = original('apply');
  (waiting.run as { isActive: boolean; status: string }).isActive = true;
  (waiting.run as { status: string }).status = 'running';
  expect(await policy.authorize(waiting)).toEqual(first);
  revision = 'current-2';
  expect((await policy.authorize(original('apply'))).revision).not.toBe(first.revision);
  trusted = false;
  expect((await policy.authorize(original('apply'))).allowed).toBe(false);
  expect(reads).toBe(5);
});
test('finite default policy rejects wrong original Tool, report recursion, role, source and cancelled facts before current reads', async () => {
  let reads = 0;
  const policy = createDefaultAfterTurnPolicy({
    roles: [{ id: 'worker', version: '1' }],
    async readCurrent() {
      reads++;
      return { workspaceTrust: true, revision: 'current' };
    },
  });
  const mutations: ((input: DefaultAfterTurnInput) => void)[] = [
    (i) => {
      (i.command as { kind: string }).kind = 'job.report';
    },
    (i) => {
      (i.execution as { kind: string }).kind = 'job';
    },
    (i) => {
      (i.execution as { definitionId: string }).definitionId = 'shell.command';
    },
    (i) => {
      (i.execution as { definitionVersion: string }).definitionVersion = '2';
    },
    (i) => {
      (i.execution as { sessionId: string }).sessionId = 'foreign';
    },
    (i) => {
      (i.execution as { runId: string | null }).runId = null;
    },
    (i) => {
      (i.execution as { originStoreId: string }).originStoreId = 'foreign';
    },
    (i) => {
      (i.execution as { rootWorkSeq: string }).rootWorkSeq = '3';
    },
    (i) => {
      (i.run as { originCommandId: string }).originCommandId = 'foreign';
    },
    (i) => {
      (i.configuration as { version: string }).version = '2';
    },
    (i) => {
      (i.configuration as { snapshot: Json }).snapshot = {
        modelId: 'parent',
        snapshot: { roleId: 'forged', roleVersion: '1' },
      };
    },
    (i) => {
      (i.execution as { input: Json }).input = { role: 'foreign' };
    },
    (i) => {
      (i.command as { cancelRequestedAt: number | null }).cancelRequestedAt = 1;
    },
    (i) => {
      (i.execution as { cancelRequestedAt: number | null }).cancelRequestedAt = 1;
    },
    (i) => {
      (i.session as { deletedAt: number | null }).deletedAt = 1;
    },
    (i) => {
      (i.run as { isActive: boolean }).isActive = false;
    },
  ];
  for (const mutate of mutations) {
    const input = original();
    mutate(input);
    expect((await policy.authorize(input)).allowed).toBe(false);
  }
  const unknown = original('apply');
  (unknown.execution as { status: string }).status = 'outcome_unknown';
  expect((await policy.authorize(unknown)).allowed).toBe(false);
  expect(reads).toBe(0);
});
test('finite default policy rejects late aborted reads and malformed current control proofs', async () => {
  const controller = new AbortController(),
    input = { ...original(), signal: controller.signal };
  const policy = createDefaultAfterTurnPolicy({
    roles: [{ id: 'worker', version: '1' }],
    async readCurrent() {
      controller.abort();
      return { workspaceTrust: true, revision: 'current' };
    },
  });
  await expect(policy.authorize(input)).rejects.toThrow();
  const invalid = createDefaultAfterTurnPolicy({
    roles: [{ id: 'worker', version: '1' }],
    async readCurrent() {
      return { workspaceTrust: true, revision: '', controlReads: [] };
    },
  });
  await expect(invalid.authorize(original())).rejects.toThrow('after_turn_authorization_invalid');
});

test('finite default policy supports exact followup and nested origins without sharing a different original grant', async () => {
  const policy = createDefaultAfterTurnPolicy({
    roles: [{ id: 'worker', version: '1' }],
    async readCurrent() {
      return { workspaceTrust: true, revision: 'current' };
    },
  });
  const first = await policy.authorize(original());
  const followup = original();
  (followup.execution as { definitionId: string; input: Json }).definitionId = 'followup_task';
  (followup.execution as { input: Json }).input = {
    taskId: 'old-child',
    key: 'new-work',
    content: 'new work',
  };
  expect((await policy.authorize(followup)).allowed).toBe(true);
  expect((await policy.authorize(followup)).revision).not.toBe(first.revision);
  const nested = original();
  (nested.command as { id: string; kind: string; sessionId: string }).id = 'child-start-original';
  (nested.command as { kind: string; sessionId: string }).kind = 'child.start';
  (nested.command as { sessionId: string }).sessionId = 'child';
  (nested.session as { id: string }).id = 'child';
  (nested.run as { sessionId: string; originCommandId: string }).sessionId = 'child';
  (nested.run as { originCommandId: string }).originCommandId = nested.command.id;
  (nested.execution as { sessionId: string; originCommandId: string }).sessionId = 'child';
  (nested.execution as { originCommandId: string }).originCommandId = nested.command.id;
  expect((await policy.authorize(nested)).allowed).toBe(true);
  expect((await policy.authorize(nested)).revision).not.toBe(first.revision);
});

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() > end) throw Error('default_after_turn_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  disposition: 'required' | 'background' | 'after_turn',
  recurse = false,
  managed = false,
  planning = false,
  singleSlot = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-report-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let currentRevision = 'original',
    trusted = true,
    normalParent = 0,
    childCalls = 0,
    reports = 0;
  const calls: Record<string, unknown>[] = [];
  let currentReport = async () => false;
  let planningCall: (index: number) => Promise<{ name: string; input: Json } | null> = async () =>
    null;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      const messages = body.messages as { role: string; content: string | null }[];
      const text = messages.map((m) => m.content ?? '').join('\n');
      const review = messages.some((m) => {
        if (m.role !== 'user' || !m.content) return false;
        try {
          return JSON.parse(m.content).purpose === 'authorization_review';
        } catch {
          return false;
        }
      });
      const child = !review && text.includes('ORIGINAL_CHILD_INPUT');
      const report = !review && !child && (await currentReport());
      if (!review) calls.push(body);
      if (child) {
        childCalls++;
        await gate;
      }
      if (report) reports++;
      const parentIndex = !review && !child && !report ? normalParent++ : -1;
      if (planning && singleSlot && parentIndex === 4) await parentGate;
      const call =
        !review &&
        !child &&
        ((!report && parentIndex === 0) || (report && recurse && reports === 1));
      const selected =
        planning && parentIndex >= 0
          ? await planningCall(parentIndex)
          : call
            ? {
                name: 'task',
                input: {
                  key: report ? 'recursive' : 'original',
                  role: 'worker',
                  input: { content: 'ORIGINAL_CHILD_INPUT' },
                  cancellation: 'detached',
                  resultDisposition: report ? 'after_turn' : disposition,
                },
              }
            : null;
      const delta = selected
        ? {
            tool_calls: [
              {
                index: 0,
                id: `task-${calls.length}`,
                type: 'function',
                function: {
                  name: selected.name,
                  arguments: JSON.stringify(selected.input),
                },
              },
            ],
          }
        : {
            content: review
              ? JSON.stringify({ decision: 'ask_user', reason: 'independent ordinary approval' })
              : child
                ? 'ORIGINAL_CHILD_RESULT complete tail'
                : 'parent complete',
          };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'original', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, selected ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'parent',
      tools: [
        'task',
        ...(planning ? ['planning.write', 'planning.review', 'planning.update'] : []),
      ].map((id) => ({ id, definitionVersion: '1' })),
      models: [
        {
          id: 'parent',
          provider: 'compatible',
          model: 'parent',
          baseURL: `${provider.url.href}v1`,
          credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
        },
      ],
      afterTurn: { allowed: true, revision: 'json-forgery' },
    }),
  );
  // No options.child or options.afterTurn: exercise the actual default factory registration.
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {},
      async remove() {},
      async resolve() {
        return 'owned-local-fixture-secret';
      },
    },
    permissionPolicy: managed
      ? undefined
      : {
          async readPolicy() {
            return {
              mode: planning ? 'full' : 'ask',
              workspaceTrust: trusted,
              revision: currentRevision,
              allowed: [
                { kind: 'model', definitionId: 'parent', definitionVersion: '1' },
                { kind: 'tool', definitionId: 'task', definitionVersion: '1' },
                { kind: 'job', definitionId: 'agent/worker', definitionVersion: '1' },
                ...(planning
                  ? ['planning.write', 'planning.review', 'planning.update'].map(
                      (definitionId) => ({
                        kind: 'tool' as const,
                        definitionId,
                        definitionVersion: '1',
                      }),
                    )
                  : []),
              ],
            };
          },
        },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  currentReport = async () =>
    (await store.getView('s')).runs.some(
      (run) => run.isActive && run.originCommandId.startsWith('report-'),
    );
  planningCall = async (index): Promise<{ name: string; input: Json } | null> => {
    if (index === 0)
      return {
        name: 'planning.write',
        input: {
          planId: 'report-plan',
          expectedVersion: null,
          title: 'Delegate then report',
          body: 'One original child and one report',
          steps: [{ id: 'delegate', title: 'Accept original child delegation' }],
        },
      };
    const current = (await store.getExtensionRecord({
      sessionId: 's',
      extensionId: planningExtensionId,
      key: 'plan.current',
    }))!.value as Record<string, Json>;
    if (index === 1)
      return {
        name: 'planning.review',
        input: { planId: current.planId!, version: current.version!, digest: current.digest! },
      };
    if (index === 2)
      return {
        name: 'task',
        input: {
          key: 'original',
          role: 'worker',
          input: { content: 'ORIGINAL_CHILD_INPUT' },
          cancellation: 'detached',
          resultDisposition: 'after_turn',
        },
      };
    if (index === 3) {
      const run = (await store.getView('s')).runs.find((run) => run.originCommandId === 'work')!;
      const task = (await store.listExecutions('s')).find(
        (e) => e.definitionId === 'task' && e.status === 'succeeded',
      )!;
      return {
        name: 'planning.update',
        input: {
          runId: run.id,
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
          expectedProgressRevision: null,
          stepId: 'delegate',
          status: 'completed',
          executionId: task.id,
          completePlan: true,
        },
      };
    }
    return null;
  };
  const runtime = createRuntime({
    ...host,
    store,
    permissions: host.permissions!,
    modelConcurrency: planning && !singleSlot ? 2 : 1,
  });
  const permissionManagement = host.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    permissionManagement,
    profile: serverProfile,
    subjectId: 'user',
    buildId: 'default-report',
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
    title: 'original',
  });
  if (managed) {
    const mode = await client.getPermissionMode('s', { storeId: expectedStoreId });
    await client.setPermissionMode('s', {
      expectedStoreId,
      commandId: 'mode',
      mode: 'ask',
      ifRevision: mode.revision,
      ifDefaultRevision: mode.defaultRevision,
      makeDefault: false,
    });
    const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
  }
  return {
    client,
    store,
    runtime,
    calls,
    expectedStoreId,
    profile,
    release,
    releaseParent,
    get childCalls() {
      return childCalls;
    },
    get reports() {
      return reports;
    },
    drift(trust = true) {
      currentRevision = 'changed';
      trusted = trust;
    },
    async approve(definitionId: string) {
      const card = await until(async () =>
        (await client.listInteractions('s', { storeId: expectedStoreId })).interactions.find(
          (card) =>
            card.kind === 'approval' &&
            card.state === 'pending' &&
            card.definitionId === definitionId,
        ),
      ).catch(async (error) => {
        console.error(
          'default-report-approval-boundary-facts',
          JSON.stringify({
            definitionId,
            runs: (await store.getView('s')).runs.map((run) => ({
              id: run.id,
              status: run.status,
              reason: run.reason,
              originCommandId: run.originCommandId,
            })),
            executions: (await store.listExecutions('s')).map((e) => ({
              id: e.id,
              kind: e.kind,
              definitionId: e.definitionId,
              status: e.status,
              runId: e.runId,
              parentExecutionId: e.parentExecutionId,
              childSessionId: e.childSessionId,
              result: e.result,
            })),
            childCalls,
            reports,
          }),
        );
        throw error;
      });
      await client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      return card;
    },
    async start() {
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId,
        commandId: 'work',
        content: 'original work',
        ...(planning
          ? {
              extensionInputs: [
                {
                  extensionId: planningExtensionId,
                  definitionVersion: '1',
                  input: { mode: 'plan' },
                },
              ],
            }
          : {}),
      });
    },
    async close() {
      release();
      releaseParent();
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('default factory independently approves original Task/carrier and reports exactly once without recursive after_turn', async () => {
  const f = await fixture('after_turn', true, true);
  try {
    await f.start();
    const tool = await f.approve('task');
    expect(f.childCalls).toBe(0);
    const carrier = await f.approve('agent/worker');
    expect(carrier.executionId).not.toBe(tool.executionId);
    await until(async () => (f.childCalls === 1 ? true : undefined));
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    f.release();
    const report = await until(async () =>
      (await f.store.getView('s')).runs.find((run) => run.originCommandId.startsWith('report-')),
    );
    await f.approve('task');
    await f.runtime.waitForCommand(report.originCommandId, { timeoutMs: 8000 });
    expect(f.childCalls).toBe(1);
    expect((await f.store.getView('s')).runs).toHaveLength(2);
    const model = (await f.store.listExecutions('s')).find(
      (e) => e.runId === report.id && e.kind === 'model',
    )!;
    const input = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'user',
      sessionId: 's',
      executionId: model.id,
    });
    expect(
      input.request.messages.some(
        (message) =>
          message.sourceIds?.some((id) => id.startsWith('result-')) &&
          message.content.includes('ORIGINAL_CHILD_RESULT'),
      ),
    ).toBe(true);
    expect((await f.store.listExecutions('s')).filter((e) => e.childSessionId)).toHaveLength(1);
    expect(
      (await f.store.listExecutions('s')).find(
        (e) => e.runId === report.id && e.definitionId === 'task',
      )!.status,
    ).toBe('failed');
    const before = f.calls.length;
    await f.client.getCommand(report.originCommandId);
    await f.client.getView('s');
    expect(f.calls).toHaveLength(before);
  } finally {
    await f.close();
  }
}, 25000);
test('default required/background remain ordinary and do not register report Runs', async () => {
  for (const disposition of ['required', 'background'] as const) {
    const f = await fixture(disposition);
    try {
      await f.start();
      await f.approve('task');
      await f.approve('agent/worker');
      await until(async () => (f.childCalls === 1 ? true : undefined));
      f.release();
      await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
      await until(async () =>
        (await f.store.listExecutions('s')).find(
          (e) => e.childSessionId && e.status === 'succeeded',
        ),
      );
      expect((await f.store.getView('s')).runs).toHaveLength(1);
      expect(f.reports).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 30000);
test('default current policy/trust drift after parent completion suppresses original report without child replay', async () => {
  for (const trusted of [true, false]) {
    const f = await fixture('after_turn');
    try {
      await f.start();
      await f.approve('task');
      await f.approve('agent/worker');
      await until(async () => (f.childCalls === 1 ? true : undefined));
      await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
      f.drift(trusted);
      f.release();
      const carrier = await until(async () =>
        (await f.store.listExecutions('s')).find(
          (e) => e.childSessionId && e.delivery === 'suppressed',
        ),
      );
      expect(carrier.status).toBe('succeeded');
      expect((await f.store.getView('s')).runs).toHaveLength(1);
      expect(f.childCalls).toBe(1);
      expect(f.reports).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 30000);

test('default report final source digest rejects changed original Tool intent while preserving the child result', async () => {
  const f = await fixture('after_turn');
  try {
    await f.start();
    const tool = await f.approve('task');
    await f.approve('agent/worker');
    await until(async () => (f.childCalls === 1 ? true : undefined));
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
    const originalTool = (await f.store.getExecution(tool.executionId))!;
    const db = new Database(join(f.profile.profilePath, 'core.db'));
    try {
      db.run('UPDATE execution SET intent_json=? WHERE id=?', [
        JSON.stringify({
          ...(originalTool.input as Record<string, Json>),
          key: 'changed-original',
        }),
        tool.executionId,
      ]);
    } finally {
      db.close();
    }
    f.release();
    const carrier = await until(async () =>
      (await f.store.listExecutions('s')).find(
        (e) => e.childSessionId && e.delivery === 'suppressed',
      ),
    );
    expect(carrier.status).toBe('succeeded');
    expect(carrier.deliveryReason).toBe('source_unverifiable');
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    expect(f.childCalls).toBe(1);
    expect(f.reports).toBe(0);
  } finally {
    await f.close();
  }
}, 20000);

async function plannedReport(singleSlot: boolean, driftPlan = false) {
  const f = await fixture('after_turn', false, false, true, singleSlot);
  try {
    await f.start();
    const review = await until(async () =>
      (
        await f.client.listInteractions('s', { storeId: f.expectedStoreId, state: 'pending' })
      ).interactions.find((card) => card.kind === 'plan_review'),
    );
    expect(f.childCalls).toBe(0);
    expect((await f.store.listExecutions('s')).filter((e) => e.childSessionId)).toHaveLength(0);
    await f.client.answerInteraction('s', review.id, {
      expectedStoreId: f.expectedStoreId,
      commandId: 'plan-approve',
      expectedRevision: review.revision,
      answer: { kind: 'plan_review', decision: 'approve', mode: 'accept_edits' },
    });
    const task = await f.approve('task');
    const carrier = await f.approve('agent/worker');
    expect(carrier.executionId).not.toBe(task.executionId);
    await until(async () => (f.childCalls === 1 ? true : undefined));
    if (singleSlot) {
      f.release();
      await until(async () =>
        (await f.store.listExecutions('s')).find(
          (e) => e.id === carrier.executionId && e.status === 'succeeded',
        ),
      );
      expect(
        (await f.store.getView('s')).runs.find((run) => run.originCommandId === 'work')!.isActive,
      ).toBe(true);
      expect(f.reports).toBe(0);
      const pending = await until(async () => {
        const reports = await f.store.listPendingJobReports({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
        });
        return reports.commands.length === 1 ? reports.commands[0] : undefined;
      });
      expect(pending.kind).toBe('job.report');
      expect(pending.status).toBe('accepted');
      expect(
        (await f.store.getView('s')).runs.filter((run) => run.originCommandId === pending.id),
      ).toHaveLength(0);
      f.releaseParent();
    }
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 }).catch(async (error) => {
      console.error(
        'planned-parent-boundary-facts',
        JSON.stringify({
          runs: (await f.store.getView('s')).runs.map((run) => ({
            id: run.id,
            status: run.status,
            active: run.isActive,
            reason: run.reason,
            originCommandId: run.originCommandId,
          })),
          executions: (await f.store.listExecutions('s')).map((e) => ({
            id: e.id,
            kind: e.kind,
            definitionId: e.definitionId,
            status: e.status,
            result: e.result,
          })),
          cards: (
            await f.client.listInteractions('s', { storeId: f.expectedStoreId, state: 'pending' })
          ).interactions.map((card) => ({
            id: card.id,
            kind: card.kind,
            definitionId: card.definitionId,
          })),
          childCalls: f.childCalls,
          reports: f.reports,
        }),
      );
      throw error;
    });
    const parent = (await f.store.getView('s')).runs.find((run) => run.originCommandId === 'work')!;
    expect(parent.status).toBe('completed');
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'planning.update')!.status,
    ).toBe('succeeded');
    if (driftPlan) {
      const head = (await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key: 'plan.current',
      }))!;
      const db = new Database(join(f.profile.profilePath, 'core.db'));
      try {
        db.run(
          "UPDATE extension_record SET revision=revision+1,json=? WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
          [
            JSON.stringify({ ...(head.value as Record<string, Json>), digest: '0'.repeat(64) }),
            planningExtensionId,
            's',
            'plan.current',
          ],
        );
      } finally {
        db.close();
      }
    }
    f.release();
    const report = await until(async () =>
      (await f.store.getView('s')).runs.find((run) => run.originCommandId.startsWith('report-')),
    );
    await f.runtime.waitForCommand(report.originCommandId, { timeoutMs: 8000 });
    if (driftPlan) {
      const failed = (await f.store.getRun(report.id))!;
      if (failed.status !== 'failed' || f.reports !== 0)
        console.error(
          'planned-report-head-drift-facts',
          JSON.stringify({
            parent: { id: parent.id, status: parent.status, requirements: parent.requirements },
            report: {
              id: failed.id,
              status: failed.status,
              reason: failed.reason,
              requirements: failed.requirements,
            },
            head: await f.store.getExtensionRecord({
              sessionId: 's',
              extensionId: planningExtensionId,
              key: 'plan.current',
            }),
            command: await f.store.getCommand(report.originCommandId),
            executions: (await f.store.listExecutions('s'))
              .filter((e) => e.runId === report.id)
              .map((e) => ({
                id: e.id,
                kind: e.kind,
                status: e.status,
                parentExecutionId: e.parentExecutionId,
                result: e.result,
              })),
            reports: f.reports,
            childCalls: f.childCalls,
          }),
        );
      expect(failed.status).toBe('failed');
      expect(failed.requirements).toEqual(parent.requirements);
      const model = (await f.store.listExecutions('s')).find(
        (e) => e.runId === report.id && e.kind === 'model',
      )!;
      expect(model.status).toBe('failed');
      expect((model.result as Record<string, Json>).code).toBe('necessary_condition_unsatisfied');
      expect(f.reports).toBe(0);
      expect(f.childCalls).toBe(1);
      expect((await f.store.getExecution(carrier.executionId))!.status).toBe('succeeded');
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions.filter(
          (card) => card.kind === 'plan_review',
        ),
      ).toHaveLength(1);
      return;
    }
    const reportAfter = (await f.store.getRun(report.id))!;
    if (reportAfter.status !== 'completed')
      console.error(
        'original-planned-report-facts',
        JSON.stringify({
          parent: {
            id: parent.id,
            status: parent.status,
            sessionId: parent.sessionId,
            originStoreId: parent.originStoreId,
            rootWorkCommandId: parent.rootWorkCommandId,
            rootWorkSeq: parent.rootWorkSeq,
            requirements: parent.requirements,
          },
          report: {
            id: reportAfter.id,
            status: reportAfter.status,
            reason: reportAfter.reason,
            sessionId: reportAfter.sessionId,
            originStoreId: reportAfter.originStoreId,
            rootWorkCommandId: reportAfter.rootWorkCommandId,
            rootWorkSeq: reportAfter.rootWorkSeq,
            requirements: reportAfter.requirements,
          },
          command: await f.store.getCommand(report.originCommandId),
          executions: (await f.store.listExecutions('s'))
            .filter((e) => e.runId === report.id)
            .map((e) => ({
              id: e.id,
              kind: e.kind,
              status: e.status,
              runId: e.runId,
              originCommandId: e.originCommandId,
              parentExecutionId: e.parentExecutionId,
              result: e.result,
            })),
        }),
      );
    expect(reportAfter.status).toBe('completed');
    expect(reportAfter.requirements).toEqual(parent.requirements);
    expect(reportAfter.requirements.length).toBeGreaterThan(0);
    expect(
      await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key: `run/${report.id}/plan.required`,
      }),
    ).toBeNull();
    expect(
      (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions.filter(
        (card) => card.kind === 'plan_review',
      ),
    ).toHaveLength(1);
    expect(f.reports).toBe(1);
    expect(f.childCalls).toBe(1);
  } finally {
    await f.close();
  }
}
test(
  'default after_turn preserves original per-Run plan approval and completed receipt without repeating plan intent in the report',
  () => plannedReport(false),
  25000,
);
test(
  'single-slot planned parent remains active after child completion and reports once only after parent finishes',
  () => plannedReport(true),
  25000,
);

test(
  'default report inherits the original plan condition and changed head refuses report Model before Provider IO',
  () => plannedReport(false, true),
  25000,
);
