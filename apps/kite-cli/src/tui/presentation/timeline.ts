import type { OutputBlock } from '../types';

/**
 * The identity used by the presentation timeline. A block id is only a local
 * adapter identity; the additional fields preserve source identity when a
 * Runtime projection supplies one.
 */
export interface SourceIdentity {
  readonly blockId: number;
  readonly kind: TimelineItemKind;
  readonly callId?: string;
  readonly subagentId?: string;
  readonly messageId?: string;
}

export type TimelineItemKind =
  | 'user'
  | 'text'
  | 'thought'
  | 'tool'
  | 'subagent_group'
  | 'interaction'
  | 'file_change'
  | 'legacy_reason';

/** Render data is kept separate from the lifecycle state consumed by Ink. */
export interface TimelineRenderModel {
  readonly block: OutputBlock;
}

export type LiveTimelineItem = {
  readonly state: 'live';
  readonly id: string;
  readonly kind: TimelineItemKind;
  readonly sourceIdentity: SourceIdentity;
  readonly renderModel: TimelineRenderModel;
};

export type SealedTimelineItem = {
  readonly state: 'sealed';
  readonly id: string;
  readonly kind: TimelineItemKind;
  readonly sourceIdentity: SourceIdentity;
  readonly visualDigest: string;
  readonly renderModel: TimelineRenderModel;
};

export type TimelineItem = LiveTimelineItem | SealedTimelineItem;

export interface TimelineState {
  readonly renderEpoch: number;
  readonly items: readonly TimelineItem[];
}

/**
 * Presentation-only visibility projection used while a Footer interaction owns
 * the input surface.  The boundary is computed here, next to the canonical
 * Timeline items, so OutputArea never decides which business entities are
 * hidden by inspecting raw OutputBlock fields itself.
 */
export interface TimelineApprovalViewport {
  readonly visibleItems: readonly TimelineItem[];
  readonly hiddenItems: readonly TimelineItem[];
  readonly frontierIndex: number;
}

/**
 * Hide the mutable tail behind the focused approval interaction.  Queued
 * metadata remains off-screen; once an execution card is visible, only the
 * card immediately preceding the approval frontier is retained.  This is a
 * presentation projection, not a lifecycle transition: the source Timeline
 * item identities and sealed state are unchanged.
 */
export function projectApprovalViewport(
  items: readonly TimelineItem[],
  awaitingApproval = false,
): TimelineApprovalViewport {
  if (!awaitingApproval) {
    return { visibleItems: items, hiddenItems: [], frontierIndex: items.length };
  }

  const blockAt = (index: number): OutputBlock => items[index]!.renderModel.block;
  const pendingApprovalIndex = items.findIndex((item) => {
    const block = item.renderModel.block;
    return block.kind === 'approval' && block.resolved === undefined;
  });

  let frontierIndex = items.length;
  if (pendingApprovalIndex >= 0) {
    for (let index = pendingApprovalIndex - 1; index >= 0; index -= 1) {
      const block = blockAt(index);
      if (block.kind === 'tool_card' && (block.status === 'queued' || block.status === 'running')) {
        frontierIndex = index + 1;
        break;
      }
    }
    if (frontierIndex === items.length) frontierIndex = pendingApprovalIndex;
  } else {
    const approvalToolIndex = items.findIndex((item) => {
      const block = item.renderModel.block;
      return (
        block.kind === 'tool_card' && (block.status === 'queued' || block.status === 'running')
      );
    });
    if (approvalToolIndex >= 0) frontierIndex = approvalToolIndex + 1;
  }

  return {
    visibleItems: items.slice(0, frontierIndex),
    hiddenItems: items.slice(frontierIndex),
    frontierIndex,
  };
}

/**
 * Canonical serialization for every field that can reach a TUI render model.
 * Object key ordering is normalized so live projection and replay generate the
 * same digest even when their JSON objects were assembled in a different
 * order. The input is a finite renderer-visible projection (rather than the
 * complete reducer DTO), so identity/fencing/bookkeeping changes do not make
 * an already committed visual item look different.
 */
export function canonicalRenderSerialization(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '"[nan]"';
    if (value === Infinity) return '"[infinity]"';
    if (value === -Infinity) return '"[-infinity]"';
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (typeof value === 'undefined') return '"[undefined]"';
  if (typeof value === 'function' || typeof value === 'symbol') {
    return JSON.stringify(`[${typeof value}]`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const record = value as Record<string, unknown>;
  // Optional DTO fields are commonly materialized as either an omitted key or
  // an explicit `undefined` by different live/history adapters. They are the
  // same render value and must not produce divergent replay digests.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** FNV-1a is sufficient here: this is a redraw key, not a security digest. */
export function visualDigest(value: unknown): string {
  const serialized = canonicalRenderSerialization(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Canonical renderer digest for a block. */
export function outputBlockVisualDigest(block: OutputBlock): string {
  return visualDigest(rendererVisibleBlock(block));
}

/**
 * Project an OutputBlock to the finite set of values consumed by the Ink
 * block renderers.  Reducer identity, lifecycle fences and recovery metadata
 * intentionally stay out of this object: Timeline carries `state` and
 * `sourceIdentity` separately, while the digest only answers whether the
 * committed pixels/rows would change.
 */
function rendererVisibleBlock(block: OutputBlock): unknown {
  switch (block.kind) {
    case 'user':
      return { kind: block.kind, content: block.content };
    case 'text':
      return {
        kind: block.kind,
        content: block.content,
        streaming: block.streaming,
        isError: block.isError,
        thoughtElapsedMs: block.thoughtElapsedMs,
      };
    case 'reason':
      // BlockRenderer deliberately does not paint legacy reason blocks.
      return { kind: block.kind, visible: false };
    case 'tool_card':
      return {
        kind: block.kind,
        name: block.name,
        args: block.args,
        status: block.status,
        summary: block.summary,
        preview: block.preview,
        startedAt: block.startedAt,
        elapsedMs: block.elapsedMs,
        detail: block.detail,
        expanded: block.expanded,
        liveOutput: block.liveOutput,
        liveTotalLines: block.liveTotalLines,
        timeoutMs: block.timeoutMs,
        reviewFailure: block.reviewFailure,
        userInput: block.userInput,
      };
    case 'tool_summary':
      return {
        kind: block.kind,
        tools: block.tools.map((tool) => ({
          name: tool.name,
          args: tool.args,
          status: tool.status,
          summary: tool.summary,
          totalLines: tool.totalLines,
        })),
        totalElapsedMs: block.totalElapsedMs,
        liveModelStartedAt: block.liveModelStartedAt,
        summaryLine: block.summaryLine,
        active: block.active,
        hasThinking: block.hasThinking,
        latestActivity: block.latestActivity,
      };
    case 'file_change':
      // File-change blocks are intentionally suppressed by BlockRenderer.
      return { kind: block.kind, visible: false };
    case 'approval':
      // Approval blocks are represented by the Footer/queue projection.
      return { kind: block.kind, visible: false };
    case 'question':
      // Question blocks are represented by the Footer/tool card projection.
      return { kind: block.kind, visible: false };
    case 'subagent':
      return {
        kind: block.kind,
        role: block.role,
        task: block.task,
        status: block.status,
        startedAt: block.startedAt,
        durationMs: block.durationMs,
        steps: block.steps.map((step) => ({
          toolName: step.toolName,
          toolArgs: step.toolArgs,
          status: step.status,
          totalLines: step.totalLines,
        })),
        error: block.error,
        failureDiagnostic: block.failureDiagnostic,
        approvalState: block.approvalState,
        awaitingApproval: block.awaitingApproval,
        concurrencyGroupId: block.concurrencyGroupId,
        expanded: block.expanded,
      };
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/**
 * Project one reducer-owned block into the normalized timeline. A missing
 * marker is intentionally treated as live: rendering must fail closed rather
 * than re-derive business terminality from variant-specific fields.
 */
export function projectOutputBlockTimelineItem(block: OutputBlock): TimelineItem {
  const kind = timelineKind(block);
  const sourceIdentity = sourceIdentityFor(block, kind);
  const id = timelineIdentity(sourceIdentity);
  const sealed = block.presentationState === 'sealed';
  const renderModel = { block } satisfies TimelineRenderModel;
  if (sealed) {
    const digest = outputBlockVisualDigest(block);
    return {
      state: 'sealed',
      id,
      kind,
      sourceIdentity,
      visualDigest: digest,
      renderModel,
    };
  }
  return { state: 'live', id, kind, sourceIdentity, renderModel };
}

/** Project a flat OutputBlock sequence into a deterministic timeline. */
export function projectOutputBlockTimeline(
  blocks: readonly OutputBlock[],
  renderEpoch = 0,
): TimelineState {
  return {
    renderEpoch,
    items: blocks.map((block) => projectOutputBlockTimelineItem(block)),
  };
}

/**
 * Advance an existing timeline without ever reopening a sealed item. This is
 * the operation used by replay/live convergence tests and is also useful to
 * callers that keep the normalized presentation state outside React.
 */
export function advanceOutputBlockTimeline(
  previous: TimelineState | undefined,
  blocks: readonly OutputBlock[],
  renderEpoch = previous?.renderEpoch ?? 0,
): TimelineState {
  const next = projectOutputBlockTimeline(blocks, renderEpoch);
  if (!previous || previous.renderEpoch !== renderEpoch) return next;
  const previousById = new Map(previous.items.map((item) => [item.id, item]));
  return {
    renderEpoch,
    items: next.items.map((item) => {
      const prior = previousById.get(item.id);
      if (prior?.state !== 'sealed') return item;
      if (item.state === 'sealed' && item.visualDigest === prior.visualDigest) return prior;
      // A late progress packet must never mutate or reopen a committed item.
      // Keep the sealed render model and digest; callers may log the dropped
      // packet separately if diagnostics are required.
      return prior;
    }),
  };
}

function timelineIdentity(identity: SourceIdentity): string {
  // The projector allocates blockId once and never resets it, including after
  // /clear. Runtime identities remain provenance/fencing metadata, but some of
  // them (notably the durable user messageId) arrive after an optimistic item
  // already exists. Promoting those optional fields into the Timeline key
  // would manufacture a second entity and allow a sealed item to be replaced.
  return `timeline:${identity.kind}:block:${identity.blockId}`;
}

function sourceIdentityFor(block: OutputBlock, kind: TimelineItemKind): SourceIdentity {
  switch (block.kind) {
    case 'user':
      return { blockId: block.id, kind, messageId: block.messageId };
    case 'tool_card':
      return { blockId: block.id, kind, callId: block.callId };
    case 'subagent':
      return { blockId: block.id, kind, subagentId: block.subagentId };
    case 'approval':
      return { blockId: block.id, kind, callId: block.approval.callId };
    case 'question':
      return { blockId: block.id, kind, callId: block.toolCallId };
    default:
      return { blockId: block.id, kind };
  }
}

function timelineKind(block: OutputBlock): TimelineItemKind {
  switch (block.kind) {
    case 'tool_summary':
      return 'thought';
    case 'tool_card':
      return 'tool';
    case 'subagent':
      return 'subagent_group';
    case 'approval':
    case 'question':
      return 'interaction';
    case 'reason':
      return 'legacy_reason';
    default:
      return block.kind;
  }
}
