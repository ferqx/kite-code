import type {
  AcceptedInformation,
  AuthorizationRequest,
  PermissionDecision,
  Permissions,
} from '../extensions';
import { semanticDigest } from '../json';
import type { ReadAuthorizationReviewInput, Store } from '../storage/port';
import {
  AgentError,
  type InformationPermissionStamp,
  type InteractionRecord,
  type Json,
  type OwnerRef,
  type RequirementEvaluation,
  type RequirementRef,
} from '../storage/types';

export interface InteractionScope {
  final?: boolean;
  previousReview?: ReadAuthorizationReviewInput;
  review?: (decision: PermissionDecision) => Promise<ReadAuthorizationReviewInput | null>;
  expectedStoreId: string;
  owner: OwnerRef;
  executionId: string;
  signal: AbortSignal;
  requiredRefs: readonly RequirementRef[];
  requirements(): Promise<RequirementEvaluation[]>;
  checkFreshness?: () => Promise<void>;
  checkpoint?: () => Promise<void>;
  sealApprovalRequest?: (request: Json) => Promise<Json>;
  verifyApprovalRequest?: (saved: Json, actual: Json) => Promise<void>;
}
export type AcceptedAuthorization = PermissionDecision & {
  grant?: { grantId: string; revision: string; commandDigest?: string };
  reviewExecutionId?: string;
  interactionId?: string;
  decisionRevision?: string;
};

/** A waiting human owns no execution resource. Only the live owner can accept the saved answer. */
export class InteractionGate {
  private readonly store: Store;
  private readonly permissions: Permissions;
  constructor(store: Store, permissions: Permissions) {
    this.store = store;
    this.permissions = permissions;
  }

  private async pause(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 50);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private async wait(scope: InteractionScope, interaction: InteractionRecord, checkpoint = false) {
    while (interaction.state === 'pending') {
      await this.pause(scope.signal);
      if (checkpoint) await scope.checkpoint?.();
      const current = await this.store.getInteraction({
        expectedStoreId: scope.expectedStoreId,
        sessionId: interaction.sessionId,
        interactionId: interaction.id,
      });
      if (!current) throw new AgentError('interaction_not_found');
      interaction = current;
    }
    scope.signal.throwIfAborted();
    if (interaction.state === 'cancelled') throw new AgentError('cancelled_before_dispatch');
    return interaction;
  }

  private async accept(
    scope: InteractionScope,
    interaction: InteractionRecord,
    information = false,
    informationPermission?: InformationPermissionStamp,
  ) {
    const requirements = information ? [] : await scope.requirements();
    await scope.checkFreshness?.();
    scope.signal.throwIfAborted();
    return this.store.acceptInteractionDecision({
      expectedStoreId: scope.expectedStoreId,
      owner: scope.owner,
      ...(informationPermission ? { informationPermission } : {}),
      interactionId: interaction.id,
      executionId: scope.executionId,
      attempt: interaction.attempt,
      decisionRevision: interaction.revision,
      definitionId: interaction.definitionId,
      definitionVersion: interaction.definitionVersion,
      inputDigest: interaction.inputDigest,
      policyRevision: interaction.policyRevision,
      requirements,
      freshness: { checked: true, source: interaction.source },
    });
  }

  async authorize(scope: InteractionScope, request: AuthorizationRequest, source: Json) {
    scope.signal.throwIfAborted();
    await scope.checkpoint?.();
    await scope.checkFreshness?.();
    let decision = await this.permissions.authorize(request);
    scope.signal.throwIfAborted();
    const execution = await this.store.getExecution(scope.executionId);
    if (!execution) throw new AgentError('execution_not_found');
    let reference = scope.previousReview;
    let reviewedGrant: string | undefined;
    if (
      reference &&
      (reference.policyRevision !== decision.revision ||
        !decision.review ||
        (reference.requireApproval === true) !== (decision.review.requireApproval === true) ||
        (reference.requestBody?.reference.hash ?? (await semanticDigest(reference.request))) !==
          (await semanticDigest(decision.review.request)))
    )
      throw new AgentError('authorization_review_binding_changed');
    if (!execution.interactionBinding && decision.allowed) return decision;
    if (!execution.interactionBinding && decision.approval?.grants?.includes('same_command')) {
      const grant = await this.store.getPermissionGrant({
        expectedStoreId: scope.expectedStoreId,
        executionId: scope.executionId,
        ...(decision.approval!.commandDigest === undefined
          ? {}
          : { commandDigest: decision.approval!.commandDigest }),
      });
      if (grant) return { ...decision, allowed: true, grant } satisfies AcceptedAuthorization;
    }
    if (request.kind === 'model') throw new AgentError('permission_denied', decision.reason);
    if (decision.review && (!execution.interactionBinding || decision.review.requireApproval)) {
      if (!reference && scope.review && !scope.final)
        reference = (await scope.review(decision)) ?? undefined;
      // Review/human waits are confined to the resource-free authorization phase.
      if (!reference && scope.final) throw new AgentError('authorization_refresh_required');
      if (reference) {
        decision = await this.permissions.authorize(request);
        scope.signal.throwIfAborted();
        await scope.checkFreshness?.();
        if (
          !decision.review ||
          (reference.requireApproval === true) !== (decision.review.requireApproval === true) ||
          decision.revision !== reference.policyRevision ||
          (await semanticDigest(decision.review.request)) !==
            (reference.requestBody?.reference.hash ?? (await semanticDigest(reference.request)))
        )
          throw new AgentError('authorization_review_binding_changed');
        const reviewed = await this.store.getAuthorizationReview(reference);
        if (reviewed.decision === 'approve_once' && !decision.review.requireApproval)
          return {
            allowed: true,
            revision: decision.revision,
            reviewExecutionId: reviewed.reviewExecutionId,
            ...(decision.controlReads === undefined ? {} : { controlReads: decision.controlReads }),
            ...(decision.snapshot === undefined ? {} : { snapshot: decision.snapshot }),
          } satisfies AcceptedAuthorization;
        if (reviewed.decision === 'approve_once') reviewedGrant = reviewed.reviewExecutionId;
        if (reviewed.decision === 'reject') {
          const command = await this.store.getCommand(execution.originCommandId);
          if (!command) throw new AgentError('command_not_found');
          await this.store.cancelCommand({
            expectedStoreId: scope.expectedStoreId,
            commandId: `review-decline-${reviewed.reviewExecutionId}`,
            sessionId: command.sessionId,
            targetCommandId: command.id,
            subjectId: command.subjectId,
          });
          throw new AgentError('approval_denied');
        }
        if (scope.final && !reviewedGrant && !execution.interactionBinding)
          throw new AgentError('authorization_refresh_required');
      }
      decision = {
        ...decision,
        approval: decision.approval ?? {
          request: {
            reason: reviewedGrant
              ? 'authorization_review_requires_user_approval'
              : 'authorization_review_unavailable',
            review: reference?.requestBody
              ? {
                  kind: 'artifact',
                  complete: true,
                  reference: {
                    id: reference.requestBody.reference.id,
                    mediaType: reference.requestBody.reference.mediaType,
                    size: reference.requestBody.reference.size,
                    scope: reference.requestBody.reference.scope,
                  },
                }
              : decision.review!.request,
          },
        },
      };
    }
    if (
      !decision.allowed &&
      !decision.approval &&
      !(decision.review && execution.interactionBinding)
    )
      throw new AgentError('permission_denied', decision.reason);
    if (scope.final && !execution.interactionBinding)
      throw new AgentError('authorization_refresh_required');
    const inputDigest = await semanticDigest(request.input);
    const approvalRequest = (): Json => ({
      policy: decision.approval!.request,
      grants: [...(decision.approval!.grants ?? ['approve_once'])],
      ...(decision.approval!.commandDigest === undefined
        ? {}
        : { commandDigest: decision.approval!.commandDigest }),
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      input: request.input,
    });
    let interaction = execution.interactionBinding
      ? await this.store.getInteraction({
          expectedStoreId: scope.expectedStoreId,
          sessionId: execution.sessionId,
          interactionId: execution.interactionBinding.interactionId,
        })
      : await this.store.requestInteraction({
          expectedStoreId: scope.expectedStoreId,
          owner: scope.owner,
          interactionId: `approval-${await semanticDigest({ executionId: execution.id, attempt: execution.attempt })}`,
          executionId: execution.id,
          attempt: execution.attempt,
          kind: 'approval',
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
          inputDigest,
          policyRevision: decision.revision,
          requiredRefs: [...scope.requiredRefs],
          source,
          request: scope.sealApprovalRequest
            ? await scope.sealApprovalRequest(approvalRequest())
            : approvalRequest(),
        });
    if (!interaction) throw new AgentError('interaction_not_found');
    if (scope.final && (interaction.state !== 'answered' || !interaction.acceptedDecisionRevision))
      throw new AgentError('authorization_refresh_required');
    const waited = interaction.state === 'pending';
    interaction = await this.wait(scope, interaction, true);
    if (interaction.answer?.kind === 'approval' && interaction.answer.decision === 'deny') {
      const command = await this.store.getCommand(execution.originCommandId);
      if (!command || command.originStoreId !== scope.expectedStoreId)
        throw new AgentError('operation_unverifiable');
      // A refusal ends the original work, even if its source became stale while waiting.
      // Cancellation never grants dispatch and is tied to the saved command, not a later Run.
      await this.store.cancelCommand({
        expectedStoreId: scope.expectedStoreId,
        commandId: `decline-${interaction.id}`,
        sessionId: command.sessionId,
        targetCommandId: command.id,
        subjectId: command.subjectId,
      });
      throw new AgentError('approval_denied');
    }
    if (waited) decision = await this.permissions.authorize(request);
    scope.signal.throwIfAborted();
    if (!decision.allowed && !decision.approval && !decision.review)
      throw new AgentError('permission_denied', decision.reason);
    if (
      decision.revision !== interaction.policyRevision ||
      interaction.definitionId !== request.definitionId ||
      interaction.definitionVersion !== request.definitionVersion ||
      interaction.inputDigest !== inputDigest
    )
      throw new AgentError('interaction_binding_changed');
    if (
      interaction.answer?.kind === 'approval' &&
      interaction.answer.grant === 'same_command' &&
      (!decision.approval?.grants?.includes('same_command') ||
        (interaction.request as { commandDigest?: string }).commandDigest !==
          decision.approval.commandDigest)
    )
      throw new AgentError('interaction_binding_changed');
    await scope.verifyApprovalRequest?.(
      interaction.request,
      decision.approval
        ? approvalRequest()
        : {
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
            input: request.input,
          },
    );
    const accepted = await this.accept(scope, interaction);
    if (accepted.answer?.kind !== 'approval' || accepted.answer.decision !== 'approve')
      throw new AgentError('permission_denied');
    const grant =
      accepted.answer.grant === 'same_command'
        ? await this.store.getPermissionGrant({
            expectedStoreId: scope.expectedStoreId,
            executionId: scope.executionId,
            ...(decision.approval?.commandDigest === undefined
              ? {}
              : { commandDigest: decision.approval.commandDigest }),
          })
        : null;
    if (
      accepted.answer.grant === 'same_command' &&
      (!decision.approval?.grants?.includes('same_command') || !grant)
    )
      throw new AgentError('permission_grant_changed');
    return {
      ...(grant ? { grant } : {}),
      allowed: true,
      revision: decision.revision,
      interactionId: accepted.id,
      decisionRevision: accepted.acceptedDecisionRevision!,
      ...(decision.controlReads === undefined ? {} : { controlReads: decision.controlReads }),
      ...(decision.snapshot === undefined ? {} : { snapshot: decision.snapshot }),
      ...(reviewedGrant ? { reviewExecutionId: reviewedGrant } : {}),
    } satisfies AcceptedAuthorization;
  }

  requester(
    scope: InteractionScope,
  ): (input: { kind: 'question' | 'plan_review'; request: Json }) => Promise<Json> {
    const request = this.informationRequester(scope);
    return async (input) => {
      const { answer } = await request(input);
      return answer.kind === 'question' ? answer.answers : (answer as unknown as Json);
    };
  }

  informationRequester(
    scope: InteractionScope,
  ): (input: { kind: 'question' | 'plan_review'; request: Json }) => Promise<AcceptedInformation> {
    let ordinal = 0;
    return async ({ kind, request }) => {
      scope.signal.throwIfAborted();
      if (!['question', 'plan_review'].includes(kind))
        throw new AgentError('interaction_kind_invalid');
      if (++ordinal > 64) throw new AgentError('interaction_limit');
      const execution = await this.store.getExecution(scope.executionId);
      if (!execution) throw new AgentError('execution_not_found');
      const observePermission = async (): Promise<InformationPermissionStamp> => {
        scope.signal.throwIfAborted();
        const decision = await this.permissions.authorize({
          kind: execution.kind,
          sessionId: execution.sessionId,
          runId: execution.runId,
          executionId: execution.id,
          definitionId: execution.definitionId!,
          definitionVersion: execution.definitionVersion!,
          input: execution.input,
          signal: scope.signal,
        });
        scope.signal.throwIfAborted();
        if (!decision.allowed && !decision.approval && !decision.review)
          throw new AgentError('information_permission_denied');
        return {
          revision: decision.revision,
          bindingDigest: await semanticDigest({
            allowed: decision.allowed,
            approval: decision.approval ?? null,
            review: decision.review ?? null,
          } as Json),
          ...(decision.controlReads !== undefined
            ? { controlReads: structuredClone(decision.controlReads) }
            : {}),
        };
      };
      const informationPermission = await observePermission();
      const requiredRefs = execution.runId
        ? (await this.store.getRun(execution.runId))?.requirements
        : execution.requirements;
      if (!requiredRefs) throw new AgentError('run_not_found');
      const interaction = await this.store.requestInteraction({
        expectedStoreId: scope.expectedStoreId,
        owner: scope.owner,
        interactionId: `information-${await semanticDigest({ executionId: execution.id, attempt: execution.attempt, ordinal })}`,
        executionId: execution.id,
        attempt: execution.attempt,
        kind,
        informationPermission,
        definitionId: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        inputDigest: await semanticDigest(execution.input),
        policyRevision: 'information-1',
        requiredRefs: [...requiredRefs],
        source: execution.decisionSource,
        request,
      });
      const answered = await this.wait(scope, interaction);
      const currentPermission = await observePermission();
      if (
        (await semanticDigest(currentPermission as unknown as Json)) !==
        (await semanticDigest(informationPermission as unknown as Json))
      )
        throw new AgentError('information_permission_changed');
      const accepted = await this.accept(scope, answered, true, currentPermission);
      if (accepted.answer?.kind !== kind) throw new AgentError('interaction_answer_invalid');
      if (!accepted.acceptedDecisionRevision) throw new AgentError('interaction_answer_invalid');
      return structuredClone({
        interactionId: accepted.id,
        originStoreId: accepted.originStoreId,
        sessionId: accepted.sessionId,
        runId: accepted.runId,
        executionId: accepted.executionId,
        attempt: accepted.attempt,
        decisionRevision: accepted.acceptedDecisionRevision,
        request: accepted.request,
        answer: accepted.answer,
      });
    };
  }
}
