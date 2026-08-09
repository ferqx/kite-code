import { createHash } from 'node:crypto';
import type { BaseMessage } from '@/core/messages';
import { countTokens } from '@/core/token-counter';
import type { ContextPreflight, ContextPressure, ContextTokenEstimate } from './context-budget';
import type { ContextFrame, FrameToolResult, ToolCallBlockFrame } from './context-frame';
import { isToolCallBlockFrame } from './context-frame';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';

export const RECLAIM_ESTIMATOR_ID_V1 = 'kite-count-tokens:v1' as const;
export type ContextReclaimModeV1 = 'off' | 'shadow';

export function resolveContextReclaimModeV1(input: {
  featureEnabled: boolean;
  configuredMode?: ContextReclaimModeV1;
}): ContextReclaimModeV1 {
  return input.featureEnabled ? (input.configuredMode ?? 'off') : 'off';
}

export interface ReclaimPolicyV1 {
  version: 1;
  policyId: 'context-reclaim:v1';
  estimatorId: typeof RECLAIM_ESTIMATOR_ID_V1;
  eligibleTools: readonly ['read_file', 'search_content', 'search_files'];
}

export const RECLAIM_POLICY_V1: Readonly<ReclaimPolicyV1> = Object.freeze({
  version: 1,
  policyId: 'context-reclaim:v1',
  estimatorId: RECLAIM_ESTIMATOR_ID_V1,
  eligibleTools: Object.freeze(['read_file', 'search_content', 'search_files'] as const),
});

export type ReclaimEligibilityReasonV1 =
  | 'invalid_pairing'
  | 'current_turn'
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

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function digestFrames(frames: readonly ContextFrame[]): string {
  return digest({ schema: 'context-frames:v1', frames });
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
): ReclaimEligibilityReasonV1 | undefined {
  if (input.activeTurnId && frame.turnId === input.activeTurnId) return 'current_turn';
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
        call.resultMeta?.digestScope !== 'raw' && call.resultMeta?.digestScope !== 'projected',
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
        createHash('sha256').update(call.content).digest('hex') !==
        call.resultMeta?.modelContentDigest,
    )
  ) {
    return 'model_content_digest_mismatch';
  }
  if (frame.calls.some((call) => !hasStableLocator(call))) return 'missing_locator';
  if (
    frame.calls.some((call) => {
      const stub = reclaimStubV1({
        tool: call.name as ReclaimSelectedEntryV1['name'],
        originalChars: call.content.length,
      });
      return (
        countTokens(call.content) - countTokens(stub) <= 0 || stub.length >= call.content.length
      );
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
              content: reclaimStubV1({ tool: entry.name, originalChars: entry.originalChars }),
            }
          : call;
      }),
    };
  });
}

export function planContextReclaim(input: PlanContextReclaimInputV1): ReclaimPlanV1 {
  const rawFramesDigest = digestFrames(input.frames);
  const selected: ReclaimSelectedEntryV1[] = [];
  const rejectionCounts: ReclaimRejectionCountsV1 = {};
  let estimatedSavedChars = 0;
  let estimatedSavedTokens = 0;
  let selectedBlockCount = 0;

  try {
    validateFramePairs([...input.frames]);
    validateMessagePairs(serializeFramesToMessages([...input.frames]));
  } catch {
    for (const frame of input.frames) {
      if (isToolCallBlockFrame(frame)) incrementReason(rejectionCounts, 'invalid_pairing');
    }
    return {
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
  }

  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex++) {
    const frame = input.frames[frameIndex]!;
    if (!isToolCallBlockFrame(frame)) continue;
    const rejection = blockRejectionReason(frame, input);
    if (rejection) {
      incrementReason(rejectionCounts, rejection);
      continue;
    }
    selectedBlockCount++;
    for (const call of frame.calls) {
      const name = call.name as ReclaimSelectedEntryV1['name'];
      const originalChars = call.content.length;
      const stub = reclaimStubV1({ tool: name, originalChars });
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
      estimatedSavedTokens += countTokens(call.content) - countTokens(stub);
    }
  }

  const appliedFrames = framesWithPlannedStubs(input.frames, selected);
  return {
    version: 1,
    policyId: RECLAIM_POLICY_V1.policyId,
    policyVersion: RECLAIM_POLICY_V1.version,
    estimatorId: RECLAIM_POLICY_V1.estimatorId,
    rawProjectionDigest: input.rawProjectionDigest,
    rawFramesDigest,
    appliedFramesDigest: digestFrames(appliedFrames),
    environmentDigest: input.environmentDigest,
    pressure: input.pressure,
    checkpointBoundary: input.checkpointBoundary ?? null,
    selected,
    selectedBlockCount,
    estimatedSavedChars,
    estimatedSavedTokens,
    rejectionCounts,
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
    const stub = reclaimStubV1({ tool: entry.name, originalChars: entry.originalChars });
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
    return { status: 'rejected', reason: 'plan_header_mismatch', frames: inputFrames };
  }
  if (!selectedBlocksAreComplete(inputFrames, plan)) {
    return { status: 'rejected', reason: 'plan_structure_mismatch', frames: inputFrames };
  }
  const inputDigest = digestFrames(inputFrames);
  if (inputDigest === plan.appliedFramesDigest) {
    if (selectedEntriesMatch(inputFrames, plan, 'applied') && validatedFrames(inputFrames)) {
      return { status: 'already_applied', frames: inputFrames };
    }
    return { status: 'rejected', reason: 'selected_entry_mismatch', frames: inputFrames };
  }
  if (inputDigest !== plan.rawFramesDigest) {
    return { status: 'rejected', reason: 'raw_frames_mismatch', frames: inputFrames };
  }
  if (!selectedEntriesMatch(inputFrames, plan, 'raw')) {
    return { status: 'rejected', reason: 'selected_entry_mismatch', frames: inputFrames };
  }
  const applied = framesWithPlannedStubs(inputFrames, plan.selected);
  if (digestFrames(applied) !== plan.appliedFramesDigest || !validatedFrames(applied)) {
    return { status: 'rejected', reason: 'applied_frames_mismatch', frames: inputFrames };
  }
  return { status: 'applied', frames: applied };
}
