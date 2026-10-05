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
import type { Json } from '@kite-ai/agent/extensions';
import { planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { PermissionMode } from '../../src/permissions';
import { readBusinessRunInputs } from '../../src/planning-configuration';

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
async function fixture(script: (step: number, f: Fixture) => Promise<Call>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-per-run-plan-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'original.txt'), 'original Chinese 中文');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'plan' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const normal: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  let step = 0;
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
      const call: Call = review ? null : await script(step++, f);
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
                    ? JSON.stringify({ decision: 'approve_once', reason: 'exact fixture call' })
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
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
      },
    ],
    tools: [
      { id: 'files.read', definitionVersion: '3' },
      { id: 'files.write', definitionVersion: '2' },
    ],
  };
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend,
    permissionPolicy: {
      readPolicy: () => ({
        mode,
        workspaceTrust: trusted,
        revision: `current-policy-${revision}`,
        allowed: [
          { kind: 'model', definitionId: 'local', definitionVersion: '1' },
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
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    store,
    workspaceSerialLocks,
    permissions: host.permissions!,
    extensions: host.extensions,
    supportsExtensionInputs: host.supportsExtensionInputs,
    resolveRunConfiguration: host.resolveRunConfiguration,
    resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
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
      return client.startRun('s', {
        expectedStoreId,
        commandId: id,
        kind: 'run.start',
        content: id,
        ...(plan ? { extensionInputs: [intent] } : {}),
      });
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
      await runtime.waitForCommand(workId, { timeoutMs: 8000 });
      return f.run();
    },
    async close() {
      try {
        await service.close();
      } finally {
        try {
          await runtime.close();
        } finally {
          try {
            await workspaceSerialLocks.close();
          } finally {
            provider.stop(true);
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function planScript(step: number, f: Fixture): Promise<Call> {
  if (step === 0) return { name: 'files.read', input: { path: 'original.txt' } };
  if (step === 1)
    return {
      name: 'files.write',
      input: { path: 'before.txt', content: 'must be refused', base: null },
    };
  if (step === 2)
    return {
      name: 'planning.write',
      input: {
        planId: 'plan',
        expectedVersion: null,
        title: 'Owned plan',
        body: 'One precise write 中文',
        steps: [{ id: 'a', title: 'Write once' }],
      },
    };
  const current = (await f.record('plan.current'))?.value as Record<string, Json>;
  if (step === 3)
    return {
      name: 'planning.review',
      input: { planId: current.planId!, version: current.version!, digest: current.digest! },
    };
  if (step === 4)
    return {
      name: 'files.write',
      input: { path: 'after.txt', content: 'approved actual effect', base: null },
    };
  if (step === 5) {
    const run = await f.run();
    const write = (await f.store.listExecutions('s')).find(
      (execution) =>
        execution.definitionId === 'files.write' &&
        execution.status === 'succeeded' &&
        execution.runId === run.id,
    );
    if (!write) return null;
    return {
      name: 'planning.update',
      input: {
        runId: run.id,
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
        expectedProgressRevision: null,
        stepId: 'a',
        status: 'completed',
        executionId: write.id,
        completePlan: true,
      },
    };
  }
  return null;
}

test('actual Service per-Run planning blocks Full writes before approval, permits exact read, completes actual receipt and does not reuse approval on next Run', async () => {
  const f = await fixture(async (step, f) =>
    f.workId === 'work'
      ? planScript(step, f)
      : step === 0
        ? { name: 'files.write', input: { path: `${f.workId}.txt`, content: f.workId, base: null } }
        : null,
  );
  try {
    await f.submit();
    const card = await f.card('plan_review');
    const run = await f.run();
    expect(run.requirements).toHaveLength(1);
    expect(run.configuration).toMatchObject({
      snapshot: { planning: { intent: { mode: 'plan' }, requirePlan: true } },
    });
    expect(existsSync(join(f.workspace, 'before.txt'))).toBe(false);
    expect(existsSync(join(f.workspace, 'after.txt'))).toBe(false);
    const executions = await f.store.listExecutions('s');
    expect(executions.find((execution) => execution.definitionId === 'files.read')?.status).toBe(
      'succeeded',
    );
    expect(executions.find((execution) => execution.definitionId === 'files.write')?.status).toBe(
      'failed',
    );
    expect((await f.runtime.getExecution(card.executionId))?.runId).toBe(run.id);
    await f.approvePlan('accept_edits');
    const done = await f.done();
    const file = (await f.store.listExecutions('s')).find(
      (row) =>
        row.runId === run.id && row.definitionId === 'files.write' && row.status === 'succeeded',
    )!;
    const progress = (await f.record('progress/plan/1'))?.value as Record<string, Json> | undefined;
    console.log(
      JSON.stringify({
        perRunPlanningEvidence: {
          storeId: f.expectedStoreId,
          commandId: 'work',
          runId: done.id,
          runStatus: done.status,
          review: { interactionId: card.id, executionId: card.executionId },
          file: {
            id: file?.id,
            status: file?.status,
            runId: file?.runId,
            originStoreId: file?.originStoreId,
            rootWorkCommandId: file?.rootWorkCommandId,
            definitionVersion: file?.definitionVersion,
            decisionSource: file?.decisionSource,
            result: file?.result,
          },
          progress,
        },
      }),
    );
    expect(done.status).toBe('completed');
    expect(file).toMatchObject({
      status: 'succeeded',
      runId: run.id,
      originStoreId: f.expectedStoreId,
      rootWorkCommandId: 'work',
      definitionVersion: '2',
    });
    expect(progress).toMatchObject({
      runId: run.id,
      planId: 'plan',
      version: 1,
      completePlan: true,
      steps: {
        a: {
          status: 'completed',
          receipt: { executionId: file.id, definitionId: 'files.write', definitionVersion: '2' },
        },
      },
    });
    expect(readFileSync(join(f.workspace, 'after.txt'), 'utf8')).toBe('approved actual effect');
    expect(f.reviews).toHaveLength(0);
    const approval = await f.record(`run/${run.id}/approval/plan/1`);
    expect(approval?.originStoreId).toBe(f.expectedStoreId);
    await f.submit('next-plan');
    const next = await f.done();
    expect(next.status).toBe('failed');
    expect(next.reason).toBe('necessary_condition_unsatisfied');
    expect(existsSync(join(f.workspace, 'next-plan.txt'))).toBe(false);
    await f.submit('ordinary', false);
    const ordinary = await f.done();
    expect(ordinary.status).toBe('completed');
    expect(ordinary.requirements).toEqual([]);
    expect(readFileSync(join(f.workspace, 'ordinary.txt'), 'utf8')).toBe('ordinary');
  } finally {
    await f.close();
  }
}, 25000);

test('chosen Auto remains a ceiling over Full; actual compatible reviewer runs for the original post-plan write', async () => {
  const f = await fixture(planScript);
  try {
    await f.submit();
    await f.approvePlan('auto');
    expect((await f.done()).status).toBe('completed');
    expect(f.reviews).toHaveLength(1);
    const payload = JSON.parse((f.reviews[0]!.messages as { content: string }[])[0]!.content);
    expect(JSON.stringify(payload)).toContain('"mode":"auto"');
    expect(payload.target.definitionId).toBe('files.write');
    expect(readFileSync(join(f.workspace, 'after.txt'), 'utf8')).toBe('approved actual effect');
  } finally {
    await f.close();
  }
}, 20000);

test('plan approval never overrides newly current Ask or trust denial', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const f = await fixture(async (step, f) => {
    if (step === 4) {
      entered = true;
      await barrier;
    }
    return planScript(step, f);
  });
  try {
    await f.submit();
    await f.approvePlan('accept_edits');
    await until(async () => (entered ? true : null));
    f.policy('ask');
    release();
    const card = await f.card('approval');
    expect(card.definitionId).toBe('files.write');
    expect(existsSync(join(f.workspace, 'after.txt'))).toBe(false);
    f.policy('full', false);
    await f.client.answerInteraction('s', card.id, {
      expectedStoreId: f.expectedStoreId,
      commandId: 'write-answer',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect((await f.done()).status).toBe('failed');
    expect(existsSync(join(f.workspace, 'after.txt'))).toBe(false);
    expect(f.reviews).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
}, 20000);

test('closed business envelopes preserve original Workflow input; malformed intents and cold planning drift reject before credentials or Provider', async () => {
  const workflow = {
    extensionId: 'builtin.skill-workflow',
    definitionVersion: '1',
    input: { activations: [] },
  };
  const request = {
    kind: 'run.start' as const,
    content: 'exact original',
    extensionInputs: [workflow, intent],
  };
  const digest = JSON.stringify(request);
  const split = readBusinessRunInputs(request);
  expect(split.planning).toEqual({ mode: 'plan' });
  expect(split.workflowRequest).toEqual({ ...request, extensionInputs: [workflow] });
  expect(JSON.stringify(request)).toBe(digest);
  const f = await fixture(planScript);
  try {
    const session = (await f.store.getSession('s'))!;
    const workspace = (await f.store.getWorkspace('w'))!;
    const command = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'bad',
      subjectId: 'user',
      sessionId: 's',
      request,
    };
    for (const [index, inputs] of [
      [intent, intent],
      [{ ...intent, input: { mode: 'full' } }],
      [{ ...intent, extensionId: 'unregistered' }],
      [{ ...intent, definitionVersion: '2' }],
    ].entries()) {
      const submitted = await f.runtime.submitCommand({
        ...command,
        commandId: `bad-${index}`,
        request: { ...request, extensionInputs: inputs },
      });
      await f.runtime.waitForCommand(submitted.id, { timeoutMs: 5000 });
      expect(f.credentialReads).toBe(0);
      expect(f.normal).toHaveLength(0);
    }
    await f.submit();
    await f.approvePlan('accept_edits');
    const run = await f.done();
    const original = (await f.store.getCommand(run.originCommandId))!;
    const before = f.credentialReads;
    const changed = createDefaultProcessConfiguration({
      profile: f.profile,
      credentialBackend: f.credentialBackend,
      planning: { allowWaiver: true },
    });
    let rejected: unknown;
    try {
      await changed.resolveRecoveryRunConfiguration!({
        command: original,
        run,
        session,
        workspace,
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code: string }).code).toBe('recovery_configuration_changed');
    expect(f.credentialReads).toBe(before);
    const reopened = await f.host.resolveRecoveryRunConfiguration!({
      command: original,
      run,
      session,
      workspace,
      signal: new AbortController().signal,
    });
    expect(reopened.snapshot).toMatchObject({
      planning: { intent: { mode: 'plan' }, requirePlan: true },
    });
    await reopened.dispose?.();
  } finally {
    await f.close();
  }
}, 25000);
