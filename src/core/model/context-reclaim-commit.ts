import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import type {
  PreparedContextRequestReadyV2,
  ProjectionSourceIdentityV2,
  RequestAdmissionIdentityV2,
} from './context-preparation-v2';
import { canonicalContextDigestV2 } from './context-preparation-v2';
import type { ReclaimPlanV1 } from './context-reclaim';

export interface ContextReclaimCommitV1 {
  readonly version: 1;
  readonly policyId: string;
  readonly toolResultBudgetPolicyId: string;
  readonly settledThroughMessageId: string;
  readonly settledThroughTurnId: string;
  readonly checkpointIdentity?: string;
  readonly rawFramesDigest: string;
  readonly appliedFramesDigest: string;
  readonly selectedCoverageDigest: string;
  readonly selectedBlockCount: number;
  readonly selectedCallCount: number;
  readonly estimatorId: string;
  readonly projectionEnvironmentDigest: string;
  readonly cacheAffectingEnvironmentDigest: string;
  readonly toolSetSchemaDigest: string;
  readonly projectionContractId: string;
  readonly cacheEpochId: string;
  readonly committedAtTurnIndex: number;
}

export interface ContextPrimaryRequestEvidenceV2 {
  readonly version: 2;
  readonly purpose: 'primary';
  readonly terminalBatchId: string;
  readonly requestId: string;
  readonly effectLeaseId: string;
  readonly reservationId: string;
  readonly preparedDigest: string;
  readonly sourceIdentityDigest: string;
  readonly requestIdentityDigest: string;
  readonly finalProviderPayloadDigest: string;
  readonly admittedRequestDigest: string;
  readonly reclaimReceiptDigest: 'none' | string;
}

export interface ContextReclaimAppliedReceiptV1 {
  readonly version: 1;
  readonly terminalBatchId: string;
  readonly previousCommitDigest: 'none' | string;
  readonly effectiveProjectionDigest: string;
  readonly sourceIdentityDigest: string;
  readonly requestIdentityDigest: string;
  readonly proposedCommitDigest: string;
  readonly admittedRequestDigest: string;
  readonly responseMessageId: string;
  readonly receiptDigest: string;
}

export interface ContextReclaimCommitAdvancedEventV1 {
  readonly type: 'context.reclaim_commit_advanced';
  readonly terminalBatchId: string;
  readonly commit: ContextReclaimCommitV1;
  readonly commitDigest: string;
  readonly receipt: ContextReclaimAppliedReceiptV1;
}

export function digestContextReclaimCommitV1(commit: ContextReclaimCommitV1): string {
  return canonicalContextDigestV2('context-reclaim-commit:v1', commit);
}

export function digestContextSourceIdentityV2(identity: ProjectionSourceIdentityV2): string {
  return canonicalContextDigestV2('context-source-identity:v2', identity);
}

export function digestContextRequestIdentityV2(identity: RequestAdmissionIdentityV2): string {
  return canonicalContextDigestV2('context-request-identity:v2', identity);
}

function cacheEpochId(input: {
  prepared: PreparedContextRequestReadyV2;
  toolSetSchemaDigest: string;
}): string {
  return canonicalContextDigestV2('context-cache-epoch:v1', {
    checkpointIdentity: input.prepared.sourceIdentity.checkpointIdentity ?? null,
    toolResultBudgetPolicyId: input.prepared.sourceIdentity.toolResultBudgetPolicyId,
    reclaimPolicyId: input.prepared.sourceIdentity.reclaimPolicyId,
    estimatorId: input.prepared.sourceIdentity.estimatorId,
    toolSetSchemaDigest: input.toolSetSchemaDigest,
    projectionContractId: input.prepared.sourceIdentity.projectionContractId,
    cacheAffectingEnvironmentDigest: input.prepared.sourceIdentity.cacheAffectingEnvironmentDigest,
  });
}

export function proposeContextReclaimCommitV1(input: {
  state: Readonly<RuntimeState>;
  prepared: PreparedContextRequestReadyV2;
  plan: ReclaimPlanV1;
}): ContextReclaimCommitV1 {
  if (input.prepared.reclaimApplication.kind !== 'applied_plan') {
    throw new Error('Only an applied L2 plan can propose a reclaim commit.');
  }
  const planDigest = canonicalContextDigestV2('context-reclaim-plan:v2', input.plan);
  if (planDigest !== input.prepared.reclaimApplication.planDigest) {
    throw new Error('Prepared reclaim evidence does not match its plan.');
  }
  if (input.plan.appliedFramesDigest !== input.prepared.reclaimApplication.appliedFramesDigest) {
    throw new Error('Prepared applied frames do not match the reclaim plan.');
  }
  const selectedCoverageDigest = canonicalContextDigestV2(
    'context-reclaim-selected-coverage:v2',
    input.plan.selected,
  );
  if (selectedCoverageDigest !== input.prepared.reclaimApplication.selectedCoverageDigest) {
    throw new Error('Prepared selected coverage does not match the reclaim plan.');
  }
  const lastSelected = input.plan.selected.at(-1);
  if (!lastSelected) throw new Error('A reclaim commit requires selected coverage.');
  const selectedCallIds = new Set(input.plan.selected.map((entry) => entry.toolCallId));
  const settledMessage = [...input.state.transcript.messages]
    .reverse()
    .find(
      (message) =>
        message.kind === 'tool' &&
        selectedCallIds.has(message.toolCallId) &&
        message.turnId === lastSelected.turnId,
    );
  if (!settledMessage?.messageId || !settledMessage.turnId) {
    throw new Error('Reclaim coverage has no canonical settled transcript boundary.');
  }
  return Object.freeze({
    version: 1 as const,
    policyId: input.plan.policyId,
    toolResultBudgetPolicyId: input.prepared.sourceIdentity.toolResultBudgetPolicyId,
    settledThroughMessageId: settledMessage.messageId,
    settledThroughTurnId: settledMessage.turnId,
    ...(input.prepared.sourceIdentity.checkpointIdentity
      ? {
          checkpointIdentity: input.prepared.sourceIdentity.checkpointIdentity,
        }
      : {}),
    rawFramesDigest: input.plan.rawFramesDigest,
    appliedFramesDigest: input.plan.appliedFramesDigest,
    selectedCoverageDigest,
    selectedBlockCount: input.plan.selectedBlockCount,
    selectedCallCount: input.plan.selected.length,
    estimatorId: input.plan.estimatorId,
    projectionEnvironmentDigest: input.prepared.sourceIdentity.projectionEnvironmentDigest,
    cacheAffectingEnvironmentDigest: input.prepared.sourceIdentity.cacheAffectingEnvironmentDigest,
    toolSetSchemaDigest: input.prepared.requestIdentity.toolSetSchemaDigest,
    projectionContractId: input.prepared.sourceIdentity.projectionContractId,
    cacheEpochId: cacheEpochId({
      prepared: input.prepared,
      toolSetSchemaDigest: input.prepared.requestIdentity.toolSetSchemaDigest,
    }),
    committedAtTurnIndex: input.state.turn.turnIndex,
  });
}

export function createContextPrimarySuccessBranchV2(input: {
  prepared: PreparedContextRequestReadyV2;
  requestId: string;
  effectLeaseId: string;
  reservationId: string;
  admittedRequestDigest: string;
  response: Omit<Extract<RuntimeEvent, { type: 'model.responded' }>, 'contextEvidence'>;
  reconciliation: Omit<
    Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }>,
    'terminalBatchId'
  >;
  terminalBatchId: string;
  previousCommit?: ContextReclaimCommitV1;
  proposedCommit?: ContextReclaimCommitV1;
}): RuntimeEvent[] {
  if (input.prepared.purpose !== 'normal' || input.prepared.next.kind !== 'primary_ready') {
    throw new Error('Only a successful primary request can own a reclaim commit.');
  }
  if (input.reconciliation.reservationId !== input.reservationId) {
    throw new Error('Primary reconciliation does not match its reservation.');
  }
  const sourceIdentityDigest = digestContextSourceIdentityV2(input.prepared.sourceIdentity);
  const requestIdentityDigest = digestContextRequestIdentityV2(input.prepared.requestIdentity);
  let advance: ContextReclaimCommitAdvancedEventV1 | undefined;
  if (input.proposedCommit) {
    const proposedCommitDigest = digestContextReclaimCommitV1(input.proposedCommit);
    const receiptWithoutDigest = {
      version: 1 as const,
      terminalBatchId: input.terminalBatchId,
      previousCommitDigest: input.previousCommit
        ? digestContextReclaimCommitV1(input.previousCommit)
        : ('none' as const),
      effectiveProjectionDigest: input.prepared.effectiveProjection.projectionDigest,
      sourceIdentityDigest,
      requestIdentityDigest,
      proposedCommitDigest,
      admittedRequestDigest: input.admittedRequestDigest,
      responseMessageId: input.response.messageId,
    };
    const receipt: ContextReclaimAppliedReceiptV1 = Object.freeze({
      ...receiptWithoutDigest,
      receiptDigest: canonicalContextDigestV2(
        'context-reclaim-applied-receipt:v1',
        receiptWithoutDigest,
      ),
    });
    advance = {
      type: 'context.reclaim_commit_advanced',
      terminalBatchId: input.terminalBatchId,
      commit: input.proposedCommit,
      commitDigest: proposedCommitDigest,
      receipt,
    };
  }
  const contextEvidence: ContextPrimaryRequestEvidenceV2 = Object.freeze({
    version: 2 as const,
    purpose: 'primary' as const,
    terminalBatchId: input.terminalBatchId,
    requestId: input.requestId,
    effectLeaseId: input.effectLeaseId,
    reservationId: input.reservationId,
    preparedDigest: input.prepared.preparedDigest,
    sourceIdentityDigest,
    requestIdentityDigest,
    finalProviderPayloadDigest: input.prepared.requestIdentity.finalProviderPayloadDigest,
    admittedRequestDigest: input.admittedRequestDigest,
    reclaimReceiptDigest: advance?.receipt.receiptDigest ?? 'none',
  });
  return [
    { ...input.response, contextEvidence },
    ...(advance ? [advance] : []),
    {
      ...input.reconciliation,
      terminalBatchId: input.terminalBatchId,
    },
  ];
}

function receiptDigest(receipt: ContextReclaimAppliedReceiptV1): string {
  const { receiptDigest: _ignored, ...body } = receipt;
  return canonicalContextDigestV2('context-reclaim-applied-receipt:v1', body);
}

export function assertContextPrimarySuccessBatchV2(
  events: readonly RuntimeEvent[],
  state: Readonly<RuntimeState>,
): void {
  const ownsContextBranch = events.some(
    (event) =>
      (event.type === 'model.responded' && event.contextEvidence != null) ||
      event.type === 'context.reclaim_commit_advanced' ||
      (event.type === 'resource_budget.reconciled' && event.terminalBatchId != null),
  );
  if (!ownsContextBranch) return;
  if (events.length !== 2 && events.length !== 3) {
    throw new Error('Primary success must be one closed 2/3-event branch.');
  }
  const [response, middleOrReconciliation, maybeReconciliation] = events;
  if (response?.type !== 'model.responded' || !response.contextEvidence) {
    throw new Error('Primary success must start with bounded response evidence.');
  }
  const evidence = response.contextEvidence;
  const toolCalls = response.toolCalls ?? [];
  const ownedToolQueue = response.ownedToolQueue ?? [];
  if (
    toolCalls.length !== ownedToolQueue.length ||
    toolCalls.some(
      (call, index) =>
        ownedToolQueue[index]?.toolCallId !== call.id ||
        ownedToolQueue[index]?.name !== call.name ||
        ownedToolQueue[index]?.modelMessageId !== response.messageId ||
        ownedToolQueue[index]?.ordinal !== index,
    ) ||
    new Set(ownedToolQueue.map((queued) => queued.toolCallId)).size !== ownedToolQueue.length
  ) {
    throw new Error('Primary response does not own its exact queued tool facts.');
  }
  const reconciliation = maybeReconciliation ?? middleOrReconciliation;
  if (
    reconciliation?.type !== 'resource_budget.reconciled' ||
    reconciliation.terminalBatchId !== evidence.terminalBatchId ||
    reconciliation.reservationId !== evidence.reservationId
  ) {
    throw new Error('Primary success must end with its exact reconciliation.');
  }
  if (evidence.reclaimReceiptDigest === 'none') {
    if (events.length !== 2) {
      throw new Error('A no-commit primary branch cannot carry a reclaim event.');
    }
    return;
  }
  if (events.length !== 3 || middleOrReconciliation?.type !== 'context.reclaim_commit_advanced') {
    throw new Error('A reclaim receipt requires exactly one adjacent advance.');
  }
  const advance = middleOrReconciliation;
  if (
    advance.terminalBatchId !== evidence.terminalBatchId ||
    advance.receipt.terminalBatchId !== evidence.terminalBatchId ||
    advance.receipt.responseMessageId !== response.messageId ||
    advance.receipt.admittedRequestDigest !== evidence.admittedRequestDigest ||
    advance.receipt.sourceIdentityDigest !== evidence.sourceIdentityDigest ||
    advance.receipt.requestIdentityDigest !== evidence.requestIdentityDigest ||
    advance.receipt.effectiveProjectionDigest.length !== 64 ||
    advance.receipt.receiptDigest !== evidence.reclaimReceiptDigest ||
    receiptDigest(advance.receipt) !== advance.receipt.receiptDigest ||
    digestContextReclaimCommitV1(advance.commit) !== advance.commitDigest ||
    advance.receipt.proposedCommitDigest !== advance.commitDigest ||
    advance.receipt.previousCommitDigest !==
      (state.context.reclaimCommit
        ? digestContextReclaimCommitV1(state.context.reclaimCommit)
        : 'none')
  ) {
    throw new Error('Primary reclaim receipt or commit identity mismatch.');
  }
  const previous = state.context.reclaimCommit;
  if (previous) {
    const previousIndex = state.transcript.messages.findIndex(
      (message) => message.messageId === previous.settledThroughMessageId,
    );
    const nextIndex = state.transcript.messages.findIndex(
      (message) => message.messageId === advance.commit.settledThroughMessageId,
    );
    if (previousIndex < 0 || nextIndex <= previousIndex) {
      throw new Error('Reclaim commit boundary must move strictly forward.');
    }
  }
}

export function validateRestoredContextReclaimStateV1(state: Readonly<RuntimeState>): void {
  if (state.context.pendingPrimaryReclaim) {
    throw new Error('Persisted context state contains an incomplete primary branch.');
  }
  const commit = state.context.reclaimCommit;
  const receipt = state.context.lastReclaimReceipt;
  if (!commit && !receipt) return;
  if (
    !commit ||
    !receipt ||
    digestContextReclaimCommitV1(commit) !== receipt.proposedCommitDigest ||
    receiptDigest(receipt) !== receipt.receiptDigest ||
    receipt.effectiveProjectionDigest.length !== 64 ||
    receipt.sourceIdentityDigest.length !== 64 ||
    receipt.requestIdentityDigest.length !== 64 ||
    receipt.admittedRequestDigest.length !== 64 ||
    !Number.isInteger(commit.selectedBlockCount) ||
    commit.selectedBlockCount <= 0 ||
    !Number.isInteger(commit.selectedCallCount) ||
    commit.selectedCallCount < commit.selectedBlockCount ||
    commit.selectedCoverageDigest.length !== 64 ||
    !state.transcript.messages.some(
      (message) =>
        message.messageId === commit.settledThroughMessageId &&
        message.turnId === commit.settledThroughTurnId &&
        message.kind === 'tool',
    )
  ) {
    throw new Error('Persisted reclaim commit lacks its exact applied receipt.');
  }
}
