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

const AUTO_EXPAND_TOOLS = new Set(['shell_execute', 'edit_file', 'write_file', 'update_plan', 'ask_user']);

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

  let interrupt: InterruptState | null = null;
  if (data.interrupt) {
    if (data.interrupt.kind === 'plan_review') {
      // 方案审批中断不创建 block，直接携带 plan 数据 / Plan review interrupt carries plan data directly, no block
      interrupt = { kind: 'plan_review', plan: data.interrupt.plan };
    } else {
      let blockId = 0;
      if (data.interrupt.kind === 'approval' && data.interrupt.callId) {
        blockId = callIdIndex[data.interrupt.callId] ?? 0;
      }
      interrupt = { kind: data.interrupt.kind, blockId } as InterruptState;
    }
  }

  // 已批准的方案信息通过 status 传递，不创建 plan_review block / Approved plan info flows through status, no plan_review block
  // (handled by the checkpoint loader in runner.ts)

  return { blocks, interrupt };
}

/** 将 LangChain 消息数组映射为 OutputBlock 数组 / Map LangChain messages to OutputBlock array */
function buildOutputBlocks(messages: unknown[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let nextId = 1;
  // Track pending task tool calls: callId → { subagent_type, task }
  const pendingTasks = new Map<string, PendingTaskCall>();

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
            // update_plan → 预填 summary（从 args 中提取方案内容），ToolMessage 结果会在下方合并覆盖
            // Pre-fill summary from plan args; ToolMessage result merges/overrides below
            let planSummary = '';
            if (name === 'update_plan') {
              const desc = (args.description as string) ?? '';
              const steps = args.steps as Array<{ step: string }> | undefined;
              if (desc || (steps && steps.length > 0)) {
                const stepsText = (steps ?? []).map((s, i) => `${i + 1}. ${s.step}`).join('\n');
                planSummary = desc ? `${desc}\n\nSteps:\n${stepsText}` : `Steps:\n${stepsText}`;
              }
            }
            blocks.push({
              id: nextId++,
              kind: 'tool_card',
              callId,
              name,
              args,
              status: 'done',
              summary: planSummary,
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

      // update_plan result → treat as normal tool_card (plan content shown via tool output)
      // (previously created a plan_review block; now standard tool_card flow handles it)

      const content = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
      let ok = true;
      const summaryMaxLen = tmName === 'edit_file' || tmName === 'write_file' ? 2000 : 200;
      let summary = content.slice(0, summaryMaxLen);
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
          // ask_user: extract human-readable answer instead of raw JSON
          if (tmName === 'ask_user') {
            const answer = p.answer as string | undefined;
            const answers = p.answers as Record<string, string> | undefined;
            if (answers && Object.keys(answers).length > 0) {
              summary = Object.entries(answers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n');
            } else if (typeof answer === 'string') {
              summary = answer || '(no answer)';
            }
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
          // update_plan 拒绝时：保持 done 状态，拒绝理由追加到方案内容末尾
          // update_plan on rejection: keep done, append feedback to plan content
          const finalSummary =
            existing.name === 'update_plan' && !ok
              ? `${existing.summary || summary}\n\nUser rejected: ${summary}`
              : summary || existing.summary;
          blocks[existingIdx] = {
            ...existing,
            status: existing.name === 'update_plan' ? 'done' : ok ? 'done' : 'error',
            summary: finalSummary,
            detail: getToolDetail(existing.name, existing.args, totalLines),
            expanded: AUTO_EXPAND_TOOLS.has(existing.name),
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
          expanded: !ok || AUTO_EXPAND_TOOLS.has(name),
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

  // update_plan tool calls without ToolMessage results are handled by the standard
  // tool_card pipeline — orphaned calls remain as 'done' tool_cards.

  return blocks;
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
