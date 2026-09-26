import { expect } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { createChatModel } from '@kite-ai/builtin-runtime/model';
import { createRuntimeHostToolCallSnapshot } from '@kite-ai/runtime-host';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import type { CrossSessionQueueMailPort } from '../../src/bootstrap/runtime/agent-mailbox-port';
import { createCrossSessionRootMailboxPort } from '../../src/bootstrap/runtime/agent-mailbox-port';
import { projectPrimaryModelEffect } from '../../src/bootstrap/runtime/model-effect';
import { createAppToolPipelineComposition } from '../../src/bootstrap/runtime/tool-pipeline-composition';
import { createAppOrdinaryToolPipelineAttemptRuntime } from '../../src/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import { createAppToolTurnContext } from '../../src/bootstrap/runtime/tool-turn-context';
import { createAppStateToolPipelinePersistence } from '../../src/runtime/tool-persistence';
import type { CompletedChildOrchestrationFixture } from './child-session-orchestrator-integration-fixture';

/** Full-policy test-only Tool cutover. Production QueueOnly Surface remains hidden. */
export async function issueInterruptFromParent(
  fixture: CompletedChildOrchestrationFixture,
  targetSessionId: string,
): Promise<Readonly<{ status: string; commandId: string | null; targetTaskId: string | null }>> {
  const {
    owner,
    services,
    parentCoordinator,
    parentSessionId,
    workspace,
    model,
    bridgeInput,
    modelRuntimeFactory,
    builtinToolCatalog,
    capabilities,
  } = fixture;
  const toolCallId =
    process.env.KITE_INTERRUPT_SIGKILL_SEED === '1'
      ? 'interrupt-tool-sigkill'
      : `interrupt-tool-${Date.now()}`;
  model.setResponses([
    {
      response: async () => ({
        message: {
          tool_calls: [
            {
              id: toolCallId,
              name: 'interrupt_agent',
              args: { agent_id: targetSessionId },
            },
          ],
        },
        toolContinuation: 'aborted' as const,
      }),
    },
  ]);
  const runtime = modelRuntimeFactory(workspace);
  await owner.runWithSessionExecution(parentSessionId, () =>
    projectPrimaryModelEffect({
      model: createChatModel(bridgeInput.config),
      state: parentCoordinator.getState(),
      config: bridgeInput.config,
      builtinToolCatalog,
      modelEffectCoordinator: runtime.modelEffects,
      agentMailboxAvailable: true,
      agentMailboxQueueOnlyAvailable: false,
      modelInvocationPersistence: {
        getState: () => parentCoordinator.getState(),
        persistEvents: async (events) =>
          parentCoordinator.control.processEventBatch(events).length === events.length,
      },
      emitRuntimeEvent: (event) => {
        parentCoordinator.control.processEventBatch([event]);
      },
    }),
  );
  const queued = parentCoordinator.getState().tools.calls[toolCallId];
  expect(queued).toMatchObject({ name: 'interrupt_agent', status: 'queued' });
  if (!queued) throw new Error('Interrupt Tool was not admitted by the full-policy test Surface.');
  const lease = parentCoordinator.session.beginEffect({
    type: 'run_tools',
    toolCallIds: [toolCallId],
  });
  expect(
    parentCoordinator.session.applyEffectEvents(
      lease,
      [{ type: 'tool.started', toolCallId }],
      'attempt_start',
    ),
  ).toBe(true);
  const raw = owner.storage.crossSessionQueueMail;
  const abort = new AbortController();
  const accepted: Parameters<
    NonNullable<CrossSessionQueueMailPort['acceptInterruptCommand']>
  >[0][] = [];
  const storage: CrossSessionQueueMailPort = {
    readActiveChildGrant: () => null,
    readTarget: () => null,
    nextSourceSequence: () => 1,
    lookupOutbox: () => null,
    acceptQueueMailCommand: async () => {
      throw new Error('QueueOnly outside interrupt fixture.');
    },
    deliverQueueMail: async () => {
      throw new Error('QueueOnly outside interrupt fixture.');
    },
    readInterruptTarget: (source, target) =>
      owner.runWithSessionExecution(source, () => raw.readInterruptTarget(source, target)),
    lookupInterruptReceipt: (input) =>
      owner.runWithSessionExecution(input.scopeSessionId, () =>
        owner.storage.commandReceipts.lookup(input),
      ),
    readInterruptIntent: (source, command) =>
      owner.runWithSessionExecution(source, () => raw.readInterruptIntent(source, command)),
    acceptInterruptCommand: async (value) => {
      const effectId = `cross-agent-interrupt-command:${value.receipt.commandId}`;
      const ownerId = 'interrupt-fixture-owner';
      expect(
        services.leases.tryAcquire(parentSessionId, effectId, ownerId, Date.now() + 30_000),
      ).toBe(true);
      try {
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.session.commitCrossSessionInterruptCommand(
            lease,
            value.event,
            value.intent.targetRunId === null
              ? {
                  kind: 'request_queued_interrupt',
                  ...value.intent,
                  targetRunId: null,
                  targetOwnerGeneration: null,
                  targetRevision: 0,
                  queuedIntentEventId: value.intent.queuedIntentEventId!,
                }
              : {
                  kind: 'request_interrupt',
                  ...value.intent,
                  targetRunId: value.intent.targetRunId,
                  targetOwnerGeneration: value.intent.targetOwnerGeneration!,
                },
            value.receipt,
            { sessionId: parentSessionId, effectId, ownerId },
          ),
        );
        accepted.push(value);
      } finally {
        services.leases.release(parentSessionId, effectId, ownerId);
      }
    },
  };
  const port = createCrossSessionRootMailboxPort({
    getState: () => parentCoordinator.getState(),
    currentRunId: () =>
      parentCoordinator.session.getLifecycleProjection().currentRun?.runId ?? null,
    storage,
    toolCallId,
    signal: abort.signal,
  });
  if (!port) throw new Error('Interrupt source Port unavailable.');
  const persistence = createAppStateToolPipelinePersistence({
    getState: () => parentCoordinator.getState(),
    persistAttemptStartEvents: async (events) =>
      parentCoordinator.session.applyEffectEvents(lease, events, 'attempt_start'),
    persistTerminalRecoveryEvents: async (events) =>
      parentCoordinator.session.applyEffectEvents(lease, events, 'terminal_recovery'),
    persistReceiptEvents: async (events) =>
      parentCoordinator.session.applyEffectEvents(lease, events, 'receipt_evidence'),
    now: () => new Date().toISOString(),
    capabilityArtifactWriter: runtime.capabilityArtifacts,
  });
  const catalog = createBuiltinToolCatalogProjection(
    createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot(),
  );
  const context = createAppToolTurnContext({
    workspace,
    config: bridgeInput.config,
    threadId: parentSessionId,
    turnId: queued.createdAtTurnId,
    modelMessageId: queued.modelMessageId,
    toolCallId,
    phase: 'building',
    interactionMode: parentCoordinator.getState().mode,
    agentMailboxAvailable: true,
    agentMailboxQueueOnlyAvailable: false,
    hasTaskAdapter: true,
  });
  const turn = createAppToolPipelineComposition(catalog).forTurn(context);
  const snapshot = createRuntimeHostToolCallSnapshot({
    toolCallId,
    name: queued.name,
    rawArguments: queued.args,
    argumentOrigin: 'model_public',
    createdAtTurnId: queued.createdAtTurnId,
    modelMessageId: queued.modelMessageId,
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  });
  if (!snapshot.ok) throw new Error(snapshot.failure.code);
  const mechanism = Object.freeze({
    caller: port.caller,
    listAgents: port.listAgents,
    waitAgent: port.waitAgent,
    submitMessage: port.submitMessage,
    interruptAgent: port.interruptAgent,
  });
  const outcome = await owner.runWithSessionExecution(parentSessionId, () =>
    createAppOrdinaryToolPipelineAttemptRuntime({ persistence }).execute({
      turn,
      snapshot: snapshot.value,
      resolution: {
        currentTurnId: queued.createdAtTurnId,
        builtinProjectionRevision: turn.projection.revision,
        dynamicCatalogRevision: null,
        availabilityContext: {
          workspace,
          threadId: parentSessionId,
          turnId: queued.createdAtTurnId,
          modelMessageId: queued.modelMessageId,
          toolCallId,
          phase: 'building',
          toolSearchEnabled: false,
        },
        bindings: [],
        descriptors: [],
        disclosures: [],
      },
      governance: {
        sessionId: parentSessionId,
        workspace,
        threadId: parentSessionId,
        canonicalWorkspaceIdentity: `workspace:${workspace}`,
        context: {
          phase: 'building',
          interactionMode: parentCoordinator.getState().mode,
          sandboxAvailable: true,
          circuitBreakerTripped: false,
          gates: {
            recoveryAdmission: 'admitted',
            boundedCancellation: 'admitted',
            executionBoundary: 'admitted',
            skillCapabilityCeiling: 'admitted',
          },
        },
        approval: {
          status: 'queued',
          grant: 'none',
          approvedToolCallId: null,
          approvalBindingDigest: null,
        },
      },
      admission: { freshness: 'current', reservationRequired: false, reservationIds: [] },
      threadId: parentSessionId,
      attempt: 1,
      taskId: null,
      planId: null,
      planStepId: null,
      capabilityRequestFacts: null,
      capabilityExecution: capabilities,
      signal: abort.signal,
      mechanismResources: {
        workspace,
        preassembledMechanism: Object.freeze({ agentMailbox: mechanism }),
      },
    }),
  );
  if (outcome.kind !== 'committed')
    throw new Error(`Interrupt pipeline did not commit: ${JSON.stringify(outcome)}`);
  return {
    status: outcome.kind,
    commandId: accepted[0]?.receipt.commandId ?? null,
    targetTaskId: accepted[0]?.intent.targetTaskId ?? null,
  };
}
