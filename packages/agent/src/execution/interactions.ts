import {
  consumesExecutionConfirmation,
  type ExecutionConfirmationProof,
  type PreparedExecutionConfirmation,
  sameExecutionConfirmation,
} from '../execution-confirmation';
import type {
  AcceptedInformation,
  AuthorizationRequest,
  PermissionDecision,
  Permissions,
} from '../extensions';
import { semanticDigest } from '../json';
import {
  approvalOptions,
  type GrantUse,
  parseGrantOffer,
  sameCapability,
  selectedApprovalOption,
} from '../permission-grants';
import type {
  AutoAuthorizationEvidence,
  ReadAuthorizationCheckInput,
  Store,
} from '../storage/port';
import {
  AgentError,
  type ExecutionRecord,
  type InformationPermissionStamp,
  type InteractionRecord,
  type Json,
  type OwnerRef,
  type RequirementEvaluation,
  type RequirementRef,
} from '../storage/types';
import { AuthorizationCheckUnavailableError } from './authorization-check-feedback';
import {
  type AuthorizationChangeWait,
  AuthorizationRefreshRequired,
  modeControlsChanged,
} from './authorization-refresh';

/** Public authorization reasons are distinct from private adapter errors. */
export class AuthorizationDeniedError extends AgentError {
  readonly reason: string;
  constructor(code: 'permission_denied' | 'approval_denied', reason: string) {
    super(code, reason);
    this.reason = reason;
  }
}

/** A checker refusal is a denied tool decision, never a human request to stop work. */
export class AuthorizationCheckRejectedError extends AuthorizationDeniedError {
  constructor(reason: string) {
    super('permission_denied', reason);
  }
}

const publicDenials = new WeakSet<AuthorizationDeniedError>();
/** Only an actual gate decision may publish a reason; adapter-thrown lookalikes are private. */
export function isPublicAuthorizationDeniedError(
  error: unknown,
): error is AuthorizationDeniedError {
  return error instanceof AuthorizationDeniedError && publicDenials.has(error);
}
function publicDenial(reason: string, automatic = false) {
  const error = automatic
    ? new AuthorizationCheckRejectedError(reason)
    : new AuthorizationDeniedError('permission_denied', reason);
  publicDenials.add(error);
  return error;
}

/** Exact saved cancellation of an information-only Question, never an effect result. */
export class QuestionCancelledError extends AgentError {
  readonly interaction: Readonly<InteractionRecord>;
  constructor(interaction: Readonly<InteractionRecord>) {
    super('execution_cancel_requested');
    this.interaction = interaction;
  }
}

export interface InteractionScope {
  final?: boolean;
  resourcesHeldByAncestor?: boolean;
  executionConfirmation?: PreparedExecutionConfirmation | null;
  prepareExecutionConfirmation?: (
    execution: ExecutionRecord,
  ) => Promise<PreparedExecutionConfirmation | null>;
  authorizeParent?: (
    request: AuthorizationRequest,
    decision: PermissionDecision,
  ) => Promise<AutoAuthorizationEvidence | null>;
  previousCheck?: ReadAuthorizationCheckInput;
  previousPolicy?: PermissionDecision;
  check?: (
    decision: PermissionDecision,
    signal: AbortSignal,
  ) => Promise<ReadAuthorizationCheckInput | AutoAuthorizationEvidence | null>;
  expectedStoreId: string;
  owner: OwnerRef;
  executionId: string;
  signal: AbortSignal;
  requiredRefs: readonly RequirementRef[];
  /** Set only by the executing host from the actual Tool/Action resource declaration. */
  informationResourcesHeld?: boolean;
  requirements(): Promise<RequirementEvaluation[]>;
  checkFreshness?: () => Promise<void>;
  checkpoint?: () => Promise<void>;
  sealApprovalRequest?: (request: Json) => Promise<Json>;
  verifyApprovalRequest?: (saved: Json, actual: Json) => Promise<void>;
}
export type AcceptedAuthorization = PermissionDecision & {
  executionConfirmation?: ExecutionConfirmationProof;
  materialReviewed?: true;
  grant?: GrantUse;
  checkExecutionId?: string;
  policyEvidenceId?: string;
  interactionId?: string;
  decisionRevision?: string;
};

/** A waiting human owns no execution resource. Only the live owner can accept the saved answer. */
export class InteractionGate {
  private readonly store: Store;
  private readonly permissions: Permissions;
  private readonly waitForChange?: AuthorizationChangeWait;
  constructor(store: Store, permissions: Permissions, waitForChange?: AuthorizationChangeWait) {
    this.store = store;
    this.permissions = permissions;
    this.waitForChange = waitForChange;
  }

  private async changes(cursor: string, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const page = await this.store.getChanges({ after: cursor, limit: 200 });
      if (page.events.length) return { ...page, rescan: false };
      if (this.waitForChange) await this.waitForChange(cursor, signal, 30_000);
      else await this.pause(signal);
      return { ...(await this.store.getChanges({ after: cursor, limit: 200 })), rescan: false };
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'cursor_expired') throw error;
      // A compacted notification range means re-read authority, never replay work.
      return { metadata: await this.store.getMetadata(), events: [], rescan: true };
    }
  }

  /** Durable changes trigger fresh reads; a wake never supplies authorization. */
  async policyChanged(
    scope: InteractionScope,
    request: AuthorizationRequest,
    decision: PermissionDecision,
    cursor: string,
  ): Promise<never> {
    for (;;) {
      const page = await this.changes(cursor, scope.signal);
      if (!page.events.length && !page.rescan) continue;
      cursor = page.events.at(-1)?.cursor ?? page.metadata.lastChangeCursor;
      if (
        !page.rescan &&
        !page.events.some((event) =>
          ['host_control.changed', 'command.accepted'].includes(event.type),
        )
      )
        continue;
      // Input wakes only reach the existing owner checkpoint. Foreground batches
      // defer steer there; stale completion decisions leave their resource wait.
      await scope.checkpoint?.();
      await scope.checkFreshness?.();
      const current = await this.permissions.authorize(request);
      if (current.revision !== decision.revision) {
        if (modeControlsChanged(decision.controlReads, current.controlReads))
          throw new AuthorizationRefreshRequired();
        throw new AgentError('permission_control_changed');
      }
    }
  }

  private async refresh(
    scope: InteractionScope,
    interaction: InteractionRecord,
    decision: PermissionDecision,
  ) {
    const original = interaction.request as {
      approvalControlReads?: PermissionDecision['controlReads'];
    };
    if (!modeControlsChanged(original.approvalControlReads, decision.controlReads))
      throw new AgentError('interaction_binding_changed');
    await this.store.invalidateAuthorizationCheck({
      expectedStoreId: scope.expectedStoreId,
      owner: scope.owner,
      executionId: scope.executionId,
      previousPolicyRevision: interaction.policyRevision,
      policyRevision: decision.revision,
      controlReads: decision.controlReads,
    });
    await this.store.refreshApproval({
      expectedStoreId: scope.expectedStoreId,
      owner: scope.owner,
      executionId: scope.executionId,
      interactionId: interaction.id,
      policyRevision: decision.revision,
      controlReads: decision.controlReads,
    });
    throw new AuthorizationRefreshRequired();
  }

  private async invalidateCheck(
    scope: InteractionScope,
    previous: PermissionDecision | undefined,
    current: PermissionDecision,
    checkExecutionId?: string,
  ): Promise<never> {
    if (!previous || !modeControlsChanged(previous.controlReads, current.controlReads))
      throw new AgentError('authorization_check_binding_changed');
    await this.store.invalidateAuthorizationCheck({
      expectedStoreId: scope.expectedStoreId,
      owner: scope.owner,
      executionId: scope.executionId,
      checkExecutionId,
      previousPolicyRevision: previous.revision,
      policyRevision: current.revision,
      controlReads: current.controlReads,
    });
    throw new AuthorizationRefreshRequired();
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
      const cursor = (await this.store.getMetadata()).lastChangeCursor;
      if (checkpoint) await scope.checkpoint?.();
      const current = await this.store.getInteraction({
        expectedStoreId: scope.expectedStoreId,
        sessionId: interaction.sessionId,
        interactionId: interaction.id,
      });
      if (!current) throw new AgentError('interaction_not_found');
      interaction = current;
      if (interaction.state === 'pending') await this.changes(cursor, scope.signal);
    }
    scope.signal.throwIfAborted();
    if (interaction.state === 'cancelled') {
      if (
        interaction.kind === 'question' &&
        interaction.originStoreId === scope.expectedStoreId &&
        interaction.executionId === scope.executionId
      )
        throw new QuestionCancelledError(interaction);
      throw new AgentError('cancelled_before_dispatch');
    }
    return interaction;
  }

  private async accept(
    scope: InteractionScope,
    interaction: InteractionRecord,
    information = false,
    informationPermission?: InformationPermissionStamp,
    currentInformationPermission?: InformationPermissionStamp,
  ) {
    const requirements = information ? [] : await scope.requirements();
    await scope.checkFreshness?.();
    scope.signal.throwIfAborted();
    return this.store.acceptInteractionDecision({
      expectedStoreId: scope.expectedStoreId,
      owner: scope.owner,
      ...(informationPermission ? { informationPermission } : {}),
      ...(currentInformationPermission ? { currentInformationPermission } : {}),
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

  async authorize(
    scope: InteractionScope,
    request: AuthorizationRequest,
    source: Json,
  ): Promise<AcceptedAuthorization> {
    for (;;) {
      try {
        return await this.authorizeOnce(scope, request, source);
      } catch (error) {
        if (!(error instanceof AuthorizationRefreshRequired) || scope.final) throw error;
        scope = { ...scope, previousCheck: undefined, previousPolicy: undefined };
      }
    }
  }

  private async confirmExecution(
    scope: InteractionScope,
    request: AuthorizationRequest,
    source: Json,
    initial: PermissionDecision,
  ): Promise<AcceptedAuthorization> {
    const prepared = scope.executionConfirmation!;
    const proof = 'proof' in prepared ? prepared.proof : undefined;
    const binding = proof?.binding ?? ('binding' in prepared ? prepared.binding : undefined)!;
    const checkPolicy = async (decision: PermissionDecision): Promise<void> => {
      if (!decision.allowed && !decision.approval && !decision.check)
        throw publicDenial(decision.reason ?? 'permission_denied');
      if (
        !(await consumesExecutionConfirmation(this.permissions, request, decision, binding.owner))
      )
        throw new AgentError('execution_confirmation_policy_unsupported');
    };
    await checkPolicy(initial);
    if (proof?.stepKey !== undefined)
      return { ...initial, allowed: true, executionConfirmation: proof };
    if (scope.resourcesHeldByAncestor)
      throw new AgentError('execution_confirmation_resources_held');
    if (!proof && !('declaration' in prepared))
      throw new AgentError('execution_confirmation_invalid');
    const execution = await this.store.getExecution(request.executionId);
    if (
      !execution ||
      execution.id !== binding.executionId ||
      execution.attempt !== binding.attempt ||
      request.kind !== binding.owner.capability.kind ||
      request.definitionId !== binding.owner.capability.definitionId ||
      request.definitionVersion !== binding.owner.capability.definitionVersion ||
      (await semanticDigest(request.input)) !== binding.inputDigest
    )
      throw new AgentError('execution_confirmation_changed');
    const revision = `execution-confirmation/${await semanticDigest(binding as unknown as Json)}`;
    let interaction = execution.interactionBinding
      ? await this.store.getInteraction({
          expectedStoreId: scope.expectedStoreId,
          sessionId: execution.sessionId,
          interactionId: execution.interactionBinding.interactionId,
        })
      : null;
    if (
      proof &&
      (!interaction ||
        interaction.id !== proof.interactionId ||
        interaction.state !== 'answered' ||
        interaction.acceptedDecisionRevision !== proof.decisionRevision ||
        interaction.revision !== proof.decisionRevision ||
        execution.interactionBinding?.decisionRevision !== proof.decisionRevision)
    )
      throw new AgentError('execution_confirmation_changed');
    if (!interaction) {
      if (!('declaration' in prepared)) throw new AgentError('execution_confirmation_changed');
      if (scope.final) throw new AgentError('authorization_refresh_required');
      const body: Json = {
        policy: {
          reason: 'owner_execution_confirmation',
          confirmation: prepared.declaration.request,
          originalPermission: initial.snapshot ?? null,
          originalPolicyRevision: initial.revision,
          originalApproval: initial.approval?.request ?? null,
          originalCheck: initial.check?.request ?? null,
        },
        options: approvalOptions() as unknown as Json,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        input: request.input,
        executionConfirmation: binding as unknown as Json,
      };
      interaction = await this.store.requestInteraction({
        expectedStoreId: scope.expectedStoreId,
        owner: scope.owner,
        interactionId: `confirmation-${await semanticDigest({ executionId: execution.id, attempt: execution.attempt })}`,
        executionId: execution.id,
        attempt: execution.attempt,
        kind: 'approval',
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        inputDigest: binding.inputDigest,
        policyRevision: revision,
        requiredRefs: [...scope.requiredRefs],
        source,
        request: scope.sealApprovalRequest ? await scope.sealApprovalRequest(body) : body,
      });
    }
    const saved = interaction.request as {
      executionConfirmation?: Json;
      policy?: Json;
      approvalRequestDigest?: Json;
    };
    if (
      interaction.kind !== 'approval' ||
      interaction.definitionId !== request.definitionId ||
      interaction.definitionVersion !== request.definitionVersion ||
      interaction.executionId !== request.executionId ||
      interaction.attempt !== binding.attempt ||
      interaction.policyRevision !== revision ||
      !sameExecutionConfirmation(saved.executionConfirmation, binding) ||
      interaction.inputDigest !== binding.inputDigest
    )
      throw new AgentError('execution_confirmation_changed');
    if (!Object.hasOwn(saved, 'approvalRequestDigest')) {
      const policy = saved.policy;
      if (
        !policy ||
        typeof policy !== 'object' ||
        Array.isArray(policy) ||
        !Object.hasOwn(policy, 'confirmation') ||
        (await semanticDigest(policy.confirmation!)) !== binding.requestDigest
      )
        throw new AgentError('execution_confirmation_changed');
    } else if (!scope.verifyApprovalRequest) throw new AgentError('artifact_content_unavailable');
    await scope.verifyApprovalRequest?.(interaction.request, {
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      input: request.input,
      executionConfirmation: binding as unknown as Json,
    });
    interaction = await this.wait(
      {
        ...scope,
        checkpoint: async () => {
          await scope.checkpoint?.();
          await scope.checkFreshness?.();
          const current = await this.permissions.authorize(request);
          await checkPolicy(current);
        },
      },
      interaction,
      true,
    );
    if (interaction.answer?.kind !== 'approval' || interaction.answer.decision !== 'approve')
      throw new AgentError('approval_denied');
    if (interaction.answer.optionId !== 'once') throw new AgentError('interaction_answer_invalid');
    const current = await this.permissions.authorize(request);
    await checkPolicy(current);
    const accepted = await this.accept(scope, interaction);
    return {
      ...current,
      allowed: true,
      interactionId: accepted.id,
      decisionRevision: accepted.acceptedDecisionRevision!,
      executionConfirmation: {
        binding,
        interactionId: accepted.id,
        decisionRevision: accepted.acceptedDecisionRevision!,
      },
    };
  }

  private async authorizeOnce(
    scope: InteractionScope,
    request: AuthorizationRequest,
    source: Json,
  ): Promise<AcceptedAuthorization> {
    scope.signal.throwIfAborted();
    await scope.checkpoint?.();
    await scope.checkFreshness?.();
    const cursor = (await this.store.getMetadata()).lastChangeCursor;
    let decision = await this.permissions.authorize(request);
    scope.signal.throwIfAborted();
    const execution = await this.store.getExecution(scope.executionId);
    if (!execution) throw new AgentError('execution_not_found');
    const confirmation =
      scope.executionConfirmation ??
      (decision.allowed || decision.approval || decision.check
        ? await scope.prepareExecutionConfirmation?.(execution)
        : null);
    scope.signal.throwIfAborted();
    if (confirmation)
      return this.confirmExecution(
        { ...scope, executionConfirmation: confirmation },
        request,
        source,
        decision,
      );
    if (execution.interactionBinding) {
      const original = await this.store.getInteraction({
        expectedStoreId: scope.expectedStoreId,
        sessionId: execution.sessionId,
        interactionId: execution.interactionBinding.interactionId,
      });
      if (!original) throw new AgentError('interaction_not_found');
      if (original.policyRevision !== decision.revision)
        await this.refresh(scope, original, decision);
    }
    const previous = scope.previousPolicy as AcceptedAuthorization | undefined;
    let reusableGrant: GrantUse | null = null;
    if (
      (!execution.interactionBinding || previous?.grant) &&
      !decision.allowed &&
      decision.grantOffers?.length
    ) {
      reusableGrant = await this.store.getPermissionGrant({
        expectedStoreId: scope.expectedStoreId,
        executionId: scope.executionId,
        offers: decision.grantOffers,
      });
      if (reusableGrant) {
        const binding = reusableGrant.offer.policyBindings.find((binding) =>
          sameCapability(binding.capability, request),
        );
        if (!binding) throw new AgentError('permission_grant_changed');
        if (
          !execution.interactionBinding &&
          binding.satisfiesCheck &&
          !(binding.requireApproval ?? decision.check?.requireApproval)
        ) {
          const { check: _check, approval: _approval, ...rest } = decision;
          return { ...rest, allowed: true, grant: reusableGrant };
        }
        if (decision.check)
          decision = {
            ...decision,
            check: {
              ...decision.check,
              requireApproval:
                execution.interactionBinding && scope.previousCheck
                  ? scope.previousCheck.requireApproval === true
                  : (binding.requireApproval ?? decision.check?.requireApproval) === true,
            },
          };
        if (!execution.interactionBinding && !decision.check)
          return { ...decision, allowed: true, grant: reusableGrant };
      }
    }
    if (
      !execution.interactionBinding &&
      previous?.policyEvidenceId &&
      decision.check &&
      previous.revision === decision.revision &&
      (await semanticDigest(previous.check?.request ?? null)) ===
        (await semanticDigest(decision.check.request))
    )
      return {
        ...decision,
        allowed: true,
        policyEvidenceId: previous.policyEvidenceId,
        ...(reusableGrant ? { grant: reusableGrant } : {}),
        ...(previous.materialReviewed ? { materialReviewed: true as const } : {}),
        ...(previous.snapshot ? { snapshot: previous.snapshot } : {}),
      };
    let reference = scope.previousCheck;
    let policyEvidence: AutoAuthorizationEvidence | undefined;
    let checkedGrant: string | undefined;
    let materialReviewed = false;
    if (
      reference &&
      (reference.policyRevision !== decision.revision ||
        !decision.check ||
        (reference.requireApproval === true) !== (decision.check.requireApproval === true) ||
        (reference.requestBody?.reference.hash ?? (await semanticDigest(reference.request))) !==
          (await semanticDigest(decision.check.request)))
    ) {
      if (modeControlsChanged(scope.previousPolicy?.controlReads, decision.controlReads))
        await this.invalidateCheck(
          scope,
          scope.previousPolicy,
          decision,
          reference.checkExecutionId,
        );
      throw new AgentError('authorization_check_binding_changed');
    }
    if (!execution.interactionBinding && decision.allowed) return decision;
    if (
      !execution.interactionBinding &&
      scope.authorizeParent &&
      (decision.approval || decision.check)
    ) {
      const inherited = await scope.authorizeParent(request, decision);
      scope.signal.throwIfAborted();
      if (inherited)
        return { ...decision, allowed: true, policyEvidenceId: inherited.policyEvidenceId };
    }
    if (request.kind === 'model') throw new AgentError('permission_denied', decision.reason);
    if (
      decision.check &&
      (!execution.interactionBinding || decision.check.requireApproval || reference)
    ) {
      if (!reference && scope.check && !scope.final) {
        const controller = new AbortController();
        const abort = () => controller.abort(scope.signal.reason);
        scope.signal.addEventListener('abort', abort, { once: true });
        if (scope.signal.aborted) abort();
        try {
          const reviewed =
            (await Promise.race([
              scope.check(decision, controller.signal),
              this.policyChanged(
                { ...scope, signal: controller.signal },
                { ...request, signal: controller.signal },
                decision,
                cursor,
              ),
            ])) ?? undefined;
          if (reviewed && 'policyEvidenceId' in reviewed) policyEvidence = reviewed;
          else reference = reviewed;
        } catch (error) {
          if (error instanceof AuthorizationRefreshRequired)
            await this.invalidateCheck(scope, decision, await this.permissions.authorize(request));
          throw error;
        } finally {
          controller.abort();
          scope.signal.removeEventListener('abort', abort);
        }
      }
      if (policyEvidence) {
        let current = await this.permissions.authorize(request);
        if (reusableGrant && current.check) {
          const binding = current.grantOffers
            ?.find((offer) => offer.scopeDigest === reusableGrant.offer.scopeDigest)
            ?.policyBindings.find((binding) => sameCapability(binding.capability, request));
          if (!binding || binding.reuseRevision !== reusableGrant.reuseRevision)
            throw new AgentError('permission_grant_changed');
          current = {
            ...current,
            check: {
              ...current.check,
              requireApproval:
                execution.interactionBinding && scope.previousCheck
                  ? scope.previousCheck.requireApproval === true
                  : (binding.requireApproval ?? current.check?.requireApproval) === true,
            },
          };
        }
        scope.signal.throwIfAborted();
        await scope.checkFreshness?.();
        if (
          current.revision !== decision.revision ||
          !current.check ||
          current.check.requireApproval
        )
          throw new AuthorizationRefreshRequired();
        return {
          ...current,
          allowed: true,
          policyEvidenceId: policyEvidence.policyEvidenceId,
          ...(reusableGrant ? { grant: reusableGrant } : {}),
          ...(policyEvidence.materialReviewed ? { materialReviewed: true as const } : {}),
          ...(policyEvidence.snapshot ? { snapshot: policyEvidence.snapshot } : {}),
        };
      }
      // Review/human waits are confined to the resource-free authorization phase.
      if (!reference && scope.final) throw new AgentError('authorization_refresh_required');
      if (reference) {
        const checkedDecision = decision;
        decision = await this.permissions.authorize(request);
        if (reusableGrant && decision.check) {
          const reusable = decision.grantOffers
            ?.find((offer) => offer.scopeDigest === reusableGrant.offer.scopeDigest)
            ?.policyBindings.find((binding) => sameCapability(binding.capability, request));
          if (!reusable || reusable.reuseRevision !== reusableGrant.reuseRevision)
            throw new AgentError('permission_grant_changed');
          decision = {
            ...decision,
            check: {
              ...decision.check,
              requireApproval:
                execution.interactionBinding && scope.previousCheck
                  ? scope.previousCheck.requireApproval === true
                  : (reusable.requireApproval ?? decision.check?.requireApproval) === true,
            },
          };
        }
        scope.signal.throwIfAborted();
        await scope.checkFreshness?.();
        if (
          !decision.check ||
          (reference.requireApproval === true) !== (decision.check.requireApproval === true) ||
          decision.revision !== reference.policyRevision ||
          (await semanticDigest(decision.check.request)) !==
            (reference.requestBody?.reference.hash ?? (await semanticDigest(reference.request)))
        ) {
          if (modeControlsChanged(checkedDecision.controlReads, decision.controlReads))
            await this.invalidateCheck(
              scope,
              checkedDecision,
              decision,
              reference.checkExecutionId,
            );
          throw new AgentError('authorization_check_binding_changed');
        }
        const checked = await this.store.getAuthorizationCheck(reference);
        materialReviewed = checked.materialReviewed === true;
        // A configured checker that failed technically supplied no human decision.
        // Settle the undispatched operation so its caller can continue the Agent Loop.
        if (checked.decision === 'unavailable') {
          const check = await this.store.getExecution(checked.checkExecutionId);
          if (!check) throw new AgentError('authorization_check_unverifiable');
          const timedOut =
            check.result &&
            typeof check.result === 'object' &&
            !Array.isArray(check.result) &&
            check.result.code === 'authorization_check_timeout';
          if (!timedOut || !decision.check.requireApproval)
            throw new AuthorizationCheckUnavailableError(
              checked.checkExecutionId,
              checked.reason,
              check.result,
            );
          // The review budget never removes an independent human requirement.
          decision = {
            ...decision,
            approval: {
              ...decision.approval,
              request: {
                kind: 'approval_after_check_timeout',
                checkExecutionId: checked.checkExecutionId,
                originalRequest: decision.approval?.request ?? null,
              },
            },
          };
        }
        if (checked.decision === 'approve_once' && !decision.check?.requireApproval)
          return {
            ...(decision.worktreeDecisionSeal
              ? { worktreeDecisionSeal: decision.worktreeDecisionSeal }
              : {}),
            allowed: true,
            revision: decision.revision,
            checkExecutionId: checked.checkExecutionId,
            ...(reusableGrant ? { grant: reusableGrant } : {}),
            ...(materialReviewed ? { materialReviewed: true as const } : {}),
            ...(decision.controlReads === undefined ? {} : { controlReads: decision.controlReads }),
            ...(decision.snapshot === undefined ? {} : { snapshot: decision.snapshot }),
          } satisfies AcceptedAuthorization;
        if (checked.decision === 'approve_once') checkedGrant = checked.checkExecutionId;
        if (checked.decision === 'reject') throw publicDenial(checked.reason, true);
        if (scope.final && !checkedGrant && !execution.interactionBinding)
          throw new AgentError('authorization_refresh_required');
      }
      decision = {
        ...decision,
        approval: decision.approval ?? {
          request: {
            reason: checkedGrant
              ? 'authorization_check_requires_user_approval'
              : 'authorization_check_unavailable',
            check: reference?.requestBody
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
              : decision.check!.request,
          },
        },
      };
    }
    if (reusableGrant && !decision.check?.requireApproval && checkedGrant)
      return {
        ...decision,
        allowed: true,
        grant: reusableGrant,
        checkExecutionId: checkedGrant,
        ...(materialReviewed ? { materialReviewed: true as const } : {}),
      };
    if (
      !decision.allowed &&
      !decision.approval &&
      !(decision.check && execution.interactionBinding)
    )
      throw publicDenial(decision.reason ?? 'permission_denied');
    if (scope.final && !execution.interactionBinding)
      throw new AgentError('authorization_refresh_required');
    const inputDigest = await semanticDigest(request.input);
    const approvalRequest = (): Json => ({
      policy: decision.approval!.request,
      options: [
        ...(decision.approval!.options ?? approvalOptions(decision.grantOffers)),
      ] as unknown as Json,
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
          interactionId: `approval-${await semanticDigest({ executionId: execution.id, attempt: execution.attempt, policyRevision: decision.revision })}`,
          executionId: execution.id,
          attempt: execution.attempt,
          kind: 'approval',
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
          inputDigest,
          policyRevision: decision.revision,
          requiredRefs: [...scope.requiredRefs],
          source,
          request: {
            ...((scope.sealApprovalRequest
              ? await scope.sealApprovalRequest(approvalRequest())
              : approvalRequest()) as Record<string, Json>),
            ...(decision.controlReads
              ? { approvalControlReads: decision.controlReads as unknown as Json }
              : {}),
          },
        });
    if (!interaction) throw new AgentError('interaction_not_found');
    if (scope.final && (interaction.state !== 'answered' || !interaction.acceptedDecisionRevision))
      throw new AgentError('authorization_refresh_required');
    const waited = interaction.state === 'pending';
    if (interaction.state === 'pending') {
      const controller = new AbortController();
      const abort = () => controller.abort(scope.signal.reason);
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) abort();
      try {
        interaction = await Promise.race([
          this.wait({ ...scope, signal: controller.signal }, interaction, true),
          this.policyChanged(
            { ...scope, signal: controller.signal },
            { ...request, signal: controller.signal },
            decision,
            cursor,
          ),
        ]);
      } catch (error) {
        if (error instanceof AuthorizationRefreshRequired) {
          const current = await this.permissions.authorize(request);
          await this.refresh(scope, interaction, current);
        }
        throw error;
      } finally {
        controller.abort();
        scope.signal.removeEventListener('abort', abort);
      }
    } else interaction = await this.wait(scope, interaction, true);
    if (interaction.answer?.kind === 'approval' && interaction.answer.decision === 'deny') {
      // Denying this exact invocation is a Tool result, not cancellation of
      // the user's task. Explicit task cancellation uses its own command.
      throw new AgentError('approval_denied');
    }
    if (waited) decision = await this.permissions.authorize(request);
    scope.signal.throwIfAborted();
    if (!decision.allowed && !decision.approval && !decision.check)
      throw publicDenial(decision.reason ?? 'permission_denied');
    if (decision.revision !== interaction.policyRevision)
      await this.refresh(scope, interaction, decision);
    if (
      interaction.definitionId !== request.definitionId ||
      interaction.definitionVersion !== request.definitionVersion ||
      interaction.inputDigest !== inputDigest
    )
      throw new AgentError('interaction_binding_changed');
    if (interaction.answer?.kind === 'approval' && interaction.answer.decision === 'approve') {
      const selected = selectedApprovalOption(interaction.request, interaction.answer.optionId);
      if (
        selected.kind === 'scope' &&
        !decision.grantOffers?.some(
          (offer) =>
            offer.scopeDigest === selected.scopeDigest &&
            offer.policyBindings.every((binding) =>
              selected.policyBindings.some(
                (original) =>
                  sameCapability(original.capability, binding.capability) &&
                  original.reuseRevision === binding.reuseRevision,
              ),
            ),
        )
      )
        throw new AgentError('interaction_binding_changed');
    }
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
    const selected = selectedApprovalOption(accepted.request, accepted.answer.optionId);
    const grant =
      selected.kind === 'scope'
        ? await this.store.getPermissionGrant({
            expectedStoreId: scope.expectedStoreId,
            executionId: scope.executionId,
            offers: [parseGrantOffer(selected)],
          })
        : null;
    if (selected.kind === 'scope' && !grant) throw new AgentError('permission_grant_changed');
    return {
      ...(decision.worktreeDecisionSeal
        ? { worktreeDecisionSeal: decision.worktreeDecisionSeal }
        : {}),
      ...((grant ?? reusableGrant) ? { grant: grant ?? reusableGrant! } : {}),
      allowed: true,
      revision: decision.revision,
      interactionId: accepted.id,
      decisionRevision: accepted.acceptedDecisionRevision!,
      ...(decision.controlReads === undefined ? {} : { controlReads: decision.controlReads }),
      ...(decision.snapshot === undefined ? {} : { snapshot: decision.snapshot }),
      ...(checkedGrant ? { checkExecutionId: checkedGrant } : {}),
      ...(materialReviewed ? { materialReviewed: true as const } : {}),
    } satisfies AcceptedAuthorization;
  }

  informationRequester(
    scope: InteractionScope,
  ): (input: { kind: 'question' | 'plan_review'; request: Json }) => Promise<AcceptedInformation> {
    let ordinal = 0;
    return async ({ kind, request }) => {
      scope.signal.throwIfAborted();
      if (scope.informationResourcesHeld)
        throw new AgentError('interaction_execution_resource_held');
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
        if (!decision.allowed && !decision.approval && !decision.check)
          throw new AgentError('information_permission_denied');
        return {
          revision: decision.revision,
          bindingDigest: await semanticDigest({
            allowed: decision.allowed,
            approval: decision.approval ?? null,
            check: decision.check ?? null,
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
      let accepted: InteractionRecord | undefined;
      // A saved human answer survives mode changes. Re-observe only a stale
      // current-control CAS; never repeat the question or retry another guard.
      for (let observation = 0; observation < 3; observation++) {
        const currentPermission = await observePermission();
        try {
          accepted = await this.accept(
            scope,
            answered,
            true,
            informationPermission,
            currentPermission,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof AgentError) ||
            error.code !== 'information_permission_control_changed' ||
            observation === 2
          )
            throw error;
        }
      }
      if (!accepted || accepted.answer?.kind !== kind)
        throw new AgentError('interaction_answer_invalid');
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
