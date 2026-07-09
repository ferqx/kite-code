/**
 * 回放 Block 构建 — 将 SessionData（中立数据）转为 TUI OutputBlock 数组
 * Replay block builder — converts SessionData (neutral) to TUI OutputBlock array
 *
 * 核心原则：重放与实时渲染使用同一条事件→reducer 管道。
 * AIMessage → parseAIMessageEvents → handleEventAction
 * ToolMessage → parseToolResultEvents → handleEventAction
 * HumanMessage → appendBlock (等价于 USER_MESSAGE action)
 * task 工具 → 独立 subagent block（reducer 跳过 task，此处自行处理）
 *
 * 这样对 reducer 的任何修改（如新增 exhausted 状态、调整 tool_card 布局）
 * 会自动反映到重放，无需维护两套独立的 block 构建逻辑。
 */

import type { AIMessage } from '@langchain/core/messages';
import type { SessionData } from '../../core/persistence/sessions.js';
import { extractText } from '../../core/persistence/sessions.js';
import { parseAIMessageEvents, parseToolResultEvents } from '../../core/runner.js';
import type { RuntimeEvent } from '../../core/runtime/events.js';
import { projectRuntimeEventToAgentEvent } from '../../core/runtime/projection.js';
import type { SubAgentRole } from '../../protocol/events.js';
import { createInitialState } from './initialState.js';
import { consolidateAllRuns } from './reducers/consolidateTools.js';
import { handleEventAction } from './reducers/handleEvent.js';
import { appendBlock } from './reducers/helpers.js';
import type { InterruptState, OutputBlock, SubAgentStepRecord } from './types.js';

/** Pending task tool call info collected from AIMessage tool_calls */
interface PendingTaskCall {
  subagentType: SubAgentRole;
  task: string;
}

/** 将 SessionData 转为 TUI 可用的 blocks + interrupt
 *  Convert SessionData to TUI-consumable blocks + interrupt */
export function sessionDataToUI(data: SessionData): {
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
} {
  const rawBlocks = hasReplayableRuntimeEvents(data.runtimeEvents)
    ? replayRuntimeEventsToBlocks(data.runtimeEvents)
    : replayMessagesToBlocks(data.messages);
  const blocks = consolidateAllRuns(rawBlocks);

  // Build callId → blockId index for interrupt mapping
  const callIdIndex: Record<string, number> = {};
  for (const b of blocks) {
    if ('callId' in b && b.callId) {
      callIdIndex[b.callId] = b.id;
    }
  }

  let interrupt: InterruptState | null = null;
  if (data.interrupt) {
    if (data.interrupt.kind === 'plan_review') {
      interrupt = { kind: 'plan_review', plan: data.interrupt.plan };
    } else {
      let blockId = 0;
      if (data.interrupt.kind === 'approval' && data.interrupt.callId) {
        blockId = callIdIndex[data.interrupt.callId] ?? 0;
      }
      interrupt = { kind: data.interrupt.kind, blockId } as InterruptState;
    }
  }

  return { blocks, interrupt };
}

function hasReplayableRuntimeEvents(events: RuntimeEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'user.message_appended' || projectRuntimeEventToAgentEvent(event).length > 0,
  );
}

function replayRuntimeEventsToBlocks(events: RuntimeEvent[]): OutputBlock[] {
  let state = createInitialState();

  for (const runtimeEvent of events) {
    if (runtimeEvent.type === 'user.message_appended') {
      const content = runtimeEvent.content.replace(/^User:\s*/, '');
      if (content.length > 0) {
        state = appendBlock(state, { id: state.nextBlockId, kind: 'user', content });
      }
      continue;
    }

    for (const event of projectRuntimeEventToAgentEvent(runtimeEvent)) {
      state = handleEventAction(state, event);
    }
  }

  return state.turns.flatMap((t) => t.blocks);
}

/** Convert checkpoint messages → OutputBlock[] using the SAME event→reducer pipeline
 *  that real-time rendering uses.  Only task/subagent blocks are handled separately
 *  (the reducer skips task tool events). */
function replayMessagesToBlocks(messages: unknown[]): OutputBlock[] {
  let state = createInitialState();
  // Track pending task tool calls: callId → { subagent_type, task }
  const pendingTasks = new Map<string, PendingTaskCall>();

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const rawMsg = msg as Record<string, unknown>;

    // ── HumanMessage → user block ──
    if (isHumanMessageLike(rawMsg)) {
      let content = extractText(rawMsg.content as unknown);
      content = content.replace(/^User:\s*/, '');
      if (content.length > 0) {
        state = appendBlock(state, { id: state.nextBlockId, kind: 'user', content });
      }
      continue;
    }

    // ── AIMessage → text + reason events (via parseAIMessageEvents, now text/reason only),
    //     then tool_call events emitted directly from msg.tool_calls (non-task only). ──
    if (isAiMessageLike(rawMsg)) {
      // Pipe text/reason through parser (tool_call moved to RuntimeEvent side channel;
      // replay reconstructs tool_call from checkpoint msg.tool_calls directly below).
      const events = parseAIMessageEvents(rawMsg as unknown as AIMessage);
      for (const event of events) {
        state = handleEventAction(state, event);
      }

      // Emit tool_call events from checkpoint tool_calls (non-task only)
      const toolCalls = rawMsg.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === 'object') {
            const call = tc as Record<string, unknown>;
            if (call.name === 'task') {
              // Collect task tool_call IDs so we can defer their blocks to ToolMessage
              const callId = typeof call.id === 'string' ? call.id : '';
              const args = (call.args as Record<string, unknown>) ?? {};
              pendingTasks.set(callId, {
                subagentType: (args.subagent_type as SubAgentRole) || 'explore',
                task: typeof args.task === 'string' ? args.task : '',
              });
            } else {
              // Non-task tools: emit tool_call event (same shape as RuntimeEvent projection)
              state = handleEventAction(state, {
                type: 'tool_call',
                data: {
                  call_id: (call.id as string) ?? '',
                  name: (call.name as string) ?? '',
                  args: (call.args as Record<string, unknown>) ?? {},
                  status: 'queued',
                },
              });
            }
          }
        }
      }
      continue;
    }

    // ── ToolMessage → tool_done (or subagent for task) ──
    if (isToolMessageLike(rawMsg)) {
      const callId = (rawMsg.tool_call_id as string) ?? '';
      const tmName = (rawMsg.name as string) ?? '';

      // task tool result → subagent block (reducer skips task events)
      if (tmName === 'task') {
        const pending = pendingTasks.get(callId) ?? { subagentType: 'explore' as const, task: '' };
        const subId = callId || `sa-${state.nextBlockId}`;
        const { ok, summary, toolCallCount, durationMs, error, steps } = parseTaskResult(
          typeof rawMsg.content === 'string' ? rawMsg.content : JSON.stringify(rawMsg.content),
        );
        const cancelled = !ok && summary === 'Cancelled';
        const resolvedStatus: 'done' | 'error' | 'cancelled' = ok
          ? 'done'
          : cancelled
            ? 'cancelled'
            : steps.length > 0
              ? 'done'
              : 'error';
        state = appendBlock(state, {
          id: state.nextBlockId,
          kind: 'subagent',
          subagentId: subId,
          role: pending.subagentType,
          task: pending.task,
          status: resolvedStatus,
          summary,
          toolCallCount,
          durationMs,
          steps,
          ...(error ? { error } : {}),
        });
        pendingTasks.delete(callId);
        continue;
      }

      // Non-task ToolMessage → feed through same parser + reducer as real-time
      const event = parseToolResultEvents(rawMsg);
      if (event) {
        state = handleEventAction(state, event);
      }
    }
  }

  // Any pending task calls without ToolMessage result → error subagent blocks
  for (const [callId, pending] of pendingTasks) {
    state = appendBlock(state, {
      id: state.nextBlockId,
      kind: 'subagent',
      subagentId: callId || `sa-${state.nextBlockId}`,
      role: pending.subagentType,
      task: pending.task,
      status: 'error',
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
      error: 'Sub-agent result not found in checkpoint',
    });
  }

  // Flatten turns → flat block array
  return state.turns.flatMap((t) => t.blocks);
}

/** Parse task tool ToolMessage content into subagent block fields */
function parseTaskResult(content: string): {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
  steps: SubAgentStepRecord[];
} {
  try {
    const p = JSON.parse(content);
    if (p && typeof p === 'object') {
      const rawSteps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
      const steps = rawSteps.map((s) => ({
        ...s,
        status:
          (s.status as SubAgentStepRecord['status']) ??
          (s.ok === false
            ? ('error' as const)
            : s.ok === true
              ? ('success' as const)
              : ('pending' as const)),
        toolArgs: (s.toolArgs ?? {}) as Record<string, unknown>,
      })) as SubAgentStepRecord[];
      return {
        ok: p.ok !== false,
        summary: (p.summary as string) ?? (p.error as string) ?? '',
        toolCallCount: typeof p.toolCallCount === 'number' ? p.toolCallCount : 0,
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
        ...(p.ok === false
          ? { error: (p.error as string) || (p.summary as string) || 'Aborted' }
          : {}),
        steps,
      };
    }
  } catch {
    /* fall through */
  }
  return {
    ok: false,
    summary: content.slice(0, 200),
    toolCallCount: 0,
    durationMs: 0,
    steps: [],
    error: content.slice(0, 200),
  };
}

/** 判断是否为 AIMessage（兼容 checkpoint 反序列化的 plain object） */
function isAiMessageLike(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === 'function') {
      return (msg._getType as () => string).call(msg) === 'ai';
    }
  } catch {
    /* ignore */
  }
  return msg.type === 'ai' || Array.isArray(msg.tool_calls);
}

/** 判断是否为 HumanMessage（兼容 checkpoint 反序列化的 plain object） */
function isHumanMessageLike(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === 'function') {
      return (msg._getType as () => string).call(msg) === 'human';
    }
  } catch {
    /* ignore */
  }
  return msg.type === 'human';
}

/** 判断是否为 ToolMessage 类消息（兼容 checkpoint 反序列化的 plain object） */
function isToolMessageLike(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === 'function') {
      return (msg._getType as () => string).call(msg) === 'tool';
    }
  } catch {
    /* ignore */
  }
  if (typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > 0) {
    return true;
  }
  return false;
}
