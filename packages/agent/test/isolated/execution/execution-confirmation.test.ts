import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, JobDefinition, Json, ToolDefinition } from '../../../src/extensions';
import { canonicalJson, semanticDigest } from '../../../src/json';
import {
  createPermissionPolicy,
  intersectPermissionPolicies,
  type PermissionMode,
} from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import type { TrustedToolBehavior } from '../../../src/tool-behavior';

const stop: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until<T>(read: () => Promise<T | null>) {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error('confirmation_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(initialMode: PermissionMode, scenario = 'closed') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-confirmation-')));
  const profile = { dataRoot: root, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'user' };
  let mode = initialMode,
    mutations = 0,
    effects = 0,
    calls = 0,
    reviews = 0;
  const hasBlocker = scenario === 'queued' || scenario === 'changing-resource';
  const policyReads: { executionId: string; mode: PermissionMode; revision: string }[] = [];
  let declarations = 0;
  let denyJob = false;
  let customJobChallenge = false;
  let blockerEntered!: () => void, releaseBlocker!: () => void, releaseFinalModel!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    blockerEntered = resolve;
  });
  const blockerWaiting = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const finalModelWaiting = new Promise<void>((resolve) => {
    releaseFinalModel = resolve;
  });
  let modelCalls = 0;
  const job: JobDefinition = {
    ...(scenario === 'queued' ? { resources: { slot: 'process' as const } } : {}),
    id: 'fixture.closed',
    version: '1',
    description: 'Exactly one bounded child',
    inputSchema: { type: 'object' },
    async start() {
      effects++;
      return { reference: {} };
    },
    async *observe() {
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'one effect' },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const tool: ToolDefinition = {
    ...(scenario === 'changing-resource' ? { resources: { slot: 'process' as const } } : {}),
    id: 'fixture.confirmed',
    version: '1',
    description: 'An owner-declared exact human decision',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      calls++;
      customJobChallenge = true;
      if (scenario === 'changing-resource') {
        effects++;
        return {
          outcome: 'succeeded',
          content: 'Owned Tool effect after current-mode resource admission',
        };
      }
      const key = `closed/${context.executionId}`;
      const operation = await context.operations.ensure({
        ...(scenario === 'detached' ? { cancellation: 'detached' as const } : {}),
        key: scenario === 'wrong-step' ? `extra/${context.executionId}` : key,
        request: {
          kind: 'job',
          definitionId: job.id,
          definitionVersion: job.version,
          input: { effect: scenario === 'wrong-input' ? 'another' : 'owned' },
        },
      });
      if (scenario === 'queued')
        return {
          outcome: 'succeeded',
          content: 'Exact internal Job registered behind the independent process slot owner',
        };
      const actual = await context.operations.wait(operation);
      if (scenario === 'same-step') {
        const original = await context.operations.ensure({
          key,
          request: {
            kind: 'job',
            definitionId: job.id,
            definitionVersion: job.version,
            input: { effect: 'owned' },
          },
        });
        expect(original).toEqual(operation);
      }
      if (scenario === 'extra-job') {
        const extra = await context.operations.ensure({
          key: `extra/${context.executionId}`,
          request: {
            kind: 'job',
            definitionId: job.id,
            definitionVersion: job.version,
            input: { effect: 'owned' },
          },
        });
        await context.operations.wait(extra);
      }
      return {
        outcome: actual.status === 'succeeded' ? 'succeeded' : 'failed',
        content: 'original closed step observed',
      };
    },
  };
  const blocker: JobDefinition = {
    id: 'fixture.block-job',
    version: '1',
    description: 'Test-owned process slot barrier',
    inputSchema: { type: 'object' },
    resources: { slot: 'process' },
    async start() {
      blockerEntered();
      return { reference: {} };
    },
    async *observe() {
      await blockerWaiting;
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'Barrier released' },
      };
    },
    async cancel() {
      releaseBlocker();
      return { status: 'requested' };
    },
    async dispose() {},
  };
  const blockTool: ToolDefinition = {
    id: 'fixture.block-tool',
    version: '1',
    description: 'Register the independent process slot owner',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      await context.operations.ensure({
        key: 'blocker',
        request: {
          kind: 'job',
          definitionId: blocker.id,
          definitionVersion: blocker.version,
          input: {},
        },
      });
      await blockerStarted;
      return { outcome: 'succeeded', content: 'The independent Job holds the single process slot' };
    },
  };
  const extension: Extension = {
    id: 'fixture.owner',
    version: '1',
    apiMajor: 1,
    tools: [tool, ...(hasBlocker ? [blockTool] : [])],
    jobs: [job, ...(hasBlocker ? [blocker] : [])],
  };
  const behavior: TrustedToolBehavior = {
    capability: { kind: 'tool', definitionId: tool.id, definitionVersion: tool.version },
    definition: tool,
    contractRef: scenario === 'long-contract' ? 'c'.repeat(512) : 'fixture.human-execution',
    configurationDigest: await semanticDigest({ closed: job.id }),
    async executionConfirmation(request) {
      declarations++;
      if (scenario === 'hard-deny-tool-throw')
        throw new Error('private_confirmation_prepare_failure');
      return {
        request: {
          purpose: 'Confirm this exact call',
          body: scenario.includes('artifact')
            ? 'x'.repeat(70000)
            : scenario.startsWith('changing')
              ? `declaration-${declarations}`
              : 'bounded',
        },
        steps: [
          {
            key: `closed/${request.executionId}`,
            capability: { kind: 'job', definitionId: job.id, definitionVersion: job.version },
            input: { effect: 'owned' },
          },
        ],
      };
    },
  };
  const policy = createPermissionPolicy({
    async readPolicy(request) {
      const current = await store.readHostControl({
        ...base,
        kind: 'permission.mode',
        scope: 'session:s',
      });
      policyReads.push({ executionId: request.executionId, mode, revision: current.revision });
      return {
        mode,
        workspaceTrust: true,
        revision: current.revision,
        controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: current.revision }],
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      };
    },
    describeCapability(request) {
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        hardAllowed:
          !(denyJob && request.kind === 'job') &&
          !(scenario.startsWith('hard-deny-tool') && request.kind === 'tool'),
        revision: 'actual',
        safeRead: request.kind === 'model',
        ...(request.definitionId.startsWith('fixture.block-')
          ? { internalRecordOnly: true as const }
          : {}),
        effects:
          request.kind === 'model'
            ? ['read']
            : request.definitionId.startsWith('fixture.block-')
              ? ['record_write']
              : ['external'],
      };
    },
  });
  const permissions = [
    'custom-check',
    'custom-manual',
    'custom-allowed',
    'late-custom-job',
  ].includes(scenario)
    ? intersectPermissionPolicies(policy, {
        async authorize(request) {
          return scenario === 'custom-allowed' ||
            request.kind === 'model' ||
            (scenario === 'late-custom-job' && !(customJobChallenge && request.kind === 'job'))
            ? { allowed: true, revision: 'custom' }
            : {
                allowed: false,
                revision: 'custom',
                ...(scenario === 'custom-manual'
                  ? { approval: { request: { separate: true } } }
                  : { check: { request: { separate: true } } }),
              };
        },
      })
    : policy;
  const mark = store.markDispatching.bind(store);
  store.markDispatching = async (input) => {
    if (
      scenario.startsWith('sql-') &&
      (await store.getExecution(input.executionId))?.kind === 'job'
    ) {
      input = structuredClone(input);
      const proof = input.authorization.executionConfirmation!;
      if (scenario === 'sql-step')
        input.authorization.executionConfirmation = { ...proof, stepKey: 'unconfirmed-step' };
      if (scenario === 'sql-answer')
        input.authorization.executionConfirmation = { ...proof, decisionRevision: '999' };
      if (scenario === 'sql-owner')
        (proof.binding.owner as { contractRef: string }).contractRef = 'another.owner';
    }
    return mark(input);
  };
  const artifacts = createArtifactStore({ profile, store });
  let materialFaulted = false;
  let alteredArtifactHash: string | null = null;
  const originalRequests = new Map<string, Json>();
  const alteredMaterial = {
    purpose: 'Read-only preview only',
    body: 'Do not perform the owned effect',
  };
  if (scenario === 'material-artifact') {
    const publish = artifacts.publish.bind(artifacts);
    artifacts.publish = async (input) => {
      let complete: Record<string, Json> | null = null;
      try {
        complete = JSON.parse(new TextDecoder().decode(input.content)) as Record<string, Json>;
      } catch {
        /* Other Artifact purposes retain their original bytes. */
      }
      if (complete?.executionConfirmation) {
        const changed = structuredClone(complete);
        (changed.policy as Record<string, Json>).confirmation = alteredMaterial;
        const ref = await publish({ ...input, content: Buffer.from(canonicalJson(changed)) });
        alteredArtifactHash = ref.hash;
        materialFaulted = true;
        return ref;
      }
      return publish(input);
    };
  }
  if (scenario.startsWith('material-')) {
    const request = store.requestInteraction.bind(store);
    store.requestInteraction = async (input) => {
      const body = input.request as Record<string, Json>;
      if (input.kind !== 'approval' || !body.executionConfirmation) return request(input);
      const changed = structuredClone(input);
      const saved = changed.request as Record<string, Json>;
      if (scenario === 'material-artifact') {
        expect(alteredArtifactHash).not.toBeNull();
        saved.approvalRequestDigest = alteredArtifactHash!;
      } else {
        (saved.policy as Record<string, Json>).confirmation = alteredMaterial;
        materialFaulted = true;
      }
      const result = await request(changed);
      if (scenario !== 'material-inline-sql') return result;
      // Hide the changed row only from Core DTO reads. Final SQL still sees the
      // actual independently stored material and must reject it on its own.
      originalRequests.set(result.id, structuredClone(input.request));
      return { ...result, request: structuredClone(input.request) };
    };
    const get = store.getInteraction.bind(store);
    store.getInteraction = async (input) => {
      const result = await get(input);
      const original = result && originalRequests.get(result.id);
      return result && original ? { ...result, request: structuredClone(original) } : result;
    };
  }
  const fixedModel = createFixedModel([
    ...(hasBlocker
      ? [
          [
            { type: 'tool_call' as const, id: 'block', name: blockTool.id, arguments: '{}' },
            { ...stop, reason: 'tool_calls' },
          ],
        ]
      : []),
    [
      { type: 'tool_call', id: 'confirmed', name: tool.id, arguments: '{}' },
      ...(scenario === 'two-calls'
        ? [{ type: 'tool_call' as const, id: 'sibling', name: tool.id, arguments: '{}' }]
        : []),
      { ...stop, reason: 'tool_calls' },
    ],
    [stop],
    ...(scenario === 'new-run'
      ? [
          [
            { type: 'tool_call' as const, id: 'new-run', name: tool.id, arguments: '{}' },
            { ...stop, reason: 'tool_calls' },
          ],
          [stop],
        ]
      : []),
  ] as ModelEvent[][]);
  const runtime = createRuntime({
    ...(hasBlocker ? { processConcurrency: 1 } : {}),
    store,
    artifacts,
    modelId: 'fixed',
    permissions,
    extensions: [extension],
    toolBehaviors: [behavior],
    model: {
      async *stream(request, context) {
        if (scenario === 'queued' && ++modelCalls === 3) await finalModelWaiting;
        yield* fixedModel.stream(request, context);
      },
    },
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'reviewer',
      model: {
        async *stream() {
          reviews++;
          yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"ordinary"}' };
          yield stop;
        },
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'bounded',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'session',
    sessionId: 's',
    workspaceId: 'w',
    title: 'bounded',
  });
  return {
    runtime,
    releaseBlocker,
    releaseFinalModel,
    store,
    base,
    root,
    stats: () => ({ effects, calls, reviews }),
    declarations: () => declarations,
    policyReads: () => policyReads,
    materialFaulted: () => materialFaulted,
    denyJob() {
      denyJob = true;
    },
    async submit() {
      await runtime.submitCommand({
        ...base,
        sessionId: 's',
        commandId: 'work',
        request: { kind: 'run.start', content: 'Perform the owned operation once' },
      });
    },
    async done() {
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
    },
    async card() {
      return until(
        async () =>
          (await runtime.listInteractions({ ...base, sessionId: 's', state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async answer(card: { id: string; revision: string }, decision: 'approve' | 'deny' = 'approve') {
      return runtime.answerInteraction({
        ...base,
        commandId: `answer-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer:
          decision === 'approve'
            ? { kind: 'approval', decision, optionId: 'once' }
            : { kind: 'approval', decision },
      });
    },
    async setMode(next: PermissionMode) {
      const current = await store.readHostControl({
        ...base,
        kind: 'permission.mode',
        scope: 'session:s',
      });
      const safeRequest = {
        scope: 'session',
        sessionId: 's',
        mode: next,
        ifRevision: current.revision,
        makeDefault: false,
        ifDefaultRevision: '0',
      };
      const commandId = `mode-${++mutations}`,
        requestDigest = await semanticDigest(safeRequest);
      await store.beginHostMutation({
        ...base,
        commandId,
        kind: 'permission.mode',
        scope: 'session:s',
        safeRequest,
        requestDigest,
      });
      await store.finishHostMutation({
        ...base,
        commandId,
        requestDigest,
        state: 'applied',
        receipt: { status: 'applied' },
      });
      mode = next;
    },
    async close() {
      releaseBlocker();
      releaseFinalModel();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
for (const mode of ['accept_edits', 'auto', 'full'] as const)
  test(`owner human confirmation covers only exact Tool and closed own Job: ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await f.submit();
      const card = await f.card();
      expect(f.stats()).toEqual({ effects: 0, calls: 0, reviews: 0 });
      expect(card.kind).toBe('approval');
      await f.answer(card);
      await f.done();
      expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
      const executions = await f.store.listExecutions('s');
      const tool = executions.find((e) => e.kind === 'tool')!;
      const job = executions.find((e) => e.definitionId === 'fixture.closed')!;
      expect(tool.status).toBe('succeeded');
      expect(job.status).toBe('succeeded');
      expect(job.parentExecutionId).toBe(tool.id);
      expect(
        (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
      ).toHaveLength(1);
      expect(tool.authorization?.human?.accepted).toBe(true);
    } finally {
      await f.close();
    }
  });

for (const scenario of ['hard-deny-tool', 'hard-deny-tool-throw'] as const)
  test(`hard denial precedes any owner declaration preparation: ${scenario}`, async () => {
    const f = await fixture('auto', scenario);
    try {
      await f.submit();
      await f.done();
      expect(f.declarations()).toBe(0);
      expect(f.stats()).toEqual({ effects: 0, calls: 0, reviews: 0 });
      expect(
        (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
      ).toHaveLength(0);
      const tool = (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'tool',
      )!;
      expect(f.policyReads().some((read) => read.executionId === tool.id)).toBe(true);
      expect(tool.authorization?.dispatched).toBe(false);
      expect(tool.result).toMatchObject({
        details: { code: 'permission_denied', reason: 'capability_unavailable' },
      });
    } finally {
      await f.close();
    }
  });
for (const scenario of [
  'wrong-step',
  'wrong-input',
  'extra-job',
  'same-step',
  'artifact',
  'custom-check',
  'sql-step',
  'sql-answer',
  'sql-owner',
  'late-custom-job',
  'detached',
  'custom-manual',
  'custom-allowed',
  'hard-deny-tool',
] as const)
  test(`owner confirmation keeps closed scope and independent policy: ${scenario}`, async () => {
    const f = await fixture('auto', scenario);
    try {
      await f.submit();
      if (!['custom-check', 'custom-manual', 'hard-deny-tool'].includes(scenario))
        await f.answer(await f.card());
      await f.done();
      const interactions = (await f.runtime.listInteractions({ ...f.base, sessionId: 's' }))
        .interactions;
      expect(interactions).toHaveLength(
        ['custom-check', 'custom-manual', 'hard-deny-tool'].includes(scenario) ? 0 : 1,
      );
      expect(f.stats().reviews).toBe(0);
      expect(f.stats().effects).toBe(
        ['same-step', 'artifact', 'extra-job', 'custom-allowed'].includes(scenario) ? 1 : 0,
      );
      const jobs = (await f.store.listExecutions('s')).filter(
        (e) => e.definitionId === 'fixture.closed',
      );
      if (
        [
          'wrong-step',
          'wrong-input',
          'extra-job',
          'sql-step',
          'sql-answer',
          'sql-owner',
          'late-custom-job',
          'detached',
        ].includes(scenario)
      ) {
        const rejected = jobs.filter((e) => e.status === 'failed');
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.authorization?.dispatched).toBe(false);
        expect(rejected[0]!.result).toMatchObject({
          content:
            scenario === 'late-custom-job'
              ? 'execution_confirmation_policy_unsupported'
              : scenario === 'sql-step'
                ? 'execution_confirmation_step_mismatch'
                : scenario.startsWith('sql-')
                  ? 'execution_confirmation_changed'
                  : 'execution_confirmation_step_mismatch',
        });
      }
      if (['custom-check', 'custom-manual'].includes(scenario))
        expect(
          (await f.store.listExecutions('s')).find((e) => e.kind === 'tool')!.result,
        ).toMatchObject({ content: 'execution_confirmation_policy_unsupported' });
    } finally {
      await f.close();
    }
  });
for (const from of ['accept_edits', 'auto', 'full'] as const)
  for (const to of ['accept_edits', 'auto', 'full'] as const)
    if (from !== to)
      test(`pending owner confirmation remains one exact human decision: ${from} to ${to}`, async () => {
        const f = await fixture(from);
        try {
          await f.submit();
          const card = await f.card();
          await f.setMode(to);
          expect(
            await f.runtime.getInteraction({ ...f.base, sessionId: 's', interactionId: card.id }),
          ).toMatchObject({ state: 'pending', revision: card.revision });
          await f.answer(card);
          await f.done();
          expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
          expect(
            (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
          ).toHaveLength(1);
        } finally {
          await f.close();
        }
      });

for (const scenario of ['deny', 'cancel', 'hard-deny-job'] as const)
  test(`owner confirmation does not bypass cancellation or hard constraints: ${scenario}`, async () => {
    const f = await fixture('full');
    try {
      await f.submit();
      const card = await f.card();
      if (scenario === 'cancel') {
        await f.runtime.cancelExecution({
          ...f.base,
          sessionId: 's',
          commandId: 'cancel',
          executionId: card.executionId,
        });
      } else {
        if (scenario === 'hard-deny-job') f.denyJob();
        await f.answer(card, scenario === 'deny' ? 'deny' : 'approve');
      }
      await f.done();
      expect(f.stats()).toEqual({
        effects: 0,
        calls: scenario === 'hard-deny-job' ? 1 : 0,
        reviews: 0,
      });
      expect(
        (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

for (const scenario of ['two-calls', 'new-run'] as const)
  test(`a once owner confirmation does not approve a sibling call or another Run: ${scenario}`, async () => {
    const f = await fixture('full', scenario);
    try {
      await f.submit();
      const first = await f.card();
      await f.answer(first);
      if (scenario === 'new-run') {
        await f.done();
        await f.runtime.submitCommand({
          ...f.base,
          sessionId: 's',
          commandId: 'second-work',
          request: { kind: 'run.start', content: 'A separately authorized invocation' },
        });
      }
      const second = await f.card();
      expect(second.id).not.toBe(first.id);
      expect(second.executionId).not.toBe(first.executionId);
      await until(async () => (f.stats().effects === 1 ? true : null));
      expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
      if (scenario === 'new-run') expect(second.runId).not.toBe(first.runId);
      await f.answer(second);
      await f.runtime.waitForCommand(scenario === 'new-run' ? 'second-work' : 'work', {
        timeoutMs: 5000,
      });
      expect(f.stats()).toEqual({ effects: 2, calls: 2, reviews: 0 });
      expect(
        (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
      ).toHaveLength(2);
      const before = await f.store.listExecutions('s');
      await f.runtime.close();
      await f.store.close();
      const cold = await openSqliteStore({ dataRoot: f.root, profile: 'new', mode: 'readonly' });
      try {
        expect(await cold.listExecutions('s')).toEqual(before);
      } finally {
        await cold.close();
      }
      expect(f.stats()).toEqual({ effects: 2, calls: 2, reviews: 0 });
    } finally {
      await f.close();
    }
  });

test('an exact closed Job queued behind an independent process owner can dispatch after the parent Tool succeeds', async () => {
  const f = await fixture('auto', 'queued');
  try {
    await f.submit();
    await f.answer(await f.card());
    const planned = await until(async () => {
      const job = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'fixture.closed',
      );
      const parent = job && (await f.store.getExecution(job.parentExecutionId!));
      return job && parent?.status === 'succeeded' ? { job, parent } : null;
    });
    expect(planned.job.status).toBe('planned');
    expect(f.stats()).toEqual({ effects: 0, calls: 1, reviews: 0 });
    f.releaseBlocker();
    const job = await until(async () => {
      const current = await f.store.getExecution(planned.job.id);
      return current &&
        ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(current.status)
        ? current
        : null;
    });
    expect(job.status).toBe('succeeded');
    expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
    expect(
      (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
    ).toHaveLength(1);
    f.releaseFinalModel();
    await f.done();
  } finally {
    await f.close();
  }
});

for (const scenario of ['material-inline', 'material-artifact', 'material-inline-sql'] as const)
  test(`the actual owner confirmation material must match its frozen request digest: ${scenario}`, async () => {
    const f = await fixture('auto', scenario);
    try {
      await f.submit();
      await f.answer(await f.card());
      await f.done();
      expect(f.materialFaulted()).toBe(true);
      expect(f.stats()).toEqual({ effects: 0, calls: 0, reviews: 0 });
      const tool = (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'tool',
      )!;
      expect(tool.status).toBe('failed');
      expect(tool.result).toMatchObject({
        content: 'execution_confirmation_changed',
        details: { dispatchCommitted: false, adapterAttempted: false },
      });
      expect(tool.authorization?.dispatched).toBe(false);
      const card = (await f.runtime.listInteractions({ ...f.base, sessionId: 's' }))
        .interactions[0]!;
      expect(card.acceptedDecisionRevision === null).toBe(scenario !== 'material-inline-sql');
    } finally {
      await f.close();
    }
  });
for (const scenario of ['changing-declaration', 'long-contract'] as const)
  test(`accepted owner confirmation is reused without re-declaring its request: ${scenario}`, async () => {
    const f = await fixture('auto', scenario);
    try {
      await f.submit();
      const card = await f.card();
      if (scenario === 'long-contract')
        expect(
          (
            (card.request as Record<string, Json>).executionConfirmation as {
              owner: { contractRef: string };
            }
          ).owner.contractRef,
        ).toHaveLength(512);
      await f.answer(card);
      await f.done();
      expect(f.declarations()).toBe(1);
      expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
      expect(
        (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
      ).toHaveLength(1);
      const own = (await f.store.listExecutions('s')).filter(
        (execution) => execution.kind === 'tool' || execution.definitionId === 'fixture.closed',
      );
      expect(own.map((execution) => execution.status)).toEqual(['succeeded', 'succeeded']);
    } finally {
      await f.close();
    }
  });

test('an accepted changing declaration is not called again when its own Tool resource wait changes mode', async () => {
  const f = await fixture('auto', 'changing-resource');
  try {
    await f.submit();
    const card = await f.card();
    await f.answer(card);
    await until(async () => {
      const own = await f.store.getExecution(card.executionId);
      return own?.status === 'planned' && own.authorization?.human?.accepted ? own : null;
    });
    expect(f.stats()).toEqual({ effects: 0, calls: 0, reviews: 0 });
    await f.setMode('full');
    // The first read invalidates the old resource wait. A second actual policy
    // observation proves re-entry before releasing the independent process slot.
    await until(async () =>
      f
        .policyReads()
        .filter((read) => read.executionId === card.executionId && read.mode === 'full').length >= 2
        ? true
        : null,
    );
    expect(f.declarations()).toBe(1);
    expect(
      (await f.runtime.listInteractions({ ...f.base, sessionId: 's' })).interactions,
    ).toHaveLength(1);
    expect(f.stats()).toEqual({ effects: 0, calls: 0, reviews: 0 });
    f.releaseBlocker();
    await f.done();
    expect(f.declarations()).toBe(1);
    expect(f.stats()).toEqual({ effects: 1, calls: 1, reviews: 0 });
    const actual = (await f.store.getExecution(card.executionId))!;
    expect(actual.status).toBe('succeeded');
    expect(actual.authorization?.human?.interactionId).toBe(card.id);
  } finally {
    await f.close();
  }
});
