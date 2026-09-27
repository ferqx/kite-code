import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { createChatModel } from '@kite-ai/builtin-runtime/model';
import { createRuntimeHostToolCallSnapshot } from '@kite-ai/runtime-host';
import {
  type CrossSessionFollowupPolicy,
  planCrossSessionTriggerTurnBackup,
} from '@kite-ai/runtime-host/kernel-adapter';
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
  legacyV1Admission = false,
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
          ...(target.originRole ? { originRole: target.originRole } : {}),
          ...(target.originalGrantDigest
            ? { originalGrantDigest: target.originalGrantDigest }
            : {}),
          ...(target.observedTargetRevision !== undefined
            ? { observedTargetRevision: target.observedTargetRevision }
            : {}),
        }
      );
    },
    lookupFollowupReceipt: (input) =>
      owner.runWithSessionExecution(input.scopeSessionId, () =>
        owner.storage.commandReceipts.lookup(input),
      ),
    acceptFollowupCommand: async (value) => {
      // Replay coverage must persist a genuine v1 admission without reopening
      // legacy dispatch through the production mailbox entry point.
      let command = value;
      if (legacyV1Admission) {
        const payload = JSON.parse(value.intent.admission.canonicalJson) as Record<string, unknown>;
        const storedPolicy = payload.policy as Record<string, unknown>;
        const {
          executionMode: _executionMode,
          targetRole: _targetRole,
          targetGrantDigest: _targetGrantDigest,
          interactionMode: _interactionMode,
          workspaceAccess: _workspaceAccess,
          ...sourcePolicy
        } = storedPolicy;
        const planned = planCrossSessionTriggerTurnBackup({
          sourceState: parentCoordinator.getState(),
          trustedCurrentRunId: value.intent.sourceRunId,
          sourceSessionId: value.intent.sourceSessionId,
          targetSessionId: value.intent.targetSessionId,
          submissionId: value.intent.submissionId,
          requestDigest: value.intent.requestDigest,
          receipt: { status: 'missing' },
          policy: sourcePolicy as unknown as CrossSessionFollowupPolicy,
          nowMs: value.intent.acceptedAtMs,
        });
        if (planned.status !== 'planned')
          throw new Error('Legacy followup backup was not planned.');
        const normalize = (item: unknown): unknown =>
          Array.isArray(item)
            ? item.map(normalize)
            : item !== null && typeof item === 'object'
              ? Object.fromEntries(
                  Object.entries(item)
                    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                    .map(([key, nested]) => [key, normalize(nested)]),
                )
              : item;
        const canonicalJson = JSON.stringify(
          normalize({
            ...payload,
            schema: 'kite.cross-session-followup-admission.v1',
            deadlineAt: planned.admission.deadlineAt,
            executableUpperBound: planned.admission.executableUpperBound,
            policy: {
              ...planned.admission.policy,
              interactionMode: parentCoordinator.getState().mode,
              workspaceAccess: parentCoordinator.getState().workspaceAccess,
            },
          }),
        );
        const digest = `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;
        const admission = {
          ref: {
            artifactId: `pa_${digest.slice('sha256:'.length)}`,
            kind: 'agent_followup_admission' as const,
            integrityIdentifier: digest,
            byteLength: Buffer.byteLength(canonicalJson, 'utf8'),
          },
          digest,
          canonicalJson,
          createdAt: value.intent.acceptedAtMs,
        };
        command = {
          ...value,
          event: {
            ...value.event,
            followupAdmissionRef: admission.ref,
            followupAdmissionDigest: admission.digest,
          },
          reservationEvent: planned.reservationEvent,
          intent: { ...value.intent, admission },
        };
      }
      const effectId = `cross-agent-followup-command:${value.receipt.commandId}`;
      const ownerId = 'followup-test-owner';
      expect(
        services.leases.tryAcquire(parentSessionId, effectId, ownerId, Date.now() + 30_000),
      ).toBe(true);
      try {
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.session.commitCrossSessionFollowupCommand(
            lease,
            command.reservationEvent,
            command.event,
            {
              kind: 'accept_followup',
              messageId: command.event.messageId,
              targetSessionId: command.intent.targetSessionId,
              commandId: value.receipt.commandId,
              requestDigest: value.receipt.requestDigest,
              sourceRunId: command.intent.sourceRunId,
              sourceTurnId: command.intent.sourceTurnId,
              sourceModelInvocationId: command.intent.sourceModelInvocationId,
              sourceToolCallId: command.intent.sourceToolCallId,
              sourceEffectAttemptId: command.intent.sourceEffectAttemptId,
              sourceSequence: command.intent.sourceSequence,
              bodyText: command.intent.bodyText,
              acceptedAtMs: command.intent.acceptedAtMs,
              submissionId: command.intent.submissionId,
              admission: command.intent.admission,
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
