// ── PR 4: Unified resource observation tracker ──
// Shared between M1 (frame compaction fold decisions) and M2 (ledger observation
// generation). Replaces the inline generation-tracking logic in context-frame-compactor.ts.

import type { ContextFrame, ToolCallBlockFrame } from './context-frame';

export interface ResourceObservation {
  toolCallId: string;
  messageId: string;
  /** The resource identifier (file path, MCP resource, etc.). */
  resource: string;
  /** Stable revision or content digest for dedup decisions. */
  revision?: string;
  /** Raw digest of the un-truncated tool output. */
  rawDigest?: string;
  /** Digest of the projected (potentially truncated) output sent to the model. */
  modelDigest?: string;
  /** Whether the output was truncated before reaching the model. */
  truncated: boolean;
  /** Effect classification from the tool capability. */
  effectClass: string;
}

export interface ToolObservationInput {
  toolCallId: string;
  messageId: string;
  name: string;
  ok: boolean;
  effectClass: string;
  content: string;
  resource?: string;
  revision?: string;
  rawDigest?: string;
  modelDigest?: string;
  truncated?: boolean;
  /** Scope of workspace mutation (paths affected). null = unknown/workspace-wide. */
  mutationScope?: string[] | null;
  /** digestScope from ToolResultMeta. legacy_unknown observations are never reliable. */
  digestScope?: string;
}

/**
 * Tracks resource observations across all context frames.
 *
 * Each tool result either produces a reliable observation (read-only, non-truncated,
 * with a known digest) or invalidates existing observations (mutations).
 * The tracker maintains per-resource generation counters so that multiple reads
 * of the same resource at the same revision can be folded, and writes invalidate
 * stale observations.
 */
export class ResourceObservationTracker {
  private globalGeneration = 0;
  private pathGenerations = new Map<string, number>();
  private observations = new Map<string, ResourceObservation>();
  private foldableIds = new Set<string>();
  private seenKeys = new Map<string, string>(); // resource key → toolCallId

  /** Record a tool result observation or mutation. */
  applyToolResult(input: ToolObservationInput): void {
    if (!input.ok) return;

    // ── Workspace mutations invalidate existing observations ──
    if (input.effectClass === 'workspace_write' || input.effectClass === 'external_side_effect') {
      if (input.mutationScope === null || input.mutationScope === undefined) {
        // Unknown scope — invalidate entire workspace.
        this.invalidateWorkspace();
      } else if (input.mutationScope.length > 0) {
        for (const path of input.mutationScope) {
          this.invalidatePath(path);
        }
      } else {
        // Empty scope on a write — also invalidate workspace.
        this.invalidateWorkspace();
      }
      return;
    }

    // ── Unknown side effects also invalidate workspace ──
    if (input.effectClass === 'unknown') {
      this.invalidateWorkspace();
      return;
    }

    // ── Read-only observations ──
    if (input.effectClass !== 'read_only') return;
    // Legacy metadata: no reliable digest → fail closed, never fold.
    if (input.digestScope === 'legacy_unknown') return;
    if (input.truncated) return;
    if (!input.resource) return;

    const revision = input.revision ?? input.rawDigest ?? input.modelDigest;
    if (!revision) return;

    const key = `${input.resource}:${revision}:${this.globalGeneration}:${this.pathGenerations.get(input.resource) ?? 0}`;

    // Check if an earlier observation at the same key already exists → mark foldable
    const earlier = this.seenKeys.get(key);
    if (earlier) {
      this.foldableIds.add(earlier);
    }

    this.seenKeys.set(key, input.toolCallId);
    this.observations.set(input.resource, {
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      resource: input.resource,
      revision,
      rawDigest: input.rawDigest,
      modelDigest: input.modelDigest,
      truncated: input.truncated ?? false,
      effectClass: input.effectClass,
    });
  }

  /** Invalidate all observations for a specific path. */
  invalidatePath(path: string): void {
    this.globalGeneration++;
    this.pathGenerations.set(path, (this.pathGenerations.get(path) ?? 0) + 1);
    for (const [resource, obs] of this.observations) {
      if (obs.resource === path || obs.resource.startsWith(`${path}/`)) {
        this.observations.delete(resource);
        this.seenKeys.delete(resource);
      }
    }
  }

  /** Invalidate ALL observations (unknown workspace-wide mutation). */
  invalidateWorkspace(): void {
    this.globalGeneration++;
    this.observations.clear();
    this.seenKeys.clear();
  }

  /** Check whether a tool call's read result can be folded (deduped). */
  isFoldable(toolCallId: string): boolean {
    return this.foldableIds.has(toolCallId);
  }

  /** Get the latest reliable observation for a resource. */
  latestReliable(resource: string): ResourceObservation | undefined {
    return this.observations.get(resource);
  }

  /** Get all reliable observations currently tracked. */
  allReliable(): ResourceObservation[] {
    return [...this.observations.values()];
  }
}

/**
 * Build a ResourceObservationTracker from canonical context frames.
 * Used by both M1 (frame compaction) and M2 (summary ledger).
 */
export function buildResourceObservationTracker(
  frames: ContextFrame[],
): ResourceObservationTracker {
  const tracker = new ResourceObservationTracker();

  for (const frame of frames) {
    if (frame.kind !== 'tool_block') continue;
    for (const call of (frame as ToolCallBlockFrame).calls) {
      const meta = call.resultMeta;
      tracker.applyToolResult({
        toolCallId: call.toolCallId,
        messageId: call.toolCallId, // frame-level ID
        name: call.name,
        ok: call.ok,
        effectClass: call.effectClass ?? 'unknown',
        content: call.content,
        resource: meta?.path,
        revision: meta?.resourceRevision,
        rawDigest: meta?.contentDigest,
        modelDigest: meta?.contentDigest,
        truncated: meta?.truncated ?? false,
        mutationScope: meta?.workspaceMutationScope,
        digestScope: meta?.digestScope,
      });
    }
  }

  return tracker;
}
