import { createHash } from 'node:crypto';
import type { BaseMessage } from '@/core/messages';
import { countTokens } from '@/core/token-counter';
import type { ContextPreflight, ContextPressure, ContextTokenEstimate } from './context-budget';
import type { ContextFrame, FrameToolResult, ToolCallBlockFrame } from './context-frame';
import { isToolCallBlockFrame } from './context-frame';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';

export const RECLAIM_ESTIMATOR_ID_V1 = 'kite-count-tokens:v1' as const;
export type ContextReclaimModeV1 = 'off' | 'shadow' | 'live';

export function resolveContextReclaimModeV1(input: {
  featureEnabled: boolean;
  toolResultBudgetEnabled?: boolean;
  configuredMode?: ContextReclaimModeV1;
}): ContextReclaimModeV1 {
  if (!input.featureEnabled) return 'off';
  const mode = input.configuredMode ?? 'off';
  return mode === 'live' && input.toolResultBudgetEnabled !== true ? 'off' : mode;
}

export interface ReclaimPolicyV1 {
  version: 1;
  policyId: 'context-reclaim:v1';
  estimatorId: typeof RECLAIM_ESTIMATOR_ID_V1;
  eligibleTools: readonly ['read_file', 'search_content', 'search_files'];
  /** Keep the two most recent settled turns before the active turn byte-for-byte raw. */
  minSettledTurnAge: 2;
}

export const RECLAIM_POLICY_V1: Readonly<ReclaimPolicyV1> = Object.freeze({
  version: 1,
  policyId: 'context-reclaim:v1',
  estimatorId: RECLAIM_ESTIMATOR_ID_V1,
  eligibleTools: Object.freeze(['read_file', 'search_content', 'search_files'] as const),
  minSettledTurnAge: 2,
});

export type ReclaimEligibilityReasonV1 =
  | 'invalid_pairing'
  | 'current_turn'
  | 'recent_turn'
  | 'uncovered_tail'
  | 'missing_identity'
  | 'unsupported_or_mixed_tool'
  | 'unsuccessful_result'
  | 'not_read_only'
  | 'workspace_mutation'
  | 'legacy_provenance'
  | 'missing_model_content_digest'
  | 'model_content_digest_mismatch'
  | 'missing_locator'
  | 'no_positive_saving';

export type ReclaimRejectionCountsV1 = Partial<Record<ReclaimEligibilityReasonV1, number>>;

export interface ReclaimSelectedEntryV1 {
  frameIndex: number;
  assistantMessageId: string;
  turnId: string;
  toolCallId: string;
  name: 'read_file' | 'search_content' | 'search_files';
  modelContentDigest: string;
  originalChars: number;
  stubDigest: string;
}

export interface ReclaimPlanV1 {
  version: 1;
  policyId: ReclaimPolicyV1['policyId'];
  policyVersion: ReclaimPolicyV1['version'];
  estimatorId: typeof RECLAIM_ESTIMATOR_ID_V1;
  rawProjectionDigest: string;
  rawFramesDigest: string;
  appliedFramesDigest: string;
  environmentDigest: string;
  pressure: ContextPressure;
  checkpointBoundary: string | null;
  selected: ReclaimSelectedEntryV1[];
  selectedBlockCount: number;
  estimatedSavedChars: number;
  estimatedSavedTokens: number;
  rejectionCounts: ReclaimRejectionCountsV1;
}

export interface RawContextProjectionIdentityInputV1 {
  providerMessages: readonly BaseMessage[];
  estimate: ContextTokenEstimate;
  environmentDigest: string;
  pressure: Pick<ContextPreflight, 'status' | 'utilization' | 'usableInputTokens'>;
  checkpointBoundary?: string;
}

export interface PlanContextReclaimInputV1 {
  frames: readonly ContextFrame[];
  rawProjectionDigest: string;
  environmentDigest: string;
  pressure: ContextPressure;
  checkpointBoundary?: string;
  activeTurnId?: string;
  /**
   * A checkpoint projection exposes only its uncovered raw tail. That tail is
   * never eligible for MicroCompact; the verified checkpoint/working-set
   * selector owns any later overlap decision.
   */
  preserveUncoveredTail?: boolean;
}

export type ReclaimApplicationV1 =
  | { status: 'applied'; frames: ContextFrame[] }
  | { status: 'already_applied'; frames: ContextFrame[] }
  | {
      status: 'rejected';
      reason:
        | 'plan_header_mismatch'
        | 'plan_structure_mismatch'
        | 'raw_frames_mismatch'
        | 'selected_entry_mismatch'
        | 'applied_frames_mismatch';
      frames: ContextFrame[];
    };

const ELIGIBLE_TOOL_NAMES = new Set<string>(RECLAIM_POLICY_V1.eligibleTools);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

function recentSettledTurnIds(input: PlanContextReclaimInputV1): ReadonlySet<string> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const frame of input.frames) {
    const turnId = 'turnId' in frame ? frame.turnId : undefined;
    if (!turnId || turnId === input.activeTurnId || seen.has(turnId)) continue;
    seen.add(turnId);
    ordered.push(turnId);
  }
  return new Set(ordered.slice(-RECLAIM_POLICY_V1.minSettledTurnAge));
}

function digest(value: unknown): string {
  const output = createHash('sha256');
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

export function digestContextFramesV1(frames: readonly ContextFrame[]): string {
  const contentIdentity = (content: unknown): { bytes: number; digest: string } => {
    const bytes = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return {
      bytes: Buffer.byteLength(bytes, 'utf8'),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const messageIdentity = (message: BaseMessage): Record<string, unknown> => {
    const { content, ...metadata } = message as unknown as Record<string, unknown>;
    return { ...metadata, contentIdentity: contentIdentity(content) };
  };
  const compactFrames = frames.map((frame) => {
    switch (frame.kind) {
      case 'tool_block':
        return {
          ...frame,
          assistantMessage: messageIdentity(frame.assistantMessage),
          calls: frame.calls.map((call) => ({
            ...call,
            content: undefined,
            contentIdentity: contentIdentity(call.content),
          })),
        };
      case 'user':
      case 'assistant':
        return { ...frame, message: messageIdentity(frame.message) };
      case 'runtime':
      case 'compaction_summary':
        return {
          ...frame,
          content: undefined,
          contentIdentity: contentIdentity(frame.content),
        };
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  });
  return digest({ schema: 'context-frames:v1', frames: compactFrames });
}

/**
 * Exact identity for an applied projection derived from a previously validated
 * raw frame digest plus the complete ordered replacement set. The raw digest
 * binds every untouched byte; each replacement binds its original and stub.
 */
export function digestValidatedAppliedContextFramesV1(
  rawFramesDigest: string,
  selected: readonly ReclaimSelectedEntryV1[],
): string {
  return digest({
    schema: 'context-applied-frames-from-validated-raw:v1',
    rawFramesDigest,
    replacements: selected.map((entry) => ({
      frameIndex: entry.frameIndex,
      toolCallId: entry.toolCallId,
      modelContentDigest: entry.modelContentDigest,
      originalChars: entry.originalChars,
      stubDigest: entry.stubDigest,
    })),
  });
}

export function digestRawContextProjection(input: RawContextProjectionIdentityInputV1): string {
  return digest({
    schema: 'raw-context-projection:v1',
    providerMessages: input.providerMessages,
    estimate: input.estimate,
    environmentDigest: input.environmentDigest,
    pressure: input.pressure,
    checkpointBoundary: input.checkpointBoundary ?? null,
  });
}

export function reclaimStubV1(input: {
  tool: ReclaimSelectedEntryV1['name'];
  originalChars: number;
}): string {
  return JSON.stringify({
    version: 1,
    reclaimed: true,
    tool: input.tool,
    originalChars: input.originalChars,
    replay: 'repeat_tool_call_with_original_arguments',
  });
}

function incrementReason(
  counts: ReclaimRejectionCountsV1,
  reason: ReclaimEligibilityReasonV1,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function hasStableLocator(call: FrameToolResult): boolean {
  const args = asRecord(call.args);
  const meta = call.resultMeta;
  if (!args || !meta || typeof meta.path !== 'string' || meta.path.length === 0) return false;
  if (call.name === 'read_file') {
    return (
      typeof args.path === 'string' &&
      args.path.length > 0 &&
      args.path === meta.path &&
      validOptionalPositiveInteger(args.offset) &&
      validOptionalPositiveInteger(args.limit)
    );
  }
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) return false;
  if (call.name === 'search_content' && args.glob !== undefined && typeof args.glob !== 'string') {
    return false;
  }
  return true;
}

function assistantCallMatches(frame: ToolCallBlockFrame, call: FrameToolResult): boolean {
  const toolCalls = (frame.assistantMessage as unknown as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some((candidate) => {
    const record = asRecord(candidate);
    return record?.id === call.toolCallId && record.name === call.name;
  });
}

function blockRejectionReason(
  frame: ToolCallBlockFrame,
  input: PlanContextReclaimInputV1,
  recentTurnIds: ReadonlySet<string>,
): ReclaimEligibilityReasonV1 | undefined {
  if (input.activeTurnId && frame.turnId === input.activeTurnId) return 'current_turn';
  if (input.preserveUncoveredTail) return 'uncovered_tail';
  if (!frame.assistantMessageId || !frame.turnId) return 'missing_identity';
  if (frame.calls.length === 0 || frame.calls.some((call) => !ELIGIBLE_TOOL_NAMES.has(call.name))) {
    return 'unsupported_or_mixed_tool';
  }
  if (frame.calls.some((call) => !assistantCallMatches(frame, call))) return 'missing_identity';
  if (frame.calls.some((call) => !call.ok)) return 'unsuccessful_result';
  if (frame.calls.some((call) => call.effectClass !== 'read_only')) return 'not_read_only';
  if (frame.calls.some((call) => (call.resultMeta?.workspaceMutationScope?.length ?? 0) > 0)) {
    return 'workspace_mutation';
  }
  if (
    frame.calls.some(
      (call) =>
        (call.resultMeta?.digestScope !== 'raw' && call.resultMeta?.digestScope !== 'projected') ||
        call.resultMeta?.terminalMigration !== undefined ||
        call.resultMeta?.toolResultReceipt?.projectionMode !== 'budget_v2',
    )
  ) {
    return 'legacy_provenance';
  }
  if (frame.calls.some((call) => !DIGEST_PATTERN.test(call.resultMeta?.modelContentDigest ?? ''))) {
    return 'missing_model_content_digest';
  }
  if (
    frame.calls.some(
      (call) =>
        call.resultMeta?.toolResultReceipt?.modelContentDigest !==
          call.resultMeta?.modelContentDigest ||
        createHash('sha256').update(call.content).digest('hex') !==
          call.resultMeta?.modelContentDigest,
    )
  ) {
    return 'model_content_digest_mismatch';
  }
  if (frame.calls.some((call) => !hasStableLocator(call))) return 'missing_locator';
  if (recentTurnIds.has(frame.turnId)) return 'recent_turn';
  if (
    frame.calls.some((call) => {
      const stub = reclaimStubV1({
        tool: call.name as ReclaimSelectedEntryV1['name'],
        originalChars: call.content.length,
      });
      return stub.length >= call.content.length;
    })
  ) {
    return 'no_positive_saving';
  }
  return undefined;
}

function framesWithPlannedStubs(
  frames: readonly ContextFrame[],
  selected: readonly ReclaimSelectedEntryV1[],
): ContextFrame[] {
  const byFrame = new Map<number, Map<string, ReclaimSelectedEntryV1>>();
  for (const entry of selected) {
    const entries = byFrame.get(entry.frameIndex) ?? new Map<string, ReclaimSelectedEntryV1>();
    entries.set(entry.toolCallId, entry);
    byFrame.set(entry.frameIndex, entries);
  }
  return frames.map((frame, frameIndex) => {
    const entries = byFrame.get(frameIndex);
    if (!entries || !isToolCallBlockFrame(frame)) return frame;
    return {
      ...frame,
      calls: frame.calls.map((call) => {
        const entry = entries.get(call.toolCallId);
        return entry
          ? {
              ...call,
              content: reclaimStubV1({
                tool: entry.name,
                originalChars: entry.originalChars,
              }),
            }
          : call;
      }),
    };
  });
}

function planContextReclaimCore(
  input: PlanContextReclaimInputV1,
  options?: { validatedRawFramesDigest: string },
): { plan: ReclaimPlanV1; appliedFrames: ContextFrame[] } {
  const rawFramesDigest = options?.validatedRawFramesDigest ?? digestContextFramesV1(input.frames);
  const selected: ReclaimSelectedEntryV1[] = [];
  const rejectionCounts: ReclaimRejectionCountsV1 = {};
  let estimatedSavedChars = 0;
  let estimatedSavedTokens = 0;
  let selectedBlockCount = 0;
  const recentTurnIds = recentSettledTurnIds(input);

  try {
    if (!options) {
      validateFramePairs([...input.frames]);
      validateMessagePairs(serializeFramesToMessages([...input.frames]));
    }
  } catch {
    for (const frame of input.frames) {
      if (isToolCallBlockFrame(frame)) incrementReason(rejectionCounts, 'invalid_pairing');
    }
    const plan: ReclaimPlanV1 = {
      version: 1,
      policyId: RECLAIM_POLICY_V1.policyId,
      policyVersion: RECLAIM_POLICY_V1.version,
      estimatorId: RECLAIM_POLICY_V1.estimatorId,
      rawProjectionDigest: input.rawProjectionDigest,
      rawFramesDigest,
      appliedFramesDigest: rawFramesDigest,
      environmentDigest: input.environmentDigest,
      pressure: input.pressure,
      checkpointBoundary: input.checkpointBoundary ?? null,
      selected,
      selectedBlockCount,
      estimatedSavedChars,
      estimatedSavedTokens,
      rejectionCounts,
    };
    return { plan, appliedFrames: [...input.frames] };
  }

  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex++) {
    const frame = input.frames[frameIndex]!;
    if (!isToolCallBlockFrame(frame)) continue;
    const rejection = blockRejectionReason(frame, input, recentTurnIds);
    if (rejection) {
      incrementReason(rejectionCounts, rejection);
      continue;
    }
    const savings = frame.calls.map((call) => {
      const name = call.name as ReclaimSelectedEntryV1['name'];
      const originalChars = call.content.length;
      const stub = reclaimStubV1({ tool: name, originalChars });
      return {
        call,
        name,
        originalChars,
        stub,
        savedTokens: countTokens(call.content) - countTokens(stub),
      };
    });
    if (savings.some((saving) => saving.savedTokens <= 0)) {
      incrementReason(rejectionCounts, 'no_positive_saving');
      continue;
    }
    selectedBlockCount++;
    for (const { call, name, originalChars, stub, savedTokens } of savings) {
      selected.push({
        frameIndex,
        assistantMessageId: frame.assistantMessageId!,
        turnId: frame.turnId!,
        toolCallId: call.toolCallId,
        name,
        modelContentDigest: call.resultMeta!.modelContentDigest!,
        originalChars,
        stubDigest: digest(stub),
      });
      estimatedSavedChars += originalChars - stub.length;
      estimatedSavedTokens += savedTokens;
    }
  }

  const appliedFrames = framesWithPlannedStubs(input.frames, selected);
  const appliedFramesDigest = options
    ? digestValidatedAppliedContextFramesV1(rawFramesDigest, selected)
    : digestContextFramesV1(appliedFrames);
  const plan: ReclaimPlanV1 = {
    version: 1,
    policyId: RECLAIM_POLICY_V1.policyId,
    policyVersion: RECLAIM_POLICY_V1.version,
    estimatorId: RECLAIM_POLICY_V1.estimatorId,
    rawProjectionDigest: input.rawProjectionDigest,
    rawFramesDigest,
    appliedFramesDigest,
    environmentDigest: input.environmentDigest,
    pressure: input.pressure,
    checkpointBoundary: input.checkpointBoundary ?? null,
    selected,
    selectedBlockCount,
    estimatedSavedChars,
    estimatedSavedTokens,
    rejectionCounts,
  };
  return { plan, appliedFrames };
}

export function planContextReclaim(input: PlanContextReclaimInputV1): ReclaimPlanV1 {
  return planContextReclaimCore(input).plan;
}

/** Core-owned fast path for a projection already pair-validated and digested. */
export function planAndApplyValidatedContextReclaim(
  input: PlanContextReclaimInputV1 & { validatedRawFramesDigest: string },
): { plan: ReclaimPlanV1; application: ReclaimApplicationV1 } {
  const { validatedRawFramesDigest, ...planInput } = input;
  const built = planContextReclaimCore(planInput, {
    validatedRawFramesDigest,
  });
  return {
    plan: built.plan,
    application: {
      status: built.plan.selected.length > 0 ? 'applied' : 'already_applied',
      frames: built.appliedFrames,
    },
  };
}

function selectedEntriesMatch(
  frames: readonly ContextFrame[],
  plan: ReclaimPlanV1,
  state: 'raw' | 'applied',
): boolean {
  return plan.selected.every((entry) => {
    const frame = frames[entry.frameIndex];
    if (!frame || !isToolCallBlockFrame(frame)) return false;
    if (frame.assistantMessageId !== entry.assistantMessageId || frame.turnId !== entry.turnId) {
      return false;
    }
    const call = frame.calls.find((candidate) => candidate.toolCallId === entry.toolCallId);
    if (
      !call ||
      call.name !== entry.name ||
      call.resultMeta?.modelContentDigest !== entry.modelContentDigest
    ) {
      return false;
    }
    const stub = reclaimStubV1({
      tool: entry.name,
      originalChars: entry.originalChars,
    });
    if (digest(stub) !== entry.stubDigest) return false;
    return state === 'raw' ? call.content.length === entry.originalChars : call.content === stub;
  });
}

function planHeaderMatches(plan: ReclaimPlanV1): boolean {
  return (
    plan.version === 1 &&
    plan.policyId === RECLAIM_POLICY_V1.policyId &&
    plan.policyVersion === RECLAIM_POLICY_V1.version &&
    plan.estimatorId === RECLAIM_POLICY_V1.estimatorId
  );
}

function selectedBlocksAreComplete(frames: readonly ContextFrame[], plan: ReclaimPlanV1): boolean {
  const byFrame = new Map<number, ReclaimSelectedEntryV1[]>();
  let previousFrameIndex = -1;
  let previousCallIndex = -1;
  for (const entry of plan.selected) {
    const frame = frames[entry.frameIndex];
    if (!frame || !isToolCallBlockFrame(frame)) return false;
    const callIndex = frame.calls.findIndex((call) => call.toolCallId === entry.toolCallId);
    if (callIndex < 0) return false;
    if (
      entry.frameIndex < previousFrameIndex ||
      (entry.frameIndex === previousFrameIndex && callIndex <= previousCallIndex)
    ) {
      return false;
    }
    previousFrameIndex = entry.frameIndex;
    previousCallIndex = callIndex;
    const entries = byFrame.get(entry.frameIndex) ?? [];
    entries.push(entry);
    byFrame.set(entry.frameIndex, entries);
  }
  if (plan.selectedBlockCount !== byFrame.size) return false;
  for (const [frameIndex, entries] of byFrame) {
    const frame = frames[frameIndex];
    if (!frame || !isToolCallBlockFrame(frame) || entries.length !== frame.calls.length)
      return false;
    if (frame.calls.some((call, callIndex) => entries[callIndex]?.toolCallId !== call.toolCallId)) {
      return false;
    }
  }
  return true;
}

function validatedFrames(frames: ContextFrame[]): boolean {
  try {
    validateFramePairs(frames);
    validateMessagePairs(serializeFramesToMessages(frames));
    return true;
  } catch {
    return false;
  }
}

export function applyContextReclaimPlan(
  frames: readonly ContextFrame[],
  plan: ReclaimPlanV1,
): ReclaimApplicationV1 {
  const inputFrames = [...frames];
  if (!planHeaderMatches(plan)) {
    return {
      status: 'rejected',
      reason: 'plan_header_mismatch',
      frames: inputFrames,
    };
  }
  if (!selectedBlocksAreComplete(inputFrames, plan)) {
    return {
      status: 'rejected',
      reason: 'plan_structure_mismatch',
      frames: inputFrames,
    };
  }
  const inputDigest = digestContextFramesV1(inputFrames);
  if (inputDigest === plan.appliedFramesDigest) {
    if (selectedEntriesMatch(inputFrames, plan, 'applied') && validatedFrames(inputFrames)) {
      return { status: 'already_applied', frames: inputFrames };
    }
    return {
      status: 'rejected',
      reason: 'selected_entry_mismatch',
      frames: inputFrames,
    };
  }
  if (inputDigest !== plan.rawFramesDigest) {
    return {
      status: 'rejected',
      reason: 'raw_frames_mismatch',
      frames: inputFrames,
    };
  }
  if (!selectedEntriesMatch(inputFrames, plan, 'raw')) {
    return {
      status: 'rejected',
      reason: 'selected_entry_mismatch',
      frames: inputFrames,
    };
  }
  const applied = framesWithPlannedStubs(inputFrames, plan.selected);
  if (digestContextFramesV1(applied) !== plan.appliedFramesDigest || !validatedFrames(applied)) {
    return {
      status: 'rejected',
      reason: 'applied_frames_mismatch',
      frames: inputFrames,
    };
  }
  return { status: 'applied', frames: applied };
}

/** Reapply an in-memory plan to its already validated raw artifact without rescanning all bytes. */
export function applyValidatedContextReclaimPlan(
  frames: readonly ContextFrame[],
  plan: ReclaimPlanV1,
): ReclaimApplicationV1 {
  const inputFrames = [...frames];
  if (!planHeaderMatches(plan)) {
    return { status: 'rejected', reason: 'plan_header_mismatch', frames: inputFrames };
  }
  if (
    !selectedBlocksAreComplete(inputFrames, plan) ||
    !selectedEntriesMatch(inputFrames, plan, 'raw')
  ) {
    return { status: 'rejected', reason: 'selected_entry_mismatch', frames: inputFrames };
  }
  const applied = framesWithPlannedStubs(inputFrames, plan.selected);
  if (digestContextFramesV1(applied) !== plan.appliedFramesDigest) {
    return { status: 'rejected', reason: 'applied_frames_mismatch', frames: inputFrames };
  }
  return { status: 'applied', frames: applied };
}
