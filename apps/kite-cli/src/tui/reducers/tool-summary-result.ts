import type { ConsolidatedToolEntry } from '../types';

export type ToolSummaryResult = 'done' | 'error' | 'cancelled' | undefined;

/**
 * Derive a summary outcome from authoritative child tool states.
 *
 * An in-flight child keeps the summary non-terminal. Presentation lifecycle
 * boundaries must never translate missing terminal facts into cancellation.
 */
export function deriveToolSummaryResult(
  tools: readonly ConsolidatedToolEntry[],
): ToolSummaryResult {
  // A content-free Thinking owner is not an aggregate. It may be reopened by
  // the tool-bearing terminal that follows the currently painted reasoning,
  // so an empty child set must not publish a vacuous `done` result.
  if (tools.length === 0) return undefined;
  if (tools.some((tool) => tool.status === 'queued' || tool.status === 'running')) {
    return undefined;
  }
  if (
    tools.some(
      (tool) => tool.status === 'error' || tool.status === 'timeout' || tool.status === 'exhausted',
    )
  ) {
    return 'error';
  }
  if (tools.some((tool) => tool.status === 'cancelled')) return 'cancelled';
  return 'done';
}
