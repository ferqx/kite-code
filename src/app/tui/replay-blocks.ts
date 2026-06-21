/**
 * 回放 Block 构建 — 将 SessionData（中立数据）转为 TUI OutputBlock 数组
 * Replay block builder — converts SessionData (neutral) to TUI OutputBlock array
 *
 * 这是从 core/persistence/sessions.ts 抽出的 UI 层代码。
 * 未来 CLI/Web 等前端可以有自己的转换函数。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { SessionData } from '../../core/persistence/sessions.js';
import { extractText } from '../../core/persistence/sessions.js';
import type { SubAgentRole } from '../../protocol/events.js';
import { getToolDetail, getToolPreview } from './components/render-utils.js';
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
  const blocks = buildOutputBlocks(data.messages);

  // Build callId → blockId index for interrupt mapping
  const callIdIndex: Record<string, number> = {};
  for (const b of blocks) {
    if ('callId' in b && b.callId) {
      callIdIndex[b.callId] = b.id;
    }
  }

  // Compute next block ID from existing blocks
  let nextId = 1;
  for (const b of blocks) {
    if (b.id >= nextId) nextId = b.id + 1;
  }

  let interrupt: InterruptState | null = null;
  if (data.interrupt) {
    let blockId = 0;
    if (data.interrupt.kind === 'approval' && data.interrupt.callId) {
      blockId = callIdIndex[data.interrupt.callId] ?? 0;
    }
    // plan_review 中断 → 创建 plan_review block（标记为待审批，回放时可见）
    if (data.interrupt.kind === 'plan_review' && data.interrupt.plan) {
      blockId = nextId++;
      blocks.push({
        id: blockId,
        kind: 'plan_review',
        plan: data.interrupt.plan,
        resolved: { action: 'pending_review' },
      });
    }
    // user_input 保持 blockId=0（question block 在回放数据中不存在）
    interrupt = { kind: data.interrupt.kind, blockId };
  }

  // Refine 'approved' action from messages with checkpoint auth mode
  for (const b of blocks) {
    if (b.kind === 'plan_review' && b.resolved?.action === 'approved') {
      const mode = data.planAuthMode === 'full_access' ? 'approved_auto' : 'approved_manual';
      b.resolved = { action: mode };
    }
  }

  // 已批准的方案（从 checkpoint state.plan 提取，消息中没有 update_plan 调用时兜底）
  if (!data.interrupt && data.plan && !blocks.some((b) => b.kind === 'plan_review')) {
    const action = data.planAuthMode === 'full_access' ? 'approved_auto' : 'approved_manual';
    blocks.push({
      id: nextId++,
      kind: 'plan_review',
      plan: data.plan,
      resolved: { action },
    });
  }

  return { blocks, interrupt };
}

/** 将 LangChain 消息数组映射为 OutputBlock 数组 / Map LangChain messages to OutputBlock array */
function buildOutputBlocks(messages: unknown[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let nextId = 1;
  // Track pending task tool calls: callId → { subagent_type, task }
  const pendingTasks = new Map<string, PendingTaskCall>();
  // Track update_plan calls: callId → plan args (for plan_review block reconstruction)
  const pendingPlans = new Map<
    string,
    { name: string; description: string; steps: { step: string; status: string }[] }
  >();

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    // HumanMessage → user block
    if (HumanMessage.isInstance(msg)) {
      let content = extractText(msg.content as unknown);
      // Strip "User: " prefix added by runTask for conversation history
      content = content.replace(/^User:\s*/, '');
      if (content.length > 0) {
        blocks.push({ id: nextId++, kind: 'user', content });
      }
      continue;
    }

    // AIMessage
    if (AIMessage.isInstance(msg)) {
      const rawMsg = msg as unknown as Record<string, unknown>;
      const additionalKwargs =
        (rawMsg.additional_kwargs as Record<string, unknown> | undefined) ?? {};

      // reasoning_content → reason block
      const reasoningContent =
        (rawMsg.reasoning_content as string | undefined) ??
        (additionalKwargs.reasoning_content as string | undefined);
      if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
        blocks.push({
          id: nextId++,
          kind: 'reason',
          content: reasoningContent,
          folded: false,
        });
      }

      // tool_calls → tool_card blocks (result summary added later from ToolMessage if present)
      const toolCalls = msg.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === 'object') {
            const call = tc as Record<string, unknown>;
            const callId = typeof call.id === 'string' ? call.id : '';
            const name = typeof call.name === 'string' ? call.name : '';
            const args = (call.args as Record<string, unknown>) ?? {};

            // task tool → defer to build subagent block from ToolMessage result
            if (name === 'task') {
              const subagentType = (args.subagent_type as SubAgentRole) || 'explore';
              const task = typeof args.task === 'string' ? args.task : '';
              pendingTasks.set(callId, { subagentType, task });
              continue;
            }
            // update_plan → save plan args, skip tool_card (plan shown as plan_review block)
            if (name === 'update_plan') {
              pendingPlans.set(callId, {
                name: (args.name as string) ?? '',
                description: (args.description as string) ?? '',
                steps: (args.steps as Array<{ step: string; status: string }>) ?? [],
              });
              continue;
            }
            blocks.push({
              id: nextId++,
              kind: 'tool_card',
              callId,
              name,
              args,
              status: 'done',
              summary: '',
              preview: getToolPreview(name, args),
            });
          }
        }
      }

      // text content → text block
      const content = extractText(msg.content as unknown);
      if (content.length > 0) {
        blocks.push({ id: nextId++, kind: 'text', content });
      }
      continue;
    }

    // ToolMessage → update matching AIMessage tool_card with result, or create standalone
    const tm = msg as Record<string, unknown>;
    if (isToolMessageLike(tm)) {
      const callId = (tm.tool_call_id as string) ?? '';
      const tmName = (tm.name as string) ?? '';

      // task tool result → build subagent block from pending task call + result
      if (tmName === 'task') {
        const pending = pendingTasks.get(callId) ?? { subagentType: 'explore' as const, task: '' };
        const subId = callId || `sa-${nextId}`;
        const { ok, summary, toolCallCount, durationMs, error, steps } = parseTaskResult(
          typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content),
        );
        blocks.push({
          id: nextId++,
          kind: 'subagent',
          subagentId: subId,
          role: pending.subagentType,
          task: pending.task,
          status: ok ? 'done' : 'error',
          summary,
          toolCallCount,
          durationMs,
          steps,
          ...(error ? { error } : {}),
        });
        pendingTasks.delete(callId);
        continue;
      }

      // update_plan result → create plan_review block
      if (tmName === 'update_plan') {
        const planData = pendingPlans.get(callId);
        if (planData) {
          const resolved = parsePlanOutcome(typeof tm.content === 'string' ? tm.content : '');
          blocks.push({
            id: nextId++,
            kind: 'plan_review',
            plan: {
              name: planData.name,
              description: planData.description,
              status:
                resolved.action === 'approved_auto' || resolved.action === 'approved_manual'
                  ? 'in_progress'
                  : 'pending',
              steps: planData.steps.map((s) => ({
                step: s.step,
                status: s.status as 'pending' | 'in_progress' | 'completed',
              })),
            },
            resolved,
          });
        }
        pendingPlans.delete(callId);
        continue;
      }

      const content = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
      let ok = true;
      let summary = content.slice(0, 200);
      let totalLines: number | undefined;
      try {
        const p = JSON.parse(content);
        if (p && typeof p === 'object') {
          ok = p.ok !== false;
          if (typeof p.totalLines === 'number') totalLines = p.totalLines;
          if (p.ok !== false) {
            summary =
              (p.stdout as string) ?? (p.message as string) ?? (p.summary as string) ?? summary;
          } else {
            summary =
              (p.reason as string) ??
              (p.stderr as string) ??
              (p.message as string) ??
              (p.summary as string) ??
              summary;
          }
        }
      } catch {
        /* use raw content */
      }

      // Find existing tool_card from AIMessage tool_calls and enrich with result
      const existingIdx = blocks.findIndex((b) => b.kind === 'tool_card' && b.callId === callId);
      if (existingIdx >= 0) {
        const existing = blocks[existingIdx]!;
        if (existing.kind === 'tool_card') {
          blocks[existingIdx] = {
            ...existing,
            status: ok ? 'done' : 'error',
            summary,
            detail: getToolDetail(existing.name, existing.args, totalLines),
            expanded: ok ? existing.expanded : true,
          } as (typeof blocks)[number];
        }
      } else {
        // Standalone ToolMessage (no preceding AIMessage tool_calls)
        const name = (tm.name as string) ?? '';
        blocks.push({
          id: nextId++,
          kind: 'tool_card',
          callId,
          name,
          args: {},
          status: ok ? 'done' : 'error',
          summary,
        });
      }
    }
  }

  // Any pending task calls without ToolMessage result → create error subagent blocks
  for (const [callId, pending] of pendingTasks) {
    blocks.push({
      id: nextId++,
      kind: 'subagent',
      subagentId: callId || `sa-${nextId}`,
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

  // Any pending plan calls without ToolMessage result → create pending_review block
  for (const [, planData] of pendingPlans) {
    blocks.push({
      id: nextId++,
      kind: 'plan_review',
      plan: {
        name: planData.name,
        description: planData.description,
        status: 'pending',
        steps: planData.steps.map((s) => ({
          step: s.step,
          status: s.status as 'pending' | 'in_progress' | 'completed',
        })),
      },
      resolved: { action: 'pending_review' },
    });
  }

  return blocks;
}

/** Parse update_plan ToolMessage content → plan_review resolved action */
function parsePlanOutcome(content: string): { action: string; feedback?: string } {
  try {
    const p = JSON.parse(content);
    if (p && typeof p === 'object') {
      if (p.ok !== false) {
        return { action: 'approved' };
      }
      if (p.rejected) {
        const reason = (p.reason as string) ?? '';
        if (reason.includes('User feedback:')) {
          return {
            action: 'supplemented',
            feedback: reason.replace('Plan needs revision. User feedback: ', ''),
          };
        }
        return { action: 'rejected' };
      }
    }
  } catch {
    /* fall through */
  }
  return { action: 'rejected' };
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
      const steps = Array.isArray(p.steps) ? (p.steps as SubAgentStepRecord[]) : [];
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

/** 判断是否为 ToolMessage 类消息 / Check if message is ToolMessage-like */
function isToolMessageLike(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === 'function') {
      return (msg._getType as () => string).call(msg) === 'tool';
    }
  } catch {
    /* ignore */
  }
  return false;
}
