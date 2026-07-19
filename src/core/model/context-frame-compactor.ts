import { createHash } from 'node:crypto';
import type { ContextBudget } from '@/core/types';
import type { ContextFrame, FrameToolResult, ToolCallBlockFrame } from './context-frame';

const DEFAULT_RECENT_TURNS = 3;
const SEARCH_TOOLS = new Set(['search_content', 'search_files']);
const RESOURCE_READ_TOOLS = new Set(['read_file', 'read_mcp_resource']);
const SEARCH_COMMAND_PREFIXES = ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find .', 'find /'];

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizedDigest(value: string | undefined, content: string): string {
  if (!value) return digest(content);
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringArg(call: FrameToolResult, key: string): string | undefined {
  const value = record(call.args)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isCompacted(call: FrameToolResult): boolean {
  try {
    const value = JSON.parse(call.content) as Record<string, unknown>;
    return value._folded === true || value._compacted === true;
  } catch {
    return false;
  }
}

function protectedFrameIndices(frames: ContextFrame[], recentTurns: number): Set<number> {
  const keys: string[] = [];
  const frameKeys: string[] = [];
  let legacyTurn = 0;
  for (const frame of frames) {
    if (frame.kind === 'user' && !frame.turnId) legacyTurn++;
    const explicit =
      frame.kind === 'user' || frame.kind === 'assistant' || frame.kind === 'tool_block'
        ? frame.turnId
        : undefined;
    const key = explicit ?? `legacy-turn-${legacyTurn}`;
    frameKeys.push(key);
    if (!keys.includes(key)) keys.push(key);
  }
  const count = Math.max(0, recentTurns);
  const protectedKeys = new Set(count === 0 ? [] : keys.slice(-count));
  return new Set(frameKeys.flatMap((key, index) => (protectedKeys.has(key) ? [index] : [])));
}

function mutationScopes(call: FrameToolResult): string[] | null | undefined {
  if (call.effectClass === 'read_only' || call.effectClass === 'plan_only') return undefined;
  const scopes = call.resultMeta?.workspaceMutationScope;
  if (scopes?.length) return scopes;
  const path = call.resultMeta?.path ?? stringArg(call, 'path');
  if (path && call.effectClass === 'workspace_write') return [path];
  return null;
}

function resourceKey(
  call: FrameToolResult,
  globalGeneration: number,
  pathGenerations: Map<string, number>,
): string | undefined {
  const path = call.resultMeta?.path;
  if (!path || call.resultMeta?.truncated || !call.ok) return undefined;
  const revision =
    call.resultMeta?.resourceRevision ?? call.resultMeta?.contentDigest ?? digest(call.content);
  return `${call.name}:${path}:${revision}:${globalGeneration}:${pathGenerations.get(path) ?? 0}`;
}

function foldRead(call: FrameToolResult): FrameToolResult {
  const path = call.resultMeta!.path!;
  const contentDigest = normalizedDigest(call.resultMeta?.contentDigest, call.content);
  return {
    ...call,
    content: JSON.stringify({
      _folded: true,
      tool: call.name,
      path,
      ...(call.resultMeta?.totalLines != null ? { totalLines: call.resultMeta.totalLines } : {}),
      contentDigest,
      ...(call.resultMeta?.resourceRevision
        ? { resourceRevision: call.resultMeta.resourceRevision }
        : {}),
      note: 'Earlier read omitted; a newer full observation of the same resource version is retained.',
    }),
  };
}

function searchQuery(call: FrameToolResult): string | undefined {
  if (SEARCH_TOOLS.has(call.name)) return stringArg(call, 'pattern');
  if (call.name !== 'shell_execute' || call.effectClass !== 'read_only') return undefined;
  if (call.resultMeta?.intent !== 'inspect') return undefined;
  const command = call.resultMeta.command ?? stringArg(call, 'command');
  return command && SEARCH_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix))
    ? command
    : undefined;
}

function foldSearch(call: FrameToolResult, query: string): FrameToolResult {
  const topMatches = call.content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    ...call,
    content: JSON.stringify({
      _folded: true,
      tool: call.name,
      query,
      ...(call.resultMeta?.path ? { scope: call.resultMeta.path } : {}),
      matchCount: call.resultMeta?.matchCount ?? topMatches.length,
      topMatches,
      truncated: call.resultMeta?.truncated ?? false,
      resultDigest: normalizedDigest(call.resultMeta?.contentDigest, call.content),
    }),
  };
}

function compactDuplicate(call: FrameToolResult, sameAsToolCallId: string): FrameToolResult {
  return {
    ...call,
    content: JSON.stringify({
      _compacted: true,
      sameAsToolCallId,
      resultDigest: normalizedDigest(call.resultMeta?.contentDigest, call.content),
    }),
  };
}

/**
 * Deterministic M1 V2 projection. It never mutates RuntimeState/transcript and
 * preserves every assistant tool call with exactly one result.
 */
export function compactContextFrames(
  frames: ContextFrame[],
  budget?: ContextBudget,
): ContextFrame[] {
  const protectedIndices = protectedFrameIndices(
    frames,
    budget?.recentTurns ?? DEFAULT_RECENT_TURNS,
  );
  const foldableReads = new Set<string>();
  const latestObservation = new Map<string, string>();
  const pathGenerations = new Map<string, number>();
  let globalGeneration = 0;

  for (const frame of frames) {
    if (frame.kind !== 'tool_block') continue;
    for (const call of frame.calls) {
      const scopes = mutationScopes(call);
      if (scopes === null) {
        globalGeneration++;
        latestObservation.clear();
      } else if (scopes) {
        for (const path of scopes) {
          pathGenerations.set(path, (pathGenerations.get(path) ?? 0) + 1);
          for (const key of latestObservation.keys()) {
            if (key.includes(`:${path}:`)) latestObservation.delete(key);
          }
        }
      }
      if (!RESOURCE_READ_TOOLS.has(call.name) || call.effectClass !== 'read_only') continue;
      const key = resourceKey(call, globalGeneration, pathGenerations);
      if (!key) continue;
      const earlier = latestObservation.get(key);
      if (earlier) foldableReads.add(earlier);
      latestObservation.set(key, call.toolCallId);
    }
  }

  let previousDuplicate: { signature: string; toolCallId: string } | undefined;

  return frames.map((frame, frameIndex): ContextFrame => {
    if (frame.kind !== 'tool_block') {
      previousDuplicate = undefined;
      return frame;
    }
    const protectedFrame = protectedIndices.has(frameIndex);
    const calls = frame.calls.map((call) => {
      const scopes = mutationScopes(call);
      if (scopes !== undefined) previousDuplicate = undefined;
      if (!call.ok || isCompacted(call) || protectedFrame) {
        previousDuplicate = undefined;
        return call;
      }

      if (foldableReads.has(call.toolCallId)) return foldRead(call);

      const query = searchQuery(call);
      if (query && call.effectClass === 'read_only') return foldSearch(call, query);

      if (
        call.effectClass === 'read_only' &&
        !RESOURCE_READ_TOOLS.has(call.name) &&
        call.resultMeta?.contentDigest
      ) {
        const signature = `${call.name}:${stableStringify(call.args)}:${normalizedDigest(
          call.resultMeta.contentDigest,
          call.content,
        )}`;
        const previous = previousDuplicate;
        if (previous?.signature === signature) {
          return compactDuplicate(call, previous.toolCallId);
        }
        previousDuplicate = { signature, toolCallId: call.toolCallId };
      } else {
        previousDuplicate = undefined;
      }
      return call;
    });
    return { ...frame, calls } satisfies ToolCallBlockFrame;
  });
}
