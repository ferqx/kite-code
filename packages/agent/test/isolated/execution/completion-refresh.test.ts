import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { AgentError, createRuntime } from '../../../src';
import type { Extension, Json, ToolContext } from '../../../src/extensions';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function fact<T>(read: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= until) throw Error('completion_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(
  mode:
    | 'steer'
    | 'source'
    | 'snapshot'
    | 'shared-snapshot'
    | 'deny'
    | 'dispatched-refresh'
    | 'spoofed-snapshot'
    | 'finish-race'
    | 'prepare-steer'
    | 'prepare-source'
    | 'evaluate-steer'
    | 'mismatched-reads',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-completion-refresh-')));
  const instruction = join(root, 'AGENTS.md');
  writeFileSync(instruction, 'original completion rule');
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'seed', name: 'fixture.seed', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
    [finish],
  ]);
  const conditionEntered = gate(),
    conditionRelease = gate();
  const prepareEntered = gate(),
    prepareRelease = gate(),
    evaluateEntered = gate(),
    evaluateRelease = gate();
  const finishEntered = gate(),
    finishRelease = gate();
  let finishAttempts = 0;
  const finishErrors: string[] = [];
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'finishRun')
        return async (input: Parameters<typeof store.finishRun>[0]) => {
          if (mode === 'finish-race' && input.status === 'completed') {
            finishAttempts++;
            if (finishAttempts === 1) {
              finishEntered.release();
              await finishRelease.waiting;
            }
          }
          try {
            return await target.finishRun(input);
          } catch (error) {
            if (mode === 'finish-race')
              finishErrors.push(error instanceof AgentError ? error.code : 'unexpected');
            throw error;
          }
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let recordKey = '',
    evaluationCount = 0,
    raced = false;
  const prepared: Json[] = [],
    effects: Json[] = [];
  const instanceId = 'completion-test-host';
  const writerStarted = gate(),
    writerRelease = gate();
  let writer: ToolContext | undefined;
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    records: [
      { contentType: 'agent.mutation-policy', contentVersion: 1, schema: { type: 'object' } },
      {
        contentType: 'fixture.completion',
        contentVersion: 1,
        schema: {
          type: 'object',
          required: ['done'],
          properties: { done: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    ],
    tools: [
      {
        id: 'fixture.seed',
        version: '1',
        description: 'Establish actual original host record writer',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          const state = (await context.records.get(recordKey))!;
          await context.records.write({
            key: recordKey,
            expectedRevision: state.revision,
            contentType: 'fixture.completion',
            contentVersion: 1,
            value: { done: ['snapshot', 'shared-snapshot', 'finish-race'].includes(mode) },
            executable: true,
          });
          if (['snapshot', 'shared-snapshot', 'finish-race'].includes(mode)) {
            await context.operations.ensure({
              key: 'concurrent-writer',
              cancellation: 'detached',
              request: {
                kind: 'tool',
                definitionId: 'fixture.concurrent',
                definitionVersion: '1',
                input: {},
              },
            });
            await writerStarted.waiting;
          }
          return { outcome: 'succeeded', content: 'original seed observed once' };
        },
      },
      {
        id: 'fixture.concurrent',
        version: '1',
        description: 'Legitimate live concurrent metadata writer',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          writer = context;
          writerStarted.release();
          await writerRelease.waiting;
          return { outcome: 'succeeded', content: 'actual concurrent metadata write completed' };
        },
      },
      {
        id: 'fixture.complete',
        version: '1',
        description: 'Original scoped completion check',
        inputSchema: {
          type: 'object',
          required: [
            'recordKey',
            'revision',
            'rule',
            'direction',
            'headRevision',
            'mutationExecutionId',
          ],
          properties: {
            recordKey: { type: 'string' },
            revision: { type: 'string' },
            rule: { type: 'string' },
            direction: { type: 'string' },
            headRevision: { type: 'string' },
            mutationExecutionId: { type: 'string' },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const parameters = input as {
            recordKey: string;
            revision: string;
            rule: string;
            headRevision: string;
            mutationExecutionId: string;
          };
          effects.push(input);
          if (mode === 'dispatched-refresh')
            return { outcome: 'failed', content: 'context_refresh_required' };
          await context.records.write({
            key: parameters.recordKey,
            expectedRevision: parameters.revision,
            contentType: 'fixture.completion',
            contentVersion: 1,
            value: { done: true },
            executable: true,
          });
          await context.mutationFacts!.commit({
            requirementId: 'complete',
            mutationExecutionId: parameters.mutationExecutionId,
            headRevision: parameters.headRevision,
            outcome: 'passed',
            evidence: {},
          });
          return {
            outcome: 'succeeded',
            content: 'completion checked with the current original input',
          };
        },
      },
    ],
    mutationGovernance: {
      requirementId: 'complete',
      definitions: [{ id: 'fixture.seed', version: '1', effects: ['record_write'] }],
      async describe(input) {
        return { input: input.input };
      },
    },
    completionGovernance: {
      async prepare(input) {
        const reference = input.requirements.find((ref) => ref.requirementId === 'complete')!;
        const scoped = await input.context.forRequirement(reference);
        const record = await scoped.records.get(recordKey);
        const page = await scoped.readMutationFacts!({ limit: 10 });
        const parameters = {
          headRevision: page.headRevision!,
          mutationExecutionId: page.facts[0]!.executionId,
          recordKey,
          revision: record!.revision,
          rule: readFileSync(instruction, 'utf8'),
          direction: model.requests.some((request) =>
            request.messages.some(
              (message) => message.content === 'Follow up: fresh completion direction',
            ),
          )
            ? 'fresh'
            : 'original',
        };
        prepared.push(parameters);
        if ((mode === 'prepare-steer' || mode === 'prepare-source') && prepared.length === 1) {
          prepareEntered.release();
          await prepareRelease.waiting;
        }
        return {
          kind: 'tool',
          key: `check-${prepared.length}`,
          definitionId: 'fixture.complete',
          definitionVersion: '1',
          input: parameters,
        };
      },
    },
  };
  const sources = createProjectSources({ workspaceRoot: async () => root });
  const runtime = createRuntime({
    instanceId,
    store: runtimeStore,
    model,
    modelId: 'fixed',
    sources,
    extensions: [
      mode === 'evaluate-steer' ? { ...extension, completionGovernance: undefined } : extension,
    ],
    permissions: {
      async authorize(request) {
        if (request.definitionId !== 'fixture.complete')
          return { allowed: true, revision: 'owned' };
        if (mode === 'deny')
          return { allowed: false, revision: 'owned', reason: 'permission_denied' };
        if (mode !== 'steer' && mode !== 'source') return { allowed: true, revision: 'owned' };
        return {
          allowed: false,
          revision: 'owned',
          reason: 'approval_required',
          approval: {
            request: { title: 'Approve original completion check' },
            grants: ['approve_once'],
          },
        };
      },
    },
    async initializeRunRequirements(input) {
      const scoped = await input.forExtension('fixture');
      recordKey = `run/${input.run.id}/completion-state`;
      const policyKey = `run/${input.run.id}/completion-policy`;
      await scoped.records.create({
        key: policyKey,
        contentType: 'agent.mutation-policy',
        contentVersion: 1,
        value: {
          kind: 'mutation_policy',
          runId: input.run.id,
          definitions: [{ id: 'fixture.seed', version: '1', effects: ['record_write'] }],
          checkDefinitionId: 'fixture.complete',
          checkDefinitionVersion: '1',
        },
      });
      await scoped.records.create({
        key: recordKey,
        contentType: 'fixture.completion',
        contentVersion: 1,
        value: { done: ['snapshot', 'shared-snapshot', 'finish-race'].includes(mode) },
      });
      return (mode === 'shared-snapshot' ? ['complete', 'shared-complete'] : ['complete']).map(
        (requirementId) => ({
          extensionId: 'fixture',
          sessionId: 's',
          runId: input.run.id,
          requirementId,
          definitionVersion: '1',
          recordKey: policyKey,
          revision: '1',
          phase: 'completion' as const,
        }),
      );
    },
    conditions: {
      async evaluate(requirements, phase, context) {
        expect(phase).toBe('completion');
        evaluationCount++;
        if (mode === 'mismatched-reads' && evaluationCount > 1)
          throw Error('invalid_provider_readset_was_retried');
        if (mode === 'spoofed-snapshot')
          throw new AgentError('necessary_condition_snapshot_changed');
        if (mode === 'shared-snapshot') {
          const evaluations = [];
          for (const requirement of requirements) {
            const scoped = await context!.forRequirement(requirement);
            const policy = (await scoped.records.get(requirement.recordKey))!;
            const record = (await scoped.records.get(recordKey))!;
            if (!raced) {
              raced = true;
              conditionEntered.release();
              await conditionRelease.waiting;
            }
            evaluations.push({
              requirement,
              recordRevision: policy.revision,
              outcome: 'satisfied' as const,
              evidence: { observedRevision: record.revision },
            });
          }
          return evaluations;
        }
        return Promise.all(
          requirements.map(async (requirement) => {
            const scoped = await context!.forRequirement(requirement);
            const policy = await scoped.records.get(requirement.recordKey);
            let record = await scoped.records.get(recordKey);
            if (mode === 'evaluate-steer' && evaluationCount === 1) {
              evaluateEntered.release();
              await evaluateRelease.waiting;
            }
            if (mode === 'snapshot' && !raced) {
              raced = true;
              conditionEntered.release();
              await conditionRelease.waiting;
              record = await scoped.records.get(recordKey);
            }
            return {
              requirement,
              recordRevision: policy!.revision,
              outcome:
                (record!.value as { done: boolean }).done ||
                (mode === 'evaluate-steer' &&
                  model.requests.some((request) =>
                    request.messages.some(
                      (message) => message.content === 'Follow up: fresh completion direction',
                    ),
                  ))
                  ? ('satisfied' as const)
                  : ('unsatisfied' as const),
              evidence: { observedRevision: record!.revision },
              ...(mode === 'mismatched-reads'
                ? {
                    recordReads: [
                      { key: recordKey, revision: '999', originStoreId: record!.originStoreId },
                    ],
                  }
                : {}),
            };
          }),
        );
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    workspaceId: 'w',
    commandId: 'create',
    title: 'completion refresh',
  });
  const run = async () => (await store.getView('s')).runs[0]!;
  const cardOrTerminal = (exclude = '') =>
    fact(async () => {
      const current = await run();
      const card = (
        await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions.find((item) => item.id !== exclude);
      return card
        ? { card, run: current }
        : current && !current.isActive
          ? { card: null, run: current }
          : null;
    });
  return {
    root,
    store,
    runtime,
    model,
    base,
    instruction,
    prepared,
    effects,
    run,
    conditionEntered,
    conditionRelease,
    prepareEntered,
    prepareRelease,
    evaluateEntered,
    evaluateRelease,
    finishEntered,
    finishRelease,
    finishErrors,
    finishAttempts: () => finishAttempts,
    cardOrTerminal,
    evaluations: () => evaluationCount,
    async submit() {
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Complete original scoped work' },
      });
    },
    async approve(card: InteractionRecord) {
      await runtime.answerInteraction({
        ...base,
        commandId: `approve-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
    },
    async done() {
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      return run();
    },
    async assertAppliedSteer(commandId: string, runId: string) {
      const command = (await store.getCommand(commandId))!;
      expect(command).toMatchObject({ status: 'applied', receipt: { runId } });
      const receipt = command.receipt as { messageId: string };
      expect(receipt.messageId).toBeString();
      const request = command.request as { content: string };
      expect(command).toMatchObject({
        id: commandId,
        kind: 'input.steer',
        rootWorkCommandId: 'work',
        status: 'applied',
        request: { targetRunId: runId, content: request.content },
        receipt: { runId },
      });
      expect(
        (await store.listMessages(command.sessionId)).find(
          (message) => message.id === receipt.messageId,
        ),
      ).toMatchObject({
        runId,
        content: request.content,
        originCommandId: commandId,
        inputKind: 'input.steer',
        sourceIds: [commandId],
      });
    },
    async bumpRecord() {
      expect(writer).toBeDefined();
      const record = (await writer!.records.get(recordKey))!;
      const written = await writer!.records.write({
        key: recordKey,
        expectedRevision: record.revision,
        contentType: 'fixture.completion',
        contentVersion: 1,
        value: { done: true },
        executable: true,
      });
      writerRelease.release();
      return written;
    },
    async close() {
      conditionRelease.release();
      prepareRelease.release();
      evaluateRelease.release();
      finishRelease.release();
      writerRelease.release();
      await runtime.close();
      await sources.dispose();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('steer retires a completion Tool awaiting approval and the same Run completes under fresh input', async () => {
  const f = await fixture('steer');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    expect({
      reason: first.run.reason,
      active: first.run.isActive,
      approval: !!first.card,
    }).toMatchObject({ reason: null, active: true, approval: true });
    const old = first.card!;
    const originalRun = first.run.id;
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'steer',
      request: {
        kind: 'input.steer',
        targetRunId: originalRun,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: Use the new completion direction',
      },
    });
    const next = await f.cardOrTerminal(old.id);
    expect({
      active: next.run.isActive,
      reason: next.run.reason,
      freshApproval: !!next.card,
    }).toMatchObject({ active: true, reason: null, freshApproval: true });
    const fresh = next.card!;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.executionId).not.toBe(old.executionId);
    const modelCount = f.model.requests.length;
    const late = await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'late-old-allow',
      presentationSessionId: 's',
      interactionId: old.id,
      expectedRevision: old.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect(late.receipt).toMatchObject({
      outcome: 'answer_saved',
      interactionId: old.id,
      cancelled: true,
    });
    const readCard = (interactionId: string) =>
      f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId,
      });
    expect(await readCard(old.id)).toMatchObject({
      state: 'cancelled',
      acceptedDecisionRevision: null,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect(await readCard(fresh.id)).toEqual(fresh);
    expect(fresh).toMatchObject({ state: 'pending', answer: null, acceptedDecisionRevision: null });
    expect(await f.store.getExecution(fresh.executionId)).toMatchObject({
      status: 'planned',
      authorization: { dispatched: false },
    });
    expect(f.effects).toEqual([]);
    expect(f.model.requests).toHaveLength(modelCount);
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    expect(await f.run()).toMatchObject({ id: originalRun, isActive: true });
    await f.approve(next.card!);
    expect(await f.done()).toMatchObject({ id: originalRun, status: 'completed' });
    await f.assertAppliedSteer('steer', originalRun);
    expect(f.model.requests).toHaveLength(3);
    expect(
      f.model.requests[2]!.messages.some(
        (message) => message.content === 'Follow up: Use the new completion direction',
      ),
    ).toBe(true);
    expect(f.effects).toHaveLength(1);
    expect(await f.store.getExecution(fresh.executionId)).toMatchObject({
      status: 'succeeded',
      authorization: {
        dispatched: true,
        human: { interactionId: fresh.id, accepted: true, decision: 'approve' },
      },
      interactionBinding: { interactionId: fresh.id },
    });
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      status: 'cancelled',
      authorization: { dispatched: false },
      result: { details: { adapterAttempted: false } },
    });
  } finally {
    await f.close();
  }
});

test('a source edit during completion approval reprepares the directive instead of dispatching old input', async () => {
  const f = await fixture('source');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    expect({
      reason: first.run.reason,
      active: first.run.isActive,
      approval: !!first.card,
    }).toMatchObject({ reason: null, active: true, approval: true });
    const old = first.card!;
    writeFileSync(f.instruction, 'updated completion rule');
    await f.approve(old);
    const next = await f.cardOrTerminal(old.id);
    expect({
      active: next.run.isActive,
      reason: next.run.reason,
      freshApproval: !!next.card,
    }).toMatchObject({ active: true, reason: null, freshApproval: true });
    expect(f.prepared).toHaveLength(2);
    expect(f.prepared[1]).toMatchObject({ rule: 'updated completion rule' });
    expect(f.effects).toEqual([]);
    await f.approve(next.card!);
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed' });
    expect(f.effects).toEqual([f.prepared[1]!]);
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      status: 'failed',
      authorization: { dispatched: false },
      result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
    });
  } finally {
    await f.close();
  }
});

test('a legitimate concurrent condition record revision is locally reevaluated without Model or Tool replay', async () => {
  const f = await fixture('snapshot');
  try {
    await f.submit();
    await f.conditionEntered.waiting;
    await f.bumpRecord();
    f.conditionRelease.release();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'completed',
      reason: null,
    });
    expect(f.evaluations()).toBe(2);
    expect(f.model.requests).toHaveLength(2);
    expect(f.prepared).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(2);
    expect(
      (await f.store.listExecutions('s')).filter(
        (execution) => execution.definitionId === 'fixture.seed',
      ),
    ).toHaveLength(1);
    expect(
      (await f.store.listExecutions('s')).filter(
        (execution) => execution.definitionId === 'fixture.concurrent',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('two requirements sharing a record reevaluate a real revision change between their reads', async () => {
  const f = await fixture('shared-snapshot');
  try {
    await f.submit();
    await f.conditionEntered.waiting;
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await f.bumpRecord();
    expect(BigInt((await f.store.getMetadata()).lastChangeCursor)).toBeGreaterThan(BigInt(before));
    f.conditionRelease.release();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'completed',
      reason: null,
    });
    expect(completed.requirements).toHaveLength(2);
    expect(f.evaluations()).toBe(2);
    expect(f.model.requests).toHaveLength(2);
    expect(f.prepared).toEqual([]);
    expect(f.effects).toEqual([]);
    const tools = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools).toHaveLength(2);
    expect(tools.filter((execution) => execution.definitionId === 'fixture.seed')).toHaveLength(1);
    expect(
      tools.filter((execution) => execution.definitionId === 'fixture.concurrent'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a genuine completion Tool permission denial remains a failed Run with zero adapter effects', async () => {
  const f = await fixture('deny');
  try {
    await f.submit();
    expect(await f.done()).toMatchObject({ status: 'failed' });
    expect(f.effects).toEqual([]);
    expect(f.model.requests).toHaveLength(2);
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.complete',
      ),
    ).toMatchObject({ status: 'failed', authorization: { dispatched: false } });
  } finally {
    await f.close();
  }
});

test('a dispatched completion Tool cannot disguise its failed adapter result as a pre-dispatch refresh', async () => {
  const f = await fixture('dispatched-refresh');
  try {
    await f.submit();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'failed',
      reason: 'context_refresh_required',
    });
    expect(f.effects).toHaveLength(1);
    expect(f.prepared).toHaveLength(1);
    expect(f.model.requests).toHaveLength(2);
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.complete',
      ),
    ).toMatchObject({
      status: 'failed',
      authorization: { dispatched: true },
      result: { outcome: 'failed', content: 'context_refresh_required' },
    });
  } finally {
    await f.close();
  }
});

test('an extension throwing the snapshot error code cannot request Core local reevaluation', async () => {
  const f = await fixture('spoofed-snapshot');
  try {
    await f.submit();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'failed',
      reason: 'necessary_condition_snapshot_changed',
    });
    expect(f.evaluations()).toBe(1);
    expect(f.model.requests).toHaveLength(2);
    expect(f.prepared).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(
      (await f.store.listExecutions('s')).filter(
        (execution) => execution.definitionId === 'fixture.seed',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a genuine record commit between completion evaluation and finishRun only retries settling', async () => {
  const f = await fixture('finish-race');
  try {
    await f.submit();
    await f.finishEntered.waiting;
    expect(f.evaluations()).toBe(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await f.bumpRecord();
    expect(BigInt((await f.store.getMetadata()).lastChangeCursor)).toBeGreaterThan(BigInt(before));
    f.finishRelease.release();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'completed',
      reason: null,
    });
    expect(f.finishErrors).toEqual(['requirement_not_satisfied']);
    expect(f.finishAttempts()).toBe(2);
    expect(f.evaluations()).toBe(2);
    expect(f.model.requests).toHaveLength(2);
    expect(f.effects).toEqual([]);
    expect(f.prepared).toEqual([]);
    const tools = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools).toHaveLength(2);
    expect(tools.filter((execution) => execution.definitionId === 'fixture.seed')).toHaveLength(1);
    expect(
      tools.filter((execution) => execution.definitionId === 'fixture.concurrent'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const change of ['steer', 'source'] as const)
  test(`a ${change} arriving while completion prepare awaits cannot dispatch its old directive`, async () => {
    const f = await fixture(change === 'steer' ? 'prepare-steer' : 'prepare-source');
    try {
      await f.submit();
      await f.prepareEntered.waiting;
      const originalRun = (await f.run()).id;
      expect(f.effects).toEqual([]);
      expect(f.prepared).toHaveLength(1);
      if (change === 'source') writeFileSync(f.instruction, 'updated completion rule');
      else {
        const session = (await f.store.getSession('s'))!;
        await f.runtime.submitCommand({
          ...f.base,
          commandId: 'prepare-steer',
          request: {
            kind: 'input.steer',
            targetRunId: originalRun,
            contextSelectionId: session.contextSelectionId,
            content: 'Follow up: fresh completion direction',
          },
        });
      }
      f.prepareRelease.release();
      expect(await f.done()).toMatchObject({ id: originalRun, status: 'completed', reason: null });
      expect(f.prepared).toHaveLength(2);
      expect(f.effects).toEqual([f.prepared[1]!]);
      expect(f.prepared[0]).toMatchObject({
        rule: 'original completion rule',
        direction: 'original',
      });
      expect(f.effects[0]).toMatchObject(
        change === 'source' ? { rule: 'updated completion rule' } : { direction: 'fresh' },
      );
      if (change === 'steer') {
        await f.assertAppliedSteer('prepare-steer', originalRun);
        expect(f.model.requests).toHaveLength(3);
        expect(
          f.model.requests[2]!.messages.some(
            (message) => message.content === 'Follow up: fresh completion direction',
          ),
        ).toBe(true);
      }
      const tools = (await f.store.listExecutions('s')).filter(
        (execution) => execution.definitionId === 'fixture.complete',
      );
      expect(tools.filter((execution) => execution.authorization?.dispatched)).toHaveLength(1);
      expect(tools.find((execution) => execution.authorization?.dispatched)!.input).toEqual(
        f.prepared[1]!,
      );
    } finally {
      await f.close();
    }
  });

test('steer accepted during completion evaluation is applied before an unsatisfied no-directive result can fail the Run', async () => {
  const f = await fixture('evaluate-steer');
  try {
    await f.submit();
    await f.evaluateEntered.waiting;
    const originalRun = (await f.run()).id;
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'evaluation-steer',
      request: {
        kind: 'input.steer',
        targetRunId: originalRun,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: fresh completion direction',
      },
    });
    f.evaluateRelease.release();
    const completed = await f.done();
    await f.assertAppliedSteer('evaluation-steer', originalRun);
    expect({ id: completed.id, status: completed.status, reason: completed.reason }).toEqual({
      id: originalRun,
      status: 'completed',
      reason: null,
    });
    expect(f.evaluations()).toBe(2);
    expect(f.model.requests).toHaveLength(3);
    expect(
      f.model.requests[2]!.messages.some(
        (message) => message.content === 'Follow up: fresh completion direction',
      ),
    ).toBe(true);
    expect(f.prepared).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('provider-declared recordReads conflicting with the actual read set are invalid rather than a retriable Core race', async () => {
  const f = await fixture('mismatched-reads');
  try {
    await f.submit();
    const completed = await f.done();
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'failed',
      reason: 'necessary_condition_snapshot_changed',
    });
    expect(f.evaluations()).toBe(1);
    expect(f.model.requests).toHaveLength(2);
    expect(f.prepared).toEqual([]);
    expect(f.effects).toEqual([]);
  } finally {
    await f.close();
  }
});
