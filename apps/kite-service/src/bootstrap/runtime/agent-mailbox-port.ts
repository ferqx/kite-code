import { createHash } from 'node:crypto';
import type {
  AgentMailboxInvocationScope,
  AgentMailboxPort,
} from '@kite-ai/builtin-runtime/subagent';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  createZeroResourceUsage,
  fundingBudgetForRun,
  planCrossSessionTriggerTurnBackup,
  reduceResourceBudgetState,
  runtimeHostStateActivePlanning,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeAgentMailboxMutation,
  RuntimeCommandReceiptLookup,
  RuntimeCommandReceiptLookupInput,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { PreparedToolInvocationIdentity } from '@kite-ai/runtime-spi';
import type { RuntimeAgentMailboxCommandCommitInput } from './state-runner';
import type { RuntimeEvent, RuntimeState, StateRuntimeStorage } from './state-runtime';

interface RootAgentMetadata {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly currentTaskId: string | null;
  readonly currentSubmissionId: string | null;
  readonly status: 'idle' | 'active' | 'context_unavailable';
  readonly turnOrdinal: number;
  readonly mailRevision: number;
  readonly preparedThroughSequence: number;
  readonly unreadCount: number;
}
interface RootAgentMetadataReader {
  readAgent(
    sessionId: string,
    sourceAgentId: string,
    targetAgentId: string,
  ): RootAgentMetadata | null;
  listAgents(sessionId: string, sourceAgentId: string): readonly RootAgentMetadata[];
  nextSequence(sessionId: string, sourceAgentId: string): number;
}

const MAX_MAIL_BYTES = 4096;
const MAX_PENDING_MAIL = 8;

/** The cross-Session Store owner implements these calls under the owning Session fence. */
export interface CrossSessionQueueMailPort {
  /** Source-owned, bounded direct-child tree; contains metadata only. */
  listDirectChildren?(
    parentSessionId: string,
    currentRunId: string,
    limit: number,
  ): readonly Readonly<{
    agentId: string;
    status: string;
    currentTaskId?: string;
    unreadCount: number;
  }>[];
  /** Source current-Run unread facts; read does not prepare model input. */
  readDirectChildInboxWatermark?(
    parentSessionId: string,
    currentRunId: string,
  ): Readonly<{ unreadCount: number; throughSequence: number }>;
  /** Most recent outcome acknowledged by the source Run; metadata only, no mail body. */
  readLastFollowupOutcomeForDirectChild?(
    sourceSessionId: string,
    currentRunId: string,
    childSessionId: string,
  ): Readonly<{
    submissionId: string;
    status: 'completed' | 'unknown' | 'pre_dispatch_released' | 'failed';
    reason?:
      | 'tool_failed'
      | 'expired'
      | 'context_unavailable'
      | 'authorization_changed'
      | 'capacity_timeout'
      | 'source_cancelled';
    taskId?: string;
    sourceRevision: number;
  }> | null;
  /** Count covers ACK-only writes that leave the parent State revision unchanged. */
  readDirectChildFollowupOutcomeWatermark?(
    sourceSessionId: string,
    currentRunId: string,
  ): Readonly<{ count: number; throughRevision: number }>;
  readActiveChildGrant(
    childSessionId: string,
    taskId: string,
    grantId: string,
  ): Readonly<{ parentSessionId: string; grantDigest: string }> | null;
  readTarget(
    sourceSessionId: string,
    targetSessionId: string,
  ): Readonly<{
    sessionId: string;
    parentSessionId: string | null;
    status:
      | 'active'
      | 'waiting'
      | 'idle'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'context_unavailable';
  }> | null;
  nextSourceSequence(sourceSessionId: string): number;
  lookupOutbox(
    sourceSessionId: string,
    messageId: string,
  ): Readonly<{
    targetSessionId: string;
    requestDigest: string;
    deliveredTargetRevision: number | null;
  }> | null;
  acceptQueueMailCommand(
    input: Readonly<{
      event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }>;
      receipt: Readonly<{
        scopeSessionId: string;
        targetSessionId: string;
        commandId: string;
        requestDigest: string;
        committedAt: number;
      }>;
      intent: Readonly<{
        sourceSessionId: string;
        targetSessionId: string;
        messageId: string;
        commandId: string;
        requestDigest: string;
        sourceRunId: string;
        sourceGrantId?: string;
        sourceGrantDigest?: string;
        bodyText: string;
        acceptedAtMs: number;
      }>;
    }>,
  ): Promise<void>;
  /** D3 source-only seams. Absent until Store13 owner and target routing are installed. */
  readFollowupTarget?(
    sourceSessionId: string,
    targetSessionId: string,
  ): Readonly<{
    sessionId: string;
    parentSessionId: string;
    status:
      | 'active'
      | 'waiting'
      | 'idle'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'context_unavailable';
    checkpointReady: boolean;
  }> | null;
  lookupFollowupReceipt?(input: RuntimeCommandReceiptLookupInput): RuntimeCommandReceiptLookup;
  acceptFollowupCommand?(
    input: Readonly<{
      event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }>;
      reservationEvent: Extract<RuntimeEvent, { type: 'resource_budget.reserved' }>;
      receipt: Readonly<{
        scopeSessionId: string;
        targetSessionId: string;
        commandId: string;
        requestDigest: string;
        committedAt: number;
      }>;
      intent: Readonly<{
        sourceSessionId: string;
        targetSessionId: string;
        messageId: string;
        commandId: string;
        requestDigest: string;
        sourceRunId: string;
        sourceTurnId: string;
        sourceModelInvocationId: string;
        sourceToolCallId: string;
        sourceEffectAttemptId: string;
        sourceSequence: number;
        bodyText: string;
        acceptedAtMs: number;
        submissionId: string;
        admission: Readonly<{
          ref: Readonly<{
            artifactId: string;
            kind: 'agent_followup_admission';
            integrityIdentifier: string;
            byteLength: number;
          }>;
          digest: string;
          canonicalJson: string;
          createdAt: number;
        }>;
      }>;
    }>,
  ): Promise<void>;
  /** Source owner reads only an exact direct child; inactive targets never fabricate a stop. */
  readInterruptTarget?(
    sourceSessionId: string,
    targetSessionId: string,
  ): Readonly<{
    targetSessionId: string;
    status: 'active' | 'queued' | 'idle' | 'unavailable';
    targetRunId: string | null;
    targetTaskId: string | null;
    targetOwnerGeneration: number | null;
    targetRevision: number;
    queuedIntentEventId?: string;
  }> | null;
  lookupInterruptReceipt?(input: RuntimeCommandReceiptLookupInput): RuntimeCommandReceiptLookup;
  readInterruptIntent?(
    sourceSessionId: string,
    commandId: string,
  ): Readonly<{
    targetSessionId: string;
    requestDigest: string;
    targetRunId: string | null;
    targetTaskId: string;
    status: 'pending' | 'accepted' | 'settled' | 'unknown' | 'idle';
  }> | null;
  acceptInterruptCommand?(
    input: Readonly<{
      event: Extract<RuntimeEvent, { type: 'background_execution.stop_requested' }>;
      receipt: Readonly<{
        scopeSessionId: string;
        targetSessionId: string;
        commandId: string;
        requestDigest: string;
        committedAt: number;
      }>;
      intent: Readonly<{
        sourceSessionId: string;
        targetSessionId: string;
        commandId: string;
        requestDigest: string;
        sourceRunId: string;
        sourceTurnId: string;
        sourceModelInvocationId: string;
        sourceToolCallId: string;
        sourceEffectAttemptId: string;
        sourceTaskId?: string;
        sourceGrantDigest?: string;
        targetRunId: string | null;
        targetTaskId: string;
        targetOwnerGeneration: number | null;
        queuedIntentEventId?: string;
        targetRevision: number;
        createdAtMs: number;
      }>;
    }>,
  ): Promise<void>;
  /** Idempotent target-owned delivery. Source receipt is already durable. */
  deliverQueueMail(sourceSessionId: string, messageId: string): Promise<void>;
}

export interface CrossSessionRootMailboxInput {
  readonly getState: () => Readonly<RuntimeState>;
  readonly currentRunId: () => string | null;
  readonly storage: CrossSessionQueueMailPort;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  /** Detached target work; absence leaves the durable outbox for recovery. */
  readonly scheduleDelivery?: (sourceSessionId: string, messageId: string) => void | Promise<void>;
  /** Detached target-owned stop scan; absence leaves the durable intent pending. */
  readonly scheduleInterrupt?: (
    targetSessionId: string,
    sourceSessionId: string,
    commandId: string,
  ) => void | Promise<void>;
  /** Detached TriggerTurn stage scan; source Tool returns after its durable receipt. */
  readonly scheduleFollowup?: (
    sourceSessionId: string,
    submissionId: string,
  ) => void | Promise<void>;
  readonly onDeliveryFailure?: (input: {
    readonly sourceSessionId: string;
    readonly messageId: string;
    readonly error: unknown;
  }) => void;
  /** Trusted Tool policy, never derived from model arguments. Omission keeps TriggerTurn closed. */
  readonly authorizeFollowup?: (input: {
    readonly state: Readonly<RuntimeState>;
    readonly scope: AgentMailboxInvocationScope;
    readonly targetSessionId: string;
    /** Exact governance policy bound to this prepared Tool attempt. */
    readonly preparedPolicyDigest: string;
  }) => RootFollowupPolicyEvidence | null;
}

export interface CrossSessionPreparedFollowupMailboxPort extends AgentMailboxPort {
  /** Private Service cutover hook; callable once for the exact prepared Tool attempt. */
  bindPreparedFollowupAuthority(
    input: Readonly<{
      identity: Readonly<PreparedToolInvocationIdentity>;
      request: Readonly<import('./tool-pipeline-prepared').AppToolPipelinePreparedRequest>;
    }>,
  ): boolean;
}

export interface CrossSessionChildMailboxInput extends CrossSessionRootMailboxInput {
  readonly child: Readonly<{
    parentSessionId: string;
    taskId: string;
    grantId: string;
    grantDigest: string;
  }>;
}

export interface CrossSessionPreparedFollowupToolEvidence {
  readonly invocationId: string;
  readonly operationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly toolCallId: string;
  readonly attemptId: string;
  readonly modelMessageId: string;
  readonly turnId: string;
  readonly policyEffects: Readonly<import('@kite-ai/runtime-spi').CapabilityPolicyEffects>;
  readonly effectiveEffects: Readonly<import('@kite-ai/runtime-spi').CapabilityEffects>;
  readonly sandboxScope: Readonly<import('@kite-ai/runtime-spi').CapabilitySandboxScopeFact> | null;
  readonly authorizationKind: import('./tool-pipeline-prepared').AppToolPipelinePreparedAuthorizationKind;
  readonly grantUsed: import('./tool-pipeline-prepared').AppToolPipelinePreparedGrantUsed;
  readonly interactionMode: 'auto' | 'accept_edits' | 'full';
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly bindingId: string | null;
  readonly effectiveEffectsDigest: string;
  readonly authorizationDigest: string | null;
  readonly admissionDigest: string | null;
  readonly policyRevision: string | null;
}

export interface RootFollowupPolicyEvidence {
  readonly phaseCeiling: 'planning' | 'building';
  readonly authorizationDigest: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly capabilityDigest: string;
  readonly policyRevision: string;
  readonly workspaceDigest: string;
  readonly interactionModeRevision: number;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly firstAttemptTimeoutMs: number;
  /** Attests that the first child Surface will be cropped to these model bounds. */
  readonly boundedContext: true;
  /** Exact prepared request facts, present only for independently routed child Sessions. */
  readonly preparedTool?: Readonly<CrossSessionPreparedFollowupToolEvidence>;
}

export interface RootAgentMailboxPortInput {
  readonly getState: () => Readonly<RuntimeState>;
  /** Persisted current Run identity from the Host lifecycle projection. */
  readonly currentRunId: () => string | null;
  readonly storage: {
    readonly agentMailbox?: RootAgentMetadataReader;
    readonly commandReceipts?: StateRuntimeStorage['commandReceipts'];
  };
  readonly commitAgentMailboxCommand: (
    input: RuntimeAgentMailboxCommandCommitInput,
  ) => RuntimeStoredCommandReceipt | Promise<RuntimeStoredCommandReceipt>;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  /** Trusted policy and model-bound proof. Missing evidence keeps TriggerTurn unavailable. */
  readonly authorizeFollowup?: (input: {
    readonly state: Readonly<RuntimeState>;
    readonly scope: AgentMailboxInvocationScope;
    readonly target: RootAgentMetadata;
  }) => RootFollowupPolicyEvidence | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}

function validFollowupPolicy(
  state: Readonly<RuntimeState>,
  toolCallId: string,
  evidence: RootFollowupPolicyEvidence | null,
): evidence is RootFollowupPolicyEvidence {
  const invocations = Object.values(state.capabilities.invocations).filter(
    (invocation) => invocation.toolCallId === toolCallId && invocation.status === 'running',
  );
  const invocation = invocations[0];
  return Boolean(
    evidence &&
      evidence.boundedContext === true &&
      invocations.length === 1 &&
      invocation?.admissionDigest &&
      typeof evidence.authorizationDigest === 'string' &&
      evidence.authorizationDigest.length > 0 &&
      typeof evidence.admissionDigest === 'string' &&
      evidence.admissionDigest.length > 0 &&
      typeof evidence.effectiveEffectsDigest === 'string' &&
      evidence.effectiveEffectsDigest.length > 0 &&
      typeof evidence.capabilityDigest === 'string' &&
      evidence.capabilityDigest.length > 0 &&
      evidence.authorizationDigest === invocation.authorizationDigest &&
      evidence.admissionDigest === invocation.admissionDigest &&
      evidence.effectiveEffectsDigest === invocation.effectiveEffectsDigest &&
      evidence.capabilityDigest === state.capabilities.catalogRevision &&
      /^sha256:[a-f0-9]{64}$/u.test(evidence.workspaceDigest) &&
      evidence.workspaceDigest === state.session.canonicalWorkspaceDigest &&
      evidence.interactionModeRevision === state.interactionModeRevision &&
      evidence.phaseCeiling === getAgentPhase(runtimeHostStateActivePlanning(state)) &&
      typeof evidence.policyRevision === 'string' &&
      evidence.policyRevision.length > 0 &&
      Number.isSafeInteger(evidence.contextWindowTokens) &&
      evidence.contextWindowTokens > 0 &&
      Number.isSafeInteger(evidence.maxOutputTokens) &&
      evidence.maxOutputTokens > 0 &&
      evidence.contextWindowTokens > evidence.maxOutputTokens &&
      Number.isSafeInteger(evidence.firstAttemptTimeoutMs) &&
      evidence.firstAttemptTimeoutMs > 0,
  );
}

function rootCaller(
  input: Pick<RootAgentMailboxPortInput, 'getState' | 'currentRunId' | 'toolCallId'>,
): AgentMailboxPort['caller'] | undefined {
  const state = input.getState();
  const call = state.tools.calls[input.toolCallId];
  const message = state.transcript.messages.find(
    (entry) => entry.kind === 'assistant' && entry.messageId === call?.modelMessageId,
  );
  const runId = input.currentRunId();
  const sessionId = state.session.threadId;
  if (
    !sessionId ||
    !runId ||
    !call ||
    call.createdAtTurnId !== state.turn.turnId ||
    (call.taskId !== undefined && call.taskId !== state.activeTaskId) ||
    state.turn.status !== 'active' ||
    message?.kind !== 'assistant' ||
    message.turnId !== state.turn.turnId ||
    !message.modelInvocationId ||
    call.modelInvocationId !== message.modelInvocationId ||
    !message.toolCalls.some((tool) => tool.id === input.toolCallId)
  )
    return undefined;
  return Object.freeze({
    sessionId,
    sourceAgentId: sessionId,
    runId,
    turnId: state.turn.turnId,
    modelInvocationId: message.modelInvocationId,
  });
}

/** QueueOnly is accepted in the source Session before target delivery is attempted. */
export function createCrossSessionRootMailboxPort(
  input: CrossSessionRootMailboxInput,
): CrossSessionPreparedFollowupMailboxPort | undefined {
  const caller = rootCaller(input);
  if (!caller) return undefined;
  let prepared: Readonly<PreparedToolInvocationIdentity> | undefined;
  let preparedRequest:
    | Readonly<import('./tool-pipeline-prepared').AppToolPipelinePreparedRequest>
    | undefined;
  const base = createCrossSessionMailboxPort({
    ...input,
    authorizeFollowup: ({ state, scope, targetSessionId }) => {
      const running = Object.values(state.capabilities.invocations).filter(
        (invocation) =>
          invocation.toolCallId === scope.toolCallId && invocation.status === 'running',
      );
      if (
        !prepared ||
        !preparedRequest ||
        running.length !== 1 ||
        running[0]?.invocationId !== prepared.invocationId ||
        running[0]?.capabilityId !== prepared.capabilityId ||
        running[0]?.capabilityRevision !== prepared.capabilityRevision ||
        scope.effectAttemptId !== prepared.attemptId ||
        scope.toolCallId !== prepared.toolCallId ||
        state.tools.calls[scope.toolCallId]?.modelMessageId !== prepared.modelMessageId ||
        !input.authorizeFollowup
      )
        return null;
      const policy = input.authorizeFollowup({
        state,
        scope,
        targetSessionId,
        preparedPolicyDigest: prepared.policyDigest!,
      });
      return policy?.policyRevision === prepared.policyDigest &&
        policy.authorizationDigest === prepared.authorizationDigest &&
        policy.admissionDigest === prepared.admissionDigest &&
        policy.effectiveEffectsDigest === prepared.effectiveEffectsDigest
        ? {
            ...policy,
            preparedTool: {
              invocationId: prepared.invocationId,
              operationId: prepared.operationId,
              capabilityId: prepared.capabilityId,
              capabilityRevision: prepared.capabilityRevision,
              toolCallId: prepared.toolCallId,
              attemptId: prepared.attemptId,
              modelMessageId: prepared.modelMessageId,
              turnId: prepared.turnId,
              policyEffects: preparedRequest.policyEffects,
              effectiveEffects: preparedRequest.effectiveEffects,
              sandboxScope: preparedRequest.sandboxScope,
              authorizationKind: preparedRequest.authorizationKind,
              grantUsed: preparedRequest.grantUsed,
              interactionMode: preparedRequest.interactionMode,
              argumentsDigest: prepared.argumentsDigest,
              schemaDigest: prepared.schemaDigest,
              bindingId: prepared.bindingId,
              effectiveEffectsDigest: prepared.effectiveEffectsDigest,
              authorizationDigest: prepared.authorizationDigest,
              admissionDigest: prepared.admissionDigest,
              policyRevision: prepared.policyDigest,
            },
          }
        : null;
    },
  });
  if (!base) return undefined;
  return Object.freeze({
    ...base,
    bindPreparedFollowupAuthority(
      bound: Parameters<
        CrossSessionPreparedFollowupMailboxPort['bindPreparedFollowupAuthority']
      >[0],
    ): boolean {
      const { identity, request } = bound;
      const state = input.getState();
      const call = state.tools.calls[input.toolCallId];
      if (
        prepared ||
        !call ||
        call.name !== 'followup_task' ||
        input.signal.aborted ||
        identity.isDynamicMcp ||
        identity.operationId !== 'builtin:followup_task' ||
        identity.exposedToolName !== 'followup_task' ||
        identity.capabilityId !== 'builtin:followup_task' ||
        identity.bindingId !== null ||
        identity.toolCallId !== input.toolCallId ||
        identity.turnId !== caller.turnId ||
        identity.modelMessageId !== call.modelMessageId ||
        request.schema !== 'kite.tool-pipeline-prepared-request.v1' ||
        request.interactionMode !== state.mode ||
        !identity.attemptId.startsWith(`${identity.invocationId}:attempt:`) ||
        !Number.isSafeInteger(
          Number(identity.attemptId.slice(`${identity.invocationId}:attempt:`.length)),
        ) ||
        Number(identity.attemptId.slice(`${identity.invocationId}:attempt:`.length)) < 1 ||
        !identity.policyDigest ||
        !identity.authorizationDigest ||
        !identity.admissionDigest ||
        !identity.effectiveEffectsDigest
      )
        return false;
      prepared = identity;
      preparedRequest = request;
      return true;
    },
  });
}

/** Child Tool calls carry the sealed grant and may queue mail only to their exact parent. */
export function createCrossSessionChildMailboxPort(
  input: CrossSessionChildMailboxInput,
): AgentMailboxPort | undefined {
  if (
    !input.child.parentSessionId ||
    !input.child.taskId ||
    !input.child.grantId ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.child.grantDigest)
  )
    return undefined;
  const { authorizeFollowup: _ignored, ...childInput } = input;
  return createCrossSessionMailboxPort(childInput, input.child);
}

function createCrossSessionMailboxPort(
  input: Omit<CrossSessionRootMailboxInput, 'authorizeFollowup'> & {
    readonly authorizeFollowup?: (input: {
      readonly state: Readonly<RuntimeState>;
      readonly scope: AgentMailboxInvocationScope;
      readonly targetSessionId: string;
    }) => RootFollowupPolicyEvidence | null;
  },
  child?: CrossSessionChildMailboxInput['child'],
): AgentMailboxPort | undefined {
  const caller = rootCaller(input);
  if (!caller || !input.toolCallId || input.signal.aborted) return undefined;
  const originalUserMessageIds = new Set(
    input
      .getState()
      .transcript.messages.filter((message) => message.kind === 'user')
      .map((message) => message.messageId),
  );
  const hasNewUserInput = (): boolean =>
    input
      .getState()
      .transcript.messages.some(
        (message) => message.kind === 'user' && !originalUserMessageIds.has(message.messageId),
      );
  const boundCaller = child
    ? Object.freeze({ ...caller, sourceTaskId: child.taskId, childGrantId: child.grantId })
    : caller;
  const sourceSessionId = caller.sessionId;
  const validGrant = (): boolean => {
    if (!child) return true;
    const state = input.getState();
    if (state.activeTaskId !== child.taskId) return false;
    const proof = input.storage.readActiveChildGrant(caller.sessionId, child.taskId, child.grantId);
    return (
      proof?.parentSessionId === child.parentSessionId && proof.grantDigest === child.grantDigest
    );
  };
  if (!validGrant()) return undefined;
  const scheduleDelivery = (messageId: string): void => {
    if (!input.scheduleDelivery) return;
    setImmediate(() => {
      try {
        void Promise.resolve(input.scheduleDelivery!(sourceSessionId, messageId)).catch(
          reportDeliveryFailure,
        );
      } catch (error) {
        reportDeliveryFailure(error);
      }
    });
    function reportDeliveryFailure(error: unknown): void {
      if (input.onDeliveryFailure) {
        input.onDeliveryFailure({ sourceSessionId, messageId, error });
      } else {
        console.error('Cross-Session mail delivery deferred for recovery.', {
          sourceSessionId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const validScope = (scope: AgentMailboxInvocationScope, signal: AbortSignal): boolean => {
    const current = rootCaller(input);
    return Boolean(
      !input.signal.aborted &&
        !signal.aborted &&
        current &&
        scope.sessionId === caller.sessionId &&
        scope.sourceAgentId === caller.sourceAgentId &&
        scope.runId === caller.runId &&
        scope.turnId === caller.turnId &&
        scope.modelInvocationId === caller.modelInvocationId &&
        scope.toolCallId === input.toolCallId &&
        scope.effectAttemptId &&
        (child
          ? scope.sourceTaskId === child.taskId && scope.childGrantId === child.grantId
          : !scope.sourceTaskId && !scope.childGrantId) &&
        validGrant() &&
        current.runId === caller.runId &&
        current.turnId === caller.turnId &&
        current.modelInvocationId === caller.modelInvocationId,
    );
  };
  return Object.freeze({
    caller: boundCaller,
    async listAgents({ scope, signal }: Parameters<AgentMailboxPort['listAgents']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (
        child ||
        !input.storage.listDirectChildren ||
        !input.storage.readDirectChildInboxWatermark
      )
        return { ok: false, code: 'admission_unavailable' };
      try {
        const inbox = input.storage.readDirectChildInboxWatermark(caller.sessionId, caller.runId);
        const children = input.storage.listDirectChildren(caller.sessionId, caller.runId, 63);
        if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
        return {
          ok: true,
          agents: [
            {
              agent_id: caller.sessionId,
              status: 'running',
              unread_count: inbox.unreadCount,
            },
            ...children.map((entry) => {
              const outcome = input.storage.readLastFollowupOutcomeForDirectChild?.(
                caller.sessionId,
                caller.runId,
                entry.agentId,
              );
              return {
                agent_id: entry.agentId,
                parent_agent_id: caller.sessionId,
                status: entry.status,
                ...(entry.currentTaskId ? { current_task_id: entry.currentTaskId } : {}),
                unread_count: entry.unreadCount,
                ...(outcome
                  ? {
                      last_followup_status: outcome.status,
                      last_followup_submission_id: outcome.submissionId,
                      ...(outcome.status === 'failed' && outcome.reason
                        ? { last_followup_reason: outcome.reason }
                        : {}),
                      ...('taskId' in outcome && outcome.taskId
                        ? { last_followup_task_id: outcome.taskId }
                        : {}),
                    }
                  : {}),
              };
            }),
          ],
        };
      } catch {
        return { ok: false, code: 'admission_unavailable' };
      }
    },
    async waitAgent({ scope, timeoutMs, signal }: Parameters<AgentMailboxPort['waitAgent']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
        return { ok: false, code: 'invalid_timeout' };
      if (child || !input.storage.readDirectChildInboxWatermark)
        return { ok: false, code: 'admission_unavailable' };
      try {
        const initial = input.storage.readDirectChildInboxWatermark(caller.sessionId, caller.runId);
        const readFollowupOutcomeWatermark = input.storage.readDirectChildFollowupOutcomeWatermark;
        const initialOutcome = readFollowupOutcomeWatermark?.(caller.sessionId, caller.runId);
        if (signal.aborted || input.signal.aborted) return { ok: false, code: 'cancelled' };
        if (!validScope(scope, signal)) return { ok: true, timed_out: false, reason: 'user_input' };
        if (initial.unreadCount > 0)
          return { ok: true, timed_out: false, reason: 'mailbox_update' };
        if (initialOutcome && initialOutcome.count > 0)
          return { ok: true, timed_out: false, reason: 'agent_update' };
        if (hasNewUserInput()) return { ok: true, timed_out: false, reason: 'user_input' };
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (signal.aborted || input.signal.aborted) return { ok: false, code: 'cancelled' };
          if (!validScope(scope, signal) || hasNewUserInput())
            return { ok: true, timed_out: false, reason: 'user_input' };
          const remaining = deadline - Date.now();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(remaining, 100));
            function done() {
              clearTimeout(timer);
              signal.removeEventListener('abort', done);
              input.signal.removeEventListener('abort', done);
              resolve();
            }
            signal.addEventListener('abort', done, { once: true });
            input.signal.addEventListener('abort', done, { once: true });
          });
          if (signal.aborted || input.signal.aborted) return { ok: false, code: 'cancelled' };
          if (!validScope(scope, signal) || hasNewUserInput())
            return { ok: true, timed_out: false, reason: 'user_input' };
          const latest = input.storage.readDirectChildInboxWatermark(
            caller.sessionId,
            caller.runId,
          );
          if (latest.unreadCount > 0 || latest.throughSequence > initial.throughSequence)
            return { ok: true, timed_out: false, reason: 'mailbox_update' };
          const latestOutcome = readFollowupOutcomeWatermark?.(caller.sessionId, caller.runId);
          if (
            latestOutcome &&
            (latestOutcome.count > (initialOutcome?.count ?? 0) ||
              latestOutcome.throughRevision > (initialOutcome?.throughRevision ?? 0))
          )
            return { ok: true, timed_out: false, reason: 'agent_update' };
        }
        return { ok: true, timed_out: true, reason: 'timeout' };
      } catch {
        return { ok: false, code: 'admission_unavailable' };
      }
    },
    async submitMessage({
      scope,
      agentId,
      message,
      mode,
      signal,
    }: Parameters<AgentMailboxPort['submitMessage']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (mode !== 'queue_only' && mode !== 'trigger_turn')
        return { ok: false, code: 'admission_unavailable' };
      if (
        !agentId ||
        agentId === caller.sessionId ||
        (child && agentId !== child.parentSessionId) ||
        typeof message !== 'string'
      )
        return { ok: false, code: 'invalid_target' };
      const byteLength = Buffer.byteLength(message, 'utf8');
      if (byteLength < 1 || byteLength > MAX_MAIL_BYTES)
        return { ok: false, code: 'capacity_exceeded' };
      const source = {
        runId: scope.runId,
        turnId: scope.turnId,
        modelInvocationId: scope.modelInvocationId,
        toolCallId: scope.toolCallId,
        effectAttemptId: scope.effectAttemptId,
        ...(child ? { sourceTaskId: child.taskId } : {}),
      };
      const messageId = `mail_${sha256(JSON.stringify([scope.sessionId, source, child?.grantId]))}`;
      const bodyDigest = `sha256:${sha256(message)}`;
      const requestDigest = sha256(JSON.stringify([messageId, agentId, mode, bodyDigest]));
      if (mode === 'trigger_turn') {
        const submissionId = `submission_${sha256(JSON.stringify([messageId, 'trigger_turn']))}`;
        const scheduleAcceptedFollowup = () => {
          try {
            void Promise.resolve(input.scheduleFollowup?.(caller.sessionId, submissionId)).catch(
              (error) =>
                input.onDeliveryFailure?.({
                  sourceSessionId: caller.sessionId,
                  messageId,
                  error,
                }),
            );
          } catch (error) {
            input.onDeliveryFailure?.({ sourceSessionId: caller.sessionId, messageId, error });
          }
        };
        if (
          child ||
          input.getState().tools.calls[scope.toolCallId]?.name !== 'followup_task' ||
          !input.authorizeFollowup ||
          !input.storage.readFollowupTarget ||
          !input.storage.lookupFollowupReceipt ||
          !input.storage.acceptFollowupCommand
        )
          return { ok: false, code: 'admission_unavailable' };
        try {
          // A source receipt is authoritative before target/policy/budget are planned.
          const receipt = input.storage.lookupFollowupReceipt({
            scopeSessionId: caller.sessionId,
            commandId: messageId,
            requestDigest,
          });
          if (receipt.status === 'digest_mismatch') return { ok: false, code: 'identity_conflict' };
          if (receipt.status === 'replay') {
            if (
              receipt.receipt.targetSessionId !== caller.sessionId ||
              receipt.receipt.requestDigest !== requestDigest
            )
              return { ok: false, code: 'identity_conflict' };
            scheduleAcceptedFollowup();
            return { ok: true };
          }
          const target = input.storage.readFollowupTarget(caller.sessionId, agentId);
          if (
            !target ||
            target.sessionId !== agentId ||
            target.parentSessionId !== caller.sessionId
          )
            return { ok: false, code: 'agent_not_found' };
          if (
            target.status === 'context_unavailable' ||
            (!['active', 'waiting'].includes(target.status) && !target.checkpointReady)
          )
            return { ok: false, code: 'target_unavailable' };
          const state = input.getState();
          const policy = input.authorizeFollowup({ state, scope, targetSessionId: agentId });
          if (!validFollowupPolicy(state, scope.toolCallId, policy) || !policy.preparedTool)
            return { ok: false, code: 'admission_unavailable' };
          const { preparedTool, ...sourcePolicy } = policy;
          const sourceSequence = input.storage.nextSourceSequence(caller.sessionId);
          if (
            !Number.isSafeInteger(sourceSequence) ||
            sourceSequence < 1 ||
            !validScope(scope, signal)
          )
            return { ok: false, code: 'invalid_source' };
          const nowMs = Date.now();
          const planned = planCrossSessionTriggerTurnBackup({
            sourceState: state,
            trustedCurrentRunId: caller.runId,
            sourceSessionId: caller.sessionId,
            targetSessionId: agentId,
            submissionId,
            requestDigest,
            receipt: { status: 'missing' },
            policy: sourcePolicy,
            nowMs,
          });
          if (planned.status !== 'planned') return { ok: false, code: 'identity_conflict' };
          const admissionJson = canonicalJson({
            schema: 'kite.cross-session-followup-admission.v1',
            submissionId,
            messageId,
            sourceSessionId: caller.sessionId,
            targetSessionId: agentId,
            sourceRunId: caller.runId,
            sourceTurnId: caller.turnId,
            sourceModelInvocationId: caller.modelInvocationId,
            sourceToolCallId: scope.toolCallId,
            sourceEffectAttemptId: scope.effectAttemptId,
            source,
            bodyDigest,
            backupReservationId: planned.admission.backupReservationId,
            fundingRunId: planned.admission.fundingRunId,
            deadlineAt: planned.admission.deadlineAt,
            executableUpperBound: planned.admission.executableUpperBound,
            policy: {
              ...planned.admission.policy,
              interactionMode: state.mode,
              workspaceAccess: state.workspaceAccess,
            },
            preparedTool,
          });
          const admissionDigest = `sha256:${sha256(admissionJson)}`;
          const admission = {
            ref: {
              artifactId: `pa_${admissionDigest.slice('sha256:'.length)}`,
              kind: 'agent_followup_admission' as const,
              integrityIdentifier: admissionDigest,
              byteLength: Buffer.byteLength(admissionJson, 'utf8'),
            },
            digest: admissionDigest,
            canonicalJson: admissionJson,
            createdAt: nowMs,
          };
          const event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }> = {
            type: 'agent.mail_accepted',
            messageId,
            senderAgentId: caller.sourceAgentId,
            targetAgentId: agentId,
            mode: 'trigger_turn',
            source,
            bodyRef: {
              artifactId: `pa_${bodyDigest.slice('sha256:'.length)}`,
              kind: 'agent_mail',
              integrityIdentifier: bodyDigest,
              byteLength,
            },
            bodyDigest,
            sequence: sourceSequence,
            submissionId,
            followupAdmissionRef: admission.ref,
            followupAdmissionDigest: admissionDigest,
          };
          if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
          await input.storage.acceptFollowupCommand({
            event,
            reservationEvent: planned.reservationEvent,
            receipt: {
              scopeSessionId: caller.sessionId,
              targetSessionId: caller.sessionId,
              commandId: messageId,
              requestDigest,
              committedAt: nowMs,
            },
            intent: {
              sourceSessionId: caller.sessionId,
              targetSessionId: agentId,
              messageId,
              commandId: messageId,
              requestDigest,
              sourceRunId: caller.runId,
              sourceTurnId: caller.turnId,
              sourceModelInvocationId: caller.modelInvocationId,
              sourceToolCallId: scope.toolCallId,
              sourceEffectAttemptId: scope.effectAttemptId,
              sourceSequence,
              bodyText: message,
              acceptedAtMs: nowMs,
              submissionId,
              admission,
            },
          });
          scheduleAcceptedFollowup();
          return { ok: true };
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'mailbox_rejected';
          return { ok: false, code };
        }
      }
      try {
        const replay = input.storage.lookupOutbox(caller.sessionId, messageId);
        if (replay) {
          if (replay.targetSessionId !== agentId || replay.requestDigest !== requestDigest)
            return { ok: false, code: 'identity_conflict' };
          scheduleDelivery(messageId);
          return { ok: true };
        }
        const target = input.storage.readTarget(caller.sessionId, agentId);
        if (
          !target ||
          target.sessionId !== agentId ||
          (child
            ? target.sessionId !== child.parentSessionId
            : target.parentSessionId !== caller.sessionId)
        )
          return { ok: false, code: 'agent_not_found' };
        if (target.status !== 'active' && target.status !== 'waiting')
          return { ok: false, code: 'target_unavailable' };
        const sequence = input.storage.nextSourceSequence(caller.sessionId);
        if (!Number.isSafeInteger(sequence) || sequence < 1 || !validScope(scope, signal))
          return { ok: false, code: 'invalid_source' };
        const acceptedAtMs = Date.now();
        const event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }> = {
          type: 'agent.mail_accepted',
          messageId,
          senderAgentId: caller.sourceAgentId,
          targetAgentId: agentId,
          mode: 'queue_only',
          source,
          bodyRef: {
            artifactId: `pa_${bodyDigest.slice('sha256:'.length)}`,
            kind: 'agent_mail',
            integrityIdentifier: bodyDigest,
            byteLength,
          },
          bodyDigest,
          sequence,
        };
        await input.storage.acceptQueueMailCommand({
          event,
          receipt: {
            scopeSessionId: caller.sessionId,
            targetSessionId: caller.sessionId,
            commandId: messageId,
            requestDigest,
            committedAt: acceptedAtMs,
          },
          intent: {
            sourceSessionId: caller.sessionId,
            targetSessionId: agentId,
            messageId,
            commandId: messageId,
            requestDigest,
            sourceRunId: scope.runId,
            ...(child
              ? { sourceGrantId: child.grantId, sourceGrantDigest: child.grantDigest }
              : {}),
            bodyText: message,
            acceptedAtMs,
          },
        });
        // The Tool receipt is source-owned; target work never blocks it.
        scheduleDelivery(messageId);
        return { ok: true };
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'mailbox_rejected';
        return { ok: false, code };
      }
    },
    async interruptAgent({
      scope,
      agentId,
      signal,
    }: Parameters<AgentMailboxPort['interruptAgent']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (!agentId || agentId === caller.sessionId || (child && agentId !== child.parentSessionId))
        return { ok: false, code: 'invalid_target' };
      if (
        input.getState().tools.calls[scope.toolCallId]?.name !== 'interrupt_agent' ||
        !input.storage.readInterruptTarget ||
        !input.storage.lookupInterruptReceipt ||
        !input.storage.readInterruptIntent ||
        !input.storage.acceptInterruptCommand
      )
        return { ok: false, code: 'admission_unavailable' };
      const commandId = `interrupt_${sha256(
        JSON.stringify([
          scope.sessionId,
          scope.runId,
          scope.turnId,
          scope.modelInvocationId,
          scope.toolCallId,
          scope.effectAttemptId,
          agentId,
        ]),
      )}`;
      const requestDigest = sha256(JSON.stringify([commandId, agentId]));
      const schedule = (): void => {
        if (!input.scheduleInterrupt) return;
        setImmediate(() => {
          try {
            void Promise.resolve(
              input.scheduleInterrupt!(agentId, caller.sessionId, commandId),
            ).catch((error) =>
              input.onDeliveryFailure?.({
                sourceSessionId: caller.sessionId,
                messageId: commandId,
                error,
              }),
            );
          } catch (error) {
            input.onDeliveryFailure?.({
              sourceSessionId: caller.sessionId,
              messageId: commandId,
              error,
            });
          }
        });
      };
      try {
        const receipt = input.storage.lookupInterruptReceipt({
          scopeSessionId: caller.sessionId,
          commandId,
          requestDigest,
        });
        if (receipt.status === 'digest_mismatch') return { ok: false, code: 'identity_conflict' };
        if (receipt.status === 'replay') {
          const intent = input.storage.readInterruptIntent(caller.sessionId, commandId);
          if (
            !intent ||
            intent.targetSessionId !== agentId ||
            intent.requestDigest !== requestDigest ||
            receipt.receipt.targetSessionId !== caller.sessionId
          )
            return { ok: false, code: 'identity_conflict' };
          if (intent.status === 'pending' || intent.status === 'accepted') schedule();
          return {
            ok: true,
            agent_id: agentId,
            status: intent.status,
            current_task_id: intent.targetTaskId,
            cancel_requested: intent.status !== 'idle',
            cleanup_confirmed: intent.status === 'settled',
          };
        }
        const target = input.storage.readInterruptTarget(caller.sessionId, agentId);
        if (!target || target.targetSessionId !== agentId)
          return { ok: false, code: 'agent_not_found' };
        if (target.status === 'idle')
          return {
            ok: true,
            agent_id: agentId,
            status: 'idle',
            cancel_requested: false,
            cleanup_confirmed: false,
          };
        if (
          (target.status === 'active' &&
            (!target.targetRunId ||
              !target.targetTaskId ||
              !target.targetOwnerGeneration ||
              target.targetRevision < 1)) ||
          (target.status === 'queued' &&
            (target.targetRunId !== null ||
              !target.targetTaskId ||
              target.targetOwnerGeneration !== null ||
              target.targetRevision !== 0 ||
              !target.queuedIntentEventId)) ||
          (target.status !== 'active' && target.status !== 'queued')
        )
          return { ok: false, code: 'target_unavailable' };
        const targetTaskId = target.targetTaskId;
        if (!targetTaskId || !validScope(scope, signal))
          return { ok: false, code: 'invalid_source' };
        const createdAtMs = Date.now();
        const event: Extract<RuntimeEvent, { type: 'background_execution.stop_requested' }> = {
          type: 'background_execution.stop_requested',
          commandId,
          executionId: targetTaskId,
          executionKind: 'subagent',
          ownerGeneration:
            target.status === 'queued'
              ? `accepted:${target.queuedIntentEventId}`
              : `child:${target.targetOwnerGeneration}`,
        };
        await input.storage.acceptInterruptCommand({
          event,
          receipt: {
            scopeSessionId: caller.sessionId,
            targetSessionId: caller.sessionId,
            commandId,
            requestDigest,
            committedAt: createdAtMs,
          },
          intent: {
            sourceSessionId: caller.sessionId,
            targetSessionId: agentId,
            commandId,
            requestDigest,
            sourceRunId: scope.runId,
            sourceTurnId: scope.turnId,
            sourceModelInvocationId: scope.modelInvocationId,
            sourceToolCallId: scope.toolCallId,
            sourceEffectAttemptId: scope.effectAttemptId,
            ...(child ? { sourceTaskId: child.taskId, sourceGrantDigest: child.grantDigest } : {}),
            targetRunId: target.targetRunId,
            targetTaskId,
            targetOwnerGeneration: target.targetOwnerGeneration,
            ...(target.status === 'queued'
              ? { queuedIntentEventId: target.queuedIntentEventId }
              : {}),
            targetRevision: target.targetRevision,
            createdAtMs,
          },
        });
        schedule();
        return {
          ok: true,
          agent_id: agentId,
          status: 'interrupt_requested',
          current_task_id: targetTaskId,
          cancel_requested: true,
          cleanup_confirmed: false,
        };
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'mailbox_rejected';
        return { ok: false, code };
      }
    },
  });
}

/** Binds every operation to the original root Tool call, active Turn, and persisted Run. */
export function createRootAgentMailboxPort(
  input: RootAgentMailboxPortInput,
): AgentMailboxPort | undefined {
  const caller = rootCaller(input);
  const metadata = input.storage.agentMailbox;
  const receipts = input.storage.commandReceipts;
  if (!caller || !metadata || !receipts || !input.toolCallId || input.signal.aborted)
    return undefined;

  const validScope = (scope: AgentMailboxInvocationScope, signal: AbortSignal): boolean => {
    const current = rootCaller(input);
    return (
      !input.signal.aborted &&
      !signal.aborted &&
      current !== undefined &&
      scope.sessionId === caller.sessionId &&
      scope.sourceAgentId === caller.sourceAgentId &&
      scope.runId === caller.runId &&
      scope.turnId === caller.turnId &&
      scope.modelInvocationId === caller.modelInvocationId &&
      scope.toolCallId === input.toolCallId &&
      typeof scope.effectAttemptId === 'string' &&
      scope.effectAttemptId.length > 0 &&
      scope.sourceTaskId === undefined &&
      scope.childGrantId === undefined &&
      current.runId === caller.runId &&
      current.turnId === caller.turnId &&
      current.modelInvocationId === caller.modelInvocationId
    );
  };

  const visibleAgents = () => metadata.listAgents(caller.sessionId, caller.sourceAgentId);
  return Object.freeze({
    caller,
    async listAgents({ scope, signal }: Parameters<AgentMailboxPort['listAgents']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      try {
        return {
          ok: true,
          agents: visibleAgents().map((agent) => ({
            agent_id: agent.agentId,
            status: agent.status,
            ...(agent.parentAgentId ? { parent_agent_id: agent.parentAgentId } : {}),
            ...(agent.currentTaskId ? { current_task_id: agent.currentTaskId } : {}),
            unread_count: agent.unreadCount,
          })),
        };
      } catch {
        return { ok: false, code: 'invalid_source' };
      }
    },
    async waitAgent({ scope, timeoutMs, signal }: Parameters<AgentMailboxPort['waitAgent']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
        return { ok: false, code: 'invalid_timeout' };
      try {
        const initial = visibleAgents().map(
          (agent) =>
            `${agent.agentId}:${agent.status}:${agent.currentTaskId ?? ''}:${agent.mailRevision}:${agent.unreadCount}`,
        );
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (signal.aborted || input.signal.aborted) return { ok: false, code: 'cancelled' };
          if (!validScope(scope, signal))
            return { ok: true, timed_out: false, reason: 'user_input' };
          const remaining = deadline - Date.now();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(remaining, 100));
            function done() {
              clearTimeout(timer);
              signal.removeEventListener('abort', done);
              input.signal.removeEventListener('abort', done);
              resolve();
            }
            signal.addEventListener('abort', done, { once: true });
            input.signal.addEventListener('abort', done, { once: true });
          });
          if (!validScope(scope, signal)) continue;
          const latest = visibleAgents().map(
            (agent) =>
              `${agent.agentId}:${agent.status}:${agent.currentTaskId ?? ''}:${agent.mailRevision}:${agent.unreadCount}`,
          );
          if (latest.length !== initial.length || latest.some((value, i) => value !== initial[i]))
            return { ok: true, timed_out: false, reason: 'mailbox_update' };
        }
        return { ok: true, timed_out: true, reason: 'timeout' };
      } catch {
        return { ok: false, code: 'invalid_source' };
      }
    },
    async submitMessage({
      scope,
      agentId,
      message,
      mode,
      signal,
    }: Parameters<AgentMailboxPort['submitMessage']>[0]) {
      if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
      if (mode !== 'queue_only' && mode !== 'trigger_turn')
        return { ok: false, code: 'invalid_input' };
      if (typeof agentId !== 'string' || agentId.length === 0 || typeof message !== 'string')
        return { ok: false, code: 'invalid_input' };
      const byteLength = Buffer.byteLength(message, 'utf8');
      if (byteLength < 1 || byteLength > MAX_MAIL_BYTES)
        return { ok: false, code: 'capacity_exceeded' };
      const source = {
        runId: scope.runId,
        turnId: scope.turnId,
        modelInvocationId: scope.modelInvocationId,
        toolCallId: scope.toolCallId,
        effectAttemptId: scope.effectAttemptId,
      };
      const messageId = `mail_${sha256(JSON.stringify([scope.sessionId, source]))}`;
      const bodyHex = sha256(message);
      const bodyDigest = `sha256:${bodyHex}`;
      const requestDigest = sha256(JSON.stringify([messageId, agentId, mode, bodyDigest]));
      const receiptLookup = receipts.lookup({
        scopeSessionId: caller.sessionId,
        commandId: messageId,
        requestDigest,
      });
      if (receiptLookup.status === 'digest_mismatch')
        return { ok: false, code: 'identity_conflict' };
      if (receiptLookup.status === 'replay')
        return receiptLookup.receipt.targetSessionId === caller.sessionId
          ? { ok: true }
          : { ok: false, code: 'identity_conflict' };
      try {
        const target = metadata.readAgent(caller.sessionId, caller.sourceAgentId, agentId);
        if (!target) return { ok: false, code: 'agent_not_found' };
        if (target.unreadCount >= MAX_PENDING_MAIL) return { ok: false, code: 'capacity_exceeded' };
        const sequence = metadata.nextSequence(caller.sessionId, caller.sourceAgentId);
        if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
        let followup:
          | {
              readonly submissionId: string;
              readonly reservation: Extract<RuntimeEvent, { type: 'resource_budget.reserved' }>;
              readonly admission: NonNullable<
                Extract<RuntimeAgentMailboxMutation, { kind: 'accept_mail' }>['followupAdmission']
              >;
            }
          | undefined;
        if (mode === 'trigger_turn') {
          const state = input.getState();
          const policy = input.authorizeFollowup?.({ state, scope, target }) ?? null;
          if (!validFollowupPolicy(state, scope.toolCallId, policy))
            return { ok: false, code: 'admission_unavailable' };
          if (target.agentId === caller.sourceAgentId) return { ok: false, code: 'invalid_target' };
          const budget = fundingBudgetForRun(state, scope.runId);
          if (
            !budget ||
            state.resourceBudget.status !== 'active' ||
            state.resourceBudget.runId !== scope.runId
          )
            return { ok: false, code: 'budget_unconfigured' };
          const nowMs = Date.now();
          const deadlineAt = Date.parse(budget.deadlineAt);
          const minimumWindow = Math.max(60_000, policy.firstAttemptTimeoutMs + 5_000);
          if (
            !Number.isSafeInteger(minimumWindow) ||
            !Number.isFinite(deadlineAt) ||
            deadlineAt - nowMs < minimumWindow
          )
            return { ok: false, code: 'expired' };
          if (Object.values(budget.reservations).some((item) => item.state === 'unknown'))
            return { ok: false, code: 'reconciliation_required' };
          const inputTokens = 2 * (policy.contextWindowTokens - policy.maxOutputTokens);
          if (!Number.isSafeInteger(inputTokens)) return { ok: false, code: 'budget_exhausted' };
          const upper = createZeroResourceUsage(
            'versioned_upper_bound',
            'trigger-followup-backup-v1',
          );
          upper.counters.turns = 1;
          upper.counters.modelRequests = 1;
          upper.counters.inputTokens = inputTokens;
          upper.counters.outputTokens = policy.maxOutputTokens;
          upper.gauges.activeSubagents = 1;
          const submissionId = `submission_${sha256(JSON.stringify([messageId, 'trigger_turn']))}`;
          const backupReservationId = `backup_${sha256(JSON.stringify([submissionId, scope.runId]))}`;
          const reservation: Extract<RuntimeEvent, { type: 'resource_budget.reserved' }> = {
            type: 'resource_budget.reserved',
            reservation: {
              version: 1,
              reservationId: backupReservationId,
              runId: scope.runId,
              invocationId: submissionId,
              resourceKind: 'subagent',
              executableUpperBound: upper,
              state: 'reserved',
            },
          };
          try {
            reduceResourceBudgetState(budget, reservation);
          } catch {
            return { ok: false, code: 'budget_exhausted' };
          }
          const canonical = canonicalJson({
            artifactFormatVersion: 1,
            fundingRunId: scope.runId,
            backupReservationId,
            deadlineAt,
            executableUpperBound: upper,
            source,
            senderAgentId: caller.sourceAgentId,
            targetAgentId: agentId,
            targetTaskId: target.currentTaskId,
            targetTurnOrdinal: target.turnOrdinal,
            submissionId,
            messageId,
            authorization: {
              phaseCeiling: policy.phaseCeiling,
              authorizationDigest: policy.authorizationDigest,
              admissionDigest: policy.admissionDigest,
              effectiveEffectsDigest: policy.effectiveEffectsDigest,
              capabilityDigest: policy.capabilityDigest,
              policyRevision: policy.policyRevision,
              workspaceDigest: policy.workspaceDigest,
              interactionMode: state.mode,
              interactionModeRevision: state.interactionModeRevision,
              workspaceAccess: state.workspaceAccess,
              boundedContext: policy.boundedContext,
              contextWindowTokens: policy.contextWindowTokens,
              maxOutputTokens: policy.maxOutputTokens,
              firstAttemptTimeoutMs: policy.firstAttemptTimeoutMs,
            },
          });
          const admissionHex = sha256(canonical);
          const digest = `sha256:${admissionHex}`;
          followup = {
            submissionId,
            reservation,
            admission: {
              ref: {
                artifactId: `pa_${admissionHex}`,
                kind: 'agent_followup_admission',
                integrityIdentifier: digest,
                byteLength: Buffer.byteLength(canonical, 'utf8'),
              },
              digest,
              canonicalJson: canonical,
              createdAt: nowMs,
            },
          };
        }
        if (!validScope(scope, signal)) return { ok: false, code: 'invalid_source' };
        const bodyRef = {
          artifactId: `pa_${bodyHex}`,
          kind: 'agent_mail' as const,
          integrityIdentifier: bodyDigest,
          byteLength,
        };
        const event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }> = {
          type: 'agent.mail_accepted',
          messageId,
          senderAgentId: caller.sourceAgentId,
          targetAgentId: agentId,
          mode,
          source,
          bodyRef,
          bodyDigest,
          sequence,
          ...(followup
            ? {
                submissionId: followup.submissionId,
                followupAdmissionRef: followup.admission.ref,
                followupAdmissionDigest: followup.admission.digest,
              }
            : {}),
        };
        const mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'accept_mail' }> = {
          kind: 'accept_mail',
          ...event,
          bodyText: message,
          requestDigest,
          acceptedAtMs: Date.now(),
          ...(followup ? { followupAdmission: followup.admission } : {}),
        };
        await input.commitAgentMailboxCommand({
          events: [...(followup ? [followup.reservation] : []), event],
          mutations: [mutation],
          evidence: {
            scopeSessionId: caller.sessionId,
            commandId: messageId,
            requestDigest,
            targetSessionId: caller.sessionId,
            committedAt: mutation.acceptedAtMs,
          },
        });
        return { ok: true };
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'mailbox_rejected';
        return { ok: false, code };
      }
    },
    async interruptAgent() {
      return { ok: false, code: 'admission_unavailable' };
    },
  });
}
