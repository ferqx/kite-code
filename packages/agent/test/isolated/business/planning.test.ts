import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { interactionAttachment } from '@kite-ai/client';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import {
  createPlanningValidation,
  type PlanningOptions,
  type PlanningRunPolicy,
  planningExtensionId,
} from '../../../src/business/planning';
import type {
  Extension,
  Json,
  NecessaryConditions,
  ToolContext,
  ToolDefinition,
} from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionAnswer } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json = {}): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + 5000;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() > until) throw new Error('planning_test_timeout');
    await Bun.sleep(5);
  }
}
type Script = (step: number, f: Awaited<ReturnType<typeof fixture>>) => Promise<ModelEvent[]>;
async function fixture(
  options: PlanningOptions,
  script: Script,
  useConditions = true,
  decorate?: (extension: Extension) => Extension,
  runPolicy?: PlanningRunPolicy,
  afterEvaluation?: (
    args: Parameters<NecessaryConditions['evaluate']>,
    f: Awaited<ReturnType<typeof fixture>>,
  ) => Promise<void>,
  extraExtensions: readonly Extension[] = [],
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-business-planning-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const business = createPlanningValidation(options);
  const files = createWorkspaceFiles({ root });
  const artifacts = createArtifactStore({
    profile: { dataRoot: join(root, 'data'), profile: 'new' },
    store,
  });
  const evaluations: Awaited<ReturnType<NecessaryConditions['evaluate']>>[] = [];
  const modelRequests: ModelRequest[] = [];
  let steps = 0,
    effects = 0,
    jobStarts = 0;
  const model: ModelAdapter = {
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      modelRequests.push(request);
      for (const event of await script(steps++, f)) yield event;
    },
  };
  const effect: ToolDefinition = {
    id: 'fixture.effect',
    version: '3',
    description: 'Actual harmless effect',
    inputSchema: { type: 'object' },
    async execute(input) {
      const value = input as Record<string, Json>;
      effects++;
      return {
        outcome:
          value.status === 'failed'
            ? 'failed'
            : value.status === 'unknown'
              ? 'outcome_unknown'
              : 'succeeded',
        content: 'actual receipt',
      };
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    extensions: [
      decorate ? decorate(business.extension) : business.extension,
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          effect,
          ...createFileTools(files),
          {
            id: 'fixture.publish',
            version: '1',
            description: 'Actual scoped Artifact',
            inputSchema: { type: 'object' },
            async execute(input, context) {
              const ref = await context.artifacts!.publish({
                key: 'json',
                content: new TextEncoder().encode(JSON.stringify(input)),
                mediaType: 'application/json',
              });
              return { outcome: 'succeeded', content: 'published', artifactRefs: [ref] };
            },
          },
          {
            id: 'fixture.launch',
            version: '1',
            description: 'Actual parent Tool for a finite ordinary Job',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const operation = await context.operations.ensure({
                key: 'job-proof',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.job',
                  definitionVersion: '1',
                  input: {},
                },
              });
              const execution = await context.operations.wait(operation);
              return {
                outcome: 'succeeded',
                content: 'Job observed',
                details: { executionId: execution.id },
              };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Harmless finite ordinary Job',
            inputSchema: { type: 'object' },
            async start() {
              jobStarts++;
              return { reference: {} };
            },
            async *observe() {
              yield {
                type: 'terminal',
                supervision: 'ended',
                result: { outcome: 'succeeded', content: 'Actual Job receipt' },
              } as const;
            },
            async cancel() {
              return { status: 'already_finished' as const };
            },
            async dispose() {},
          },
        ],
      },
      ...extraExtensions,
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'host-1' };
      },
    },
    initializeRunRequirements: (input) => business.initializeRequirements(input, runPolicy),
    ...(useConditions
      ? {
          conditions: {
            async evaluate(...args: Parameters<NecessaryConditions['evaluate']>) {
              const result = await business.conditions.evaluate(...args);
              evaluations.push(result);
              await afterEvaluation?.(args, f);
              return result;
            },
          },
        }
      : {}),
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'temporary',
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'business',
  });
  const f = {
    root,
    files,
    store,
    runtime,
    business,
    evaluations,
    modelRequests,
    base,
    get jobStarts() {
      return jobStarts;
    },
    get effects() {
      return effects;
    },
    get steps() {
      return steps;
    },
    async record(key: string) {
      return store.getExtensionRecord({ sessionId: 's', extensionId: planningExtensionId, key });
    },
    async planRef(plan: Record<string, Json>): Promise<string> {
      for (const row of (await store.listExecutions('s')).reverse()) {
        const data = (row.result as { details?: Record<string, Json> } | null)?.details;
        const original = (data?.current ?? data) as Record<string, Json> | undefined;
        if (
          row.status === 'succeeded' &&
          typeof data?.plan_ref === 'string' &&
          original?.planId === plan.planId &&
          original?.version === plan.version &&
          original?.digest === plan.digest
        )
          return data.plan_ref;
      }
      throw Error('fixture_exact_plan_reference_missing');
    },
    async progressRef(revision: string | null): Promise<string | null> {
      if (revision === null) return null;
      for (const row of (await store.listExecutions('s')).reverse()) {
        const data = (row.result as { details?: Record<string, Json> } | null)?.details;
        const original = (data?.progress ?? data) as Record<string, Json> | undefined;
        if (
          row.status === 'succeeded' &&
          typeof data?.progress_ref === 'string' &&
          original?.revision === revision
        )
          return data.progress_ref;
      }
      throw Error('fixture_exact_progress_reference_missing');
    },
    async runId() {
      return (await store.listExecutions('s')).find((x) => x.runId !== null)!.runId!;
    },
    async submit(commandId = 'work') {
      return runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: '新任务：explicit business task' },
      });
    },
    async done(commandId = 'work', timeoutMs = 5000) {
      const command = await runtime.waitForCommand(commandId, { timeoutMs });
      return store.getRun((command.receipt as { runId: string }).runId);
    },
    async pending() {
      return eventually(
        async () =>
          (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async answer(answer: InteractionAnswer) {
      const card = await f.pending();
      await runtime.answerInteraction({
        ...base,
        commandId: `answer-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer,
      });
      return card;
    },
    async close() {
      await runtime.close();
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
const plan = (version: number | null) => ({
  planId: 'p',
  expectedVersion: version,
  title: 'Plan',
  body: 'Harmless precise task',
  steps: [{ id: 'a', title: 'effect' }],
});
const modelPlan = (_version: number | null) => ({
  plan_id: 'p',
  title: 'Plan',
  body: 'Harmless precise task',
  steps: [{ id: 'a', title: 'effect' }],
});

test('model progress binds the actual current Run and rejects a supplied Run instead of correcting its identity', async () => {
  const f = await fixture({ requirePlan: true }, async (step, current) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    const plan = (await current.record('plan.current'))!.value as Record<string, Json>;
    if (step === 1)
      return call('request_plan_review', {
        plan_ref: await current.planRef({
          planId: plan.planId!,
          version: plan.version!,
          digest: plan.digest!,
        }),
      });
    if (step === 2) return call('fixture.effect');
    if (step >= 3 && step <= 5) {
      if (step === 5) {
        const feedback = current.modelRequests
          .at(-1)!
          .messages.filter((m) => m.role === 'tool')
          .at(-1)!;
        expect(feedback.content).toContain("must have required property 'plan_ref'");
      }
      const effect = (await current.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.effect',
      )!;
      return call('update_plan_progress', {
        ...(step === 3 ? { run_id: 'forged-current-run' } : {}),
        ...(step === 4 ? {} : { plan_ref: await current.planRef(plan) }),
        progress_ref: null,
        step_id: 'a',
        status: 'completed',
        execution_id: effect.id,
        complete_plan: true,
      });
    }
    return [finish];
  });
  try {
    await f.submit();
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    expect(await f.done()).toMatchObject({ status: 'completed' });
    const schema = f.modelRequests[0]!.tools.find(
      (tool) => tool.id === 'update_plan_progress',
    )!.inputSchema;
    expect(schema.properties).not.toHaveProperty('run_id');
    const updates = (await f.store.listExecutions('s')).filter(
      (execution) => execution.definitionId === 'planning.update',
    );
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({
      status: 'failed',
      result: { details: { code: 'invalid_tool_arguments' } },
    });
    expect(updates[1]).toMatchObject({
      status: 'failed',
      result: {
        details: {
          code: 'invalid_tool_arguments',
          schemaError: "#/required: must have required property 'plan_ref'",
        },
      },
    });
    expect(updates[2]).toMatchObject({ status: 'succeeded', runId: await f.runId() });
    expect(updates[2]!.input).not.toHaveProperty('runId');
    expect((await f.record('progress/p/1'))!.value).toMatchObject({
      runId: await f.runId(),
      completePlan: true,
    });
    expect(f.effects).toBe(1);
  } finally {
    await f.close();
  }
});

test('canonical progress keeps explicit Run validation and the user Action still requires its original Run field', async () => {
  const extension = createPlanningValidation().extension;
  const tool = extension.tools!.find((item) => item.id === 'planning.update')!;
  const action = extension.actions!.find((item) => item.id === 'planning.update')!;
  expect(action.inputSchema.required).toContain('runId');
  const context = {
    executionId: 'actual-tool',
    runId: 'actual-child-run',
    getExecution: async () => ({ id: 'actual-tool', runId: 'actual-child-run' }),
    getRun: async () => {
      throw Error('wrong_run_must_fail_before_further_reads');
    },
  } as unknown as ToolContext;
  expect(await tool.execute({ runId: 'parent-run' }, context)).toMatchObject({
    outcome: 'failed',
    content: 'planning_run_mismatch',
  });
});

test('actual plan review feedback reaches the next Model input and revised v2 needs exact new approval before effects', async () => {
  const feedback = '  请调整方案 🪁\n保留组合字符 e\u0301 与原换行\n  ';
  const approvalFeedback = '批准新版 ✅\n请按这个方案执行 e\u0301';
  const f = await fixture({ requirePlan: true }, async (step, f) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    if (step === 1 || step === 5) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
      });
    }
    if (step === 2 || step === 4 || step === 6) return call('fixture.effect');
    if (step === 3)
      return call('write_plan', {
        ...modelPlan(null),
        expected_plan_ref: await f.planRef(
          (await f.record('plan.current'))!.value as Record<string, Json>,
        ),
        body: feedback,
      });
    if (step === 7) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      const effect = (await f.store.listExecutions('s')).find(
        (execution) =>
          execution.definitionId === 'fixture.effect' && execution.status === 'succeeded',
      )!;
      return call('update_plan_progress', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
        progress_ref: null,
        step_id: 'a',
        status: 'completed',
        execution_id: effect.id,
        complete_plan: true,
      });
    }
    return [finish];
  });
  const lastResult = (step: number) =>
    JSON.parse(
      f.modelRequests[step]!.messages.filter((message) => message.role === 'tool').at(-1)!.content,
    );
  try {
    await f.submit();
    const original = await f.answer({ kind: 'plan_review', decision: 'revise', feedback });
    const revised = await f.pending();
    // This is the actual next Model adapter input, after the accepted SQLite receipt.
    expect(lastResult(2)).toEqual({ status: 'not_approved', decision: 'revise', feedback });
    expect(
      (await f.runtime.getInteraction({ ...f.base, interactionId: original.id }))!.answer,
    ).toEqual({ kind: 'plan_review', decision: 'revise', feedback });
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${await f.runId()}/approval/p/1`)).toBeNull();
    expect(await f.record(`run/${await f.runId()}/approval/p/2`)).toBeNull();
    expect(revised.request).toMatchObject({ version: '2' });
    expect(JSON.parse((revised.request as { content: string }).content).body).toBe(feedback);
    await f.answer({
      kind: 'plan_review',
      decision: 'approve',
      feedback: approvalFeedback,
    });
    const run = await f.done();
    expect(lastResult(6)).toEqual({
      status: 'approved',
      decision: 'approve',
      feedback: approvalFeedback,
    });
    expect(run!.status).toBe('completed');
    expect(f.effects).toBe(1);
    expect((await f.record('progress/p/2'))!.value).toMatchObject({ completePlan: true });
    expect((await f.record(`run/${run!.id}/approval/p/2`))!.value).toMatchObject({
      proof: {
        interactionId: revised.id,
        answer: { decision: 'approve', feedback: approvalFeedback },
      },
    });
  } finally {
    await f.close();
  }
});

test('denied plan preserves its receipt and stops the original work without another Model', async () => {
  const f = await fixture({ requirePlan: true, completionGuidance: true }, async (step, f) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
      });
    }
    if (step > 3) throw new Error('fixture_duplicate_completion_model');
    return [finish];
  });
  try {
    await f.submit();
    const card = await f.answer({ kind: 'plan_review', decision: 'deny' });
    const settled = await f.done();
    const run = await eventually(async () => {
      const value = await f.store.getRun(settled!.id);
      return value && !value.isActive ? value : null;
    });
    expect(run.status).toBe('cancelled');
    expect(f.steps).toBe(2);
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
    expect(await f.runtime.getInteraction({ ...f.base, interactionId: card.id })).toMatchObject({
      state: 'answered',
      answer: { kind: 'plan_review', decision: 'deny' },
      acceptedDecisionRevision: expect.any(String),
    });
    const review = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'planning.review',
    )!;
    expect(review).toMatchObject({
      status: 'succeeded',
      result: {
        content: '用户拒绝了该计划，已停止本轮对话',
        details: { status: 'not_approved', decision: 'deny' },
        control: { kind: 'stop_work' },
      },
    });
    expect((await f.store.listExecutions('s')).every((e) => e.status === 'succeeded')).toBe(true);
  } finally {
    await f.close();
  }
});

test('actual plan denial stops its work while empty revision preserves next-Model feedback; invalid answers grant no effects', async () => {
  for (const answer of [
    { kind: 'plan_review', decision: 'deny', feedback: '拒绝当前方案\n e\u0301' },
    { kind: 'plan_review', decision: 'revise', feedback: '' },
  ] as const) {
    const f = await fixture({ requirePlan: true }, async (step, f) => {
      if (step === 0) return call('write_plan', modelPlan(null));
      if (step === 1) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('request_plan_review', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
        });
      }
      return step === 2 ? call('fixture.effect') : [finish];
    });
    try {
      await f.submit();
      const pending = await f.pending();
      let invalidAnswer: unknown;
      try {
        await f.runtime.answerInteraction({
          ...f.base,
          commandId: 'invalid-kind',
          presentationSessionId: 's',
          interactionId: pending.id,
          expectedRevision: pending.revision,
          answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
        });
      } catch (error) {
        invalidAnswer = error;
      }
      await f.answer(answer);
      const run = await f.done();
      expect((invalidAnswer as { code?: string })?.code).toBe('interaction_answer_invalid');
      const reviewResult =
        answer.decision === 'deny'
          ? (
              (await f.store.listExecutions('s')).find(
                (row) => row.definitionId === 'planning.review',
              )!.result as Record<string, Json>
            ).details
          : JSON.parse(
              f.modelRequests[2]!.messages.filter((message) => message.role === 'tool').at(-1)!
                .content,
            );
      expect(reviewResult).toEqual({
        status: 'not_approved',
        decision: answer.decision,
        feedback: answer.feedback,
      });
      expect(run!.status).toBe(answer.decision === 'deny' ? 'cancelled' : 'failed');
      if (answer.decision === 'deny') expect(f.modelRequests).toHaveLength(2);
      expect(f.effects).toBe(0);
      expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
      expect((await f.record('plan.current'))!.value).toMatchObject({ version: 1 });
    } finally {
      await f.close();
    }
  }
}, 20000);

test('actual plan review binds the original decision/current digest; v2 invalidates v1 and only fresh user review permits the second effect', async () => {
  for (const scenario of ['no-review', 'new-receipt', 'old-receipt'] as const) {
    const reviewV2 = scenario !== 'no-review';
    const f = await fixture({ requirePlan: true }, async (step, f) => {
      if (step === 0) return call('write_plan', modelPlan(null));
      if (step === 1 || (reviewV2 && step === 4)) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('request_plan_review', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
        });
      }
      if (step === 2 || step === (reviewV2 ? 5 : 4)) return call('fixture.effect');
      if (step === 3)
        return call('write_plan', {
          ...modelPlan(null),
          expected_plan_ref: await f.planRef(
            (await f.record('plan.current'))!.value as Record<string, Json>,
          ),
        });
      if (reviewV2 && step === 6) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        const effects = (await f.store.listExecutions('s')).filter(
          (e) => e.definitionId === 'fixture.effect' && e.status === 'succeeded',
        );
        return call('update_plan_progress', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
          progress_ref: null,
          step_id: 'a',
          status: 'completed',
          execution_id: effects.find((e) =>
            (e.decisionSource as { sources: { id: string }[] }).sources.some(
              (source) =>
                source.id ===
                (scenario === 'old-receipt' ? 'builtin.planning:s:p:1' : 'builtin.planning:s:p:2'),
            ),
          )!.id,
          complete_plan: true,
        });
      }
      return [finish];
    });
    try {
      await f.submit();
      const old = await f.answer({
        kind: 'plan_review',
        decision: 'approve',
      });
      expect(old.request).toMatchObject({ version: '1' });
      expect(old.request).not.toHaveProperty('allowedModes');
      expect(JSON.parse((old.request as { content: string }).content).body).toBe(
        'Harmless precise task',
      );
      expect((old.request as Record<string, Json>).plan).toBeUndefined();
      if (reviewV2) await f.answer({ kind: 'plan_review', decision: 'approve' });
      const run = await f.done();
      expect(run!.status).toBe(scenario === 'new-receipt' ? 'completed' : 'failed');
      expect(f.effects).toBe(reviewV2 ? 2 : 1);
      expect(run!.requirements).toHaveLength(1);
      const progress = await f.record('progress/p/2');
      expect(progress === null).toBe(scenario !== 'new-receipt');
      if (progress)
        expect(progress.value).toMatchObject({
          completePlan: true,
          runId: run!.id,
          steps: { a: { status: 'completed' } },
        });
      const approval = (await f.record(`run/${run!.id}/approval/p/1`))!.value as {
        proof: { interactionId: string; answer: { decision: string } };
      };
      expect(approval.proof.interactionId).toBe(old.id);
      expect(approval.proof.answer.decision).toBe('approve');
      expect(approval.proof.answer).not.toHaveProperty('mode');
      expect((await f.record('plan.current'))!.value).toMatchObject({ version: 2 });
      expect(
        (await f.runtime.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          interactionId: old.id,
        }))!.acceptedDecisionRevision,
      ).not.toBeNull();
    } finally {
      await f.close();
    }
  }
}, 20000);

test('compensation requires prior completion and a distinct real receipt, preserves original facts, and cannot finish the plan', async () => {
  for (const scenario of ['distinct', 'no-prior', 'same-receipt'] as const) {
    const f = await fixture({ requirePlan: true }, async (step, f) => {
      if (step === 0) return call('write_plan', modelPlan(null));
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return call('request_plan_review', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
        });
      if (step === 2 || (scenario === 'distinct' && step === 4)) return call('fixture.effect');
      if (
        step === 3 ||
        (scenario === 'same-receipt' && step === 4) ||
        (scenario === 'distinct' && step === 5)
      ) {
        const effects = (await f.store.listExecutions('s')).filter(
          (e) => e.definitionId === 'fixture.effect' && e.status === 'succeeded',
        );
        const progress = await f.record('progress/p/1');
        const originalId = progress
          ? (progress.value as { steps: { a: { receipt: { executionId: string } } } }).steps.a
              .receipt.executionId
          : null;
        return call('update_plan_progress', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
          progress_ref: await f.progressRef(progress?.revision ?? null),
          step_id: 'a',
          status: step === 3 && scenario !== 'no-prior' ? 'completed' : 'compensated',
          execution_id:
            scenario === 'distinct' && step === 5
              ? effects.find((e) => e.id !== originalId)!.id
              : effects[0]!.id,
          complete_plan: false,
        });
      }
      return [finish];
    });
    try {
      await f.submit();
      await f.answer({ kind: 'plan_review', decision: 'approve' });
      expect((await f.done())!.status).toBe('failed');
      expect(f.effects).toBe(scenario === 'distinct' ? 2 : 1);
      const record = await f.record('progress/p/1');
      if (scenario === 'no-prior') expect(record).toBeNull();
      else {
        const progress = record!.value as {
          steps: {
            a: {
              status: string;
              receipt: { executionId: string };
              originalReceipt?: { executionId: string };
            };
          };
          completePlan: boolean;
        };
        expect(progress.steps.a.status).toBe(scenario === 'distinct' ? 'compensated' : 'completed');
        expect(progress.completePlan).toBe(false);
        if (scenario === 'distinct') {
          expect(progress.steps.a.originalReceipt!.executionId).not.toBe(
            progress.steps.a.receipt.executionId,
          );
          expect(
            (await f.store.getExecution(progress.steps.a.originalReceipt!.executionId))!.status,
          ).toBe('succeeded');
        } else expect(record!.revision).toBe('1');
      }
      expect((await f.record('plan.current'))!.value).toMatchObject({ version: 1 });
    } finally {
      await f.close();
    }
  }
}, 15000);

test('planning.write retains its original pointer CAS when a real nested writer selects another plan', async () => {
  let nestedExecutionId = '';
  const f = await fixture(
    {},
    async (step) =>
      step === 0 ? call('write_plan', { ...modelPlan(null), plan_id: 'old' }) : [finish],
    true,
    (extension) => ({
      ...extension,
      tools: extension.tools!.map((tool) =>
        tool.id !== 'planning.write'
          ? tool
          : {
              ...tool,
              async execute(input, context) {
                if ((input as { planId: string }).planId !== 'old')
                  return tool.execute(input, context);
                return tool.execute(input, {
                  ...context,
                  records: {
                    ...context.records,
                    async write(value) {
                      const saved = await context.records.write(value);
                      if (value.key === 'plan/old/1') {
                        const operation = await context.operations.ensure({
                          key: 'concurrent-plan',
                          request: {
                            kind: 'tool',
                            definitionId: 'planning.write',
                            definitionVersion: '1',
                            input: {
                              planId: 'new',
                              title: 'Plan',
                              body: 'Harmless precise task',
                              steps: [{ id: 'a', title: 'effect' }],
                            },
                          },
                        });
                        nestedExecutionId = (await context.operations.wait(operation)).id;
                      }
                      return saved;
                    },
                  },
                });
              },
            },
      ),
    }),
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    expect((await f.record('plan.current'))!.value).toMatchObject({ planId: 'new', version: 1 });
    expect((await f.record('plan.current'))!.revision).toBe('1');
    expect(await f.record('plan/old/1')).not.toBeNull();
    const executions = (await f.store.listExecutions('s')).filter(
      (e) => e.definitionId === 'planning.write',
    );
    expect(executions.find((e) => e.id === nestedExecutionId)!.status).toBe('succeeded');
    expect(executions.find((e) => e.id !== nestedExecutionId)!.status).toBe('failed');
    expect(executions.find((e) => e.id !== nestedExecutionId)!.result).toMatchObject({
      outcome: 'failed',
      content: 'record_revision_conflict',
    });
  } finally {
    await f.close();
  }
}, 10000);

test('planning.update preserves a concurrent same-namespace progress update instead of replacing it with old steps', async () => {
  let runId = '';
  const f = await fixture(
    {},
    async (step, f) => {
      if (step === 0) {
        runId = await f.runId();
        return call('write_plan', {
          ...modelPlan(null),
          steps: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
          ],
        });
      }
      if (step === 1) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('update_plan_progress', {
          plan_ref: await f.planRef({ planId: 'p', version: 1, digest: current.digest! }),
          progress_ref: null,
          step_id: 'a',
          status: 'running',
        });
      }
      return [finish];
    },
    true,
    (extension) => ({
      ...extension,
      tools: [
        ...extension.tools!.map((tool) =>
          tool.id !== 'planning.update'
            ? tool
            : {
                ...tool,
                async execute(input: Json, context: ToolContext) {
                  return tool.execute(input, {
                    ...context,
                    records: {
                      ...context.records,
                      async write(value) {
                        const saved = await context.records.write(value);
                        if (value.key.startsWith('progress/p/1/attempt/')) {
                          const operation = await context.operations.ensure({
                            key: 'concurrent-progress',
                            request: {
                              kind: 'tool',
                              definitionId: 'fixture.progress',
                              definitionVersion: '1',
                              input: { runId },
                            },
                          });
                          expect((await context.operations.wait(operation)).status).toBe(
                            'succeeded',
                          );
                        }
                        return saved;
                      },
                    },
                  });
                },
              },
        ),
        {
          id: 'fixture.progress',
          version: '1',
          description: 'Controlled legitimate namespace record update',
          inputSchema: { type: 'object' },
          async execute(input, context) {
            const pointer = (await context.records.get('plan.current'))!.value as Record<
              string,
              Json
            >;
            await context.records.write({
              key: 'progress/p/1',
              expectedRevision: null,
              contentType: 'builtin.planning.record',
              contentVersion: 1,
              executable: true,
              value: {
                kind: 'plan_progress',
                runId: (input as { runId: string }).runId,
                planId: 'p',
                version: 1,
                digest: pointer.digest!,
                steps: { b: { status: 'running', receipt: null } },
                completePlan: false,
              },
            });
            return { outcome: 'succeeded', content: 'Concurrent progress persisted' };
          },
        },
      ],
    }),
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    const progress = (await f.record('progress/p/1'))!;
    expect(progress.revision).toBe('1');
    expect(progress.value).toMatchObject({ steps: { b: { status: 'running' } } });
    expect((progress.value as { steps: Record<string, Json> }).steps.a).toBeUndefined();
    const update = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'planning.update',
    )!;
    expect(update.status).toBe('failed');
    expect(update.result).toMatchObject({ content: 'record_revision_conflict' });
    expect(await f.record(`progress/p/1/attempt/${update.id}`)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 10000);

test('single-Run host policy monotonically requires planning and matches only sealed exact readonly Tool versions', async () => {
  for (const version of ['3', '4']) {
    const policy: PlanningRunPolicy = {
      requirePlan: true,
      readOnlyDefinitions: [
        { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: version },
      ],
    };
    const f = await fixture(
      {},
      async (step) => (step === 0 ? call('fixture.effect') : [finish]),
      true,
      undefined,
      policy,
    );
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(f.effects).toBe(version === '3' ? 1 : 0);
      expect((await f.record(`run/${run!.id}/plan.required`))!.value).toMatchObject({
        readOnlyDefinitions: policy.readOnlyDefinitions,
      });
    } finally {
      await f.close();
    }
  }
  const f = await fixture(
    { requirePlan: true },
    async (step) => (step === 0 ? call('fixture.effect') : [finish]),
    true,
    undefined,
    { requirePlan: false },
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('failed');
    expect(f.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('host-qualified readonly parent Tool cannot authorize its ordinary Job before exact plan approval', async () => {
  const f = await fixture(
    {},
    async (step) => (step === 0 ? call('fixture.launch') : [finish]),
    true,
    undefined,
    {
      requirePlan: true,
      readOnlyDefinitions: [
        { kind: 'tool', definitionId: 'fixture.launch', definitionVersion: '1' },
      ],
    },
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('failed');
    const job = (await f.store.listExecutions('s')).find((execution) => execution.kind === 'job')!;
    expect(job.status).toBe('failed');
    expect(f.jobStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual accepted plan approval is exclusive to its original Run and old completed approval contributes no authority', async () => {
  const f = await fixture({ requirePlan: true }, async (step, f) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
      });
    }
    if (step === 2 || step === 4) return call('fixture.effect');
    return [finish];
  });
  const read = {
    sessionId: 's',
    getRun: (id: string) => f.runtime.getRun(id),
    getExecution: (id: string) => f.runtime.getExecution(id),
    getInteraction: (id: string) =>
      f.runtime.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: id,
      }),
    records: { get: (key: string) => f.record(key) },
  };
  try {
    await f.submit('first');
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    const first = await f.done('first');
    expect(f.effects).toBe(1);
    const state = await f.business.readPlanningState(read, {
      runId: first!.id,
      originStoreId: f.base.expectedStoreId,
    });
    expect(state).toMatchObject({
      status: 'approved',
      planId: 'p',
      version: 1,
    });
    const sources = await f.business
      .sourcesFor(async () => ({ ...read, records: { ...read.records, list: async () => [] } }))
      .capture({ sessionId: 's', workspaceId: 'w', definitionId: 'fixed', input: {} });
    expect(JSON.parse(sources[0]!.content).approval).toBeNull();
    await f.submit('second');
    const second = await f.done('second');
    expect(second!.status).toBe('failed');
    expect(f.effects).toBe(1);
    expect(
      await f.business.readPlanningState(read, {
        runId: second!.id,
        originStoreId: f.base.expectedStoreId,
      }),
    ).toEqual({ status: 'pending' });
    expect(await f.record(`run/${first!.id}/approval/p/1`)).not.toBeNull();
    expect(await f.record(`run/${second!.id}/approval/p/1`)).toBeNull();
  } finally {
    await f.close();
  }
});

test('a real runless user Action review remains readable and cannot grant a later Run', async () => {
  const f = await fixture({ requirePlan: true }, async (step) =>
    step === 0 ? call('fixture.effect') : [finish],
  );
  const invoke = (commandId: string, actionId: string, input: Json) =>
    f.runtime.submitCommand({
      ...f.base,
      commandId,
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId,
        definitionVersion: '1',
        input,
      },
    });
  try {
    await invoke('write', 'planning.write', plan(null));
    await f.runtime.waitForCommand('write', { timeoutMs: 5000 });
    const current = (await f.record('plan.current'))!.value as Record<string, Json>;
    await invoke('review', 'planning.review', {
      planId: current.planId!,
      version: current.version!,
      digest: current.digest!,
    });
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    await f.runtime.waitForCommand('review', { timeoutMs: 5000 });
    expect((await f.record('approval.current/p/1'))!.value).toMatchObject({ runId: null });
    expect(await f.record('approval/p/1')).toBeNull();
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
  } finally {
    await f.close();
  }
});

test('an accepted original plan cannot dispatch effects after its actual condition read-set drifts before final SQLite CAS', async () => {
  let drifted = false;
  const f = await fixture(
    { requirePlan: true },
    async (step, f) => {
      if (step === 0) return call('write_plan', modelPlan(null));
      if (step === 1) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('request_plan_review', {
          plan_ref: await f.planRef({
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
          }),
        });
      }
      if (step === 2) return call('fixture.effect');
      return [finish];
    },
    true,
    undefined,
    undefined,
    async (args, f) => {
      if (drifted || args[1] !== 'dispatch' || args[2]?.boundary.definitionId !== 'fixture.effect')
        return;
      drifted = true;
      // Exact barrier after the business evaluator read the original head; unrelated SQL connection models a committed concurrent writer.
      const db = new Database(join(f.root, 'data', 'new', 'core.db'));
      try {
        db.run(
          "UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key='plan.current'",
          [planningExtensionId, 's'],
        );
      } finally {
        db.close();
      }
    },
  );
  try {
    await f.submit();
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    expect((await f.done())!.status).toBe('failed');
    expect(drifted).toBe(true);
    expect(f.effects).toBe(0);
    const effect = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'fixture.effect',
    )!;
    expect(effect.status).toBe('failed');
    expect((await f.record('plan.current'))!.revision).toBe('2');
  } finally {
    await f.close();
  }
});

test('a complete UTF8 and escaped plan above 300KiB is reviewed through its original full Artifact and completes with real receipt', async () => {
  const body = ('原始完整计划正文' + '"\\\r\n' + 'e\u0301').repeat(15000);
  const f = await fixture({ requirePlan: true }, async (step, f) => {
    if (step === 0) return call('write_plan', { ...modelPlan(null), body });
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
      });
    }
    if (step === 2) return call('fixture.effect');
    if (step === 3) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      const effect = (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.effect',
      )!;
      return call('update_plan_progress', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
        progress_ref: null,
        step_id: 'a',
        status: 'completed',
        execution_id: effect.id,
        complete_plan: true,
      });
    }
    return [finish];
  });
  try {
    await f.submit();
    const card = await f.pending();
    const request = card.request as {
      policy: {
        review: {
          reference: {
            id: string;
            mediaType: string;
            size: string;
            scope: { kind: 'execution'; id: string };
          };
          hash: string;
        };
      };
    };
    expect(Buffer.byteLength(JSON.stringify(card.request))).toBeLessThan(32768);
    const ref = request.policy.review.reference;
    const attachment = interactionAttachment(card);
    expect(attachment!.reference).toEqual(ref);
    expect(attachment!.originStoreId).toBe(f.base.expectedStoreId);
    expect(ref.scope).toEqual({ kind: 'execution', id: card.executionId });
    const full = await f.runtime.readArtifact({ ...f.base, refId: ref.id, scope: ref.scope });
    expect(full.reference.hash).toBe(request.policy.review.hash);
    expect(full.content.byteLength).toBeGreaterThan(300 * 1024);
    expect(String(full.content.byteLength)).toBe(ref.size);
    expect(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(full.content)).body).toBe(
      body,
    );
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    const run = await f.done();
    expect(run!.status).toBe('completed');
    expect(f.effects).toBe(1);
    expect((await f.record('plan/p/1'))!.value).toMatchObject({ body });
    const read = {
      sessionId: 's',
      getRun: (id: string) => f.runtime.getRun(id),
      getExecution: (id: string) => f.runtime.getExecution(id),
      getInteraction: (id: string) => f.runtime.getInteraction({ ...f.base, interactionId: id }),
      records: { get: (key: string) => f.record(key) },
    };
    expect(
      await f.business.readPlanningState(read, {
        runId: run!.id,
        originStoreId: f.base.expectedStoreId,
      }),
    ).toMatchObject({ status: 'approved' });
    expect((await f.record(`review.body/${card.executionId}`))!.value).toMatchObject({
      planRecordRevision: '1',
      bodyRecordRevision: '1',
      executionId: card.executionId,
      runId: run!.id,
    });
  } finally {
    await f.close();
  }
}, 15000);

test('sealed readonly identities survive caller mutation and their final revision drift denies the actual Tool', async () => {
  for (const drift of [false, true]) {
    const policy: PlanningRunPolicy = {
      requirePlan: true,
      readOnlyDefinitions: [
        { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '3' },
      ],
    };
    let changed = false;
    const f = await fixture(
      {},
      async (step) => {
        (policy.readOnlyDefinitions![0] as { definitionVersion: string }).definitionVersion = '4';
        return step === 0 ? call('fixture.effect') : [finish];
      },
      true,
      undefined,
      policy,
      async (args, f) => {
        if (
          !drift ||
          changed ||
          args[1] !== 'dispatch' ||
          args[2]?.boundary.definitionId !== 'fixture.effect'
        )
          return;
        changed = true;
        const db = new Database(join(f.root, 'data', 'new', 'core.db'));
        try {
          db.run(
            "UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key LIKE 'run/%/plan.required'",
            [planningExtensionId, 's'],
          );
        } finally {
          db.close();
        }
      },
    );
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(f.effects).toBe(drift ? 0 : 1);
      expect((await f.record(`run/${run!.id}/plan.required`))!.value).toMatchObject({
        readOnlyDefinitions: [
          { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '3' },
        ],
      });
      expect(changed).toBe(drift);
    } finally {
      await f.close();
    }
  }
});

const attachmentPlanBody = '精确原计划\r\n"完整正文'.repeat(5000);
const attachmentPlanScript: Script = async (step, f) => {
  if (step === 0) return call('write_plan', { ...modelPlan(null), body: attachmentPlanBody });
  if (step === 1) {
    const current = (await f.record('plan.current'))!.value as Record<string, Json>;
    return call('request_plan_review', {
      plan_ref: await f.planRef({
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
      }),
    });
  }
  if (step === 2) return call('fixture.effect');
  return [finish];
};
test('original accepted Artifact request cannot be rebound by hash/ref/foreign scope or seal/document revision tampering', async () => {
  for (const fault of ['hash', 'ref', 'foreign', 'seal_revision', 'document_revision'] as const) {
    const f = await fixture({ requirePlan: true }, attachmentPlanScript);
    try {
      await f.submit();
      const card = await f.pending();
      const key = `review.body/${card.executionId}`;
      const db = new Database(join(f.root, 'data', 'new', 'core.db'));
      try {
        if (fault === 'seal_revision' || fault === 'document_revision')
          db.run(
            'UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key=?',
            [planningExtensionId, 's', fault === 'seal_revision' ? key : 'plan/p/1'],
          );
        else {
          const seal = (await f.record(key))!.value as Record<string, Json>;
          const reference = seal.reference as Record<string, Json>;
          if (fault === 'hash') seal.hash = '0'.repeat(64);
          if (fault === 'ref') reference.id = 'artifact-unregistered-original';
          if (fault === 'foreign') reference.scope = { kind: 'execution', id: 'foreign-execution' };
          db.run(
            'UPDATE extension_record SET json=? WHERE extension_id=? AND scope_id=? AND key=?',
            [JSON.stringify(seal), planningExtensionId, 's', key],
          );
        }
      } finally {
        db.close();
      }
      await f.answer({ kind: 'plan_review', decision: 'approve' });
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(f.effects).toBe(0);
      expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
      const accepted = await f.runtime.getInteraction({ ...f.base, interactionId: card.id });
      expect(accepted!.acceptedDecisionRevision).not.toBeNull();
    } finally {
      await f.close();
    }
  }
}, 15000);

test('physically incomplete original attachment and foreign public scope cannot create approval or dispatch effects', async () => {
  const f = await fixture({ requirePlan: true }, attachmentPlanScript);
  try {
    await f.submit();
    const card = await f.pending();
    const request = card.request as {
      policy: { review: { reference: { id: string; scope: { kind: 'execution'; id: string } } } };
    };
    const ref = request.policy.review.reference;
    const full = await f.runtime.readArtifact({ ...f.base, refId: ref.id, scope: ref.scope });
    let foreignRejected = false;
    try {
      await f.runtime.readArtifact({
        ...f.base,
        refId: ref.id,
        scope: { kind: 'execution', id: 'foreign-execution' },
      });
    } catch {
      foreignRejected = true;
    }
    expect(foreignRejected).toBe(true);
    const file = artifactPath(join(f.root, 'data', 'new'), full.reference.hash);
    chmodSync(file, 0o600);
    writeFileSync(file, full.content.slice(0, -1));
    chmodSync(file, 0o400);
    let incompleteRejected = false;
    try {
      await f.runtime.readArtifact({ ...f.base, refId: ref.id, scope: ref.scope });
    } catch {
      incompleteRejected = true;
    }
    expect(incompleteRejected).toBe(true);
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
  } finally {
    await f.close();
  }
});

test('a genuine original Artifact with invalid UTF8 is rejected before informational Interaction creation', async () => {
  const f = await fixture({ requirePlan: true }, attachmentPlanScript, true, (extension) => ({
    ...extension,
    tools: extension.tools!.map((tool) =>
      tool.id !== 'planning.review'
        ? tool
        : {
            ...tool,
            execute(input, context) {
              return tool.execute(input, {
                ...context,
                artifacts: {
                  ...context.artifacts!,
                  async publish(value) {
                    const content = new Uint8Array(value.content);
                    content[0] = 255;
                    return context.artifacts!.publish({ ...value, content });
                  },
                },
              });
            },
          },
    ),
  }));
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${run!.id}/approval/p/1`)).toBeNull();
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
    const review = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'planning.review',
    )!;
    expect(review.result).toMatchObject({
      outcome: 'failed',
      content: 'planning_review_body_invalid',
    });
  } finally {
    await f.close();
  }
});

test('after actual accepted full-plan proof read, concurrent seal revision commit is rejected by final SQLite dispatch CAS', async () => {
  let drifted = false;
  const f = await fixture(
    { requirePlan: true },
    attachmentPlanScript,
    true,
    undefined,
    undefined,
    async (args, f) => {
      if (drifted || args[1] !== 'dispatch' || args[2]?.boundary.definitionId !== 'fixture.effect')
        return;
      drifted = true;
      const db = new Database(join(f.root, 'data', 'new', 'core.db'));
      try {
        db.run(
          "UPDATE extension_record SET revision=revision+1 WHERE extension_id=? AND scope_id=? AND key LIKE 'review.body/%'",
          [planningExtensionId, 's'],
        );
      } finally {
        db.close();
      }
    },
  );
  try {
    await f.submit();
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(drifted).toBe(true);
    expect(f.effects).toBe(0);
    expect(await f.record(`run/${run!.id}/approval/p/1`)).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('historical completed plan receipt retains original approval source while current contribution and next Run have none', async () => {
  const f = await fixture({ requirePlan: true }, async (step, f) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    const pointer = (await f.record('plan.current'))!.value as Record<string, Json>;
    if (step === 1)
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: pointer.planId!,
          version: pointer.version!,
          digest: pointer.digest!,
        }),
      });
    if (step === 2) return call('fixture.effect');
    if (step === 3)
      return call('update_plan_progress', {
        plan_ref: await f.planRef({
          planId: pointer.planId!,
          version: pointer.version!,
          digest: pointer.digest!,
        }),
        progress_ref: null,
        step_id: 'a',
        status: 'completed',
        execution_id: (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'fixture.effect',
        )!.id,
        complete_plan: true,
      });
    return [finish];
  });
  const read = {
    sessionId: 's',
    getRun: (id: string) => f.runtime.getRun(id),
    async getExecution(id: string) {
      const actual = await f.runtime.getExecution(id);
      if (!actual) return null;
      const decision = actual.decisionSource as { sources?: { id: string; digest: string }[] };
      // The owner reader projects immutable decision sources and semantic input digest.
      return {
        ...actual,
        sources: decision.sources ?? [],
        inputDigest: new Bun.CryptoHasher('sha256')
          .update(JSON.stringify(actual.input))
          .digest('hex'),
      };
    },
    getInteraction: (id: string) =>
      f.runtime.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: id,
      }),
    records: { get: (key: string) => f.record(key) },
  };
  try {
    await f.submit('first');
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    const original = (await f.done('first'))!;
    expect(original.status).toBe('completed');
    await f.submit('next');
    const next = (await f.done('next'))!;
    expect(next.status).toBe('failed');
    expect(
      (
        await f.business.readPlanningState(read, {
          runId: next.id,
          originStoreId: f.base.expectedStoreId,
        })
      ).status,
    ).toBe('pending');
    const sources = await f.business
      .sourcesFor(async () => ({ ...read, records: { ...read.records, list: async () => [] } }))
      .capture({ sessionId: 's', workspaceId: 'w', definitionId: 'fixed', input: {} });
    expect(JSON.parse(sources[0]!.content).approval).toBeNull();
    const evaluate = () =>
      f.business.conditions.evaluate(original.requirements, 'completion', {
        boundary: {
          sessionId: 's',
          runId: next.id,
          executionId: null,
          kind: null,
          definitionId: null,
          definitionVersion: null,
          attempt: null,
        },
        forRequirement: async () => read,
      });
    expect((await evaluate())[0]!.outcome).toBe('satisfied');
    const effect = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'fixture.effect',
    )!;
    const decision = effect.decisionSource as { sources: { id: string; digest: string }[] };
    const db = new Database(join(f.root, 'data', 'new', 'core.db'));
    try {
      db.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
        JSON.stringify({
          ...decision,
          sources: decision.sources.map((source) => ({ ...source, digest: '0'.repeat(64) })),
        }),
        effect.id,
      ]);
    } finally {
      db.close();
    }
    expect((await evaluate())[0]!.outcome).toBe('unsatisfied');
    expect(f.effects).toBe(1);
  } finally {
    await f.close();
  }
});

test('plan progress updates preserve sibling tools and original successful receipts without Agent phases', async () => {
  const f = await fixture({ requirePlan: true }, async (step, currentFixture) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    const current = (await currentFixture.record('plan.current'))!.value as Record<string, Json>;
    if (step === 1)
      return call('request_plan_review', {
        plan_ref: await currentFixture.planRef({
          planId: 'p',
          version: current.version!,
          digest: current.digest!,
        }),
      });
    if (step === 2) return call('fixture.effect');
    if (step === 3 || step === 4) {
      const original = (await currentFixture.store.listExecutions('s')).find(
        (execution) =>
          execution.definitionId === 'fixture.effect' && execution.status === 'succeeded',
      )!;
      const progress = await currentFixture.record('progress/p/1');
      const update = call('update_plan_progress', {
        plan_ref: await currentFixture.planRef({
          planId: 'p',
          version: current.version!,
          digest: current.digest!,
        }),
        progress_ref: await currentFixture.progressRef(progress?.revision ?? null),
        step_id: 'a',
        status: 'completed',
        execution_id: original.id,
        complete_plan: step === 4,
      });
      if (step === 3) return [...update.slice(0, -1), ...call('fixture.effect')];
      return update;
    }
    return [finish];
  });
  try {
    await f.submit();
    await f.answer({ kind: 'plan_review', decision: 'approve' });
    expect((await f.done())!.status).toBe('completed');
    expect(f.effects).toBe(2);
    const executions = await f.store.listExecutions('s');
    const effects = executions.filter((execution) => execution.definitionId === 'fixture.effect');
    expect(effects.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(
      executions
        .filter((execution) => execution.definitionId === 'planning.update')
        .every((execution) => execution.status === 'succeeded'),
    ).toBe(true);
    const progress = (await f.record('progress/p/1'))!.value as {
      steps: { a: { receipt: { executionId: string } } };
      completePlan: boolean;
    };
    expect(progress.completePlan).toBe(true);
    expect(progress.steps.a.receipt.executionId).toBe(effects[0]!.id);
    for (const request of f.modelRequests) {
      expect(
        request.messages.some((message) => /phase: (?:building|planning)/.test(message.content)),
      ).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test('ordinary plan saving does not require approval, but an explicit implementation review registers its original Run gate', async () => {
  const readOnlyDefinitions = [
    { kind: 'tool' as const, definitionId: 'files.read', definitionVersion: '5' },
  ];
  for (const decision of [null, 'deny', 'approve'] as const) {
    const review = decision !== null;
    const f = await fixture(
      {},
      async (step, f) => {
        if (step === 0) return call('write_plan', modelPlan(null));
        if (review && step === 1) {
          const current = (await f.record('plan.current'))!.value as Record<string, Json>;
          return call('request_plan_review', {
            plan_ref: await f.planRef({
              planId: current.planId!,
              version: current.version!,
              digest: current.digest!,
            }),
          });
        }
        if (step === (review ? 2 : 1)) return call('fixture.effect');
        if (decision === 'approve' && step === 3) {
          const current = (await f.record('plan.current'))!.value as Record<string, Json>;
          const effect = (await f.store.listExecutions('s')).find(
            (e) => e.definitionId === 'fixture.effect' && e.status === 'succeeded',
          )!;
          return call('update_plan_progress', {
            plan_ref: await f.planRef({
              planId: current.planId!,
              version: current.version!,
              digest: current.digest!,
            }),
            progress_ref: null,
            step_id: 'a',
            status: 'completed',
            execution_id: effect.id,
            complete_plan: true,
          });
        }
        return [finish];
      },
      true,
      undefined,
      { readOnlyDefinitions },
    );
    try {
      await f.submit();
      if (review) {
        const card = await f.pending(),
          runId = await f.runId();
        expect(card.kind).toBe('plan_review');
        expect(card.request).not.toHaveProperty('allowedModes');
        expect((await f.store.getRun(runId))!.requirements).toMatchObject([
          {
            requirementId: 'plan.required',
            runId,
            sessionId: 's',
            recordKey: `run/${runId}/plan.required`,
          },
        ]);
        expect((await f.record(`run/${runId}/plan.required`))!.value).toMatchObject({
          readOnlyDefinitions,
        });
        expect(f.effects).toBe(0);
        await f.answer({
          kind: 'plan_review',
          decision: decision!,
          feedback: 'Exact business decision',
        });
      }
      const run = (await f.done())!;
      expect(run.status).toBe(decision === 'deny' ? 'cancelled' : 'completed');
      expect(run.requirements).toHaveLength(review ? 1 : 0);
      expect(f.effects).toBe(decision === 'deny' ? 0 : 1);
      if (review) {
        const interactions = await f.runtime.listInteractions({ ...f.base });
        expect(interactions.interactions).toHaveLength(1);
        expect({
          accepted: interactions.interactions[0]!.acceptedDecisionRevision,
          reviewResult: (await f.store.listExecutions('s')).find(
            (e) => e.definitionId === 'planning.review',
          )?.result,
        }).toMatchObject({ accepted: expect.any(String) });
      }
      expect((await f.record(`run/${run.id}/planning.policy`))!.value).toMatchObject({
        kind: 'planning_policy',
        runId: run.id,
        readOnlyDefinitions,
      });
      if (!review) expect(await f.record(`run/${run.id}/plan.required`)).toBeNull();
    } finally {
      await f.close();
    }
  }
});

test('retired mode-bearing plan answers are rejected without consuming the pending business decision', async () => {
  const f = await fixture({ requirePlan: true }, async (step, f) => {
    if (step === 0) return call('write_plan', modelPlan(null));
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('request_plan_review', {
        plan_ref: await f.planRef({
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        }),
      });
    }
    return step === 2 ? call('fixture.effect') : [finish];
  });
  try {
    await f.submit();
    const card = await f.pending();
    let rejected: unknown;
    try {
      await f.runtime.answerInteraction({
        ...f.base,
        commandId: 'retired-mode-answer',
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: {
          kind: 'plan_review',
          decision: 'approve',
          mode: 'auto',
        } as unknown as InteractionAnswer,
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string })?.code).toBe('interaction_answer_invalid');
    expect(await f.runtime.getInteraction({ ...f.base, interactionId: card.id })).toMatchObject({
      state: 'pending',
      answer: null,
      acceptedDecisionRevision: null,
      revision: card.revision,
    });
    expect(f.effects).toBe(0);
    await f.answer({ kind: 'plan_review', decision: 'deny' });
    expect((await f.done())!.status).toBe('cancelled');
    expect(f.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('requirement registration never absorbs earlier foreign context or later plan and other-owner drift', async () => {
  for (const scenario of ['before_foreign', 'after_plan', 'after_foreign'] as const) {
    let revision = 0;
    const other: Extension = {
      id: 'other.owner',
      version: '1',
      apiMajor: 1,
      context: {
        async capture(request) {
          return [
            {
              id: 'other.owner:runtime',
              kind: 'runtime_state',
              role: 'user',
              placement: 'after_history',
              scope: request.sessionId,
              content: `External state ${revision}`,
              digest: String(revision),
            },
          ];
        },
      },
    };
    const f = await fixture(
      {},
      async (step, f) => {
        if (step === 0) return call('write_plan', modelPlan(null));
        if (step === 1) {
          const current = (await f.record('plan.current'))!.value as Record<string, Json>;
          return call('request_plan_review', {
            plan_ref: await f.planRef({
              planId: current.planId!,
              version: current.version!,
              digest: current.digest!,
            }),
          });
        }
        if (step === 2 && scenario !== 'before_foreign') return call('fixture.effect');
        return [finish];
      },
      true,
      (extension) => ({
        ...extension,
        tools: extension.tools!.map((tool) =>
          tool.id !== 'planning.review'
            ? tool
            : {
                ...tool,
                async execute(input, context) {
                  const register = context.requirements!.register;
                  return tool.execute(input, {
                    ...context,
                    requirements: {
                      register: async (refs) => {
                        if (scenario === 'before_foreign') revision++;
                        const registered = await register(refs);
                        if (scenario === 'after_foreign') revision++;
                        if (scenario === 'after_plan') {
                          const record = (await context.records.get('plan/p/1'))!;
                          await context.records.write({
                            key: record.key,
                            expectedRevision: record.revision,
                            contentType: record.contentType,
                            contentVersion: record.contentVersion,
                            executable: true,
                            value: {
                              ...(record.value as Record<string, Json>),
                              body: 'Changed after registration',
                            },
                          });
                        }
                        return registered;
                      },
                    },
                  });
                },
              },
        ),
      }),
      undefined,
      undefined,
      [other],
    );
    try {
      await f.submit();
      const waiting = await eventually(async () => {
        const card = (await f.runtime.listInteractions({ ...f.base, state: 'pending' }))
          .interactions[0];
        const execution = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'planning.review',
        );
        return card
          ? { card }
          : execution && ['failed', 'outcome_unknown'].includes(execution.status)
            ? { execution }
            : null;
      });
      if ('card' in waiting) await f.answer({ kind: 'plan_review', decision: 'approve' });
      await f.done();
      const review = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'planning.review',
      )!;
      expect(review.status).toBe('outcome_unknown');
      expect(review.result).toMatchObject({ content: 'context_refresh_required' });
      const interactions = (await f.runtime.listInteractions({ ...f.base })).interactions;
      expect(interactions.every((i) => i.acceptedDecisionRevision === null)).toBe(true);
      expect(f.effects).toBe(0);
      const run = (await f.store.getRun(review.runId!))!;
      expect(run.requirements).toHaveLength(scenario === 'before_foreign' ? 0 : 1);
      expect(await f.record(`run/${run.id}/approval/p/1`)).toBeNull();
    } finally {
      await f.close();
    }
  }
});
