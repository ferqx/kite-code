import { expect } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { createChatModel } from '@kite-ai/builtin-runtime/model';
import { createRuntimeHostToolCallSnapshot } from '@kite-ai/runtime-host';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import {
  type CrossSessionQueueMailPort,
  createCrossSessionRootMailboxPort,
} from '../../src/bootstrap/runtime/agent-mailbox-port';
import { projectPrimaryModelEffect } from '../../src/bootstrap/runtime/model-effect';
import { createAppToolPipelineComposition } from '../../src/bootstrap/runtime/tool-pipeline-composition';
import { createAppOrdinaryToolPipelineAttemptRuntime } from '../../src/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import { createAppToolTurnContext } from '../../src/bootstrap/runtime/tool-turn-context';
import { createAppStateToolPipelinePersistence } from '../../src/runtime/tool-persistence';
import type { CompletedChildOrchestrationFixture } from './child-session-orchestrator-integration-fixture';

export async function submitRealParentFollowup(
  {
    owner,
    services,
    parentCoordinator,
    parentSessionId,
    childSessionId,
    workspace,
    model,
    bridgeInput,
    modelRuntimeFactory,
    builtinToolCatalog,
    capabilities,
  }: CompletedChildOrchestrationFixture,
  body: string,
) {
  model.setResponses([
    {
      response: async () => ({
        message: {
          tool_calls: [
            {
              id: 'followup-tool',
              name: 'followup_task',
              args: { agent_id: childSessionId, message: body },
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
  const state = parentCoordinator.getState();
  expect(state.tools.calls['followup-tool']).toMatchObject({
    name: 'followup_task',
    status: 'queued',
  });
  expect(state.capabilities.catalogRevision).not.toBe('');
  const abort = new AbortController();
  const lease = parentCoordinator.session.beginEffect({
    type: 'run_tools',
    toolCallIds: ['followup-tool'],
  });
  expect(
    parentCoordinator.session.applyEffectEvents(
      lease,
      [{ type: 'tool.started', toolCallId: 'followup-tool' }],
      'attempt_start',
    ),
  ).toBe(true);
  const raw = owner.storage.crossSessionQueueMail;
  let sourceCommitError: unknown;
  const storage: CrossSessionQueueMailPort = {
    readActiveChildGrant: () => null,
    readTarget: () => null,
    nextSourceSequence: (sessionId) =>
      owner.runWithSessionExecution(sessionId, () => raw.nextSourceSequence(sessionId)),
    lookupOutbox: (sessionId, messageId) =>
      owner.runWithSessionExecution(sessionId, () => raw.readOutbox(sessionId, messageId)),
    acceptQueueMailCommand: async () => {
      throw new Error('QueueOnly is outside this TriggerTurn fixture.');
    },
    deliverQueueMail: async () => {
      throw new Error('QueueOnly delivery is outside this TriggerTurn fixture.');
    },
    readFollowupTarget: (sourceSessionId, targetSessionId) => {
      const target = owner.runWithSessionExecution(sourceSessionId, () =>
        raw.readFollowupTarget(sourceSessionId, targetSessionId),
      );
      return (
        target && {
          sessionId: target.targetSessionId,
          parentSessionId: sourceSessionId,
          status: target.status,
          checkpointReady: target.checkpointReady,
        }
      );
    },
    lookupFollowupReceipt: (input) =>
      owner.runWithSessionExecution(input.scopeSessionId, () =>
        owner.storage.commandReceipts.lookup(input),
      ),
    acceptFollowupCommand: async (value) => {
      const effectId = `cross-agent-followup-command:${value.receipt.commandId}`;
      const ownerId = 'followup-test-owner';
      expect(
        services.leases.tryAcquire(parentSessionId, effectId, ownerId, Date.now() + 30_000),
      ).toBe(true);
      try {
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.session.commitCrossSessionFollowupCommand(
            lease,
            value.reservationEvent,
            value.event,
            {
              kind: 'accept_followup',
              messageId: value.event.messageId,
              targetSessionId: value.intent.targetSessionId,
              commandId: value.receipt.commandId,
              requestDigest: value.receipt.requestDigest,
              sourceRunId: value.intent.sourceRunId,
              sourceTurnId: value.intent.sourceTurnId,
              sourceModelInvocationId: value.intent.sourceModelInvocationId,
              sourceToolCallId: value.intent.sourceToolCallId,
              sourceEffectAttemptId: value.intent.sourceEffectAttemptId,
              sourceSequence: value.intent.sourceSequence,
              bodyText: value.intent.bodyText,
              acceptedAtMs: value.intent.acceptedAtMs,
              submissionId: value.intent.submissionId,
              admission: value.intent.admission,
            },
            value.receipt,
            { sessionId: parentSessionId, effectId, ownerId },
          ),
        );
      } catch (error) {
        sourceCommitError = error;
        throw error;
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
    toolCallId: 'followup-tool',
    signal: abort.signal,
    authorizeFollowup: ({ state: current, preparedPolicyDigest }) => ({
      phaseCeiling: 'building',
      authorizationDigest: Object.values(current.capabilities.invocations).find(
        (item) => item.toolCallId === 'followup-tool',
      )!.authorizationDigest,
      admissionDigest: Object.values(current.capabilities.invocations).find(
        (item) => item.toolCallId === 'followup-tool',
      )!.admissionDigest!,
      effectiveEffectsDigest: Object.values(current.capabilities.invocations).find(
        (item) => item.toolCallId === 'followup-tool',
      )!.effectiveEffectsDigest,
      capabilityDigest: current.capabilities.catalogRevision,
      policyRevision: preparedPolicyDigest,
      workspaceDigest: current.session.canonicalWorkspaceDigest!,
      interactionModeRevision: current.interactionModeRevision,
      contextWindowTokens: bridgeInput.config.modelCapabilities?.contextWindowTokens ?? 4_096,
      maxOutputTokens: bridgeInput.config.modelCapabilities?.maxOutputTokens ?? 64,
      firstAttemptTimeoutMs: 10_000,
      boundedContext: true,
    }),
  });
  expect(port).toBeDefined();
  if (!port) throw new Error('Followup Tool has no source port.');
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
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const catalog = createBuiltinToolCatalogProjection(registry.snapshot());
  const call = parentCoordinator.getState().tools.calls['followup-tool']!;
  const context = createAppToolTurnContext({
    workspace,
    config: bridgeInput.config,
    threadId: parentSessionId,
    turnId: parentCoordinator.getState().turn.turnId,
    modelMessageId: call.modelMessageId,
    toolCallId: call.toolCallId,
    phase: 'building',
    interactionMode: parentCoordinator.getState().mode,
    agentMailboxAvailable: true,
    agentMailboxQueueOnlyAvailable: false,
    hasTaskAdapter: true,
  });
  const turn = createAppToolPipelineComposition(catalog).forTurn(context);
  const snapshot = createRuntimeHostToolCallSnapshot({
    toolCallId: call.toolCallId,
    name: call.name,
    rawArguments: call.args,
    argumentOrigin: 'model_public',
    createdAtTurnId: call.createdAtTurnId,
    modelMessageId: call.modelMessageId,
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  });
  if (!snapshot.ok) throw new Error(snapshot.failure.code);
  const attempt = createAppOrdinaryToolPipelineAttemptRuntime({ persistence });
  const mailboxMechanism = Object.freeze({
    caller: port.caller,
    listAgents: port.listAgents,
    waitAgent: port.waitAgent,
    submitMessage: port.submitMessage,
    interruptAgent: port.interruptAgent,
  });
  const outcome = await owner
    .runWithSessionExecution(parentSessionId, () =>
      attempt.execute({
        turn,
        snapshot: snapshot.value,
        resolution: {
          currentTurnId: call.createdAtTurnId,
          builtinProjectionRevision: turn.projection.revision,
          dynamicCatalogRevision: null,
          availabilityContext: {
            workspace,
            threadId: parentSessionId,
            turnId: call.createdAtTurnId,
            modelMessageId: call.modelMessageId,
            toolCallId: call.toolCallId,
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
          preassembledMechanism: Object.freeze({ agentMailbox: mailboxMechanism }),
        },
        bindPreparedFollowupAuthority: (prepared) => port.bindPreparedFollowupAuthority(prepared),
      }),
    )
    .catch((error) => {
      throw new Error(
        JSON.stringify({
          pipelineError: String(error),
          sourceCommitError: String(sourceCommitError),
          sourceCause: String((sourceCommitError as { cause?: unknown } | undefined)?.cause),
          sourceNestedCause: String(
            (
              (sourceCommitError as { cause?: unknown } | undefined)?.cause as
                | { cause?: unknown }
                | undefined
            )?.cause,
          ),
          lastEvents: owner.storage.sessions
            .loadEventsStrict(parentSessionId)
            .slice(-12)
            .map(({ event }) => event.type),
        }),
      );
    });
  if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
  expect(outcome.kind).toBe('committed');
  const sourceEvents = owner.storage.sessions
    .loadEventsStrict(parentSessionId)
    .map(({ event }) => event);
  const accepted = sourceEvents.find(
    (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
  );
  expect(accepted?.type).toBe('agent.mail_accepted');
  if (accepted?.type !== 'agent.mail_accepted' || !accepted.submissionId)
    throw new Error('The real parent Tool did not durably accept followup.');
  return { accepted: { ...accepted, submissionId: accepted.submissionId }, raw };
}
