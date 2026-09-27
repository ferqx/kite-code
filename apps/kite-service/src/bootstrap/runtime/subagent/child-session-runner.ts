import { createHash } from 'node:crypto';
import { sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import {
  type KiteChildApprovalProxyRecord,
  parseFollowupChildApprovalParentToolCallId,
} from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeSessionCoordinator } from '../RuntimeSessionCoordinator';
import type { RuntimeActionProvider } from '../state-runner';
import type { RuntimeEvent } from '../state-runtime';
import {
  assertPrecommittedChildActivation,
  type PrecommittedChildActivationDescriptor,
} from '../turn-coordinator';
import type { ChildApprovalProxyOwner } from './child-approval-owner';
import { classifyChildFirstTurnRecovery } from './child-first-turn-recovery';

type ChildTurnInput = Omit<
  Parameters<RuntimeSessionCoordinator['executeTurn']>[0],
  | 'task'
  | 'userGoal'
  | 'precommittedStart'
  | 'precommittedChildActivation'
  | 'resumeCommittedInteraction'
  | 'childToolCeiling'
  | 'childSessionAcceptance'
  | 'initialSkillActivations'
>;

export class HiddenChildInteractionUnavailableError extends Error {
  readonly code = 'hidden_child_interaction_unavailable';

  constructor(effectType: string) {
    super(`Hidden child Session cannot request ${effectType} without a child interaction route.`);
    this.name = 'HiddenChildInteractionUnavailableError';
  }
}

export const hiddenChildActionProvider: RuntimeActionProvider = Object.freeze({
  requestAction: (effect: Parameters<RuntimeActionProvider['requestAction']>[0]) =>
    Promise.reject(new HiddenChildInteractionUnavailableError(effect.type)),
});

/** Only the accepted parent proxy can resolve a child tool approval. */
export function createChildApprovalActionProvider(input: {
  readonly owner: Pick<KiteSessionAppServerStorageOwner, 'listPendingChildApprovalProxies'>;
  readonly parentSessionId: string;
  readonly proxyOwner: Pick<ChildApprovalProxyOwner, 'waitForDecision'>;
  readonly onProxyOpened?: (proxy: KiteChildApprovalProxyRecord) => void;
  readonly signal?: AbortSignal;
}): RuntimeActionProvider {
  const provider: RuntimeActionProvider = {
    requestAction: async (effect, state, commandCommit) => {
      if (effect.type !== 'request_tool_approval')
        throw new HiddenChildInteractionUnavailableError(effect.type);
      const origin = state.childSessionOrigin;
      if (!origin || origin.parentSessionId !== input.parentSessionId)
        throw new Error('Child approval request has no active parent lineage.');
      const active = state.activeFollowupTurn;
      const followup =
        active && origin.terminal?.status === 'completed' && origin.terminal.cleanupConfirmed
          ? {
              submissionId: active.submissionId,
              targetRunId: active.targetRunId,
              grantDigest: active.grantDigest,
            }
          : null;
      if (origin.terminal && !followup)
        throw new Error('Child approval request has no active parent lineage.');
      const matches = [];
      let cursor: string | undefined;
      for (;;) {
        const page = input.owner.listPendingChildApprovalProxies(
          input.parentSessionId,
          100,
          cursor,
        );
        matches.push(
          ...page.filter(
            (row) =>
              row.childThreadId === state.session.threadId &&
              row.childInvocationId === origin.childInvocationId &&
              (followup
                ? row.grantDigest === followup.grantDigest &&
                  parseFollowupChildApprovalParentToolCallId(row.parentToolCallId)?.submissionId ===
                    followup.submissionId &&
                  parseFollowupChildApprovalParentToolCallId(row.parentToolCallId)?.targetRunId ===
                    followup.targetRunId &&
                  state.turn.turnId === followup.targetRunId &&
                  state.turn.status === 'active' &&
                  state.resourceBudget.status === 'active' &&
                  state.resourceBudget.runId === followup.targetRunId
                : row.grantDigest === origin.grantDigest &&
                  row.parentToolCallId === origin.parentToolCallId) &&
              row.childInteractionId === effect.interactionId &&
              row.childToolCallId === effect.toolCallId,
          ),
        );
        if (page.length < 100) break;
        cursor = page.at(-1)!.proxyInteractionId;
      }
      if (matches.length !== 1) throw new Error('Child approval has no exact parent proxy.');
      const proxy = matches[0]!;
      if (
        (proxy.status !== 'pending' && proxy.status !== 'decided') ||
        proxy.childRequestRevision > state.revision ||
        (proxy.status === 'decided' &&
          (!proxy.parentCommandId || !proxy.parentCommandDigest || proxy.decision === null))
      )
        throw new Error('Child approval proxy has stale request State.');
      if (proxy.status === 'pending') input.onProxyOpened?.(proxy);
      const decided = await input.proxyOwner.waitForDecision(
        proxy.proxyInteractionId,
        input.signal,
      );
      if (
        decided.status !== 'decided' ||
        decided.childThreadId !== proxy.childThreadId ||
        decided.childInteractionId !== proxy.childInteractionId ||
        decided.childGeneration !== proxy.childGeneration ||
        decided.childRequestRevision !== proxy.childRequestRevision ||
        decided.approvalDigest !== proxy.approvalDigest ||
        !decided.parentCommandId ||
        !decided.parentCommandDigest ||
        !decided.decision
      )
        throw new Error('Child approval parent decision lost its durable identity.');
      const action =
        decided.decision === 'approve_once'
          ? {
              type: 'approve' as const,
              interactionId: proxy.childInteractionId,
              generation: proxy.childGeneration,
              grant: 'approve_once' as const,
            }
          : {
              type: 'reject' as const,
              interactionId: proxy.childInteractionId,
              generation: proxy.childGeneration,
            };
      const requestDigest = createHash('sha256')
        .update(
          JSON.stringify([
            'kite.child-approval-apply.v1',
            proxy.proxyInteractionId,
            decided.parentCommandId,
            decided.parentCommandDigest,
            decided.decision,
          ]),
        )
        .digest('hex');
      return commandCommit.commit(
        action,
        {
          scopeSessionId: state.session.threadId,
          commandId: `apply-child-approval:${proxy.proxyInteractionId}`,
          requestDigest,
          targetSessionId: state.session.threadId,
          committedAt: Date.now(),
        },
        state.revision,
      ).descriptor;
    },
  };
  return Object.freeze(provider);
}

/**
 * Run the first delegated turn after an independently committed child Run and
 * parent dispatch ACK. No human input is accepted into the child transcript.
 */
export async function* runAcceptedChildSession(input: {
  readonly owner: Pick<KiteSessionAppServerStorageOwner, 'readChildSessionIntent'>;
  readonly child: Pick<
    RuntimeSessionCoordinator,
    'sessionId' | 'getState' | 'session' | 'executeTurn'
  >;
  readonly descriptor: PrecommittedChildActivationDescriptor;
  /** Already inspected against the sealed private grant during activation. */
  readonly grant: Readonly<SubagentDelegationGrant>;
  readonly turn: ChildTurnInput;
  /** Single consuming authority; called only after the persisted ACK is checked. */
  readonly consumeStartGrant: (
    grant: Readonly<SubagentDelegationGrant>,
  ) => Readonly<SubagentDelegationGrant>;
  /** Only for a fenced, previously activated and acknowledged first-turn recovery. */
  readonly activatedRecovery?: { readonly independentTurnDeadline: boolean };
  readonly actionProvider?: RuntimeActionProvider;
  readonly now?: () => number;
}): AsyncGenerator<RuntimeEvent> {
  const { child, descriptor, grant } = input;
  const intent = input.owner.readChildSessionIntent(child.sessionId);
  const sealed = sealChildGrantPayload(grant);
  const nowMs = input.now?.() ?? Date.now();
  if (
    !intent?.childSessionCreated ||
    intent.childThreadId !== child.sessionId ||
    intent.childBudgetActivatedRunId !== descriptor.childRunId ||
    !intent.dispatchAckEventId ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    intent.grantDigest !== sealed.sealedGrantDigest ||
    intent.sealedGrantDigest !== sealed.sealedGrantDigest ||
    intent.sealedGrantByteLength !== sealed.sealedGrantByteLength ||
    intent.parentSessionId !== descriptor.parentSessionId ||
    intent.parentInvocationId !== descriptor.parentInvocationId ||
    intent.originToolCallId !== descriptor.parentToolCallId ||
    intent.attempt !== descriptor.attempt ||
    intent.childInvocationId !== descriptor.childInvocationId ||
    intent.taskArtifactId !== descriptor.taskArtifactId ||
    intent.taskArtifactByteLength !== descriptor.taskArtifactByteLength ||
    intent.taskArtifactDigest !== descriptor.taskArtifactDigest ||
    intent.taskTextDigest !== descriptor.taskTextDigest ||
    intent.fundingRunId !== descriptor.fundingRunId ||
    intent.delegatedReservationId !== descriptor.delegatedReservationId ||
    intent.delegatedUpperBoundDigest !== descriptor.delegatedUpperBoundDigest ||
    grant.purpose !== 'start' ||
    grant.parentInvocationId !== descriptor.parentInvocationId ||
    grant.parentToolCallId !== descriptor.parentToolCallId ||
    grant.parentAttempt !== descriptor.attempt ||
    grant.childInvocationId !== descriptor.childInvocationId ||
    grant.taskArtifact.artifactId !== descriptor.taskArtifactId ||
    grant.taskArtifact.byteLength !== descriptor.taskArtifactByteLength ||
    grant.taskArtifact.integrityIdentifier !== descriptor.taskArtifactDigest ||
    grant.taskDigest !== descriptor.taskTextDigest ||
    grant.role !== intent.role ||
    (!input.activatedRecovery && grant.expiresAtMs <= nowMs)
  ) {
    throw new Error('Child Session cannot run without an exact durable dispatch ACK and grant.');
  }
  const state = child.getState();
  if (state.childSessionOrigin?.role !== intent.role || input.turn.threadId !== child.sessionId) {
    throw new Error('Child Session runner identity or role conflicts with the accepted intent.');
  }
  if (input.activatedRecovery) {
    const recovery = classifyChildFirstTurnRecovery({
      childState: state,
      intent,
      grant,
      nowMs,
      independentTurnDeadline: input.activatedRecovery.independentTurnDeadline,
    });
    if (recovery.kind !== 'begin_first_turn')
      throw new Error(`Activated child first-turn recovery is unsafe: ${recovery.kind}.`);
  }
  assertPrecommittedChildActivation(
    state,
    descriptor,
    child.sessionId,
    child.session.getLifecycleProjection().currentRun?.runId,
  );
  // Activation commits the child Run as queued. Start it only after the
  // parent dispatch ACK is durable, before any Provider-capable model effect.
  child.session.activateRun(descriptor.childRunId);
  if (!input.activatedRecovery) {
    const consumed = input.consumeStartGrant(grant);
    if (sealChildGrantPayload(consumed).sealedGrantDigest !== sealed.sealedGrantDigest) {
      throw new Error('Child Session consuming authority changed the sealed grant.');
    }
  }
  yield* child.executeTurn(
    {
      ...input.turn,
      task: '',
      initialSkillActivations: [],
      precommittedChildActivation: descriptor,
      childToolCeiling: {
        grantDigest: intent.grantDigest,
        role: intent.role,
        allowedTools: [...grant.capabilityCeiling.allowedTools],
      },
      crossSessionChildIdentity: {
        parentSessionId: descriptor.parentSessionId,
        taskId: grant.childInvocationId,
        grantId: grant.grantId,
        grantDigest: intent.grantDigest,
      },
    },
    input.actionProvider ?? hiddenChildActionProvider,
  );
}
