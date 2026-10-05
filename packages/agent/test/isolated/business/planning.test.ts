import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
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
  let steps = 0,
    effects = 0,
    jobStarts = 0;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      signal.throwIfAborted();
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
    rootUri: `file://${root}`,
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
    async runId() {
      return (await store.listExecutions('s')).find((x) => x.runId !== null)!.runId!;
    },
    async submit(commandId = 'work') {
      return runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: 'explicit business task' },
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

test('an ordinary Job receipt reaches its actual Run through its parent Tool rather than a guessed Run ID', async () => {
  const f = await fixture({ requiredValidation: true }, async (step, f) => {
    if (step === 0) return call('fixture.launch');
    const job = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'fixture.job')!;
    const parent = (await f.store.getExecution(job.parentExecutionId!))!;
    if (step === 1)
      return call('validation.define', {
        runId: parent.runId!,
        checks: [
          {
            kind: 'receipt',
            target: {
              executionId: job.id,
              attempt: job.attempt,
              definitionId: job.definitionId,
              definitionVersion: job.definitionVersion,
              inputDigest: Array.from(
                new Uint8Array(
                  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{}')),
                ),
              )
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(''),
              resultRevision: job.resultRevision,
            },
          },
        ],
      });
    if (step === 2) return call('validation.check', { runId: parent.runId! });
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    const job = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'fixture.job')!;
    expect(job.runId).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.parentExecutionId).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(f.effects).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

test('actual successful Model text and planning-management receipts cannot count as work verification', async () => {
  for (const kind of ['model', 'planning'] as const) {
    const f = await fixture({ requiredValidation: true }, async (step, f) => {
      if (step === 0) return call('planning.read');
      const target = (await f.store.listExecutions('s')).find(
        (e) =>
          e.status === 'succeeded' &&
          (kind === 'model' ? e.kind === 'model' : e.definitionId === 'planning.read'),
      )!;
      if (step === 1) {
        const canonical = (value: Json): string =>
          Array.isArray(value)
            ? `[${value.map(canonical).join(',')}]`
            : value && typeof value === 'object'
              ? `{${Object.keys(value)
                  .sort()
                  .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
                  .join(',')}}`
              : JSON.stringify(value);
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(canonical(target.input)),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return call('validation.define', {
          runId: target.runId!,
          checks: [
            {
              kind: 'receipt',
              target: {
                executionId: target.id,
                attempt: target.attempt,
                definitionId: target.definitionId,
                definitionVersion: target.definitionVersion,
                inputDigest: hash,
                resultRevision: target.resultRevision,
              },
            },
          ],
        });
      }
      if (step === 2) return call('validation.check', { runId: target.runId! });
      return [finish];
    });
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(f.effects).toBe(0);
      const pointer = (await f.record(`run/${run!.id}/validation.current`))!.value as {
        key: string;
      };
      expect((await f.record(pointer.key))!.value).toMatchObject({
        checks: [{ outcome: 'inconclusive' }],
      });
    } finally {
      await f.close();
    }
  }
}, 10000);

test('a newly disabled factory cannot omit an already persisted validation requirement when declaring plan completion', async () => {
  const disabled = createPlanningValidation();
  const f = await fixture(
    { requirePlan: true, requiredValidation: true },
    async (step, f) => {
      if (step === 0) return call('planning.write', plan(null));
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return call('planning.review', {
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        });
      if (step === 2) return call('fixture.effect');
      if (step === 3) {
        const execution = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'fixture.effect',
        )!;
        return call('planning.update', {
          runId: execution.runId!,
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
          expectedProgressRevision: null,
          stepId: 'a',
          status: 'completed',
          executionId: execution.id,
          completePlan: true,
        });
      }
      return [finish];
    },
    true,
    (extension) => ({
      ...extension,
      tools: extension.tools!.map((tool) =>
        tool.id === 'planning.update'
          ? disabled.extension.tools!.find((t) => t.id === tool.id)!
          : tool,
      ),
    }),
  );
  try {
    await f.submit();
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(run!.requirements).toHaveLength(2);
    expect(await f.record('progress/p/1')).toBeNull();
    expect(f.effects).toBe(1);
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'planning.update')!.status,
    ).not.toBe('succeeded');
  } finally {
    await f.close();
  }
}, 10000);

test('future verification pointer content is shown readonly with unavailable resolution and no query effects', async () => {
  let runId = '';
  const f = await fixture(
    {},
    async (step, f) => {
      if (step === 0) {
        runId = await f.runId();
        return call('fixture.future', { runId });
      }
      return [finish];
    },
    true,
    (extension) => ({
      ...extension,
      records: [
        ...extension.records!,
        { contentType: 'builtin.planning.record', contentVersion: 2, schema: { type: 'object' } },
      ],
      tools: [
        ...extension.tools!,
        {
          id: 'fixture.future',
          version: '1',
          description: 'Trusted future-version writer fixture',
          inputSchema: { type: 'object' },
          async execute(input, context) {
            await context.records.write({
              key: `run/${(input as { runId: string }).runId}/validation.current`,
              expectedRevision: null,
              contentType: 'builtin.planning.record',
              contentVersion: 2,
              value: { future: { unknown: 'retained' }, key: 'must-not-resolve-with-old-decoder' },
              executable: true,
            });
            return { outcome: 'succeeded', content: 'Future metadata written' };
          },
        },
      ],
    }),
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    const before = (await f.store.getSession('s'))!.nextSeq,
      steps = f.steps;
    const views = await f.runtime.queryExtension({
      sessionId: 's',
      extensionId: planningExtensionId,
      queryId: 'validation.status',
      input: { runId },
    });
    expect(views[0]!.payload).toMatchObject({
      resolution: 'unavailable',
      current: { future: { unknown: 'retained' } },
      attempt: null,
    });
    expect((await f.store.getSession('s'))!.nextSeq).toBe(before);
    expect(f.steps).toBe(steps);
    expect(f.effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual plan review binds mode/current digest; v2 invalidates v1 and only fresh user review permits the second effect', async () => {
  for (const scenario of ['no-review', 'new-receipt', 'old-receipt'] as const) {
    const reviewV2 = scenario !== 'no-review';
    const f = await fixture({ requirePlan: true }, async (step, f) => {
      if (step === 0) return call('planning.write', plan(null));
      if (step === 1 || (reviewV2 && step === 4)) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('planning.review', {
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
        });
      }
      if (step === 2 || step === (reviewV2 ? 5 : 4)) return call('fixture.effect');
      if (step === 3) return call('planning.write', plan(1));
      if (reviewV2 && step === 6) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        const effects = (await f.store.listExecutions('s')).filter(
          (e) => e.definitionId === 'fixture.effect' && e.status === 'succeeded',
        );
        return call('planning.update', {
          runId: await f.runId(),
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
          expectedProgressRevision: null,
          stepId: 'a',
          status: 'completed',
          executionId: effects.find((e) =>
            (e.decisionSource as { sources: { id: string }[] }).sources.some(
              (source) =>
                source.id ===
                (scenario === 'old-receipt' ? 'builtin.planning:s:p:1' : 'builtin.planning:s:p:2'),
            ),
          )!.id,
          completePlan: true,
        });
      }
      return [finish];
    });
    try {
      await f.submit();
      const old = await f.answer({
        kind: 'plan_review',
        decision: 'approve',
        mode: 'accept_edits',
      });
      expect(old.request).toMatchObject({ version: '1', allowedModes: ['auto', 'accept_edits'] });
      expect(JSON.parse((old.request as { content: string }).content).body).toBe(
        'Harmless precise task',
      );
      expect((old.request as Record<string, Json>).plan).toBeUndefined();
      if (reviewV2) await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
      const approval = (await f.record('approval/p/1'))!.value as {
        proof: { interactionId: string; answer: { mode: string } };
      };
      expect(approval.proof.interactionId).toBe(old.id);
      expect(approval.proof.answer.mode).toBe('accept_edits');
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
      if (step === 0) return call('planning.write', plan(null));
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return call('planning.review', {
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
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
        return call('planning.update', {
          runId: await f.runId(),
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
          expectedProgressRevision: progress?.revision ?? null,
          stepId: 'a',
          status: step === 3 && scenario !== 'no-prior' ? 'completed' : 'compensated',
          executionId:
            scenario === 'distinct' && step === 5
              ? effects.find((e) => e.id !== originalId)!.id
              : effects[0]!.id,
          completePlan: false,
        });
      }
      return [finish];
    });
    try {
      await f.submit();
      await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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

test('caller mutation cannot remove the original host verification policy before actual first execution', async () => {
  const definitions = [{ definitionId: 'actual.verifier', definitionVersion: '9' }];
  const f = await fixture(
    { requiredValidation: true, requiredReceiptDefinitions: definitions },
    async (step, f) => {
      if (step === 0) return call('fixture.effect');
      if (step === 1) {
        const actual = (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'fixture.effect',
        )!;
        return call('validation.define', {
          runId: actual.runId!,
          checks: [
            {
              kind: 'receipt',
              target: {
                executionId: actual.id,
                attempt: actual.attempt,
                definitionId: actual.definitionId,
                definitionVersion: actual.definitionVersion,
                inputDigest: 'irrelevant',
                resultRevision: actual.resultRevision,
              },
            },
          ],
        });
      }
      return [finish];
    },
  );
  definitions[0]!.definitionId = 'fixture.effect';
  definitions[0]!.definitionVersion = '3';
  definitions.length = 0;
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(f.effects).toBe(1);
    expect((await f.record(run!.requirements[0]!.recordKey))!.value).toMatchObject({
      requiredReceiptDefinitions: [{ definitionId: 'actual.verifier', definitionVersion: '9' }],
    });
    expect(await f.record(`run/${run!.id}/validation.spec`)).toBeNull();
  } finally {
    await f.close();
  }
});

test('a real successful receipt in an older Run cannot satisfy a later Run requirement or replay its effect', async () => {
  let currentRun = '';
  const f = await fixture({ requiredValidation: true }, async (step, f) => {
    if (step === 0) return call('fixture.effect');
    if (step === 1) return [finish];
    const executions = await f.store.listExecutions('s');
    const old = executions.find((e) => e.definitionId === 'fixture.effect')!;
    if (step === 2) {
      currentRun = executions.find((e) => e.kind === 'model' && e.runId !== old.runId)!.runId!;
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{}'));
      const inputDigest = Array.from(new Uint8Array(bytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return call('validation.define', {
        runId: currentRun,
        checks: [
          {
            kind: 'receipt',
            target: {
              executionId: old.id,
              attempt: old.attempt,
              definitionId: old.definitionId,
              definitionVersion: old.definitionVersion,
              inputDigest,
              resultRevision: old.resultRevision,
            },
          },
        ],
      });
    }
    if (step === 3) return call('validation.check', { runId: currentRun });
    return [finish];
  });
  try {
    await f.submit('old');
    const old = await f.done('old');
    expect(old!.status).toBe('failed');
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('failed');
    expect(f.effects).toBe(1);
    expect(run!.id).not.toBe(old!.id);
    const pointer = (await f.record(`run/${run!.id}/validation.current`))!.value as { key: string };
    expect((await f.record(pointer.key))!.value).toMatchObject({
      checks: [{ outcome: 'scope_mismatch' }],
    });
  } finally {
    await f.close();
  }
}, 10000);

test('actual deterministic receipt validation rejects missing/failed/unknown and exact identity mismatches; unsupported checks remain inconclusive', async () => {
  for (const variant of [
    'passed',
    'failed',
    'unknown',
    'missing',
    'wrongRun',
    'attempt',
    'definition',
    'definitionVersion',
    'hostChecks',
    'result',
    'input',
    'inconclusive',
  ] as const) {
    const f = await fixture(
      {
        requiredValidation: true,
        ...(variant === 'hostChecks'
          ? {
              requiredReceiptDefinitions: [
                { definitionId: 'actual.verifier', definitionVersion: '9' },
              ],
            }
          : {}),
      },
      async (step, f) => {
        if (step === 0)
          return call('fixture.effect', {
            status: variant === 'failed' ? 'failed' : variant === 'unknown' ? 'unknown' : 'success',
          });
        const actual = (await f.store.listExecutions('s')).find(
          (x) => x.definitionId === 'fixture.effect',
        )!;
        const bytes = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify(actual.input)),
        );
        const inputDigest = Array.from(new Uint8Array(bytes))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const target = {
          executionId: variant === 'missing' ? 'missing' : actual.id,
          attempt: variant === 'attempt' ? actual.attempt + 1 : actual.attempt,
          definitionId: variant === 'definition' ? 'other' : actual.definitionId,
          definitionVersion:
            variant === 'definitionVersion' ? 'old-version' : actual.definitionVersion,
          inputDigest: variant === 'input' ? 'wrong' : inputDigest,
          resultRevision: variant === 'result' ? '999' : actual.resultRevision,
        };
        if (step === 1)
          return call('validation.define', {
            runId: variant === 'wrongRun' ? 'other-run' : actual.runId!,
            checks: [
              variant === 'inconclusive'
                ? { kind: 'command', description: 'unavailable runner' }
                : { kind: 'receipt', target },
            ],
          });
        if (step === 2) return call('validation.check', { runId: actual.runId! });
        return [finish];
      },
    );
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe(variant === 'passed' ? 'completed' : 'failed');
      expect(f.effects).toBe(1);
      expect(run!.requirements).toHaveLength(1);
      const pointer = await f.record(`run/${run!.id}/validation.current`);
      if (variant === 'inconclusive') {
        const attempt = await f.record((pointer!.value as { key: string }).key);
        expect(attempt!.value).toMatchObject({
          outcome: 'unsatisfied',
          checks: [{ outcome: 'inconclusive', reason: 'validation_capability_unavailable' }],
        });
      }
      if (variant === 'wrongRun')
        expect(await f.record(`run/${run!.id}/validation.spec`)).toBeNull();
    } finally {
      await f.close();
    }
  }
}, 20000);

test('an exact real user waiver remains waived without inventing passed evidence; missing evaluator fails and disabled ordinary chat completes', async () => {
  const f = await fixture({ requiredValidation: true, allowWaiver: true }, async (step, f) => {
    if (step === 0) {
      const runId = await f.runId();
      return call('validation.request_waiver', {
        recordKey: `run/${runId}/validation.required`,
        reason: 'User accepts missing harmless receipt',
      });
    }
    return [finish];
  });
  try {
    await f.submit();
    const card = await f.answer({ kind: 'question', answers: { waive: true } });
    const run = await f.done();
    expect(run!.status).toBe('completed');
    const key = run!.requirements[0]!.recordKey;
    const waiverKey = ((await f.record(`${key}/waiver.current`))!.value as { key: string }).key;
    const waiver = (await f.record(waiverKey))!.value as {
      proof: { interactionId: string };
      request: { runId: string; revision: string };
    };
    expect(waiver.proof.interactionId).toBe(card.id);
    expect(waiver.request.runId).toBe(run!.id);
    expect(waiver.request.revision).toBe(run!.requirements[0]!.revision);
    expect(await f.record(`run/${run!.id}/validation.current`)).toBeNull();
    expect(f.effects).toBe(0);
    expect(f.evaluations.flat().some((e) => e.outcome === 'waived')).toBe(true);
    await f.submit('next');
    const next = await f.done('next');
    expect(next!.status).toBe('failed');
    expect(next!.requirements[0]!.runId).not.toBe(run!.id);
  } finally {
    await f.close();
  }
  for (const required of [false, true]) {
    const plain = await fixture({ requiredValidation: required }, async () => [finish], false);
    try {
      await plain.submit();
      const run = await plain.done();
      expect(run!.status).toBe(required ? 'failed' : 'completed');
      expect(run!.reason).toBe(required ? 'necessary_condition_implementation_missing' : null);
      expect(run!.requirements).toHaveLength(required ? 1 : 0);
    } finally {
      await plain.close();
    }
  }
}, 10000);

test('immutable file expectation survives repeated same-Run repair and actual full-baseline reverification', async () => {
  let runId = '',
    specRevision = '',
    originalRequired = '',
    firstAttempt = '';
  const hash = new Bun.CryptoHasher('sha256').update('good\nsecond line\n').digest('hex');
  const f = await fixture(
    {
      requiredValidation: true,
      fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
    },
    async (step, f) => {
      if (step === 0) {
        runId = await f.runId();
        writeFileSync(join(f.root, 'work.txt'), 'bad\nsecond line\n');
        originalRequired = (await f.record(`run/${runId}/validation.required`))!.revision;
        return call('validation.define', {
          runId,
          checks: [{ kind: 'file_hash', path: 'work.txt', sha256: hash }],
        });
      }
      if (step === 1) {
        specRevision = (await f.record(`run/${runId}/validation.spec`))!.revision;
        return call('validation.check', { runId });
      }
      if (step === 2) {
        const pointer = (await f.record(`run/${runId}/validation.current`))!.value as {
          key: string;
        };
        firstAttempt = pointer.key;
        expect(((await f.record(firstAttempt))!.value as { outcome: string }).outcome).toBe(
          'unsatisfied',
        );
      }
      // Thirteen actual governed repairs stay wrong before the last repair succeeds.
      if (step >= 2 && step <= 27) {
        if (step % 2 === 0) {
          const base = (await f.files.read('work.txt')).baseline;
          return call('files.write', {
            path: 'work.txt',
            content: `bad-${step}\nsecond line\n`,
            base: base as unknown as Json,
          });
        }
        return call('validation.check', { runId });
      }
      if (step === 28) {
        const base = (await f.files.read('work.txt')).baseline;
        return call('files.write', {
          path: 'work.txt',
          content: 'good\nsecond line\n',
          base: base as unknown as Json,
        });
      }
      if (step === 29) return call('validation.check', { runId });
      return [finish];
    },
  );
  try {
    await f.submit();
    const run = await f.done('work', 15000);
    expect(run!.status).toBe('completed');
    expect((await f.record(`run/${runId}/validation.spec`))!.revision).toBe(specRevision);
    expect((await f.record(`run/${runId}/validation.required`))!.revision).toBe(originalRequired);
    expect(((await f.record(firstAttempt))!.value as { outcome: string }).outcome).toBe(
      'unsatisfied',
    );
    const pointer = (await f.record(`run/${runId}/validation.current`))!.value as { key: string };
    const evidence = (await f.record(pointer.key))!.value as {
      outcome: string;
      checks: { observedHash: string }[];
    };
    expect(evidence.outcome).toBe('passed');
    expect(evidence.checks[0]!.observedHash).toBe(hash);
    expect(f.steps).toBeGreaterThan(30);
    const checkers = (await f.store.listExecutions('s')).filter(
      (e) => e.definitionId === 'files.read',
    );
    expect(checkers.length).toBe(15);
    expect(
      (await f.store.listExecutions('s')).filter((e) => e.definitionId === 'files.write'),
    ).toHaveLength(14);
    expect(checkers.every((e) => e.parentExecutionId !== null)).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);

function receiptTarget(execution: {
  id: string;
  attempt: number;
  definitionId: string | null;
  definitionVersion: string | null;
  input: Json;
  resultRevision: string;
}): Json {
  return {
    executionId: execution.id,
    attempt: execution.attempt,
    definitionId: execution.definitionId!,
    definitionVersion: execution.definitionVersion!,
    inputDigest: new Bun.CryptoHasher('sha256')
      .update(JSON.stringify(execution.input))
      .digest('hex'),
    resultRevision: execution.resultRevision,
  };
}

test('Artifact schema failure repairs via a new exact execution binding without rewriting schema or required', async () => {
  let runId = '',
    specRevision = '',
    oldAttempt = '';
  const f = await fixture({ requiredValidation: true }, async (step, f) => {
    if (step === 0) {
      runId = await f.runId();
      return call('fixture.publish', { ok: false });
    }
    if (step === 1) {
      const execution = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'fixture.publish',
      )!;
      const ref = (execution.result as { artifactRefs: Json[] }).artifactRefs[0]!;
      return call('validation.define', {
        runId,
        checks: [
          {
            kind: 'artifact_schema',
            target: receiptTarget(execution),
            artifactRef: ref,
            schema: { type: 'object', required: ['ok'], properties: { ok: { const: true } } },
          },
        ],
      });
    }
    if (step === 2) {
      specRevision = (await f.record(`run/${runId}/validation.spec`))!.revision;
      return call('validation.check', { runId });
    }
    if (step === 3) {
      oldAttempt = ((await f.record(`run/${runId}/validation.current`))!.value as { key: string })
        .key;
      expect(
        ((await f.record(oldAttempt))!.value as { checks: { outcome: string }[] }).checks[0]!
          .outcome,
      ).toBe('failed');
      return call('fixture.publish', { ok: true });
    }
    if (step === 4) {
      const execution = (await f.store.listExecutions('s'))
        .filter((e) => e.definitionId === 'fixture.publish')
        .at(-1)!;
      const ref = (execution.result as { artifactRefs: Json[] }).artifactRefs[0]!;
      return call('validation.rebind', {
        runId,
        expectedRevision: null,
        bindings: [{ index: 0, target: receiptTarget(execution), artifactRef: ref }],
      });
    }
    if (step === 5) return call('validation.check', { runId });
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('completed');
    expect((await f.record(`run/${runId}/validation.spec`))!.revision).toBe(specRevision);
    expect(
      ((await f.record(oldAttempt))!.value as { checks: { outcome: string }[] }).checks[0]!.outcome,
    ).toBe('failed');
    expect(await f.record(`run/${runId}/validation.binding.current`)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 10000);

test('missing checker, wrong Artifact scope and unsupported schema stay inconclusive without fabricated evidence', async () => {
  for (const scenario of [
    'no_checker',
    'missing_checker',
    'wrong_scope',
    'literal_ref',
    'unsupported_schema',
  ] as const) {
    let runId = '';
    const f = await fixture(
      {
        requiredValidation: true,
        ...(scenario === 'missing_checker'
          ? { fileHashChecker: { definitionId: 'absent.read', definitionVersion: '2' } }
          : {}),
      },
      async (step, f) => {
        if (step === 0) {
          runId = await f.runId();
          return call('fixture.publish', { ok: true });
        }
        if (step === 1) {
          if (scenario === 'no_checker' || scenario === 'missing_checker')
            return call('validation.define', {
              runId,
              checks: [{ kind: 'file_hash', path: 'unused.txt', sha256: '0'.repeat(64) }],
            });
          const execution = (await f.store.listExecutions('s')).find(
            (e) => e.definitionId === 'fixture.publish',
          )!;
          const published = (execution.result as { artifactRefs: Json[] })
            .artifactRefs[0]! as Record<string, Json>;
          const ref =
            scenario === 'wrong_scope'
              ? { ...published, scope: { executionId: 'foreign' } }
              : scenario === 'literal_ref'
                ? { ...published, id: 'literal-success' }
                : published;
          return call('validation.define', {
            runId,
            checks: [
              {
                kind: 'artifact_schema',
                target: receiptTarget(execution),
                artifactRef: ref,
                schema:
                  scenario === 'unsupported_schema'
                    ? { type: 'object', $ref: 'https://unavailable.invalid/schema' }
                    : { type: 'object', required: ['ok'] },
              },
            ],
          });
        }
        if (step === 2) return call('validation.check', { runId });
        return [finish];
      },
    );
    try {
      await f.submit();
      expect((await f.done())!.status).toBe('failed');
      const pointer = (await f.record(`run/${runId}/validation.current`))!.value as { key: string };
      expect(
        ((await f.record(pointer.key))!.value as { checks: { outcome: string }[] }).checks[0]!
          .outcome,
      ).toBe('inconclusive');
      expect(
        (await f.store.listExecutions('s')).filter((e) => e.definitionId === 'files.read'),
      ).toHaveLength(0);
      expect(f.effects).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 15000);

test('repair bindings cannot swap definition, overwrite immutable expectations, or use a stale CAS revision', async () => {
  let runId = '',
    spec = '',
    bindingRevision = '';
  const f = await fixture({ requiredValidation: true }, async (step, f) => {
    if (step === 0) {
      runId = await f.runId();
      return call('fixture.effect');
    }
    const executions = await f.store.listExecutions('s');
    const effect = executions.find((e) => e.definitionId === 'fixture.effect')!;
    if (step === 1)
      return call('validation.define', {
        runId,
        checks: [{ kind: 'receipt', target: receiptTarget(effect) }],
      });
    if (step === 2) {
      spec = (await f.record(`run/${runId}/validation.spec`))!.revision;
      return call('validation.rebind', {
        runId,
        expectedRevision: null,
        bindings: [
          {
            index: 0,
            target: {
              ...(receiptTarget(effect) as Record<string, Json>),
              definitionId: 'planning.read',
            },
          },
        ],
      });
    }
    if (step === 3) {
      expect(executions.filter((e) => e.definitionId === 'validation.rebind').at(-1)!.status).toBe(
        'failed',
      );
      expect(await f.record(`run/${runId}/validation.binding.current`)).toBeNull();
      return call('validation.rebind', {
        runId,
        expectedRevision: null,
        bindings: [{ index: 0, target: receiptTarget(effect) }],
      });
    }
    if (step === 4) {
      bindingRevision = (await f.record(`run/${runId}/validation.binding.current`))!.revision;
      return call('validation.rebind', {
        runId,
        expectedRevision: null,
        bindings: [{ index: 0, target: receiptTarget(effect) }],
      });
    }
    if (step === 5) {
      expect(executions.filter((e) => e.definitionId === 'validation.rebind').at(-1)!.status).toBe(
        'failed',
      );
      return call('validation.define', {
        runId,
        checks: [{ kind: 'command', description: 'replace failure' }],
      });
    }
    if (step === 6) {
      expect(executions.filter((e) => e.definitionId === 'validation.define').at(-1)!.status).toBe(
        'failed',
      );
      return call('validation.check', { runId });
    }
    return [finish];
  });
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    expect((await f.record(`run/${runId}/validation.spec`))!.revision).toBe(spec);
    expect((await f.record(`run/${runId}/validation.binding.current`))!.revision).toBe(
      bindingRevision,
    );
    expect(f.effects).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('a late checker callback cannot cover a newer verification head; its known CAS failure can reverify normally', async () => {
  let runId = '',
    calls = 0,
    newerRevision = '',
    priorKey = '';
  const hash = new Bun.CryptoHasher('sha256').update('actual').digest('hex');
  const f = await fixture(
    {
      requiredValidation: true,
      fileHashChecker: { definitionId: 'fixture.checker', definitionVersion: '1' },
    },
    async (step, f) => {
      if (step === 0) {
        runId = await f.runId();
        writeFileSync(join(f.root, 'work.txt'), 'actual');
        return call('validation.define', {
          runId,
          checks: [{ kind: 'file_hash', path: 'work.txt', sha256: hash }],
        });
      }
      if (step === 1 || step === 2) return call('validation.check', { runId });
      if (step === 3) {
        const pointer = (await f.record(`run/${runId}/validation.current`))!;
        expect(pointer.revision).toBe(newerRevision);
        expect((pointer.value as { key: string }).key).toBe(priorKey);
        expect(
          (await f.store.listExecutions('s'))
            .filter((e) => e.definitionId === 'validation.check')
            .at(-1)!.status,
        ).toBe('failed');
        return call('validation.check', { runId });
      }
      return [finish];
    },
    true,
    (extension) => ({
      ...extension,
      tools: [
        ...extension.tools!,
        {
          id: 'fixture.checker',
          version: '1',
          description: 'Trusted actual file checker with an adversarial delayed head',
          inputSchema: { type: 'object' },
          async execute(input, context) {
            const snapshot = await f.files.read((input as { path: string }).path, {
              offset: 1,
              limit: 1,
            });
            if (++calls === 2) {
              const key = `run/${runId}/validation.current`,
                pointer = (await context.records.get(key))!;
              priorKey = (pointer.value as { key: string }).key;
              const saved = await context.records.write({
                key,
                expectedRevision: pointer.revision,
                contentType: pointer.contentType,
                contentVersion: pointer.contentVersion,
                value: pointer.value,
                executable: true,
              });
              newerRevision = saved.revision;
            }
            return { outcome: 'succeeded', content: JSON.stringify(snapshot) };
          },
        },
      ],
    }),
  );
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    expect(calls).toBe(3);
    expect((await f.record(`run/${runId}/validation.current`))!.revision).not.toBe(newerRevision);
    expect(await f.record(priorKey)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 10000);

test('planning.write retains its original pointer CAS when a real nested writer selects another plan', async () => {
  let nestedExecutionId = '';
  const f = await fixture(
    {},
    async (step) =>
      step === 0 ? call('planning.write', { ...plan(null), planId: 'old' }) : [finish],
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
                            input: { ...plan(null), planId: 'new' },
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
        return call('planning.write', {
          ...plan(null),
          steps: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
          ],
        });
      }
      if (step === 1) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('planning.update', {
          runId,
          planId: 'p',
          version: 1,
          digest: current.digest!,
          expectedProgressRevision: null,
          stepId: 'a',
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

test('two real accepted waiver decisions survive rebind in one Run with immutable history and the newest exact proof', async () => {
  let runId = '',
    firstKey = '',
    secondKey = '';
  const f = await fixture({ requiredValidation: true, allowWaiver: true }, async (step, f) => {
    if (step === 0) {
      runId = await f.runId();
      return call('fixture.publish', { ok: false, repair: 0 });
    }
    const execution = (await f.store.listExecutions('s'))
      .filter((e) => e.definitionId === 'fixture.publish')
      .at(-1)!;
    if (step === 1)
      return call('validation.define', {
        runId,
        checks: [
          {
            kind: 'artifact_schema',
            target: receiptTarget(execution),
            artifactRef: (execution.result as { artifactRefs: Json[] }).artifactRefs[0]!,
            schema: { type: 'object', required: ['ok'], properties: { ok: { const: true } } },
          },
        ],
      });
    if (step === 2 || step === 6) return call('validation.check', { runId });
    if (step === 3 || step === 7)
      return call('validation.request_waiver', {
        recordKey: `run/${runId}/validation.required`,
        reason:
          step === 3 ? 'First precise user decision' : 'User accepts the changed repair binding',
      });
    if (step === 4) {
      firstKey = (
        (await f.record(`run/${runId}/validation.required/waiver.current`))!.value as {
          key: string;
        }
      ).key;
      return call('fixture.publish', { ok: false, repair: 1 });
    }
    if (step === 5)
      return call('validation.rebind', {
        runId,
        expectedRevision: null,
        bindings: [
          {
            index: 0,
            target: receiptTarget(execution),
            artifactRef: (execution.result as { artifactRefs: Json[] }).artifactRefs[0]!,
          },
        ],
      });
    secondKey = (
      (await f.record(`run/${runId}/validation.required/waiver.current`))!.value as { key: string }
    ).key;
    return [finish];
  });
  try {
    await f.submit();
    const first = await f.answer({ kind: 'question', answers: { waive: true } });
    const second = await f.answer({ kind: 'question', answers: { waive: true } });
    expect((await f.done())!.status).toBe('completed');
    expect(first.id).not.toBe(second.id);
    expect(firstKey).not.toBe(secondKey);
    const original = (await f.record(firstKey))!,
      latest = (await f.record(secondKey))!;
    expect(original.revision).toBe('1');
    expect(latest.revision).toBe('1');
    expect(original.value).toMatchObject({
      request: { bindingRevision: null },
      proof: { interactionId: first.id },
    });
    expect(latest.value).toMatchObject({
      request: { bindingRevision: '1' },
      proof: { interactionId: second.id },
    });
    expect((await f.record(`run/${runId}/validation.required/waiver.current`))!.revision).toBe('2');
    expect(f.evaluations.flat().at(-1)!.outcome).toBe('waived');
    const interactions = await f.runtime.listInteractions({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      state: 'answered',
    });
    expect(interactions.interactions).toHaveLength(2);
    expect(interactions.interactions.every((i) => i.acceptedDecisionRevision !== null)).toBe(true);
    const views = await f.runtime.queryExtension({
      sessionId: 's',
      extensionId: planningExtensionId,
      queryId: 'validation.status',
      input: { runId },
    });
    expect(views[0]!.payload).toMatchObject({
      waiver: { proof: { interactionId: second.id } },
      waiverCurrent: { key: secondKey },
    });
  } finally {
    await f.close();
  }
}, 15000);

test('request_waiver known denial has no Interaction or unknown execution while an actual checker failure remains unknown', async () => {
  const denied = await fixture({}, async (step, f) =>
    step === 0
      ? call('validation.request_waiver', {
          recordKey: `run/${await f.runId()}/validation.required`,
          reason: 'not allowed',
        })
      : [finish],
  );
  try {
    await denied.submit();
    expect((await denied.done())!.status).toBe('completed');
    const execution = (await denied.store.listExecutions('s')).find(
      (e) => e.definitionId === 'validation.request_waiver',
    )!;
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({ content: 'validation_waiver_not_allowed' });
    expect(
      (
        await denied.runtime.listInteractions({
          expectedStoreId: denied.base.expectedStoreId,
          sessionId: 's',
        })
      ).interactions,
    ).toHaveLength(0);
  } finally {
    await denied.close();
  }
  let runId = '';
  const unknown = await fixture(
    {
      requiredValidation: true,
      fileHashChecker: { definitionId: 'fixture.unknown', definitionVersion: '1' },
    },
    async (step, f) => {
      if (step === 0) {
        runId = await f.runId();
        return call('validation.define', {
          runId,
          checks: [{ kind: 'file_hash', path: 'unused', sha256: '0'.repeat(64) }],
        });
      }
      if (step === 1) return call('validation.check', { runId });
      return [finish];
    },
    true,
    (extension) => ({
      ...extension,
      tools: [
        ...extension.tools!,
        {
          id: 'fixture.unknown',
          version: '1',
          description: 'Actual thrown adapter after dispatch',
          inputSchema: { type: 'object' },
          async execute() {
            throw new Error('external_result_unconfirmed');
          },
        },
      ],
    }),
  );
  try {
    await unknown.submit();
    expect((await unknown.done())!.status).toBe('failed');
    expect(
      (await unknown.store.listExecutions('s')).find((e) => e.definitionId === 'fixture.unknown')!
        .status,
    ).toBe('outcome_unknown');
    const pointer = (await unknown.record(`run/${runId}/validation.current`))!.value as {
      key: string;
    };
    expect(
      ((await unknown.record(pointer.key))!.value as { checks: { outcome: string }[] }).checks[0]!
        .outcome,
    ).toBe('unknown');
  } finally {
    await unknown.close();
  }
}, 15000);

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
    if (step === 0) return call('planning.write', plan(null));
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('planning.review', {
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'accept_edits' });
    const first = await f.done('first');
    expect(f.effects).toBe(1);
    const state = await f.business.readPlanningState(read, {
      runId: first!.id,
      originStoreId: f.base.expectedStoreId,
    });
    expect(state).toMatchObject({
      status: 'approved',
      mode: 'accept_edits',
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
    await f.runtime.waitForCommand('review', { timeoutMs: 5000 });
    expect((await f.record('approval/p/1'))!.value).toMatchObject({ runId: null });
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
      if (step === 0) return call('planning.write', plan(null));
      if (step === 1) {
        const current = (await f.record('plan.current'))!.value as Record<string, Json>;
        return call('planning.review', {
          planId: current.planId!,
          version: current.version!,
          digest: current.digest!,
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
    if (step === 0) return call('planning.write', { ...plan(null), body });
    if (step === 1) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      return call('planning.review', {
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
      });
    }
    if (step === 2) return call('fixture.effect');
    if (step === 3) {
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      const effect = (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.effect',
      )!;
      return call('planning.update', {
        runId: await f.runId(),
        planId: current.planId!,
        version: current.version!,
        digest: current.digest!,
        expectedProgressRevision: null,
        stepId: 'a',
        status: 'completed',
        executionId: effect.id,
        completePlan: true,
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
    ).toMatchObject({ status: 'approved', mode: 'auto' });
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
  if (step === 0) return call('planning.write', { ...plan(null), body: attachmentPlanBody });
  if (step === 1) {
    const current = (await f.record('plan.current'))!.value as Record<string, Json>;
    return call('planning.review', {
      planId: current.planId!,
      version: current.version!,
      digest: current.digest!,
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
      await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
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
    if (step === 0) return call('planning.write', plan(null));
    const pointer = (await f.record('plan.current'))!.value as Record<string, Json>;
    if (step === 1)
      return call('planning.review', {
        planId: pointer.planId!,
        version: pointer.version!,
        digest: pointer.digest!,
      });
    if (step === 2) return call('fixture.effect');
    if (step === 3)
      return call('planning.update', {
        runId: await f.runId(),
        planId: pointer.planId!,
        version: pointer.version!,
        digest: pointer.digest!,
        expectedProgressRevision: null,
        stepId: 'a',
        status: 'completed',
        executionId: (await f.store.listExecutions('s')).find(
          (e) => e.definitionId === 'fixture.effect',
        )!.id,
        completePlan: true,
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
    await f.answer({ kind: 'plan_review', decision: 'approve', mode: 'accept_edits' });
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
