import { createHash } from 'node:crypto';
import type { BaseMessage } from '@/core/messages';
import type { ContextCompactionCheckpoint } from '@/core/runtime/context-compaction';
import type { RuntimeState } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import type { ContextPreflight, ContextTokenEstimate } from './context-budget';
import { estimateContextTokens, preflightModelContext } from './context-budget';
import { type ContextFrame, isToolCallBlockFrame } from './context-frame';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from './context-projection';
import {
  type ContextReclaimModeV1,
  digestContextFramesV1,
  digestRawContextProjection,
  digestValidatedAppliedContextFramesV1,
  planAndApplyValidatedContextReclaim,
  type ReclaimPlanV1,
  reclaimStubV1,
} from './context-reclaim';
import type { ContextReclaimCommitV1 } from './context-reclaim-commit';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';
import type { ResolvedModelCapabilities } from './model-capabilities';

export const CONTEXT_PROJECTION_CONTRACT_V2 = 'prepared-context-request:v2' as const;
export const CONTEXT_ESTIMATOR_ID_V2 = 'kite-count-tokens:v1' as const;

export const CONTEXT_RECLAIM_LIVE_POLICY_V2 = Object.freeze({
  version: 2 as const,
  policyId: 'context-reclaim-live:v2' as const,
  minEstimatedSavedTokens: 1_024,
  minSavingRatio: 0.05,
  minSelectedBlockCount: 2,
});

export type ContextPreparationPurposeV2 =
  | 'normal'
  | 'context_inspection'
  | 'candidate_validation'
  | 'restore_debug'
  | 'summary_source';

export type PreparedContextNextV2 =
  | { kind: 'primary_ready' }
  | { kind: 'summary_ready' }
  | { kind: 'summary_input_too_large' }
  | { kind: 'candidate_ready' }
  | { kind: 'candidate_invalid'; reason: string }
  | { kind: 'diagnostic_only' }
  | { kind: 'correctness_blocked'; reason: string };

export interface ProjectionSourceIdentityV2 {
  projectionSourceRevision: number;
  sourceTurnId: string;
  checkpointIdentity?: string;
  transcriptPrefixDigest: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  projectionContractId: typeof CONTEXT_PROJECTION_CONTRACT_V2;
  toolResultBudgetPolicyId: string;
  reclaimPolicyId: string;
  estimatorId: typeof CONTEXT_ESTIMATOR_ID_V2;
}

export interface RequestAdmissionIdentityV2 {
  purpose: ContextPreparationPurposeV2;
  finalProviderPayloadDigest: string;
  toolSetSchemaDigest: string;
  promptAffectingParametersDigest: string;
  requestedMaxOutputTokens: number;
}

export interface ProjectionArtifactV2 {
  readonly frames: readonly ContextFrame[];
  readonly providerMessages: readonly BaseMessage[];
  readonly estimate: Readonly<ContextTokenEstimate>;
  readonly preflight: Readonly<ContextPreflight>;
  readonly framesDigest: string;
  readonly providerPayloadDigest: string;
  readonly projectionDigest: string;
}

export type ReclaimApplicationEvidenceV2 =
  | { kind: 'off'; rawFramesDigest: string }
  | {
      kind: 'applied_commit';
      planDigest: string;
      commitDigest: string;
      appliedFramesDigest: string;
    }
  | {
      kind: 'applied_plan';
      planDigest: string;
      baseCommitDigest?: string;
      selectedCoverageDigest: string;
      appliedFramesDigest: string;
    }
  | {
      kind: 'valid_noop_plan';
      planDigest: string;
      appliedFramesDigest: string;
    }
  | {
      kind: 'raw_fallback';
      failure: 'ineligible' | 'plan_rejected' | 'apply_rejected';
      rawFramesDigest: string;
    };

interface PreparedContextRequestBaseV2 {
  readonly version: 2;
  readonly purpose: ContextPreparationPurposeV2;
  readonly sourceIdentity: Readonly<ProjectionSourceIdentityV2>;
  readonly preparedDigest: string;
  readonly next: Readonly<PreparedContextNextV2>;
}

export interface PreparedContextRequestReadyV2 extends PreparedContextRequestBaseV2 {
  readonly rawProjection: Readonly<ProjectionArtifactV2>;
  readonly reclaimApplication: Readonly<ReclaimApplicationEvidenceV2>;
  readonly effectiveProjection: Readonly<ProjectionArtifactV2>;
  readonly requestIdentity: Readonly<RequestAdmissionIdentityV2>;
  readonly canonicalProjectionIdentity: string;
  /** Bounded metadata-only candidate; never advances a durable watermark. */
  readonly proposedReclaimPlan?: Readonly<ReclaimPlanV1>;
}

export interface PreparedContextRequestBlockedV2 extends PreparedContextRequestBaseV2 {
  readonly next: Readonly<{
    kind: 'correctness_blocked';
    reason: string;
  }>;
}

export type PreparedContextRequestV2 =
  | PreparedContextRequestReadyV2
  | PreparedContextRequestBlockedV2;

export interface PrepareContextRequestV2Input {
  purpose: ContextPreparationPurposeV2;
  state: Readonly<RuntimeState>;
  environment: ContextProjectionEnvironment;
  capabilities: ResolvedModelCapabilities;
  requestedMaxOutputTokens: number;
  promptAffectingParameters: Readonly<Record<string, unknown>>;
  toolResultBudgetPolicyId: string;
  reclaimPolicyId: string;
  reclaimMode?: ContextReclaimModeV1;
  reclaimAfterEstimatedTokens?: number;
  candidateValid?: boolean;
  providerSafetyRatio?: number;
  compactRatio?: number;
  hardRatio?: number;
  warningRatio?: number;
  /**
   * Purpose-specific projection override. Compaction uses a settled source or
   * candidate checkpoint while retaining the immutable lease source identity.
   */
  candidateCheckpoint?: ContextCompactionCheckpoint;
  sourceIdentityState?: Readonly<RuntimeState>;
}

export function canonicalContextDigestV2(domain: string, value: unknown): string {
  const output = createHash('sha256').update(`${domain}\0`);
  const update = (candidate: unknown): void => {
    if (candidate === undefined) {
      output.update('null');
      return;
    }
    if (Array.isArray(candidate)) {
      output.update('[');
      candidate.forEach((entry, index) => {
        if (index > 0) output.update(',');
        update(entry);
      });
      output.update(']');
      return;
    }
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      output.update('{');
      let index = 0;
      for (const key of Object.keys(record)
        .filter((entry) => record[entry] !== undefined)
        .sort()) {
        if (index++ > 0) output.update(',');
        output.update(JSON.stringify(key));
        output.update(':');
        update(record[key]);
      }
      output.update('}');
      return;
    }
    output.update(JSON.stringify(candidate) ?? 'null');
  };
  update(value);
  return output.digest('hex');
}

function cloneAndDeepFreeze<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  return deepFreezeOwned(clone);
}

/** Freeze a Core-owned projection without cloning multi-megabyte immutable strings. */
function deepFreezeOwned<T>(value: T): Readonly<T> {
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) {
      freeze(child);
    }
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}

function projectionSourceIdentity(input: PrepareContextRequestV2Input): ProjectionSourceIdentityV2 {
  const identityState = input.sourceIdentityState ?? input.state;
  const checkpoint = identityState.context.activeCheckpoint;
  const transcriptPrefixIdentity = identityState.transcript.messages.map((message) => {
    const base = {
      kind: message.kind,
      messageId: message.messageId,
      turnId: message.turnId ?? null,
      ordinal: message.ordinal ?? null,
    };
    switch (message.kind) {
      case 'tool':
        return {
          ...base,
          toolCallId: message.toolCallId,
          name: message.name,
          ok: message.ok,
          modelContentDigest:
            message.resultMeta?.modelContentDigest ??
            canonicalContextDigestV2('context-transcript-tool-content:v2', message.content),
          modelContentUtf8Bytes: Buffer.byteLength(message.content, 'utf8'),
          terminalIdentity: message.resultMeta?.terminalIdentity ?? null,
        };
      case 'assistant':
        return {
          ...base,
          contentDigest: canonicalContextDigestV2(
            'context-transcript-assistant-content:v2',
            message.content ?? '',
          ),
          reasoningDigest: message.reasoningText
            ? canonicalContextDigestV2('context-transcript-reasoning:v2', message.reasoningText)
            : null,
          toolCalls: message.toolCalls,
        };
      case 'user':
      case 'runtime':
        return {
          ...base,
          contentDigest: canonicalContextDigestV2(
            'context-transcript-message-content:v2',
            message.content,
          ),
        };
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });
  return {
    projectionSourceRevision: identityState.revision,
    sourceTurnId: identityState.turn.turnId,
    ...(checkpoint
      ? {
          checkpointIdentity: canonicalContextDigestV2(
            'context-checkpoint-identity:v2',
            checkpoint,
          ),
        }
      : {}),
    transcriptPrefixDigest: canonicalContextDigestV2(
      'context-transcript-prefix:v2',
      transcriptPrefixIdentity,
    ),
    projectionEnvironmentDigest: digestProjectionEnvironment(input.environment),
    cacheAffectingEnvironmentDigest: digestCacheAffectingEnvironmentV2(
      input.environment,
      identityState,
    ),
    projectionContractId: CONTEXT_PROJECTION_CONTRACT_V2,
    toolResultBudgetPolicyId: input.toolResultBudgetPolicyId,
    reclaimPolicyId: input.reclaimPolicyId,
    estimatorId: CONTEXT_ESTIMATOR_ID_V2,
  };
}

export function digestCacheAffectingEnvironmentV2(
  environment: ContextProjectionEnvironment,
  state: Readonly<RuntimeState>,
): string {
  return canonicalContextDigestV2('context-cache-environment:v2', {
    serializedTools: environment.serializedTools,
    activeSkillInstructions: environment.activeSkillInstructions ?? null,
    workflowSkills: environment.workflowSkills,
    promptContractVersion: environment.promptContractVersion ?? 'legacy',
    projectInstructions: environment.projectInstructions ?? null,
    sandboxBackend: environment.sandboxBackend ?? 'unknown',
    runtime: {
      mode: state.mode,
      authorization: state.authorization,
      planning: state.planning,
      activeTaskId: state.activeTaskId,
    },
  });
}

/** Revalidate every non-incidental dependency without rebuilding provider bytes. */
export function assertPreparedContextCurrentV2(
  prepared: PreparedContextRequestReadyV2,
  input: PrepareContextRequestV2Input,
): void {
  const currentSource = {
    ...projectionSourceIdentity(input),
    projectionSourceRevision: prepared.sourceIdentity.projectionSourceRevision,
  };
  const currentRequest: RequestAdmissionIdentityV2 = {
    purpose: input.purpose,
    finalProviderPayloadDigest: canonicalContextDigestV2(
      'context-final-provider-payload:v2',
      prepared.effectiveProjection.providerMessages,
    ),
    toolSetSchemaDigest: canonicalContextDigestV2(
      'context-tool-set-schema:v2',
      input.environment.serializedTools,
    ),
    promptAffectingParametersDigest: canonicalContextDigestV2(
      'context-prompt-parameters:v2',
      input.promptAffectingParameters,
    ),
    requestedMaxOutputTokens: input.requestedMaxOutputTokens,
  };
  if (
    canonicalContextDigestV2('context-source-identity:v2', currentSource) !==
      canonicalContextDigestV2('context-source-identity:v2', prepared.sourceIdentity) ||
    canonicalContextDigestV2('context-request-identity:v2', currentRequest) !==
      canonicalContextDigestV2('context-request-identity:v2', prepared.requestIdentity)
  ) {
    throw new Error('Prepared context dependency identity is stale.');
  }
}

/**
 * Rebind one immutable projection to another non-Provider purpose without
 * cloning or rebuilding its multi-megabyte canonical source. The caller must
 * prove that both purposes cover the exact same transcript boundary.
 */
export function rebindPreparedContextPurposeV2(input: {
  prepared: PreparedContextRequestReadyV2;
  currentInput: PrepareContextRequestV2Input;
  purpose: Exclude<ContextPreparationPurposeV2, 'normal'>;
  requestedMaxOutputTokens: number;
  promptAffectingParameters: Readonly<Record<string, unknown>>;
  /**
   * A compact proof emitted by the Core-owned normal-source snapshot. This is
   * used only while the caller still owns the same immutable Runtime lease;
   * restore/replay never accepts it in place of recomputing durable bytes.
   */
  validatedNormalSource?: Readonly<{
    sourceIdentityDigest: string;
    requestIdentityDigest: string;
  }>;
}): PreparedContextRequestReadyV2 {
  if (input.prepared.purpose !== 'normal') {
    throw new Error('Only a normal prepared source can be rebound.');
  }
  if (input.validatedNormalSource) {
    if (
      input.validatedNormalSource.sourceIdentityDigest !==
        canonicalContextDigestV2('context-source-identity:v2', input.prepared.sourceIdentity) ||
      input.validatedNormalSource.requestIdentityDigest !==
        canonicalContextDigestV2('context-request-identity:v2', input.prepared.requestIdentity)
    ) {
      throw new Error('Validated normal-source proof does not match the prepared request.');
    }
  } else {
    assertPreparedContextCurrentV2(input.prepared, input.currentInput);
  }
  const purposeInput: PrepareContextRequestV2Input = {
    ...input.currentInput,
    purpose: input.purpose,
    requestedMaxOutputTokens: input.requestedMaxOutputTokens,
    promptAffectingParameters: input.promptAffectingParameters,
  };
  const reproject = (projection: ProjectionArtifactV2): ProjectionArtifactV2 => {
    const preflight = preflightModelContext({
      estimate: projection.estimate,
      capabilities: purposeInput.capabilities,
      requestMaxOutputTokens: purposeInput.requestedMaxOutputTokens,
      providerSafetyRatio: purposeInput.providerSafetyRatio,
      compactRatio: purposeInput.compactRatio,
      hardRatio: purposeInput.hardRatio,
      warningRatio: purposeInput.warningRatio,
    });
    return deepFreezeOwned({
      ...projection,
      preflight,
      projectionDigest: canonicalContextDigestV2('context-projection-artifact:v2', {
        framesDigest: projection.framesDigest,
        providerPayloadDigest: projection.providerPayloadDigest,
        estimate: projection.estimate,
        preflight,
      }),
    }) as Readonly<ProjectionArtifactV2>;
  };
  const rawProjection = reproject(input.prepared.rawProjection);
  const effectiveProjection = reproject(input.prepared.effectiveProjection);
  const requestIdentity = deepFreezeOwned({
    purpose: input.purpose,
    finalProviderPayloadDigest: effectiveProjection.providerPayloadDigest,
    toolSetSchemaDigest: input.prepared.requestIdentity.toolSetSchemaDigest,
    promptAffectingParametersDigest: canonicalContextDigestV2(
      'context-prompt-parameters:v2',
      input.promptAffectingParameters,
    ),
    requestedMaxOutputTokens: input.requestedMaxOutputTokens,
  });
  const reclaimApplication = input.prepared.reclaimApplication;
  const canonicalProjectionIdentity = canonicalContextDigestV2('canonical-context-projection:v2', {
    sourceIdentity: input.prepared.sourceIdentity,
    requestIdentity,
    rawProjectionDigest: rawProjection.projectionDigest,
    effectiveProjectionDigest: effectiveProjection.projectionDigest,
    reclaimApplication,
  });
  const next = deepFreezeOwned(purposeNext(purposeInput));
  const proposedPlan = input.prepared.proposedReclaimPlan;
  const preparedDigest = canonicalContextDigestV2('prepared-context-request:v2', {
    purpose: input.purpose,
    sourceIdentity: input.prepared.sourceIdentity,
    requestIdentity,
    canonicalProjectionIdentity,
    reclaimApplication,
    next,
    proposedPlanDigest: proposedPlan
      ? canonicalContextDigestV2('context-reclaim-plan:v2', proposedPlan)
      : null,
  });
  return deepFreezeOwned({
    version: 2 as const,
    purpose: input.purpose,
    sourceIdentity: input.prepared.sourceIdentity,
    rawProjection,
    reclaimApplication,
    effectiveProjection,
    requestIdentity,
    canonicalProjectionIdentity,
    next,
    ...(proposedPlan ? { proposedReclaimPlan: proposedPlan } : {}),
    preparedDigest,
  }) as PreparedContextRequestReadyV2;
}

function projectionArtifact(input: {
  frames: ContextFrame[];
  providerMessages: BaseMessage[];
  estimate: ContextTokenEstimate;
  preflight: ContextPreflight;
  framesDigest?: string;
}): ProjectionArtifactV2 {
  const framesDigest = input.framesDigest ?? digestContextFramesV1(input.frames);
  const providerPayloadDigest = canonicalContextDigestV2(
    'context-final-provider-payload:v2',
    input.providerMessages,
  );
  const projectionDigest = canonicalContextDigestV2('context-projection-artifact:v2', {
    framesDigest,
    providerPayloadDigest,
    estimate: input.estimate,
    preflight: input.preflight,
  });
  return deepFreezeOwned({
    ...input,
    framesDigest,
    providerPayloadDigest,
    projectionDigest,
  }) as Readonly<ProjectionArtifactV2>;
}

function purposeNext(input: PrepareContextRequestV2Input): PreparedContextNextV2 {
  switch (input.purpose) {
    case 'normal':
      return { kind: 'primary_ready' };
    case 'candidate_validation':
      return input.candidateValid === false
        ? { kind: 'candidate_invalid', reason: 'candidate_validation_failed' }
        : { kind: 'candidate_ready' };
    case 'context_inspection':
    case 'restore_debug':
      return { kind: 'diagnostic_only' };
    case 'summary_source':
      return { kind: 'summary_ready' };
  }
}

function rebuildProjectionWithFrames(input: {
  raw: ReturnType<typeof buildContextProjection>;
  frames: ContextFrame[];
  environment: ContextProjectionEnvironment;
  capabilities: ResolvedModelCapabilities;
  requestedMaxOutputTokens: number;
  providerSafetyRatio?: number;
  compactRatio?: number;
  hardRatio?: number;
  warningRatio?: number;
  estimatedSavedTokens?: number;
  expectedFramesDigest?: string;
}): ProjectionArtifactV2 {
  validateFramePairs(input.frames);
  const transcriptMessages = serializeFramesToMessages(input.frames);
  validateMessagePairs(transcriptMessages);
  const providerMessages = [
    ...input.raw.systemMessages,
    ...input.raw.projectInstructionMessages,
    ...input.raw.summaryMessages,
    ...transcriptMessages,
    ...input.raw.dynamicRuntimeMessages,
  ];
  const estimate =
    input.estimatedSavedTokens === undefined
      ? estimateContextTokens({
          systemMessages: input.raw.systemMessages,
          transcriptMessages: [...input.raw.projectInstructionMessages, ...transcriptMessages],
          summaryMessages: input.raw.summaryMessages,
          dynamicRuntimeMessages: input.raw.dynamicRuntimeMessages,
          serializedTools: input.environment.serializedTools,
        })
      : {
          ...input.raw.estimate,
          transcriptTokens: Math.max(
            0,
            input.raw.estimate.transcriptTokens - input.estimatedSavedTokens,
          ),
          totalInputTokens: Math.max(
            0,
            input.raw.estimate.totalInputTokens - input.estimatedSavedTokens,
          ),
        };
  const preflight = preflightModelContext({
    estimate,
    capabilities: input.capabilities,
    requestMaxOutputTokens: input.requestedMaxOutputTokens,
    providerSafetyRatio: input.providerSafetyRatio,
    compactRatio: input.compactRatio,
    hardRatio: input.hardRatio,
    warningRatio: input.warningRatio,
  });
  return projectionArtifact({
    frames: input.frames,
    providerMessages,
    estimate,
    preflight,
    ...(input.expectedFramesDigest ? { framesDigest: input.expectedFramesDigest } : {}),
  });
}

function triggeredForReclaim(
  input: PrepareContextRequestV2Input,
  raw: ProjectionArtifactV2,
): boolean {
  const pressureTrigger =
    raw.preflight.usableInputTokens != null &&
    raw.preflight.status !== 'unknown' &&
    raw.preflight.status !== 'normal';
  const absoluteThreshold = input.reclaimAfterEstimatedTokens;
  const absoluteTrigger =
    typeof absoluteThreshold === 'number' &&
    Number.isFinite(absoluteThreshold) &&
    absoluteThreshold > 0 &&
    raw.estimate.totalInputTokens >= Math.floor(absoluteThreshold);
  return pressureTrigger || absoluteTrigger;
}

function committedReclaimApplication(input: {
  request: PrepareContextRequestV2Input;
  raw: ReturnType<typeof buildContextProjection>;
  rawProjection: ProjectionArtifactV2;
  commit: ContextReclaimCommitV1;
}): {
  evidence: ReclaimApplicationEvidenceV2;
  effective: ProjectionArtifactV2;
  selected: ReadonlyArray<ReclaimPlanV1['selected'][number]>;
} | null {
  const { request, raw, rawProjection, commit } = input;
  const environmentDigest = digestProjectionEnvironment(request.environment);
  const toolSetSchemaDigest = canonicalContextDigestV2(
    'context-tool-set-schema:v2',
    request.environment.serializedTools,
  );
  if (
    commit.version !== 1 ||
    commit.policyId !== 'context-reclaim:v1' ||
    commit.toolResultBudgetPolicyId !== request.toolResultBudgetPolicyId ||
    commit.estimatorId !== CONTEXT_ESTIMATOR_ID_V2 ||
    commit.projectionEnvironmentDigest !== environmentDigest ||
    commit.cacheAffectingEnvironmentDigest !==
      projectionSourceIdentity(request).cacheAffectingEnvironmentDigest ||
    commit.toolSetSchemaDigest !== toolSetSchemaDigest ||
    commit.projectionContractId !== CONTEXT_PROJECTION_CONTRACT_V2 ||
    commit.checkpointIdentity !== projectionSourceIdentity(request).checkpointIdentity
  ) {
    return null;
  }
  const currentPlan = planAndApplyValidatedContextReclaim({
    frames: rawProjection.frames,
    validatedRawFramesDigest: rawProjection.framesDigest,
    rawProjectionDigest: 'committed-replay',
    environmentDigest,
    pressure: rawProjection.preflight.status,
    ...(request.state.turn.status === 'active' ? { activeTurnId: request.state.turn.turnId } : {}),
  }).plan;
  const settledBoundary = request.state.transcript.messages.findIndex(
    (message) =>
      message.messageId === commit.settledThroughMessageId &&
      message.turnId === commit.settledThroughTurnId &&
      message.kind === 'tool',
  );
  if (settledBoundary < 0) return null;
  const toolMessagePositions = new Map(
    request.state.transcript.messages.flatMap((message, position) =>
      message.kind === 'tool' ? [[message.toolCallId, position] as const] : [],
    ),
  );
  const selected = currentPlan.selected.filter(
    (candidate) =>
      (toolMessagePositions.get(candidate.toolCallId) ?? Number.POSITIVE_INFINITY) <=
      settledBoundary,
  );
  if (
    selected.length !== commit.selectedCallCount ||
    new Set(selected.map((entry) => entry.frameIndex)).size !== commit.selectedBlockCount ||
    canonicalContextDigestV2('context-reclaim-selected-coverage:v2', selected) !==
      commit.selectedCoverageDigest
  ) {
    return null;
  }
  const selectedKeys = new Set(selected.map((entry) => `${entry.frameIndex}\0${entry.toolCallId}`));
  const selectedByFrameAndCall = new Map(
    selected.map((entry) => [`${entry.frameIndex}\0${entry.toolCallId}`, entry]),
  );
  const appliedFrames = rawProjection.frames.map((frame, frameIndex) => {
    if (!isToolCallBlockFrame(frame)) return frame;
    return {
      ...frame,
      calls: frame.calls.map((call) => {
        const entry = selectedByFrameAndCall.get(`${frameIndex}\0${call.toolCallId}`);
        return entry
          ? {
              ...call,
              content: JSON.stringify({
                version: 1,
                reclaimed: true,
                tool: entry.name,
                originalChars: entry.originalChars,
                replay: 'repeat_tool_call_with_original_arguments',
              }),
            }
          : call;
      }),
    };
  });
  const replayPlan: ReclaimPlanV1 = {
    ...currentPlan,
    selected,
    selectedBlockCount: new Set(selected.map((entry) => entry.frameIndex)).size,
    estimatedSavedChars: selected.reduce(
      (total, entry) =>
        total +
        Math.max(
          0,
          entry.originalChars -
            reclaimStubV1({
              tool: entry.name,
              originalChars: entry.originalChars,
            }).length,
        ),
      0,
    ),
    estimatedSavedTokens: selected.reduce((total, entry) => {
      const frame = rawProjection.frames[entry.frameIndex];
      const call =
        frame && isToolCallBlockFrame(frame)
          ? frame.calls.find((candidate) => candidate.toolCallId === entry.toolCallId)
          : undefined;
      return call
        ? total +
            countTokens(call.content) -
            countTokens(
              reclaimStubV1({
                tool: entry.name,
                originalChars: entry.originalChars,
              }),
            )
        : total;
    }, 0),
    appliedFramesDigest: digestValidatedAppliedContextFramesV1(
      rawProjection.framesDigest,
      selected,
    ),
  };
  if (selectedKeys.size !== selected.length) return null;
  const effective = rebuildProjectionWithFrames({
    raw,
    frames: appliedFrames,
    environment: request.environment,
    capabilities: request.capabilities,
    requestedMaxOutputTokens: request.requestedMaxOutputTokens,
    providerSafetyRatio: request.providerSafetyRatio,
    compactRatio: request.compactRatio,
    hardRatio: request.hardRatio,
    warningRatio: request.warningRatio,
    estimatedSavedTokens: replayPlan.estimatedSavedTokens,
    expectedFramesDigest: replayPlan.appliedFramesDigest,
  });
  return {
    evidence: {
      kind: 'applied_commit',
      planDigest: canonicalContextDigestV2('context-reclaim-plan:v2', replayPlan),
      commitDigest: canonicalContextDigestV2('context-reclaim-commit:v1', commit),
      appliedFramesDigest: replayPlan.appliedFramesDigest,
    },
    effective,
    selected,
  };
}

function resolveReclaimApplication(input: {
  request: PrepareContextRequestV2Input;
  raw: ReturnType<typeof buildContextProjection>;
  rawProjection: ProjectionArtifactV2;
}): {
  evidence: ReclaimApplicationEvidenceV2;
  effective: ProjectionArtifactV2;
  proposedPlan?: ReclaimPlanV1;
} {
  const { request, raw, rawProjection } = input;
  const mode = request.reclaimMode ?? 'off';
  if (mode === 'off') {
    return {
      evidence: { kind: 'off', rawFramesDigest: rawProjection.framesDigest },
      effective: rawProjection,
    };
  }
  const committed =
    mode === 'live' && request.state.context.reclaimCommit
      ? committedReclaimApplication({
          request,
          raw,
          rawProjection,
          commit: request.state.context.reclaimCommit,
        })
      : null;
  if (!triggeredForReclaim(request, rawProjection)) {
    if (committed) return committed;
    return {
      evidence: {
        kind: 'raw_fallback',
        failure: 'ineligible',
        rawFramesDigest: rawProjection.framesDigest,
      },
      effective: rawProjection,
    };
  }

  const environmentDigest = digestProjectionEnvironment(request.environment);
  const checkpointBoundary = request.state.context.activeCheckpoint?.coveredThroughMessageId;
  const rawProjectionDigest = digestRawContextProjection({
    providerMessages: rawProjection.providerMessages,
    estimate: rawProjection.estimate,
    environmentDigest,
    pressure: {
      status: rawProjection.preflight.status,
      ...(rawProjection.preflight.utilization != null
        ? { utilization: rawProjection.preflight.utilization }
        : {}),
      ...(rawProjection.preflight.usableInputTokens != null
        ? { usableInputTokens: rawProjection.preflight.usableInputTokens }
        : {}),
    },
    ...(checkpointBoundary ? { checkpointBoundary } : {}),
  });
  const planned = planAndApplyValidatedContextReclaim({
    frames: rawProjection.frames,
    validatedRawFramesDigest: rawProjection.framesDigest,
    rawProjectionDigest,
    environmentDigest,
    pressure: rawProjection.preflight.status,
    ...(checkpointBoundary ? { checkpointBoundary } : {}),
    ...(request.state.turn.status === 'active' ? { activeTurnId: request.state.turn.turnId } : {}),
  });
  const plan = planned.plan;
  const planDigest = canonicalContextDigestV2('context-reclaim-plan:v2', plan);
  const committedKeys = new Set(
    committed?.selected.map(
      (entry) => `${entry.assistantMessageId}\0${entry.turnId}\0${entry.toolCallId}`,
    ) ?? [],
  );
  const newEntries = plan.selected.filter(
    (entry) =>
      !committedKeys.has(`${entry.assistantMessageId}\0${entry.turnId}\0${entry.toolCallId}`),
  );
  if (committed && newEntries.length === 0) return committed;
  const newBlockCount = new Set(newEntries.map((entry) => entry.frameIndex)).size;
  const incrementalSavedTokens = committed
    ? newEntries.reduce((total, entry) => {
        const frame = rawProjection.frames[entry.frameIndex];
        const call =
          frame && isToolCallBlockFrame(frame)
            ? frame.calls.find((candidate) => candidate.toolCallId === entry.toolCallId)
            : undefined;
        return call
          ? total +
              countTokens(call.content) -
              countTokens(
                reclaimStubV1({
                  tool: entry.name,
                  originalChars: entry.originalChars,
                }),
              )
          : total;
      }, 0)
    : plan.estimatedSavedTokens;
  const incrementalSavingRatio =
    rawProjection.estimate.totalInputTokens > 0
      ? incrementalSavedTokens / rawProjection.estimate.totalInputTokens
      : 0;
  if (
    incrementalSavedTokens < CONTEXT_RECLAIM_LIVE_POLICY_V2.minEstimatedSavedTokens ||
    incrementalSavingRatio < CONTEXT_RECLAIM_LIVE_POLICY_V2.minSavingRatio ||
    (committed ? newBlockCount : plan.selectedBlockCount) <
      CONTEXT_RECLAIM_LIVE_POLICY_V2.minSelectedBlockCount
  ) {
    if (committed) return committed;
    return {
      evidence: {
        kind: 'raw_fallback',
        failure: 'plan_rejected',
        rawFramesDigest: rawProjection.framesDigest,
      },
      effective: rawProjection,
    };
  }
  if (mode === 'shadow') {
    return {
      evidence: {
        kind: 'valid_noop_plan',
        planDigest,
        appliedFramesDigest: rawProjection.framesDigest,
      },
      effective: rawProjection,
    };
  }

  const application = planned.application;
  if (application.status !== 'applied') {
    if (committed) return committed;
    return {
      evidence: {
        kind: 'raw_fallback',
        failure: 'apply_rejected',
        rawFramesDigest: rawProjection.framesDigest,
      },
      effective: rawProjection,
    };
  }
  const effective = rebuildProjectionWithFrames({
    raw,
    frames: application.frames,
    environment: request.environment,
    capabilities: request.capabilities,
    requestedMaxOutputTokens: request.requestedMaxOutputTokens,
    providerSafetyRatio: request.providerSafetyRatio,
    compactRatio: request.compactRatio,
    hardRatio: request.hardRatio,
    warningRatio: request.warningRatio,
    estimatedSavedTokens: plan.estimatedSavedTokens,
    expectedFramesDigest: plan.appliedFramesDigest,
  });
  const actualSaved = rawProjection.estimate.totalInputTokens - effective.estimate.totalInputTokens;
  const actualRatio =
    rawProjection.estimate.totalInputTokens > 0
      ? actualSaved / rawProjection.estimate.totalInputTokens
      : 0;
  if (
    actualSaved < CONTEXT_RECLAIM_LIVE_POLICY_V2.minEstimatedSavedTokens ||
    actualRatio < CONTEXT_RECLAIM_LIVE_POLICY_V2.minSavingRatio
  ) {
    if (committed) return committed;
    return {
      evidence: {
        kind: 'raw_fallback',
        failure: 'plan_rejected',
        rawFramesDigest: rawProjection.framesDigest,
      },
      effective: rawProjection,
    };
  }
  return {
    evidence: {
      kind: 'applied_plan',
      planDigest,
      selectedCoverageDigest: canonicalContextDigestV2(
        'context-reclaim-selected-coverage:v2',
        plan.selected,
      ),
      appliedFramesDigest: plan.appliedFramesDigest,
    },
    effective,
    proposedPlan: plan,
  };
}

/** Pure Slice-A request preparation. No lease, reservation, Store or Provider is accepted. */
export function prepareContextRequestV2(
  input: PrepareContextRequestV2Input,
): PreparedContextRequestV2 {
  const sourceIdentity = cloneAndDeepFreeze(projectionSourceIdentity(input));
  const blocked = (reason: string): PreparedContextRequestBlockedV2 => {
    const next = cloneAndDeepFreeze({
      kind: 'correctness_blocked' as const,
      reason,
    });
    const preparedDigest = canonicalContextDigestV2('prepared-context-request:v2', {
      purpose: input.purpose,
      sourceIdentity,
      next,
    });
    return cloneAndDeepFreeze({
      version: 2 as const,
      purpose: input.purpose,
      sourceIdentity,
      preparedDigest,
      next,
    }) as PreparedContextRequestBlockedV2;
  };

  const diagnosticWithoutProviderOutput =
    input.purpose === 'context_inspection' && input.requestedMaxOutputTokens === 0;
  if (
    !Number.isInteger(input.requestedMaxOutputTokens) ||
    input.requestedMaxOutputTokens < 0 ||
    (input.requestedMaxOutputTokens === 0 && !diagnosticWithoutProviderOutput)
  ) {
    return blocked('invalid_requested_max_output_tokens');
  }

  try {
    const raw = buildContextProjection({
      role: 'agent',
      state: input.state,
      serializedTools: input.environment.serializedTools,
      activeSkillInstructions: input.environment.activeSkillInstructions,
      workflowSkills: input.environment.workflowSkills,
      promptContractVersion: input.environment.promptContractVersion,
      projectInstructions: input.environment.projectInstructions,
      sandboxBackend: input.environment.sandboxBackend,
      candidateCheckpoint: input.candidateCheckpoint,
    });
    const rawPreflight = preflightModelContext({
      estimate: raw.estimate,
      capabilities: input.capabilities,
      requestMaxOutputTokens: input.requestedMaxOutputTokens,
      providerSafetyRatio: input.providerSafetyRatio,
      compactRatio: input.compactRatio,
      hardRatio: input.hardRatio,
      warningRatio: input.warningRatio,
    });
    const rawProjection = projectionArtifact({
      frames: raw.frames,
      providerMessages: raw.providerMessages,
      estimate: raw.estimate,
      preflight: rawPreflight,
    });
    const reclaim = resolveReclaimApplication({
      request: input,
      raw,
      rawProjection,
    });
    const reclaimApplication = cloneAndDeepFreeze(reclaim.evidence);
    const effectiveProjection = reclaim.effective;
    const requestIdentity = cloneAndDeepFreeze({
      purpose: input.purpose,
      finalProviderPayloadDigest: effectiveProjection.providerPayloadDigest,
      toolSetSchemaDigest: canonicalContextDigestV2(
        'context-tool-set-schema:v2',
        input.environment.serializedTools,
      ),
      promptAffectingParametersDigest: canonicalContextDigestV2(
        'context-prompt-parameters:v2',
        input.promptAffectingParameters,
      ),
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
    });
    const canonicalProjectionIdentity = canonicalContextDigestV2(
      'canonical-context-projection:v2',
      {
        sourceIdentity,
        requestIdentity,
        rawProjectionDigest: rawProjection.projectionDigest,
        effectiveProjectionDigest: effectiveProjection.projectionDigest,
        reclaimApplication,
      },
    );
    const next = cloneAndDeepFreeze(purposeNext(input));
    const body = {
      version: 2 as const,
      purpose: input.purpose,
      sourceIdentity,
      rawProjection,
      reclaimApplication,
      effectiveProjection,
      requestIdentity,
      canonicalProjectionIdentity,
      next,
      ...(reclaim.proposedPlan ? { proposedReclaimPlan: reclaim.proposedPlan } : {}),
    };
    const preparedDigest = canonicalContextDigestV2('prepared-context-request:v2', {
      purpose: input.purpose,
      sourceIdentity,
      requestIdentity,
      canonicalProjectionIdentity,
      reclaimApplication,
      next,
      proposedPlanDigest: reclaim.proposedPlan
        ? canonicalContextDigestV2('context-reclaim-plan:v2', reclaim.proposedPlan)
        : null,
    });
    return deepFreezeOwned({
      ...body,
      preparedDigest,
    }) as PreparedContextRequestReadyV2;
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'context_projection_failed');
  }
}
