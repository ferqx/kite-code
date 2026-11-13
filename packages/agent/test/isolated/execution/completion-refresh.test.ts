import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { fixtureGrant, fixtureScopeOption } from '../../../../../tests/fixtures/permission-grant';
import { AgentError, createRuntime } from '../../../src';
import { Semaphore } from '../../../src/execution/resources';
import type { Extension, Json, ToolContext } from '../../../src/extensions';
import { approvalOptions } from '../../../src/permission-grants';
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
    await sleepTimer(5);
  }
}
async function fixture(
  mode:
    | 'steer'
    | 'busy-steer'
    | 'source'
    | 'snapshot'
    | 'shared-snapshot'
    | 'deny'
    | 'dispatched-refresh'
    | 'dispatched-steer'
    | 'dispatched-unknown'
    | 'dispatch-race'
    | 'grant-dispatch-race'
    | 'resource-steer'
    | 'foreground-resource-steer'
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
  const resourceMode = mode === 'resource-steer' || mode === 'foreground-resource-steer';
  const resourceSemaphore = new Semaphore(1);
  const releaseResource = resourceMode
    ? await resourceSemaphore.acquire(new AbortController().signal)
    : () => {};
  const resourceEntered = gate(),
    resourceInputObserved = gate();
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
  const dispatchEntered = gate(),
    dispatchRelease = gate();
  const inputBusyEntered = gate(),
    inputBusyRelease = gate(),
    inputBusyThrown = gate();
  let inputBusyInjected = false;
  const inputAttempts: string[] = [];
  let dispatchHeld = false;
  let finishAttempts = 0;
  const finishErrors: string[] = [];
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'getPendingInputQueue' && resourceMode)
        return async (input: Parameters<typeof store.getPendingInputQueue>[0]) => {
          const page = await target.getPendingInputQueue(input);
          if (page.commands.some((command) => command.id === 'resource-steer'))
            resourceInputObserved.release();
          return page;
        };
      if (key === 'applyInput' && mode === 'busy-steer')
        return async (input: Parameters<typeof store.applyInput>[0]) => {
          inputAttempts.push(input.commandId);
          if (input.kind === 'steer' && !inputBusyInjected) {
            inputBusyInjected = true;
            inputBusyEntered.release();
            await inputBusyRelease.waiting;
            inputBusyThrown.release();
            throw new AgentError('input_tools_pending');
          }
          return target.applyInput(input);
        };
      if (key === 'markDispatching' && ['dispatch-race', 'grant-dispatch-race'].includes(mode))
        return async (input: Parameters<typeof store.markDispatching>[0]) => {
          const execution = await target.getExecution(input.executionId);
          if (!dispatchHeld && execution?.definitionId === 'fixture.complete') {
            dispatchHeld = true;
            dispatchEntered.release();
            await dispatchRelease.waiting;
          }
          return target.markDispatching(input);
        };
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
  const completionEntered = gate(),
    completionRelease = gate();
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
        ...(mode === 'foreground-resource-steer'
          ? { resources: { serial: { scope: 'workspace' as const, key: 'completion-test' } } }
          : {}),
        async execute(_input, context) {
          const state = (await context.records.get(recordKey))!;
          await context.records.write({
            key: recordKey,
            expectedRevision: state.revision,
            contentType: 'fixture.completion',
            contentVersion: 1,
            value: {
              done: [
                'snapshot',
                'shared-snapshot',
                'finish-race',
                'foreground-resource-steer',
              ].includes(mode),
            },
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
        ...(mode === 'resource-steer'
          ? { resources: { serial: { scope: 'workspace' as const, key: 'completion-test' } } }
          : {}),
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
          if (mode === 'dispatched-steer' || mode === 'dispatched-unknown') {
            completionEntered.release();
            await completionRelease.waiting;
          }
          if (mode === 'dispatched-unknown')
            return { outcome: 'outcome_unknown', content: 'completion_effect_unconfirmed' };
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
          direction:
            mode !== 'grant-dispatch-race' &&
            model.requests.some((request) =>
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
    ...(resourceMode
      ? {
          workspaceSerialLocks: {
            async acquire(_input: { workspaceId: string; key: string }, signal: AbortSignal) {
              resourceEntered.release();
              return resourceSemaphore.acquire(signal);
            },
          },
        }
      : {}),
    extensions: [
      mode === 'evaluate-steer' ? { ...extension, completionGovernance: undefined } : extension,
    ],
    permissions: {
      async authorize(request) {
        if (
          request.definitionId !==
          (mode === 'foreground-resource-steer' ? 'fixture.seed' : 'fixture.complete')
        )
          return { allowed: true, revision: 'owned' };
        if (mode === 'deny')
          return { allowed: false, revision: 'owned', reason: 'permission_denied' };
        if (
          ![
            'steer',
            'busy-steer',
            'source',
            'dispatch-race',
            'grant-dispatch-race',
            'resource-steer',
            'foreground-resource-steer',
          ].includes(mode)
        )
          return { allowed: true, revision: 'owned' };
        return {
          allowed: false,
          revision: 'owned',
          reason: 'approval_required',
          ...(mode === 'grant-dispatch-race'
            ? {
                grantOffers: [
                  fixtureGrant(request.definitionId, request.input, request.kind as 'tool' | 'job'),
                ],
              }
            : {}),
          approval: {
            request: { title: 'Approve original completion check' },
            options:
              mode === 'grant-dispatch-race'
                ? approvalOptions([
                    fixtureGrant(
                      request.definitionId,
                      request.input,
                      request.kind as 'tool' | 'job',
                    ),
                  ])
                : approvalOptions(),
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
    resourceEntered,
    resourceInputObserved,
    releaseResource,
    completionEntered,
    completionRelease,
    dispatchEntered,
    dispatchRelease,
    inputBusyEntered,
    inputBusyRelease,
    inputBusyThrown,
    inputAttempts,
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
    async approve(
      card: InteractionRecord,
      selection: 'approve_once' | 'same_command' = 'approve_once',
    ) {
      await runtime.answerInteraction({
        ...base,
        commandId: `approve-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: {
          kind: 'approval',
          decision: 'approve',
          optionId: selection === 'same_command' ? fixtureScopeOption(card.request) : 'once',
        },
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
    async assertNoOrphanToolMessages() {
      const groups = [
        await store.listMessages('s'),
        ...model.requests.map((request) => request.messages),
      ];
      for (const messages of groups) {
        const declared = new Set(
          messages.flatMap((message) =>
            message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [],
          ),
        );
        expect(
          messages.filter(
            (message) => message.role === 'tool' && !declared.has(message.toolCallId ?? ''),
          ),
        ).toEqual([]);
      }
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
      releaseResource();
      conditionRelease.release();
      prepareRelease.release();
      evaluateRelease.release();
      finishRelease.release();
      writerRelease.release();
      completionRelease.release();
      dispatchRelease.release();
      inputBusyRelease.release();
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
        content: 'Follow up: fresh completion direction',
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
    expect(f.prepared).toHaveLength(2);
    expect(f.prepared[0]).toMatchObject({ direction: 'original' });
    expect(f.prepared[1]).toMatchObject({ direction: 'fresh' });
    expect((await f.store.getExecution(old.executionId))?.input).toEqual(f.prepared[0]);
    expect((await f.store.getExecution(fresh.executionId))?.input).toEqual(f.prepared[1]);
    expect(f.prepared[1]).not.toEqual(f.prepared[0]);
    const modelCount = f.model.requests.length;
    const late = await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'late-old-allow',
      presentationSessionId: 's',
      interactionId: old.id,
      expectedRevision: old.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
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
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
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
    await f.assertNoOrphanToolMessages();
    await f.approve(next.card!);
    expect(await f.done()).toMatchObject({ id: originalRun, status: 'completed' });
    await f.assertAppliedSteer('steer', originalRun);
    expect(f.model.requests).toHaveLength(3);
    expect(
      f.model.requests[2]!.messages.some(
        (message) => message.content === 'Follow up: fresh completion direction',
      ),
    ).toBe(true);
    expect(f.effects).toHaveLength(1);
    expect(f.effects).toEqual([f.prepared[1]!]);
    expect(f.effects[0]).toMatchObject({ direction: 'fresh' });
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
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

test('a controlled input_tools_pending response defers accepted steer until the next completion checkpoint', async () => {
  const f = await fixture('busy-steer');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    expect(first.card).not.toBeNull();
    const old = first.card!;
    const session = (await f.store.getSession('s'))!;
    const steer = (commandId: string, content: string) =>
      f.runtime.submitCommand({
        ...f.base,
        commandId,
        request: {
          kind: 'input.steer',
          targetRunId: first.run.id,
          contextSelectionId: session.contextSelectionId,
          content,
        },
      });
    await steer('busy-first', 'Follow up: fresh completion direction');
    await f.inputBusyEntered.waiting;
    expect((await f.store.getCommand('busy-first'))?.status).toBe('accepted');
    expect(await f.run()).toMatchObject({ id: first.run.id, isActive: true, reason: null });
    expect(
      await f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: old.id,
      }),
    ).toMatchObject({ state: 'pending', acceptedDecisionRevision: null });
    expect(f.effects).toEqual([]);
    expect(f.inputAttempts).toEqual(['busy-first']);
    f.inputBusyRelease.release();
    await f.inputBusyThrown.waiting;
    await steer('busy-second', 'Preserve this second completion instruction in order');
    const next = await f.cardOrTerminal(old.id);
    expect(next.run).toMatchObject({ id: first.run.id, isActive: true, reason: null });
    expect(next.card).not.toBeNull();
    expect(f.effects).toEqual([]);
    await f.approve(next.card!);
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed', reason: null });
    await f.assertAppliedSteer('busy-first', first.run.id);
    await f.assertAppliedSteer('busy-second', first.run.id);
    expect(f.inputAttempts).toEqual(['busy-first', 'busy-first', 'busy-second']);
    const messages = f.model.requests[2]!.messages;
    const firstIndex = messages.findIndex(
      (message) => message.content === 'Follow up: fresh completion direction',
    );
    const secondIndex = messages.findIndex(
      (message) => message.content === 'Preserve this second completion instruction in order',
    );
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(f.effects).toEqual([f.prepared[1]!]);
    expect(f.effects[0]).toMatchObject({ direction: 'fresh' });
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

test('steer accepted before the final dispatch transaction prevents the old approved completion directive', async () => {
  const f = await fixture('dispatch-race');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    expect(first.card).not.toBeNull();
    const old = first.card!;
    await f.approve(old);
    await f.dispatchEntered.waiting;
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      status: 'planned',
      authorization: { dispatched: false },
    });
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'dispatch-race-steer',
      request: {
        kind: 'input.steer',
        targetRunId: first.run.id,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: fresh completion direction',
      },
    });
    expect(f.effects).toEqual([]);
    f.dispatchRelease.release();
    const next = await f.cardOrTerminal(old.id);
    expect(next.run).toMatchObject({ id: first.run.id, isActive: true, reason: null });
    expect(next.card).not.toBeNull();
    const fresh = next.card!;
    expect(fresh.executionId).not.toBe(old.executionId);
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      authorization: { dispatched: false },
    });
    expect(await f.store.getExecution(fresh.executionId)).toMatchObject({
      status: 'planned',
      authorization: { dispatched: false },
      input: f.prepared[1],
    });
    expect(f.prepared).toHaveLength(2);
    expect(f.prepared[1]).toMatchObject({ direction: 'fresh' });
    expect(f.effects).toEqual([]);
    await f.approve(fresh);
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed', reason: null });
    expect(f.effects).toEqual([f.prepared[1]!]);
    await f.assertAppliedSteer('dispatch-race-steer', first.run.id);
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

test('steer retires an approved completion Tool while its original serial resource remains occupied', async () => {
  const f = await fixture('resource-steer');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    const old = first.card!;
    expect(old).not.toBeNull();
    await f.approve(old);
    await f.resourceEntered.waiting;
    const readOld = () =>
      f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: old.id,
      });
    const accepted = await readOld();
    expect(accepted).toMatchObject({ state: 'answered' });
    expect(accepted!.acceptedDecisionRevision).not.toBeNull();
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'resource-steer',
      request: {
        kind: 'input.steer',
        targetRunId: first.run.id,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: fresh completion direction',
      },
    });
    await f.resourceInputObserved.waiting;
    const next = await f.cardOrTerminal(old.id);
    expect(next.run).toMatchObject({ id: first.run.id, isActive: true, reason: null });
    expect(next.card).not.toBeNull();
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      status: 'cancelled',
      authorization: { dispatched: false },
    });
    expect(await readOld()).toMatchObject({
      state: 'cancelled',
      acceptedDecisionRevision: accepted!.acceptedDecisionRevision,
    });
    expect(next.card).toMatchObject({ state: 'pending', acceptedDecisionRevision: null });
    expect(f.prepared).toHaveLength(2);
    expect(f.prepared[1]).toMatchObject({ direction: 'fresh' });
    expect(f.effects).toEqual([]);
    await f.assertAppliedSteer('resource-steer', first.run.id);
    expect(
      f.model.requests[2]!.messages.some(
        (message) => message.content === 'Follow up: fresh completion direction',
      ),
    ).toBe(true);
    // The original permit stays held until all retirement and fresh-card assertions pass.
    f.releaseResource();
    await f.approve(next.card!);
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed' });
    expect(f.effects).toEqual([f.prepared[1]!]);
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

test('steer keeps an approved foreground Tool and its parameters while the same serial resource is occupied', async () => {
  const f = await fixture('foreground-resource-steer');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    const old = first.card!;
    expect(old).not.toBeNull();
    await f.approve(old);
    await f.resourceEntered.waiting;
    const execution = await f.store.getExecution(old.executionId);
    const originalCard = await f.store.getInteraction({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      interactionId: old.id,
    });
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'resource-steer',
      request: {
        kind: 'input.steer',
        targetRunId: first.run.id,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: fresh completion direction',
      },
    });
    // Observe the real resource-wait checkpoint, rather than asserting immediately at admission.
    await f.resourceInputObserved.waiting;
    expect((await f.store.getCommand('resource-steer'))?.status).toBe('accepted');
    expect(await f.store.getExecution(old.executionId)).toEqual(execution);
    expect(
      await f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: old.id,
      }),
    ).toEqual(originalCard);
    expect(f.model.requests).toHaveLength(1);
    expect(f.prepared).toHaveLength(0);
    f.releaseResource();
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed' });
    expect(await f.store.getExecution(old.executionId)).toMatchObject({
      status: 'succeeded',
      input: execution!.input,
      authorization: { dispatched: true },
    });
    await f.assertAppliedSteer('resource-steer', first.run.id);
    expect(f.model.requests).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.some(
        (message) => message.content === 'Follow up: fresh completion direction',
      ),
    ).toBe(true);
    expect(f.effects).toEqual([]);
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

test('retiring an approved completion decision revokes its same_command grant before an identical fresh directive', async () => {
  const f = await fixture('grant-dispatch-race');
  try {
    await f.submit();
    const first = await f.cardOrTerminal();
    const old = first.card!;
    expect(old).not.toBeNull();
    await f.approve(old, 'same_command');
    await f.dispatchEntered.waiting;
    const readOld = () =>
      f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: old.id,
      });
    const accepted = await readOld();
    expect(accepted!.acceptedDecisionRevision).not.toBeNull();
    const readGrants = () =>
      f.store.listPermissionGrants({
        expectedStoreId: f.base.expectedStoreId,
        subjectId: 'owner',
        sessionId: 's',
      });
    expect((await readGrants()).items.map((item) => item.grant.interactionId)).toEqual([old.id]);
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'grant-steer',
      request: {
        kind: 'input.steer',
        targetRunId: first.run.id,
        contextSelectionId: session.contextSelectionId,
        content: 'Follow up: fresh completion direction',
      },
    });
    f.dispatchRelease.release();
    const next = await f.cardOrTerminal(old.id);
    expect(next.run).toMatchObject({ id: first.run.id, isActive: true, reason: null });
    expect(next.card).not.toBeNull();
    const fresh = next.card!;
    expect(fresh.executionId).not.toBe(old.executionId);
    expect(f.prepared).toHaveLength(2);
    expect(f.prepared[1]).toEqual(f.prepared[0]);
    expect(fixtureScopeOption(fresh.request)).toBe(fixtureScopeOption(old.request));
    expect(await readOld()).toMatchObject({
      state: 'cancelled',
      acceptedDecisionRevision: accepted!.acceptedDecisionRevision,
    });
    expect(fresh).toMatchObject({ state: 'pending', acceptedDecisionRevision: null });
    expect((await readGrants()).items).toEqual([]);
    expect(f.effects).toEqual([]);
    await f.assertAppliedSteer('grant-steer', first.run.id);
    await f.approve(fresh);
    expect(await f.done()).toMatchObject({ id: first.run.id, status: 'completed' });
    expect(f.effects).toEqual([f.prepared[1]!]);
    expect(await f.store.getExecution(fresh.executionId)).toMatchObject({
      authorization: { dispatched: true, human: { interactionId: fresh.id, accepted: true } },
    });
    await f.assertNoOrphanToolMessages();
  } finally {
    await f.close();
  }
});

for (const outcome of ['succeeded', 'outcome_unknown'] as const)
  test(`steer cannot retire or replay a dispatched completion Tool that returns ${outcome}`, async () => {
    const f = await fixture(outcome === 'succeeded' ? 'dispatched-steer' : 'dispatched-unknown');
    try {
      await f.submit();
      await f.completionEntered.waiting;
      const originalRun = (await f.run()).id;
      const original = (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'fixture.complete',
      )!;
      expect(original).toMatchObject({
        status: 'dispatching',
        authorization: { dispatched: true },
      });
      expect(f.effects).toEqual([f.prepared[0]!]);
      const session = (await f.store.getSession('s'))!;
      await f.runtime.submitCommand({
        ...f.base,
        commandId: 'after-dispatch-steer',
        request: {
          kind: 'input.steer',
          targetRunId: originalRun,
          contextSelectionId: session.contextSelectionId,
          content: 'Follow up: fresh completion direction',
        },
      });
      expect((await f.store.getCommand('after-dispatch-steer'))?.status).toBe('accepted');
      expect(await f.store.getExecution(original.id)).toMatchObject({
        status: 'dispatching',
        authorization: { dispatched: true },
        input: original.input,
        resultRevision: original.resultRevision,
      });
      expect(f.prepared).toHaveLength(1);
      expect(f.model.requests).toHaveLength(2);
      f.completionRelease.release();
      const completed = await f.done();
      expect(completed).toMatchObject({
        id: originalRun,
        status: outcome === 'succeeded' ? 'completed' : 'failed',
        reason: outcome === 'succeeded' ? null : 'operation_unverifiable',
      });
      expect(await f.store.getExecution(original.id)).toMatchObject({
        status: outcome,
        authorization: { dispatched: true },
        input: original.input,
        result: {
          outcome,
          content:
            outcome === 'succeeded'
              ? 'completion checked with the current original input'
              : 'completion_effect_unconfirmed',
        },
      });
      expect(f.prepared).toHaveLength(1);
      expect(f.effects).toEqual([f.prepared[0]!]);
      expect(f.effects[0]).toMatchObject({ direction: 'original' });
      expect(
        (await f.store.listExecutions('s')).filter(
          (execution) => execution.definitionId === 'fixture.complete',
        ),
      ).toHaveLength(1);
      if (outcome === 'succeeded') {
        await f.assertAppliedSteer('after-dispatch-steer', originalRun);
        expect(f.model.requests).toHaveLength(3);
        expect(
          f.model.requests[2]!.messages.some(
            (message) => message.content === 'Follow up: fresh completion direction',
          ),
        ).toBe(true);
      } else {
        expect((await f.store.getCommand('after-dispatch-steer'))?.status).not.toBe('applied');
        expect(f.model.requests).toHaveLength(2);
      }
      await f.assertNoOrphanToolMessages();
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
