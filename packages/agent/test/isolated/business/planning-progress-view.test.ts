import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createPlanningValidation } from '../../../src/business/planning';
import type { ExtensionRecord, Json, ReadContext } from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const business = createPlanningValidation({ requirePlan: true });
  const plan = {
    planId: 'p',
    version: 1,
    title: 'Exact plan',
    body: 'Original body',
    steps: [{ id: 'one', title: 'Original step' }],
  };
  const digest = createHash('sha256').update(canonicalJson(plan)).digest('hex');
  const document = { ...plan, kind: 'plan_document', digest };
  const current = { kind: 'plan_current', key: 'plan/p/1', planId: 'p', version: 1, digest };
  const answer = { kind: 'plan_review', decision: 'approve' };
  const request = {
    kind: 'plan_review',
    planId: 'p',
    version: '1',
    digest,
    content: canonicalJson(document),
  };
  const proof = {
    interactionId: 'interaction',
    decisionRevision: '5',
    executionId: 'review',
    attempt: 1,
    answer,
  };
  const rows = new Map<string, ExtensionRecord>();
  const put = (key: string, value: unknown) =>
    rows.set(key, {
      key,
      originStoreId: 'store',
      sessionId: 'session',
      revision: '1',
      contentType: 'builtin.planning.record',
      contentVersion: 1,
      value,
    } as ExtensionRecord);
  put('run/run/plan.required', { kind: 'plan', runId: 'run', requirementId: 'plan.required' });
  put('plan.current', current);
  put('plan/p/1', document);
  put('run/run/approval/p/1', { kind: 'plan_approval', runId: 'run', proof, request });
  put('progress/p/1', {
    kind: 'plan_progress',
    runId: 'run',
    planId: 'p',
    version: 1,
    digest,
    steps: { one: { status: 'failed' } },
    completePlan: false,
  });
  let acceptedRevision: string | null = '5';
  const context = {
    sessionId: 'session',
    records: { get: async (key: string) => rows.get(key) ?? null },
    getRun: async (id: string) =>
      id === 'run'
        ? {
            id,
            sessionId: 'session',
            originStoreId: 'store',
            requirements: [
              {
                extensionId: 'builtin.planning',
                definitionVersion: '1',
                requirementId: 'plan.required',
                recordKey: 'run/run/plan.required',
                revision: rows.get('run/run/plan.required')?.revision ?? '1',
                sessionId: 'session',
                runId: 'run',
                originStoreId: 'store',
                phase: 'both',
              },
            ],
          }
        : { id, sessionId: 'other', originStoreId: 'store', requirements: [] },
    getInteraction: async () => ({
      kind: 'plan_review',
      state: 'answered',
      acceptedDecisionRevision: acceptedRevision,
      executionId: 'review',
      attempt: 1,
      originStoreId: 'store',
      sessionId: 'session',
      request,
      answer,
    }),
    getExecution: async () => ({
      id: 'review',
      runId: 'run',
      sessionId: 'session',
      originStoreId: 'store',
    }),
  } as unknown as ReadContext;
  const query = business.extension.queries!.find((item) => item.id === 'planning.progress.view')!;
  return {
    business,
    query,
    context,
    rows,
    put,
    rejectProof() {
      acceptedRevision = null;
    },
  };
}
test('plan approval observations preserve exact Run requirements without Agent phases or mutable step progress', async () => {
  const f = await fixture();
  const request = {
    sessionId: 'session',
    runId: 'run',
    workspaceId: 'workspace',
    definitionId: 'fixed',
    input: { kind: 'model_request' },
  };
  const capture = () => f.business.extension.context!.capture(request, f.context);
  const approved = await capture();
  const actual = approved.find((source) => source.placement === 'runtime')!;
  expect(actual.content).toContain('plan_requirement:');
  expect(actual.content).toContain('"status":"approved"');
  expect(actual.content).toContain('"planId":"p"');
  expect(actual.content).toContain('Do not ask again');
  expect(actual.content).toContain('current tool permissions');
  expect(actual.content).not.toContain('phase:');
  expect(actual.content).not.toContain('building');
  f.put('progress/p/1', {
    ...(f.rows.get('progress/p/1')!.value as Record<string, Json>),
    steps: { one: { status: 'completed', receipt: { executionId: 'original-effect' } } },
  });
  expect(await capture()).toEqual(approved);
  f.rejectProof();
  const pending = (await capture()).find((source) => source.placement === 'runtime')!;
  expect(pending.content).toContain('"status":"pending"');
  expect(pending.content).not.toContain('Do not ask again');
  expect(pending.content).not.toContain('phase:');
  f.rows.delete('run/run/plan.required');
  await expect(capture()).rejects.toThrow('planning_run_mismatch');
  f.context.getRun = async (id: string) => ({
    id,
    sessionId: 'session',
    originStoreId: 'store',
    requirements: [],
    status: 'running',
    isActive: true,
    createdAt: 0,
    finishedAt: null,
  });
  const disabled = (await capture()).find((source) => source.placement === 'runtime')!;
  expect(disabled.content).toContain('"status":"disabled"');
  expect(disabled.content).not.toContain('Do not ask again');
  expect(disabled.content).not.toContain('phase:');
});
test('approved continuation guidance does not survive a changed plan digest or a successor Run', async () => {
  for (const change of ['digest', 'run'] as const) {
    const f = await fixture();
    const request = {
      sessionId: 'session',
      runId: 'run',
      workspaceId: 'workspace',
      definitionId: 'fixed',
      input: { kind: 'model_request' },
    };
    const capture = () => f.business.extension.context!.capture(request, f.context);
    expect((await capture()).find((source) => source.placement === 'runtime')!.content).toContain(
      'Do not ask again',
    );
    if (change === 'digest') {
      f.put('plan.current', {
        ...(f.rows.get('plan.current')!.value as Record<string, Json>),
        digest: 'changed-digest',
      });
    } else {
      const getRun = f.context.getRun;
      f.put('run/next/plan.required', {
        kind: 'plan',
        runId: 'next',
        requirementId: 'plan.required',
      });
      f.context.getRun = async (id) => {
        const original = await getRun('run');
        return id === 'next'
          ? {
              ...original!,
              id,
              requirements: original!.requirements.map((ref) => ({
                ...ref,
                runId: id,
                recordKey: 'run/next/plan.required',
              })),
            }
          : getRun(id);
      };
      request.runId = 'next';
    }
    const runtime = (await capture()).find((source) => source.placement === 'runtime')!;
    expect(runtime.content).toContain('"status":"pending"');
    expect(runtime.content).not.toContain('Do not ask again');
    expect(
      await f.business.readPlanningState(f.context, {
        runId: request.runId,
        originStoreId: 'store',
      }),
    ).toEqual({ status: 'pending' });
  }
});
test('planning progress query verifies accepted original proof and exposes exact failed progress without changing status query', async () => {
  const f = await fixture(),
    parts = await f.query.execute({ runId: 'run' }, f.context);
  const body = parts[0]!.payload as Record<string, Json>;
  expect(body.approvalStatus).toBe('approved');
  expect(body.runId).toBe('run');
  expect(body.originStoreId).toBe('store');
  expect((body.plan as Record<string, Json>).steps).toEqual([
    { id: 'one', title: 'Original step' },
  ]);
  expect((body.progress as Record<string, Json>).steps).toEqual({ one: { status: 'failed' } });
  const status = createPlanningValidation().extension.queries!.find(
    (item) => item.id === 'planning.status',
  )!;
  expect((await status.execute({}, f.context))[0]!.payload).toEqual(
    f.rows.get('plan.current')!.value,
  );
});
test('unaccepted or stale proof does not expose approved progress and foreign session Run is rejected', async () => {
  const f = await fixture();
  f.rejectProof();
  const body = (await f.query.execute({ runId: 'run' }, f.context))[0]!.payload as Record<
    string,
    Json
  >;
  expect(body.approvalStatus).toBe('pending');
  expect(body.plan).toBeNull();
  expect(body.progress).toBeNull();
  await expect(f.query.execute({ runId: 'foreign' }, f.context)).rejects.toThrow(
    'planning_run_mismatch',
  );
});

test('actual ExtensionHost reads a real accepted plan proof and current document from the stored Run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-plan-query-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const business = createPlanningValidation({ requirePlan: true });
  let step = 0;
  let postApprovalInput: string | undefined;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixed',
    extensions: [business.extension],
    initializeRunRequirements: (input) => business.initializeRequirements(input),
    conditions: business.conditions,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    model: {
      async *stream(request, { signal }) {
        if (step === 0) {
          step++;
          yield {
            type: 'tool_call',
            id: 'write',
            name: 'write_plan',
            arguments: JSON.stringify({
              plan_id: 'actual',
              title: 'Approved actual plan',
              body: 'Actual original content',
              steps: [{ id: 'one', title: 'Actual step' }],
            }),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else if (step === 1) {
          step++;
          const write = (await store.listExecutions('s')).find(
            (row) => row.definitionId === 'planning.write' && row.status === 'succeeded',
          )!;
          const planRef = (write.result as { details: Record<string, Json> }).details.plan_ref!;
          yield {
            type: 'tool_call',
            id: 'review',
            name: 'request_plan_review',
            arguments: JSON.stringify({
              plan_ref: planRef,
            }),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          postApprovalInput = JSON.stringify(request);
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'actual plan',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Plan actual work' },
    });
    const until = Date.now() + 5000;
    let interaction:
      | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
      | undefined;
    while (!interaction) {
      interaction = (
        await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions.find((item) => item.kind === 'plan_review');
      if (Date.now() > until) throw Error('plan_query_timeout');
      if (!interaction) await Bun.sleep(5);
    }
    const runId = (await runtime.getView('s')).runs.find(
      (run) => run.originCommandId === 'work',
    )!.id;
    await runtime.answerInteraction({
      ...base,
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      answer: { kind: 'plan_review', decision: 'approve' },
    });
    let parts: Awaited<ReturnType<typeof runtime.queryExtension>> = [];
    do {
      parts = await runtime.queryExtension({
        ...base,
        extensionId: 'builtin.planning',
        queryId: 'planning.progress.view',
        input: { runId },
      });
      if ((parts[0]!.payload as Record<string, Json>).approvalStatus !== 'approved')
        await Bun.sleep(5);
      if (Date.now() > until) throw Error('plan_approval_query_timeout');
    } while ((parts[0]!.payload as Record<string, Json>).approvalStatus !== 'approved');
    const body = parts[0]!.payload as Record<string, Json>;
    expect(body.originStoreId).toBe(expectedStoreId);
    expect(body.runId).toBe(runId);
    expect((body.plan as Record<string, Json>).steps).toEqual([
      { id: 'one', title: 'Actual step' },
    ]);
    expect(body.progress).toBeNull();
    while (postApprovalInput === undefined) {
      if (Date.now() > until) throw Error('postapproval_input_timeout');
      await Bun.sleep(5);
    }
    expect(postApprovalInput).toContain('Do not ask again');
    expect(postApprovalInput).toContain('current tool permissions');
    await runtime.cancelCommand({ ...base, commandId: 'cancel', targetCommandId: 'work' });
    await runtime.waitForCommand('work');
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
