import { childThreadIdForToolAttempt } from './child-session';
import type { KernelEvent } from './events';
import { fundingDeadlineMatches } from './resource-deadline';
import type { AgentState, ResourceReservation } from './state';

export type StateModelEvidenceFailure = 'artifact_missing' | 'artifact_corrupt';

export interface StatePendingFollowupFundingProof {
  readonly fundingRunId: string;
  readonly submissionId: string;
  readonly stage: 'accepted' | 'replaced' | 'routed' | 'activated';
  readonly backupReservationId: string;
  readonly turnReservationId: string | null;
  readonly modelReservationId: string | null;
  readonly modelInvocationId: string | null;
  /** Exact Store receipt for a v1 released backup removed from the active State working set. */
  readonly releasedBackupReservation?:
    | Readonly<ResourceReservation>
    | Readonly<Record<string, unknown>>;
  /** Store target-owner no-attempt proof, present only for a routed activated first Model. */
  readonly targetPreparedNoAttempt?: StatePreparedFollowupModelProof;
}

/** Target-owner proof that this exact routed first Model has no Provider attempt. */
export interface StatePreparedFollowupModelProof {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly modelReservationId: string;
  readonly preparedStateRevision: number;
  readonly surfaceRef: Readonly<{
    readonly artifactId: string;
    readonly kind: 'model_surface';
    readonly integrityIdentifier: string;
    readonly byteLength: number;
  }>;
  readonly surfaceDigest: string;
  readonly estimatedInputTokens: number;
  readonly activationSourceRevision: number;
}

/** Store-verified old child Run Surface, route, source release and no Provider attempt. */
export interface StatePreparedCurrentTurnModelProof {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly modelReservationId: string;
  readonly preparedStateRevision: number;
  readonly surfaceRef: StatePreparedFollowupModelProof['surfaceRef'];
  readonly surfaceDigest: string;
  readonly estimatedInputTokens: number;
  readonly releaseSourceRevision: number;
  readonly routeDigest: string;
}

/** Source-owner Store proof of one D0 child Run frozen before its first Provider attempt. */
interface StateDispatchedChildDelegationIdentity {
  readonly sourceSessionId: string;
  readonly delegatedReservationId: string;
  readonly childThreadId: string;
  readonly parentInvocationId: string;
  readonly originToolCallId: string;
  readonly fundingRunId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly submissionId: string;
  readonly preparedStateRevision: number;
}

export type StateDispatchedChildDelegationProof = StateDispatchedChildDelegationIdentity &
  (
    | {
        readonly stage: 'routed';
        readonly sourceRevision: number;
        readonly routedTargetRevision: number;
      }
    | { readonly stage: 'released'; readonly releaseSourceRevision: number }
  );

/** Store-indexed, still-pending after_turn child and its reserved report Model. */
export interface StatePendingAfterTurnDelegationProof {
  readonly childThreadId: string;
  readonly parentInvocationId: string;
  readonly childInvocationId: string;
  readonly fundingRunId: string;
  readonly delegatedReservationId: string;
  readonly reportReservationId: string;
}

/** Store-confirmed terminal seal with ACK and no parent import; status may remain unknown. */
export interface StateSealedAfterTurnReportProof extends StatePendingAfterTurnDelegationProof {
  readonly sealEventId: string;
  readonly sealRevision: number;
  readonly terminalReceiptId: string;
  readonly status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'exhausted'
    | 'suspended'
    | 'unknown';
}

/** Current-process runner proof; never reconstructed from a restarted Store alone. */
export interface StateLiveAfterTurnDelegationProof extends StatePendingAfterTurnDelegationProof {
  readonly dispatchAckEventId: string;
  readonly dispatchAckRevision: number;
  readonly controllerGeneration: number;
}

export interface StateRestartRecoveryFacts {
  readonly capabilityFinishedAtByInvocationId: Readonly<Record<string, string | undefined>>;
  readonly pendingModelEvidenceFailures: Readonly<
    Record<string, StateModelEvidenceFailure | undefined>
  >;
  readonly completedModelEvidenceFailures: Readonly<
    Record<string, StateModelEvidenceFailure | undefined>
  >;
  /** Store-verified, still-pending independent child intents from the Host. */
  readonly preserveReservedChildDelegations?: readonly string[];
  /** Store-verified after_turn intent whose child and report debts remain unattempted. */
  readonly preservePendingAfterTurnDelegations?: readonly StatePendingAfterTurnDelegationProof[];
  /** Store-confirmed terminal children whose parent report remains reserved. */
  readonly preserveSealedAfterTurnReports?: readonly StateSealedAfterTurnReportProof[];
  /** Only a live runner in this process may preserve the dispatched child debt. */
  readonly preserveLiveAfterTurnDelegations?: readonly StateLiveAfterTurnDelegationProof[];
  /** Store-verified routed child with no Provider attempt; retain only its dispatched D0 debt. */
  readonly preserveDispatchedChildDelegations?: readonly StateDispatchedChildDelegationProof[];
  /** Store-verified, unsettled TriggerTurn stages in the original funding ledger. */
  readonly preservePendingFollowupFunding?: readonly StatePendingFollowupFundingProof[];
  /** Store-verified route, activation, immutable Surface and no-attempt target facts. */
  readonly preservePreparedFollowupModels?: readonly StatePreparedFollowupModelProof[];
  /** Store-verified current-turn route/release and no-attempt old child Model. */
  readonly preservePreparedCurrentTurnModels?: readonly StatePreparedCurrentTurnModelProof[];
}

/** Cross-check pending Store intents against both debts in the original funding ledger. */
export function verifiedPendingAfterTurnReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StatePendingAfterTurnDelegationProof[],
): ReadonlySet<string> {
  const preserved = new Set<string>();
  const childThreads = new Set<string>();
  for (const proof of proofs) {
    const invocation = state.capabilities.invocations[proof.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    const call = link ? state.tools.calls[link.originToolCallId] : undefined;
    const args =
      call?.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? (call.args as Readonly<Record<string, unknown>>)
        : undefined;
    const ledger =
      state.resourceBudget.status === 'active' && state.resourceBudget.runId === proof.fundingRunId
        ? state.resourceBudget
        : state.retainedResourceBudgets[proof.fundingRunId];
    const delegated = ledger?.reservations[proof.delegatedReservationId];
    const report = ledger?.reservations[proof.reportReservationId];
    const reportUpper = report?.executableUpperBound;
    if (
      childThreads.has(proof.childThreadId) ||
      preserved.has(proof.delegatedReservationId) ||
      preserved.has(proof.reportReservationId) ||
      proof.delegatedReservationId === proof.reportReservationId ||
      proof.delegatedReservationId !== `child-allotment:${proof.childThreadId}` ||
      !/^child_[a-f0-9]{64}$/u.test(proof.childThreadId) ||
      !link ||
      !call ||
      !ledger ||
      proof.childThreadId !==
        childThreadIdForToolAttempt({
          parentSessionId: state.session.threadId,
          parentInvocationId: proof.parentInvocationId,
          parentToolCallId: link.originToolCallId,
          attempt: invocation.subagentProviderLifecycle!.attempt,
        }) ||
      invocation.toolCallId !== link.originToolCallId ||
      invocation.status !== 'succeeded' ||
      link.childThreadId !== proof.childThreadId ||
      link.disposition !== 'after_turn' ||
      link.terminalImport !== undefined ||
      link.originRunId !== proof.fundingRunId ||
      link.fundingRunId !== proof.fundingRunId ||
      link.delegatedReservationId !== proof.delegatedReservationId ||
      invocation.subagentProviderLifecycle?.childInvocationId !== proof.childInvocationId ||
      call.createdAtTurnId !== link.originTurnId ||
      call.status !== 'succeeded' ||
      call.result?.resultMeta?.taskId !== proof.childInvocationId ||
      call.result.resultMeta.taskStatus !== 'running' ||
      call.result.resultMeta.taskDisposition !== 'after_turn' ||
      args?.background !== true ||
      args.result_disposition !== 'after_turn' ||
      ledger.status !== 'active' ||
      !fundingDeadlineMatches(ledger, link.deadlineAt) ||
      (delegated?.state !== 'reserved' && delegated?.state !== 'queued') ||
      delegated.resourceKind !== 'subagent' ||
      delegated.runId !== proof.fundingRunId ||
      delegated.invocationId !== proof.delegatedReservationId ||
      delegated.parentReservationId !== undefined ||
      report?.state !== 'reserved' ||
      report.resourceKind !== 'model' ||
      report.runId !== proof.fundingRunId ||
      report.invocationId !== `model-invocation:after-turn:${proof.childInvocationId}` ||
      report.parentReservationId !== undefined ||
      reportUpper?.source !== 'versioned_upper_bound' ||
      reportUpper.counters.modelRequests !== 1 ||
      reportUpper.counters.inputTokens < (reportUpper.unboundedModelTokens === true ? 0 : 1) ||
      reportUpper.counters.outputTokens < (reportUpper.unboundedModelTokens === true ? 0 : 1)
    )
      throw new Error('Pending after_turn recovery proof conflicts with the source ledger.');
    childThreads.add(proof.childThreadId);
    preserved.add(proof.delegatedReservationId);
    preserved.add(proof.reportReservationId);
  }
  return preserved;
}

/** Preserve only the report debt; a dispatched child debt keeps its recovery uncertainty. */
export function verifiedSealedAfterTurnReportReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StateSealedAfterTurnReportProof[],
): ReadonlySet<string> {
  const preserved = new Set<string>();
  const children = new Set<string>();
  for (const proof of proofs) {
    const invocation = state.capabilities.invocations[proof.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    const ledger =
      state.resourceBudget.status === 'active' && state.resourceBudget.runId === proof.fundingRunId
        ? state.resourceBudget
        : state.retainedResourceBudgets[proof.fundingRunId];
    const delegated = ledger?.reservations[proof.delegatedReservationId];
    const report = ledger?.reservations[proof.reportReservationId];
    const upper = report?.executableUpperBound;
    const call = link ? state.tools.calls[link.originToolCallId] : undefined;
    if (
      !proof.sealEventId ||
      !Number.isSafeInteger(proof.sealRevision) ||
      proof.sealRevision < 1 ||
      !proof.terminalReceiptId ||
      ![
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'exhausted',
        'suspended',
        'unknown',
      ].includes(proof.status) ||
      children.has(proof.childThreadId) ||
      preserved.has(proof.reportReservationId) ||
      proof.delegatedReservationId !== `child-allotment:${proof.childThreadId}` ||
      !/^child_[a-f0-9]{64}$/u.test(proof.childThreadId) ||
      !link ||
      !ledger ||
      proof.childThreadId !==
        childThreadIdForToolAttempt({
          parentSessionId: state.session.threadId,
          parentInvocationId: proof.parentInvocationId,
          parentToolCallId: link.originToolCallId,
          attempt: invocation.subagentProviderLifecycle!.attempt,
        }) ||
      invocation.toolCallId !== link.originToolCallId ||
      invocation.status !== 'succeeded' ||
      link.childThreadId !== proof.childThreadId ||
      link.disposition !== 'after_turn' ||
      link.terminalImport !== undefined ||
      link.originRunId !== proof.fundingRunId ||
      link.fundingRunId !== proof.fundingRunId ||
      link.delegatedReservationId !== proof.delegatedReservationId ||
      invocation.subagentProviderLifecycle?.childInvocationId !== proof.childInvocationId ||
      call?.status !== 'succeeded' ||
      call.result?.resultMeta?.taskId !== proof.childInvocationId ||
      call.result.resultMeta.taskDisposition !== 'after_turn' ||
      ledger.status !== 'active' ||
      !fundingDeadlineMatches(ledger, link.deadlineAt) ||
      (delegated?.state !== 'dispatch_started' && delegated?.state !== 'unknown') ||
      delegated.resourceKind !== 'subagent' ||
      delegated.runId !== proof.fundingRunId ||
      delegated.invocationId !== proof.delegatedReservationId ||
      report?.state !== 'reserved' ||
      report.resourceKind !== 'model' ||
      report.runId !== proof.fundingRunId ||
      report.invocationId !== `model-invocation:after-turn:${proof.childInvocationId}` ||
      report.parentReservationId !== undefined ||
      upper?.source !== 'versioned_upper_bound' ||
      upper.counters.modelRequests !== 1 ||
      upper.counters.inputTokens < (upper.unboundedModelTokens === true ? 0 : 1) ||
      upper.counters.outputTokens < (upper.unboundedModelTokens === true ? 0 : 1)
    )
      throw new Error('Sealed after_turn report recovery proof conflicts with the source ledger.');
    children.add(proof.childThreadId);
    preserved.add(proof.reportReservationId);
  }
  return preserved;
}

export function verifiedLiveAfterTurnReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StateLiveAfterTurnDelegationProof[],
): ReadonlySet<string> {
  const preserved = new Set<string>();
  const children = new Set<string>();
  for (const proof of proofs) {
    const invocation = state.capabilities.invocations[proof.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    const ledger =
      state.resourceBudget.status === 'active' && state.resourceBudget.runId === proof.fundingRunId
        ? state.resourceBudget
        : state.retainedResourceBudgets[proof.fundingRunId];
    const child = ledger?.reservations[proof.delegatedReservationId];
    const report = ledger?.reservations[proof.reportReservationId];
    const call = link ? state.tools.calls[link.originToolCallId] : undefined;
    if (
      !proof.dispatchAckEventId ||
      !Number.isSafeInteger(proof.dispatchAckRevision) ||
      proof.dispatchAckRevision < 1 ||
      !Number.isSafeInteger(proof.controllerGeneration) ||
      proof.controllerGeneration < 1 ||
      children.has(proof.childThreadId) ||
      preserved.has(proof.delegatedReservationId) ||
      preserved.has(proof.reportReservationId) ||
      proof.delegatedReservationId !== `child-allotment:${proof.childThreadId}` ||
      !/^child_[a-f0-9]{64}$/u.test(proof.childThreadId) ||
      !link ||
      !ledger ||
      proof.childThreadId !==
        childThreadIdForToolAttempt({
          parentSessionId: state.session.threadId,
          parentInvocationId: proof.parentInvocationId,
          parentToolCallId: link.originToolCallId,
          attempt: invocation.subagentProviderLifecycle!.attempt,
        }) ||
      invocation.toolCallId !== link.originToolCallId ||
      invocation.status !== 'succeeded' ||
      link.childThreadId !== proof.childThreadId ||
      link.disposition !== 'after_turn' ||
      link.terminalImport !== undefined ||
      link.originRunId !== proof.fundingRunId ||
      link.fundingRunId !== proof.fundingRunId ||
      link.delegatedReservationId !== proof.delegatedReservationId ||
      invocation.subagentProviderLifecycle?.childInvocationId !== proof.childInvocationId ||
      call?.status !== 'succeeded' ||
      call.result?.resultMeta?.taskId !== proof.childInvocationId ||
      call.result.resultMeta.taskDisposition !== 'after_turn' ||
      ledger.status !== 'active' ||
      !fundingDeadlineMatches(ledger, link.deadlineAt) ||
      child?.state !== 'dispatch_started' ||
      child.resourceKind !== 'subagent' ||
      child.runId !== proof.fundingRunId ||
      child.invocationId !== proof.delegatedReservationId ||
      report?.state !== 'reserved' ||
      report.resourceKind !== 'model' ||
      report.runId !== proof.fundingRunId ||
      report.invocationId !== `model-invocation:after-turn:${proof.childInvocationId}` ||
      report.parentReservationId !== undefined ||
      report.executableUpperBound?.source !== 'versioned_upper_bound' ||
      report.executableUpperBound.counters.modelRequests !== 1
    )
      throw new Error('Live after_turn recovery proof conflicts with the source ledger.');
    children.add(proof.childThreadId);
    preserved.add(proof.delegatedReservationId);
    preserved.add(proof.reportReservationId);
  }
  return preserved;
}

export function verifiedDispatchedChildDelegationIds(
  state: Readonly<AgentState>,
  proofs: readonly StateDispatchedChildDelegationProof[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const proof of proofs) {
    const ledger = state.resourceBudget;
    const reservation =
      ledger.status === 'active' ? ledger.reservations[proof.delegatedReservationId] : undefined;
    const invocation = state.capabilities.invocations[proof.parentInvocationId];
    const link = invocation?.subagentProviderLifecycle?.childSession;
    if (
      !proof.submissionId ||
      !proof.modelInvocationId ||
      !Number.isSafeInteger(proof.preparedStateRevision) ||
      proof.preparedStateRevision < 1 ||
      (proof.stage === 'released'
        ? !Number.isSafeInteger(proof.releaseSourceRevision) || proof.releaseSourceRevision < 1
        : !Number.isSafeInteger(proof.sourceRevision) ||
          proof.sourceRevision < 1 ||
          !Number.isSafeInteger(proof.routedTargetRevision) ||
          proof.routedTargetRevision < 1) ||
      ids.has(proof.delegatedReservationId) ||
      proof.sourceSessionId !== state.session.threadId ||
      proof.delegatedReservationId !== `child-allotment:${proof.childThreadId}` ||
      !/^child_[a-f0-9]{64}$/u.test(proof.childThreadId) ||
      proof.targetRunId === proof.fundingRunId ||
      state.turn.status !== 'active' ||
      state.turn.turnId !== proof.fundingRunId ||
      ledger.status !== 'active' ||
      ledger.runId !== proof.fundingRunId ||
      reservation?.state !== 'dispatch_started' ||
      reservation.resourceKind !== 'subagent' ||
      reservation.runId !== proof.fundingRunId ||
      reservation.invocationId !== proof.delegatedReservationId ||
      state.tools.calls[proof.originToolCallId]?.status !== 'succeeded' ||
      invocation?.status !== 'succeeded' ||
      invocation.toolCallId !== proof.originToolCallId ||
      link?.childThreadId !== proof.childThreadId ||
      link.delegatedReservationId !== proof.delegatedReservationId
    )
      throw new Error('Dispatched child recovery proof conflicts with the source ledger.');
    ids.add(proof.delegatedReservationId);
  }
  return ids;
}

export function verifiedPreparedCurrentTurnModelReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StatePreparedCurrentTurnModelProof[],
): ReadonlyMap<string, string> {
  if (proofs.length > 1) throw new Error('Only one prepared current-turn Model may be preserved.');
  const preserved = new Map<string, string>();
  for (const proof of proofs) {
    const model = state.modelInvocations[proof.invocationId];
    const budget = model?.budget;
    const ledger = state.resourceBudget;
    const reservation =
      ledger.status === 'active' ? ledger.reservations[proof.modelReservationId] : undefined;
    if (
      !proof.submissionId ||
      !proof.routeDigest ||
      !state.childSessionOrigin ||
      state.childSessionOrigin.terminal ||
      state.activeFollowupTurn ||
      !state.activeTaskId ||
      state.turn.turnId !== proof.targetRunId ||
      state.turn.status !== 'active' ||
      proof.preparedStateRevision !== state.revision ||
      !Number.isSafeInteger(proof.releaseSourceRevision) ||
      proof.releaseSourceRevision < 1 ||
      !Number.isSafeInteger(proof.estimatedInputTokens) ||
      proof.estimatedInputTokens < 0 ||
      proof.surfaceRef.kind !== 'model_surface' ||
      proof.surfaceRef.integrityIdentifier !== proof.surfaceDigest ||
      model?.status !== 'prepared' ||
      model.attempts !== 0 ||
      model.preparedStateRevision > proof.preparedStateRevision ||
      model.estimatedInputTokens !== proof.estimatedInputTokens ||
      model.surfaceArtifact.artifactId !== proof.surfaceRef.artifactId ||
      model.surfaceArtifact.integrityIdentifier !== proof.surfaceRef.integrityIdentifier ||
      model.surfaceArtifact.byteLength !== proof.surfaceRef.byteLength ||
      model.surfaceIntegrityIdentifier !== proof.surfaceDigest ||
      budget?.kind !== 'reservation' ||
      budget.reservationId !== proof.modelReservationId ||
      ledger.status !== 'active' ||
      ledger.runId !== proof.targetRunId ||
      reservation?.state !== 'reserved' ||
      reservation.runId !== proof.targetRunId ||
      reservation.resourceKind !== 'model' ||
      reservation.invocationId !== `model-invocation:${proof.invocationId}`
    )
      throw new Error('Prepared current-turn recovery proof conflicts with target State.');
    preserved.set(proof.invocationId, proof.modelReservationId);
  }
  return preserved;
}

/** Cross-check the Store's no-dispatch proof against the exact target State. */
export function verifiedPreparedFollowupModelReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StatePreparedFollowupModelProof[],
): ReadonlyMap<string, string> {
  if (proofs.length > 1)
    throw new Error('Only one prepared first Model may be preserved per TriggerTurn.');
  const preserved = new Map<string, string>();
  const reservations = new Set<string>();
  for (const proof of proofs) {
    const active = state.activeFollowupTurn;
    const model = state.modelInvocations[proof.invocationId];
    const budget = model?.budget;
    const ledger = state.resourceBudget;
    const reservation =
      ledger.status === 'active' ? ledger.reservations[proof.modelReservationId] : undefined;
    if (
      !active ||
      !proof.submissionId ||
      preserved.has(proof.invocationId) ||
      reservations.has(proof.modelReservationId) ||
      active.submissionId !== proof.submissionId ||
      active.targetRunId !== proof.targetRunId ||
      state.turn.turnId !== proof.targetRunId ||
      state.turn.status !== 'active' ||
      proof.preparedStateRevision !== state.revision ||
      !Number.isSafeInteger(proof.activationSourceRevision) ||
      proof.activationSourceRevision < 1 ||
      !Number.isSafeInteger(proof.estimatedInputTokens) ||
      proof.estimatedInputTokens < 0 ||
      proof.surfaceRef.kind !== 'model_surface' ||
      proof.surfaceRef.integrityIdentifier !== proof.surfaceDigest ||
      model?.status !== 'prepared' ||
      model.attempts !== 0 ||
      model.preparedStateRevision > proof.preparedStateRevision ||
      model.estimatedInputTokens !== proof.estimatedInputTokens ||
      model.surfaceArtifact.artifactId !== proof.surfaceRef.artifactId ||
      model.surfaceArtifact.integrityIdentifier !== proof.surfaceRef.integrityIdentifier ||
      model.surfaceArtifact.byteLength !== proof.surfaceRef.byteLength ||
      model.surfaceIntegrityIdentifier !== proof.surfaceDigest ||
      budget?.kind !== 'reservation' ||
      budget.reservationId !== proof.modelReservationId ||
      ledger.status !== 'active' ||
      ledger.runId !== proof.targetRunId ||
      reservation?.state !== 'reserved' ||
      reservation.runId !== proof.targetRunId ||
      reservation.resourceKind !== 'model' ||
      reservation.invocationId !== `model-invocation:${proof.invocationId}`
    )
      throw new Error('Prepared TriggerTurn recovery proof conflicts with target State.');
    preserved.set(proof.invocationId, proof.modelReservationId);
    reservations.add(proof.modelReservationId);
  }
  return preserved;
}

/** Validate a Store-indexed source stage against the exact State ledger before preserving it. */
export function verifiedPendingFollowupReservationIds(
  state: Readonly<AgentState>,
  proofs: readonly StatePendingFollowupFundingProof[],
): ReadonlySet<string> {
  const preserved = new Set<string>();
  const submissions = new Set<string>();
  for (const proof of proofs) {
    if (!proof.submissionId || submissions.has(proof.submissionId))
      throw new Error('TriggerTurn funding recovery submission is duplicated.');
    submissions.add(proof.submissionId);
    const ledger =
      state.resourceBudget.status === 'active' && state.resourceBudget.runId === proof.fundingRunId
        ? state.resourceBudget
        : state.retainedResourceBudgets[proof.fundingRunId];
    const inStateBackup = ledger?.reservations[proof.backupReservationId];
    const backup =
      inStateBackup ??
      (ledger?.externalizedClosedReservations === true
        ? (proof.releasedBackupReservation as ResourceReservation | undefined)
        : undefined);
    if (
      !ledger ||
      !/^backup_[a-f0-9]{64}$/u.test(proof.backupReservationId) ||
      (proof.releasedBackupReservation !== undefined &&
        (inStateBackup !== undefined ||
          ledger.externalizedClosedReservations !== true ||
          proof.releasedBackupReservation.state !== 'released')) ||
      backup?.reservationId !== proof.backupReservationId ||
      backup.version !== 1 ||
      backup?.runId !== proof.fundingRunId ||
      backup.resourceKind !== 'subagent' ||
      backup.invocationId !== proof.submissionId ||
      backup.parentReservationId !== undefined ||
      !backup.executableUpperBound ||
      !backup.executableUpperBound.counters ||
      !backup.executableUpperBound.gauges
    )
      throw new Error('TriggerTurn backup recovery proof conflicts with State.');
    if (backup.executableUpperBound.independentFollowupTurn === true) {
      if (
        backup.executableUpperBound.unboundedToolInvocations !== true ||
        backup.executableUpperBound.gauges.elapsedRunMs !== 30 * 60_000 ||
        proof.turnReservationId !== null ||
        proof.modelReservationId !== null ||
        (proof.stage !== 'accepted' && proof.stage !== 'activated')
      )
        throw new Error('Independent TriggerTurn recovery proof conflicts with State.');
      if (proof.stage === 'accepted') {
        if (
          (backup.state !== 'reserved' && backup.state !== 'queued') ||
          proof.modelInvocationId !== null ||
          proof.targetPreparedNoAttempt
        )
          throw new Error('Independent TriggerTurn accepted stage conflicts with State.');
        preserved.add(backup.reservationId);
        continue;
      }
      const target = proof.targetPreparedNoAttempt;
      if (backup.state !== 'dispatch_started') {
        if (target)
          throw new Error('Independent TriggerTurn no-attempt proof conflicts with State.');
        continue;
      }
      if (
        target &&
        (!proof.modelInvocationId ||
          target.submissionId !== proof.submissionId ||
          target.invocationId !== proof.modelInvocationId ||
          !target.targetRunId ||
          !target.modelReservationId ||
          !Number.isSafeInteger(target.activationSourceRevision) ||
          target.activationSourceRevision < 1 ||
          !Number.isSafeInteger(target.preparedStateRevision) ||
          target.preparedStateRevision < 1 ||
          target.surfaceRef.kind !== 'model_surface' ||
          target.surfaceRef.integrityIdentifier !== target.surfaceDigest ||
          !Number.isSafeInteger(target.estimatedInputTokens) ||
          target.estimatedInputTokens < 0)
      )
        throw new Error('Independent TriggerTurn no-attempt proof conflicts with State.');
      // The v2 backup is accounting only. Target Model recovery owns the
      // no-replay decision after an attempt, so keep source funding until the
      // target settles completed, unknown, or pre-dispatch released.
      preserved.add(backup.reservationId);
      continue;
    }
    if (proof.stage === 'accepted') {
      if (
        (backup.state !== 'reserved' && backup.state !== 'queued') ||
        proof.turnReservationId !== null ||
        proof.modelReservationId !== null ||
        proof.modelInvocationId !== null
      )
        throw new Error('TriggerTurn accepted recovery stage conflicts with State.');
      preserved.add(backup.reservationId);
      continue;
    }
    const turn = proof.turnReservationId ? ledger.reservations[proof.turnReservationId] : undefined;
    const model = proof.modelReservationId
      ? ledger.reservations[proof.modelReservationId]
      : undefined;
    if (
      backup.state !== 'released' ||
      !proof.modelInvocationId ||
      !/^followup_turn_[a-f0-9]{64}$/u.test(proof.turnReservationId ?? '') ||
      !/^followup_model_[a-f0-9]{64}$/u.test(proof.modelReservationId ?? '') ||
      turn?.runId !== proof.fundingRunId ||
      turn.resourceKind !== 'subagent' ||
      turn.invocationId !== `followup-turn:${proof.modelInvocationId}` ||
      turn.replacesReservationId !== backup.reservationId ||
      turn.parentReservationId !== undefined ||
      model?.runId !== proof.fundingRunId ||
      model.resourceKind !== 'model' ||
      model.invocationId !== `model-invocation:${proof.modelInvocationId}` ||
      model.replacesReservationId !== backup.reservationId ||
      model.parentReservationId !== turn.reservationId
    )
      throw new Error('TriggerTurn replacement recovery proof conflicts with State.');
    if (proof.stage === 'activated') {
      if (turn.state === 'reserved' || model.state === 'reserved')
        throw new Error('Activated TriggerTurn retained an undispatched source reservation.');
      const target = proof.targetPreparedNoAttempt;
      if (!target) continue;
      if (
        turn.state !== 'dispatch_started' ||
        model.state !== 'dispatch_started' ||
        target.submissionId !== proof.submissionId ||
        target.invocationId !== proof.modelInvocationId ||
        !Number.isSafeInteger(target.activationSourceRevision) ||
        target.activationSourceRevision < 1 ||
        !Number.isSafeInteger(target.preparedStateRevision) ||
        target.preparedStateRevision < 1 ||
        target.surfaceRef.kind !== 'model_surface' ||
        target.surfaceRef.integrityIdentifier !== target.surfaceDigest ||
        !Number.isSafeInteger(target.estimatedInputTokens) ||
        target.estimatedInputTokens < 0
      )
        throw new Error('Activated TriggerTurn no-attempt proof conflicts with source State.');
      preserved.add(turn.reservationId);
      preserved.add(model.reservationId);
      continue;
    }
    if (turn.state !== 'reserved' || model.state !== 'reserved')
      throw new Error('TriggerTurn pending route is not an undispatched replacement.');
    preserved.add(turn.reservationId);
    preserved.add(model.reservationId);
  }
  return preserved;
}

/** Exact capability intents which restart recovery must terminalize as unknown. */
export function stateRestartRecoveryCapabilityInvocationIds(
  state: Readonly<AgentState>,
): readonly string[] {
  return Object.values(state.capabilities.invocations)
    .filter((invocation) => {
      if (invocation.status !== 'recorded' && invocation.status !== 'running') return false;
      if (
        invocation.subagentProviderLifecycle &&
        invocation.subagentProviderLifecycle.status !== 'cleanup_completed'
      ) {
        return false;
      }
      if (state.suspendedSubagents[invocation.toolCallId]) return false;
      const suspendedCall = state.tools.calls[invocation.toolCallId];
      return !(
        suspendedCall &&
        (suspendedCall.status === 'awaiting_review' ||
          suspendedCall.status === 'awaiting_approval' ||
          suspendedCall.status === 'awaiting_auto_review' ||
          suspendedCall.status === 'awaiting_user_input')
      );
    })
    .map((invocation) => invocation.invocationId);
}

/**
 * Project the current State restart policy from canonical Host/Builtin
 * evidence facts. This function performs no I/O and owns no artifact reader.
 */
export function projectStateRestartRecoveryEvents(
  state: Readonly<AgentState>,
  facts: StateRestartRecoveryFacts,
): readonly KernelEvent[] {
  const events: KernelEvent[] = [];
  const preserveFollowupIds = verifiedPendingFollowupReservationIds(
    state,
    facts.preservePendingFollowupFunding ?? [],
  );
  const preserveAfterTurnIds = verifiedPendingAfterTurnReservationIds(
    state,
    facts.preservePendingAfterTurnDelegations ?? [],
  );
  const preserveSealedAfterTurnReports = verifiedSealedAfterTurnReportReservationIds(
    state,
    facts.preserveSealedAfterTurnReports ?? [],
  );
  const preserveLiveAfterTurnIds = verifiedLiveAfterTurnReservationIds(
    state,
    facts.preserveLiveAfterTurnDelegations ?? [],
  );
  for (const id of preserveSealedAfterTurnReports) {
    if (preserveAfterTurnIds.has(id) || preserveLiveAfterTurnIds.has(id))
      throw new Error('After_turn report has conflicting pending and sealed recovery proofs.');
  }
  for (const id of preserveLiveAfterTurnIds) {
    if (preserveAfterTurnIds.has(id))
      throw new Error('After_turn delegation has conflicting pending and live recovery proofs.');
  }
  const preserveDispatchedChildIds = verifiedDispatchedChildDelegationIds(
    state,
    facts.preserveDispatchedChildDelegations ?? [],
  );
  const preservePreparedModels = new Map(
    verifiedPreparedFollowupModelReservationIds(state, facts.preservePreparedFollowupModels ?? []),
  );
  const preserveCurrentTurnModels = verifiedPreparedCurrentTurnModelReservationIds(
    state,
    facts.preservePreparedCurrentTurnModels ?? [],
  );
  for (const [invocationId, reservationId] of preserveCurrentTurnModels) {
    if (preservePreparedModels.has(invocationId))
      throw new Error('Prepared Model has conflicting TriggerTurn recovery proofs.');
    preservePreparedModels.set(invocationId, reservationId);
  }
  const preservePreparedReservations = new Set(preservePreparedModels.values());
  const capabilityRecoveryIds = new Set(stateRestartRecoveryCapabilityInvocationIds(state));
  for (const invocation of Object.values(state.capabilities.invocations)) {
    if (!capabilityRecoveryIds.has(invocation.invocationId)) continue;
    const finishedAt = facts.capabilityFinishedAtByInvocationId[invocation.invocationId];
    if (
      finishedAt === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(finishedAt)
    ) {
      throw new Error(
        `State restart recovery requires a valid Host timestamp for ${invocation.invocationId}.`,
      );
    }
    events.push({
      type: 'capability.execution_unknown',
      invocationId: invocation.invocationId,
      reason: 'Runtime recovered after invocation intent was persisted without a terminal result.',
      finishedAt,
    });
  }

  const evidenceUncertainReservations = new Set<string>();
  for (const invocation of Object.values(state.modelInvocations)) {
    if (invocation.status === 'completed' && !invocation.modelEvidenceUnavailable) {
      const evidenceFailure = facts.completedModelEvidenceFailures[invocation.invocationId];
      if (evidenceFailure) {
        events.push({
          type: 'model.invocation_evidence_unavailable',
          invocationId: invocation.invocationId,
          reasonCode: evidenceFailure,
        });
      }
      continue;
    }
    if (invocation.status !== 'prepared' && invocation.status !== 'dispatching') continue;
    if (invocation.status === 'prepared' && preservePreparedModels.has(invocation.invocationId))
      continue;
    events.push({
      type: 'model.invocation_interrupted',
      invocationId: invocation.invocationId,
      dispatchCertainty: invocation.status === 'prepared' ? 'none' : 'unknown',
      reasonCode: 'runtime_restored',
    });
    if (
      invocation.status === 'dispatching' &&
      facts.pendingModelEvidenceFailures[invocation.invocationId] &&
      invocation.budget.kind === 'reservation'
    ) {
      evidenceUncertainReservations.add(invocation.budget.reservationId);
    }
  }

  if (state.resourceBudget.status === 'active') {
    const retainedChildDelegations = new Set(facts.preserveReservedChildDelegations ?? []);
    for (const reservation of Object.values(state.resourceBudget.reservations)) {
      if (reservation.state === 'reserved') {
        if (preserveFollowupIds.has(reservation.reservationId)) continue;
        if (preserveAfterTurnIds.has(reservation.reservationId)) continue;
        if (preserveSealedAfterTurnReports.has(reservation.reservationId)) continue;
        if (preserveLiveAfterTurnIds.has(reservation.reservationId)) continue;
        if (preservePreparedReservations.has(reservation.reservationId)) continue;
        if (
          state.turn.status === 'active' &&
          reservation.runId === state.resourceBudget.runId &&
          reservation.resourceKind === 'subagent' &&
          reservation.invocationId === reservation.reservationId &&
          /^child-allotment:child_[a-f0-9]{64}$/u.test(reservation.reservationId) &&
          retainedChildDelegations.has(reservation.reservationId)
        )
          continue;
        events.push(
          evidenceUncertainReservations.has(reservation.reservationId)
            ? { type: 'resource_budget.unknown', reservationId: reservation.reservationId }
            : { type: 'resource_budget.released', reservationId: reservation.reservationId },
        );
      } else if (reservation.state === 'dispatch_started') {
        if (
          !preserveFollowupIds.has(reservation.reservationId) &&
          !preserveLiveAfterTurnIds.has(reservation.reservationId) &&
          !preserveDispatchedChildIds.has(reservation.reservationId)
        )
          events.push({
            type: 'resource_budget.unknown',
            reservationId: reservation.reservationId,
          });
      }
    }
    if (state.turn.status !== 'active') {
      for (const waiter of Object.values(state.resourceBudget.waiters ?? {})) {
        if (waiter.state !== 'waiting') continue;
        events.push({
          type: 'resource_budget.waiter_cancelled',
          invocationId: waiter.invocationId,
        });
      }
    }
  }
  return events;
}
