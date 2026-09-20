import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import { aiMessage, BuiltinModelEffectCoordinator } from '@kite-ai/builtin-runtime/model';
import { SubagentResultArtifactStore } from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeHost } from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  DescendantResourceAdmissionError,
  LIMITED_RESOURCE_BUDGET_,
  planModelInvocationResource,
  type RuntimeState,
  reconciliationEventsForReservations,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-service/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  projection,
  TestExecutionBridge,
  testRuntimeModules,
  testStorage,
} from '../../../packages/runtime-host/test/helpers';
import { createMockModel } from '../../../tests/helpers/mock-model';
import { createTestModelInvocationHarness } from '../../../tests/helpers/model-invocation';
import {
  projectTestPrimaryModelEffect,
  testBuiltinToolCatalog,
  testSubagentComposition,
} from '../../../tests/helpers/runtime-model';
import {
  AfterTurnContinuationRuntime,
  afterTurnContinuationIdentity,
  planAfterTurnContinuationReservation,
} from '../src/bootstrap/runtime/subagent/after-turn-continuation';
import {
  type BackgroundSubagentCompletionNotification,
  BackgroundSubagentRuntime,
  backgroundSubagentOwnerKey,
} from '../src/bootstrap/runtime/subagent/background-runtime';
import { createPipelineSubagentRuntime } from '../src/bootstrap/runtime/subagent/pipeline-runtime';
import type { SubAgentResult } from '../src/bootstrap/runtime/subagent/types';
import { runtimeStartTurnDerivedId } from '../src/bootstrap/runtime/turn-command-decision';

const CONFIG: AgentConfig = {
  apiKey: 'unused',
  baseURL: 'https://example.invalid',
  modelName: 'after-turn-model',
  providerName: 'fixture',
  providerType: 'openai-compatible',
  modelKwargs: { maxOutputTokens: 64 },
  features: { afterTurnContinuation: true },
  sandbox: { enabled: false },
};

function apply(state: RuntimeState, events: readonly RuntimeEvent[]): RuntimeState {
  return events.reduce(reduceRuntimeState, state);
}

function configuredState(input: {
  sessionId: string;
  activeTurnId: string;
  deadlineAt: string;
  budget?: Partial<typeof LIMITED_RESOURCE_BUDGET_>;
}): RuntimeState {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: input.sessionId,
    userId: 'test-user',
    workspace: process.cwd(),
  });
  state = reduceRuntimeState(state, { type: 'turn.started', turnId: input.activeTurnId });
  state = reduceRuntimeState(state, {
    type: 'user.message_appended',
    messageId: 'origin-message',
    content: 'Continue after the background report arrives.',
  });
  return reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: 'budget-ledger',
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineAt: input.deadlineAt,
    budget: { ...LIMITED_RESOURCE_BUDGET_, ...input.budget, version: 1 },
  });
}

function applied(commandId: string, sessionId: string, revision: number) {
  return { status: 'applied' as const, commandId, sessionId, revision };
}

function terminal(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    ok: true,
    summary: 'background evidence is durable',
    toolCallCount: 1,
    durationMs: 10,
    terminalStatus: 'completed',
    ...overrides,
  };
}

function afterTurnModel() {
  const fixture = createMockModel([{ message: aiMessage({ content: 'reported to user' }) }]);
  const model: SupportedChatModel = {
    ...fixture,
    capabilityMetadata: {
      ...fixture.capabilityMetadata,
      contextWindowTokens: 4_096,
      maxOutputTokens: 64,
    },
  };
  return { fixture, model };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('After-turn fixture did not settle.');
}

describe('after-turn continuation', () => {
  for (const reportPersistence of ['accepted', 'rejected'] as const) {
    test(`persists one named result before after-turn wake when report persistence is ${reportPersistence}`, async () => {
      const sessionId = `after-turn-report-${reportPersistence}`;
      const invocationId = `after-turn-parent-${reportPersistence}`;
      const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
      let lifecycleState = configuredState({
        sessionId,
        activeTurnId: 'origin-turn',
        deadlineAt,
      });
      const capabilityRevision = digestCapabilityValue({ invocationId, field: 'capability' });
      const authorizationDigest = digestCapabilityValue({ invocationId, field: 'authorization' });
      const admissionDigest = digestCapabilityValue({ invocationId, field: 'admission' });
      const effectiveEffectsDigest = digestCapabilityValue({ invocationId, field: 'effects' });
      lifecycleState.capabilities.invocations[invocationId] = {
        invocationId,
        toolCallId: 'parent-tool',
        capabilityId: 'builtin:task',
        capabilityRevision,
        argumentsDigest: digestCapabilityValue({ invocationId, field: 'arguments' }),
        authorizationDigest,
        admissionDigest,
        effectiveEffectsDigest,
        status: 'running',
        recordedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        attemptsStarted: 1,
      };
      const { model } = afterTurnModel();
      const harness = createTestModelInvocationHarness({
        workspace: process.cwd(),
        state: lifecycleState,
      });
      const order: string[] = [];
      const namedResults: RuntimeEvent[] = [];
      let releaseAttempts = 0;
      const afterTurn = new AfterTurnContinuationRuntime({
        resolveAfterTurnOriginRun: async () => 'origin-run',
        scheduleAfterTurnWake: async () => {
          order.push('wake');
          return { status: 'started' };
        },
      });
      const root = mkdtempSync(join(tmpdir(), `kite-after-turn-report-${reportPersistence}-`));
      try {
        const background = new BackgroundSubagentRuntime(
          new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') }),
        );
        const runtime = createPipelineSubagentRuntime(() => testSubagentComposition(), background);
        const backgroundPersistence = {
          ownerKey: backgroundSubagentOwnerKey(sessionId, 'a'.repeat(64)),
          recoveryIdentityKey: 'a'.repeat(64),
          getState: () => lifecycleState,
          persistEvents: async (events: RuntimeEvent[]) => {
            const resultEvents = events.filter(
              (event) => event.type === 'subagent.background_result_persisted',
            );
            if (resultEvents.length > 0) {
              order.push('named-result');
              namedResults.push(...resultEvents);
              if (reportPersistence === 'rejected') return false;
              lifecycleState = apply(lifecycleState, resultEvents);
              return true;
            }
            if (
              reportPersistence === 'rejected' &&
              events.length === 1 &&
              events[0]?.type === 'resource_budget.released'
            ) {
              releaseAttempts += 1;
              if (releaseAttempts === 1) return false;
            }
            lifecycleState = apply(lifecycleState, events);
            return true;
          },
        };
        const accepted = await runtime.start(
          {
            builtinToolCatalog: testBuiltinToolCatalog(),
            config: CONFIG,
            workspace: process.cwd(),
            interactionMode: 'accept_edits',
            recoveryIdentityKey: 'a'.repeat(64),
            threadId: sessionId,
            model,
            eventSink: () => {},
            modelEffectCoordinator: new BuiltinModelEffectCoordinator(harness.gateway),
            modelInvocationPersistence: backgroundPersistence,
            backgroundModelInvocationPersistence: backgroundPersistence,
            subagentLifecyclePersistence: {
              getState: () => lifecycleState,
              persistEvents: async (events) => {
                lifecycleState = apply(lifecycleState, events);
                return true;
              },
            },
            modelInvocationParentId: 'parent-model',
            modelInvocationParentToolCallId: 'parent-tool',
            subagentInvocationIdentity: {
              invocationId,
              attempt: 1,
              capabilityRevision,
              authorizationDigest,
              admissionDigest,
              effectiveEffectsDigest,
            },
            afterTurnContinuationRuntime: afterTurn,
          },
          {
            name: 'Report background result',
            subagent_type: 'review',
            task: 'Return a concise result.',
            background: true,
            result_disposition: 'after_turn',
          },
        );
        expect(accepted).toMatchObject({ ok: true });
        if (!accepted.backgroundTaskId)
          throw new Error('Background task identity was not returned.');

        await until(() => order.includes('named-result'));
        if (reportPersistence === 'accepted') {
          await until(() => order.includes('wake'));
          expect(order).toEqual(['named-result', 'wake']);
          expect(namedResults).toHaveLength(1);
        } else {
          await Bun.sleep(10);
          expect(order).toEqual(['named-result']);
          expect(namedResults).toHaveLength(1);
          const namedResult = namedResults[0];
          if (
            namedResult?.type !== 'subagent.background_result_persisted' ||
            !namedResult.afterTurn
          ) {
            throw new Error('Expected the after-turn reservation identity.');
          }
          await until(
            () =>
              lifecycleState.resourceBudget.status === 'active' &&
              lifecycleState.resourceBudget.reservations[namedResult.afterTurn!.reservationId]
                ?.state === 'released',
          );
          expect(
            await background.readTask(
              backgroundSubagentOwnerKey(sessionId, 'a'.repeat(64)),
              accepted.backgroundTaskId,
            ),
          ).toMatchObject({ status: 'unknown' });
          expect(releaseAttempts).toBe(2);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('drives one durable background completion through Host start_turn into a real model call', async () => {
    const sessionId = 'after-turn-session';
    const originRunId = 'initial-run-root';
    const activeTurnId = 'continuation-active-turn';
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    let state = configuredState({ sessionId, activeTurnId, deadlineAt });
    const originToolCallId = 'tool-after-turn';
    const dispatchIntentDigest = `sha256:${'d'.repeat(64)}`;
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          ...state.tools.calls,
          [originToolCallId]: {
            toolCallId: originToolCallId,
            name: 'task',
            modelMessageId: 'origin-message',
            args: { task: 'inspect' },
            createdAtTurnId: activeTurnId,
            status: 'running',
          },
        },
        active: [originToolCallId],
      },
      capabilities: {
        ...state.capabilities,
        invocations: {
          ...state.capabilities.invocations,
          'after-turn-parent': {
            invocationId: 'after-turn-parent',
            toolCallId: originToolCallId,
            capabilityId: 'builtin:task',
            capabilityRevision: 'task-v1',
            argumentsDigest: 'arguments',
            authorizationDigest: 'authorization',
            admissionDigest: 'admission',
            effectiveEffectsDigest: 'effects',
            status: 'running',
            recordedAt: '2026-08-20T00:00:00.000Z',
            startedAt: '2026-08-20T00:00:00.000Z',
            attemptsStarted: 1,
            receiptRequirement: 'observation_receipt',
            subagentProviderLifecycle: {
              attempt: 1,
              purpose: 'start',
              childInvocationId: 'child-after-turn',
              taskArtifact: {
                kind: 'subagent_task',
                artifactId: `pa_${'a'.repeat(64)}`,
                integrityIdentifier: `sha256:${'b'.repeat(64)}`,
                byteLength: 1,
              },
              dispatchIntentDigest,
              status: 'cleanup_completed',
              recordedAt: '2026-08-20T00:00:00.000Z',
              handleArtifact: {
                kind: 'subagent_handle',
                artifactId: `pa_${'c'.repeat(64)}`,
                integrityIdentifier: `sha256:${'e'.repeat(64)}`,
                byteLength: 1,
              },
              handleIntegrityIdentifier: `sha256:${'e'.repeat(64)}`,
              handleRecordedAt: '2026-08-20T00:00:01.000Z',
              observationStatus: 'completed',
              observedAt: '2026-08-20T00:00:02.000Z',
              cleanupAttempt: 1,
              cleanupKind: 'handle_reconcile',
              cleanupStartedAt: '2026-08-20T00:00:03.000Z',
              cleanupConfirmed: true,
              cleanupCompletedAt: '2026-08-20T00:00:04.000Z',
            },
          },
        },
      },
    };
    const { fixture: modelFixture, model } = afterTurnModel();
    const bridge = new TestExecutionBridge();
    bridge.projections.set(sessionId, {
      ...projection(sessionId, 1),
      currentRun: {
        runId: originRunId,
        initialTurnId: originRunId,
        activeTurnId,
        status: 'running',
        revision: 1,
      },
    });
    const host = createRuntimeHost({
      storage: testStorage(),
      modules: testRuntimeModules(() => bridge),
    });
    const afterTurn = new AfterTurnContinuationRuntime(host);
    const resolvedOrigin = await afterTurn.resolveOriginRunId(sessionId, activeTurnId);
    expect(resolvedOrigin).toBe(originRunId);
    expect(activeTurnId).not.toBe(originRunId);

    const reservation = planAfterTurnContinuationReservation({
      state,
      config: CONFIG,
      model,
      childInvocationId: 'child-after-turn',
      originRunId: resolvedOrigin!,
    });
    state = apply(state, reservation.preparationEvents);
    const placeholderId = reservation.reservationId;
    let modelHarness: ReturnType<typeof createTestModelInvocationHarness> | undefined;
    bridge.prepareImplementation = async (command) => {
      if (command.type !== 'start_turn') throw new Error(`Unexpected command: ${command.type}`);
      const successorTurnId = runtimeStartTurnDerivedId(command.commandId, 'turn');
      state = reduceRuntimeState(state, {
        type: 'user.message_appended',
        messageId: `${command.commandId}:message`,
        content: command.input,
      });
      state = reduceRuntimeState(state, { type: 'turn.started', turnId: successorTurnId });
      modelHarness = createTestModelInvocationHarness({ workspace: process.cwd(), state });
      bridge.projections.set(sessionId, {
        ...projection(sessionId, 2),
        currentRun: {
          runId: successorTurnId,
          initialTurnId: successorTurnId,
          activeTurnId: successorTurnId,
          status: 'running',
          revision: 2,
        },
      });
      return {
        receipt: applied(command.commandId, sessionId, 2),
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: 2,
          operation: 'turn' as const,
          run: async () => {
            if (!modelHarness) throw new Error('Model harness was not prepared.');
            const live = modelHarness.getState();
            const recoveredAfterTurn = new AfterTurnContinuationRuntime(host);
            const replacement = recoveredAfterTurn.replacementReservationId(
              sessionId,
              live.turn.turnId,
              live,
            );
            expect(replacement).toBe(placeholderId);
            await projectTestPrimaryModelEffect({
              model,
              state: live,
              config: CONFIG,
              replaceReservationId: replacement,
              modelInvocationGateway: modelHarness.gateway,
              modelInvocationPersistence: modelHarness.persistence,
            });
          },
        },
      };
    };

    const root = mkdtempSync(join(tmpdir(), 'kite-after-turn-e2e-'));
    let notification: BackgroundSubagentCompletionNotification | undefined;
    let delivery: Parameters<AfterTurnContinuationRuntime['deliver']>[0] | undefined;
    try {
      const background = new BackgroundSubagentRuntime(
        new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') }),
      );
      const ownerKey = backgroundSubagentOwnerKey(sessionId, 'a'.repeat(64));
      background.adopt({
        taskId: 'child-after-turn',
        ownerKey,
        originRunId,
        originTurnId: activeTurnId,
        originToolCallId,
        attempt: 1,
        observe: async () => terminal(),
        cancel: async () => {},
        onResultPersisted: async (persisted) => {
          notification = persisted;
          const afterTurnIdentity = afterTurnContinuationIdentity({
            taskId: persisted.taskId,
            attempt: persisted.attempt,
            resultRevision: persisted.resultArtifact.integrityIdentifier,
            originRunId: persisted.originRunId,
          });
          const admissionRevision = state.revision + 1;
          state = apply(state, [
            {
              type: 'subagent.background_result_persisted',
              taskId: persisted.taskId,
              notificationId: persisted.notificationId,
              artifactIntegrityIdentifier: persisted.resultArtifact.integrityIdentifier,
              shortReport: persisted.shortReport,
              source: persisted.source,
              modelRole: persisted.modelRole,
              originRunId: persisted.originRunId,
              originTurnId: persisted.originTurnId,
              originToolCallId: persisted.originToolCallId,
              attempt: persisted.attempt,
              afterTurn: {
                reservationId: reservation.reservationId,
                admissionRevision,
                phase: 'building',
                status: persisted.status as 'completed',
                cancelRequested: persisted.cancelRequested,
                ...afterTurnIdentity,
              },
            },
          ]);
          delivery = {
            sessionId,
            phase: 'building',
            attempt: 1,
            admissionRevision,
            reservation,
            notification: persisted,
            persistEvents: async (events) => {
              state = apply(state, events);
              return true;
            },
          };
          await afterTurn.deliver(delivery);
        },
      });

      await until(() => modelFixture.callCount.count === 1);
      await host.waitForSessionIdle(sessionId);
      if (!notification || !delivery || !modelHarness) {
        throw new Error('Background completion did not reach the after-turn model fixture.');
      }
      expect(notification.status).toBe('completed');
      // Crash-window replay after the continuation Run/command receipt was
      // committed is idempotent: the Host receipt is the durable consumption
      // marker, so no second Run or model dispatch can be created.
      await expect(afterTurn.deliver(delivery)).resolves.toEqual({ status: 'replayed' });
      await host.waitForSessionIdle(sessionId);
      expect(modelFixture.callCount.count).toBe(1);
      expect(reservation.originRunId).toBe(originRunId);
      expect(
        state.capabilities.invocations['after-turn-parent']?.subagentProviderLifecycle
          ?.backgroundResult,
      ).toMatchObject({
        originRunId,
        originTurnId: activeTurnId,
        originToolCallId,
        afterTurn: { reservationId: placeholderId },
      });
      expect(modelHarness.getState().resourceBudget).toMatchObject({
        status: 'active',
        deadlineAt,
        reservations: { [placeholderId]: { state: 'released' } },
      });
      expect(
        Object.values(
          modelHarness.getState().resourceBudget.status === 'active'
            ? modelHarness.getState().resourceBudget.reservations
            : {},
        ).some(
          (candidate) =>
            candidate.reservationId !== placeholderId &&
            candidate.resourceKind === 'model' &&
            candidate.state === 'reconciled',
        ),
      ).toBe(true);
      expect(
        new AfterTurnContinuationRuntime(host).replacementReservationId(
          sessionId,
          modelHarness.getState().turn.turnId,
          modelHarness.getState(),
        ),
      ).toBeUndefined();
      expect(bridge.calls.filter((call) => call.type === 'start_turn')).toHaveLength(1);

      expect(await afterTurn.deliver(delivery)).toEqual({
        status: 'replayed',
      });
      await host.waitForSessionIdle(sessionId);
      expect(modelFixture.callCount.count).toBe(1);
      expect(bridge.calls.filter((call) => call.type === 'start_turn')).toHaveLength(1);
    } finally {
      await host[Symbol.asyncDispose]();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('suppresses cancelled completion and releases its reservation without waking Host', async () => {
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    let state = configuredState({
      sessionId: 'cancelled-after-turn',
      activeTurnId: 'active-turn',
      deadlineAt,
    });
    const { model } = afterTurnModel();
    const reservation = planAfterTurnContinuationReservation({
      state,
      config: CONFIG,
      model,
      childInvocationId: 'cancelled-child',
      originRunId: 'origin-run',
    });
    state = apply(state, reservation.preparationEvents);
    let wakes = 0;
    const runtime = new AfterTurnContinuationRuntime({
      resolveAfterTurnOriginRun: async () => 'origin-run',
      scheduleAfterTurnWake: async () => {
        wakes += 1;
        return { status: 'started' };
      },
    });
    const result = await runtime.deliver({
      sessionId: 'cancelled-after-turn',
      phase: 'building',
      attempt: 1,
      admissionRevision: state.revision,
      reservation,
      notification: {
        notificationId: 'cancelled',
        source: 'subagent',
        modelRole: 'user',
        ownerKey: 'owner',
        taskId: 'cancelled-child',
        originRunId: 'origin-run',
        originTurnId: 'active-turn',
        originToolCallId: 'cancelled-tool-call',
        attempt: 1,
        status: 'cancelled',
        shortReport: 'cancelled',
        resultArtifact: {
          artifactId: 'cancelled-artifact',
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'b'.repeat(64)}`,
          byteLength: 1,
        },
        cancelRequested: true,
      },
      persistEvents: async (events) => {
        state = apply(state, events);
        return true;
      },
    });
    expect(result).toEqual({ status: 'suppressed', reason: 'after_turn_ineligible' });
    expect(wakes).toBe(0);
    expect(state.resourceBudget).toMatchObject({
      reservations: { [reservation.reservationId]: { state: 'released' } },
    });
  });

  test('releases the reservation when Host wake scheduling fails', async () => {
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    let state = configuredState({
      sessionId: 'failed-wake-after-turn',
      activeTurnId: 'active-turn',
      deadlineAt,
    });
    const { model } = afterTurnModel();
    const reservation = planAfterTurnContinuationReservation({
      state,
      config: CONFIG,
      model,
      childInvocationId: 'failed-wake-child',
      originRunId: 'origin-run',
    });
    state = apply(state, reservation.preparationEvents);
    const runtime = new AfterTurnContinuationRuntime({
      resolveAfterTurnOriginRun: async () => 'origin-run',
      scheduleAfterTurnWake: async () => {
        throw new Error('wake scheduler unavailable');
      },
    });
    await expect(
      runtime.deliver({
        sessionId: 'failed-wake-after-turn',
        phase: 'building',
        attempt: 1,
        admissionRevision: state.revision,
        reservation,
        notification: {
          notificationId: 'failed-wake',
          source: 'subagent',
          modelRole: 'user',
          ownerKey: 'owner',
          taskId: 'failed-wake-child',
          originRunId: 'origin-run',
          originTurnId: 'active-turn',
          originToolCallId: 'failed-wake-tool-call',
          attempt: 1,
          status: 'completed',
          shortReport: 'completed',
          resultArtifact: {
            artifactId: 'failed-wake-artifact',
            kind: 'subagent_task',
            integrityIdentifier: `sha256:${'c'.repeat(64)}`,
            byteLength: 1,
          },
          cancelRequested: false,
        },
        persistEvents: async (events) => {
          state = apply(state, events);
          return true;
        },
      }),
    ).rejects.toThrow('wake scheduler unavailable');
    expect(state.resourceBudget).toMatchObject({
      reservations: { [reservation.reservationId]: { state: 'released' } },
    });
  });

  test('rejects after-turn before dispatch when no positive model budget remains', () => {
    let state = configuredState({
      sessionId: 'exhausted-after-turn',
      activeTurnId: 'active-turn',
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      budget: { maxModelRequests: 1 },
    });
    const consumed = planModelInvocationResource(state, {
      invocationId: 'already-consumed',
      inputTokens: 1,
      requestedMaxOutputTokens: 1,
      resourceKind: 'model',
    });
    if (consumed.budget.kind !== 'reservation') throw new Error('Expected reservation.');
    state = apply(state, [
      ...consumed.preparationEvents,
      { type: 'resource_budget.dispatch_started', reservationId: consumed.budget.reservationId },
    ]);
    state = apply(
      state,
      reconciliationEventsForReservations(state, [consumed.budget.reservationId]),
    );
    const { model } = afterTurnModel();
    expect(() =>
      planAfterTurnContinuationReservation({
        state,
        config: CONFIG,
        model,
        childInvocationId: 'exhausted-child',
        originRunId: 'origin-run',
      }),
    ).toThrow(DescendantResourceAdmissionError);
  });
});
