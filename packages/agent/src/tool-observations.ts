import type { ModelMessage } from '@kite-ai/ai';
import type { ExecutionRecord } from './storage/types';

/** Tool-owned observations are evidence data, never permission or a completion predicate. */
export interface ToolObservation {
  kind: 'lookup' | 'inspection';
  scope: string;
  query?: string;
  sources: { path: string; version: string; fromLine?: number; toLine?: number }[];
  matchCount?: number;
  complete: boolean;
  coverage: 'file' | 'window' | 'page';
  next?: string | null;
  windowComplete?: boolean;
  excerpt?: { text: string; truncated: boolean };
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

export function toolObservation(content: string): ToolObservation | undefined {
  let value: Record<string, unknown> | undefined;
  try {
    value = object(object(JSON.parse(content))?.observation);
  } catch {
    return;
  }
  if (
    !value ||
    !['lookup', 'inspection'].includes(String(value.kind)) ||
    typeof value.scope !== 'string' ||
    typeof value.complete !== 'boolean' ||
    !['file', 'window', 'page'].includes(String(value.coverage)) ||
    (value.query !== undefined && typeof value.query !== 'string') ||
    (value.matchCount !== undefined &&
      (!Number.isSafeInteger(value.matchCount) || Number(value.matchCount) < 0)) ||
    (value.next !== undefined && value.next !== null && typeof value.next !== 'string') ||
    (value.windowComplete !== undefined && typeof value.windowComplete !== 'boolean') ||
    !Array.isArray(value.sources)
  )
    return;
  const sources: ToolObservation['sources'] = [];
  const excerpt = value.excerpt === undefined ? undefined : object(value.excerpt);
  if (
    value.excerpt !== undefined &&
    (!excerpt || typeof excerpt.text !== 'string' || typeof excerpt.truncated !== 'boolean')
  )
    return;
  for (const item of value.sources) {
    const source = object(item);
    if (
      !source ||
      typeof source.path !== 'string' ||
      typeof source.version !== 'string' ||
      !source.version ||
      (source.fromLine !== undefined && !positive(source.fromLine)) ||
      (source.toLine !== undefined && !positive(source.toLine)) ||
      (source.fromLine !== undefined &&
        source.toLine !== undefined &&
        Number(source.toLine) < Number(source.fromLine))
    )
      return;
    sources.push({
      path: source.path,
      version: source.version,
      ...(source.fromLine === undefined ? {} : { fromLine: Number(source.fromLine) }),
      ...(source.toLine === undefined ? {} : { toLine: Number(source.toLine) }),
    });
  }
  return {
    kind: value.kind as ToolObservation['kind'],
    scope: value.scope,
    sources,
    complete: value.complete,
    coverage: value.coverage as ToolObservation['coverage'],
    ...(value.query === undefined ? {} : { query: String(value.query) }),
    ...(value.matchCount === undefined ? {} : { matchCount: Number(value.matchCount) }),
    ...(value.next === undefined ? {} : { next: value.next as string | null }),
    ...(value.windowComplete === undefined ? {} : { windowComplete: value.windowComplete }),
    ...(excerpt
      ? { excerpt: { text: String(excerpt.text), truncated: excerpt.truncated as boolean } }
      : {}),
  };
}

/** Original execution identity is Host evidence; observations remain attributed Tool data.
 * The selected-history boundary is explicit: omitted/compacted work is not proved absent. */
export async function childToolEvidence(
  history: readonly ModelMessage[],
  identity: { sessionId: string; runId: string; storeId: string },
  getExecution: (id: string) => Promise<ExecutionRecord | null>,
) {
  const calls = new Map<string, string>();
  const seen = new Set<string>();
  // This is a bounded preview of independently retained original receipts. It must never
  // make an otherwise valid child result exceed the Store's transport boundary.
  let observationBytes = 0;
  let observationsOmitted = 0;
  let toolCallsOmitted = 0;
  const observations: {
    executionId: string;
    tool: string;
    definitionVersion: string;
    observation: ToolObservation;
  }[] = [];
  const tools = new Map<
    string,
    { tool: string; definitionVersion: string; outcomes: Record<string, number> }
  >();
  for (const message of history) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call.name);
    if (message.role !== 'tool' || !message.toolCallId) continue;
    for (const id of message.sourceIds ?? []) {
      if (seen.has(id)) continue;
      const execution = await getExecution(id);
      if (
        execution?.kind !== 'tool' ||
        execution.sessionId !== identity.sessionId ||
        execution.runId !== identity.runId ||
        execution.originStoreId !== identity.storeId ||
        execution.callId !== message.toolCallId ||
        execution.definitionId !== calls.get(message.toolCallId) ||
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
      )
        continue;
      seen.add(id);
      const key = JSON.stringify([execution.definitionId, execution.definitionVersion]);
      const summary = tools.get(key) ?? {
        tool: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        outcomes: {},
      };
      summary.outcomes[execution.status] = (summary.outcomes[execution.status] ?? 0) + 1;
      if (tools.has(key) || tools.size < 64) tools.set(key, summary);
      else toolCallsOmitted++;
      const result = object(execution.result);
      const observation =
        execution.status === 'succeeded' && typeof result?.content === 'string'
          ? toolObservation(result.content)
          : undefined;
      if (observation) {
        const item = {
          executionId: execution.id,
          tool: execution.definitionId,
          definitionVersion: execution.definitionVersion,
          observation,
        };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        // Reserve most of the preview for source inspections rather than candidate searches.
        const budget = observation.kind === 'lookup' ? 8 * 1024 : 32 * 1024;
        if (observationBytes + bytes <= budget) {
          observations.push(item);
          observationBytes += bytes;
        } else observationsOmitted++;
      }
    }
  }
  if (!seen.size) return;
  return {
    kind: 'recorded_tool_evidence',
    ...identity,
    coverage: 'selected_history',
    reportVerification: 'not_verified',
    limitation:
      'This is a bounded preview of original Tool receipts retained in selected history; compacted or omitted work is not proved absent. Full original receipts remain in the child execution history. Compare child assertions with the original source excerpts; resolve discrepancies before repeating them. Tool-reported observations establish inspected sources, not semantic correctness, call reachability or authorization. Independently verify the connections that determine the answer before adopting a child conclusion.',
    observationsOmitted,
    toolCallsOmitted,
    tools: [...tools.values()],
    observations,
  };
}
