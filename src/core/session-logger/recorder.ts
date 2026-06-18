// src/core/session-logger/recorder.ts
// AgentEvent → TraceRecord 映射器（全量记录，所有事件都留痕）
//
// 截断策略：本地会话日志用于调试回溯，保留完整语义但控制文件体积。
// 隐私脱敏由遥测通道的 scrubber 负责，本层不裁剪内容。

import { genSpanId } from '@/core/id-utils';
import type { AgentEvent } from '@/protocol/events';
import { classifyToolFailure } from './classifier';
import type { TraceRecord } from './types';

// 内容截断阈值（字符数）
const TRUNC_CONTENT = 10_000; // text / reason / final 正文
const TRUNC_SUMMARY = 4096; // tool_done summary / subagent summary
const TRUNC_ARGS = 4096; // tool_call args / subagent toolArgs
const TRUNC_ERROR = 500; // 错误消息
const TRUNC_COMMAND = 500; // 审批命令
const TRUNC_QUESTION = 500; // 用户提问

/** 安全截断字符串，超过长度时追加 "…(truncated)" */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(truncated, ${s.length} total)`;
}

/** 安全序列化对象为 JSON 字符串并截断 */
function safeStringify(value: unknown, max: number): string {
  try {
    return trunc(JSON.stringify(value), max);
  } catch {
    return '[unserializable]';
  }
}

/** ISO 8601 with ns (OTel 格式) */
function ts(): string {
  return new Date().toISOString();
}

/** 将 AgentEvent 转为 TraceRecord（全量，一条都不丢）
 *  @param spanId 可选预生成 spanId。step_begin 由 event.data.spanId 决定（兼作 node span），
 *                turn_begin 由 collector 传入。其余事件由内部 genSpanId() 生成。 */
export function recordEvent(
  event: AgentEvent,
  traceId: string,
  parentSpanId: string,
  spanId?: string,
): TraceRecord {
  // step_begin：使用 chunkToEvents 预生成的 spanId 作为 node span
  if (event.type === 'step_begin') {
    spanId = event.data.spanId;
  }
  const sid = spanId ?? genSpanId();
  const base: TraceRecord = {
    traceId,
    spanId: sid,
    parentSpanId,
    name: '',
    kind: 1, // INTERNAL
    timestamp: ts(),
    attributes: {},
    status: { code: 'OK', message: '' },
  };

  switch (event.type) {
    // ── 步骤边界 ──
    case 'step_begin':
      // spanId 已在函数入口处赋值（event.data.spanId 在 line 50-51 覆盖）
      base.name = `node.${event.data.node}`;
      base.kind = event.data.node === 'agent' ? 3 : 1; // CLIENT for agent (API call)
      base.attributes = {
        'openpx.node': event.data.node,
        ...(event.data.internal ? { 'openpx.internal': true } : {}),
      };
      break;

    case 'step_end':
      base.name = `node.${event.data.node}.end`;
      base.attributes = { 'openpx.node': event.data.node };
      break;

    // ── 模型产出 ──
    case 'text':
      base.name = 'text';
      base.attributes = {
        'openpx.text.length': event.data.text.length,
        'openpx.text.content': trunc(event.data.text, TRUNC_CONTENT),
      };
      break;

    case 'reason':
      base.name = 'reason';
      base.attributes = {
        'openpx.reason.length': event.data.text.length,
        'openpx.reason.content': trunc(event.data.text, TRUNC_CONTENT),
      };
      break;

    // ── 工具调用 ──
    case 'tool_call':
      base.name = `tool.${event.data.name}.call`;
      base.attributes = {
        'openpx.tool.name': event.data.name,
        'openpx.tool.call_id': event.data.call_id,
        'openpx.tool.args': safeStringify(event.data.args, TRUNC_ARGS),
      };
      break;

    case 'tool_done':
      base.name = `tool.${event.data.name}`;
      base.attributes = {
        'openpx.tool.name': event.data.name,
        'openpx.tool.call_id': event.data.call_id,
        'openpx.tool.ok': event.data.ok,
        'openpx.tool.summary': trunc(event.data.summary, TRUNC_SUMMARY),
      };
      if (event.data.totalLines != null) {
        base.attributes['openpx.tool.total_lines'] = event.data.totalLines;
      }
      if (!event.data.ok) {
        const reason = classifyToolFailure(event.data.name, event.data.summary);
        base.attributes['openpx.tool.failure_reason'] = reason;
        base.status = { code: 'ERROR', message: reason };
        base.events = [
          {
            name: 'tool.error',
            timestamp: ts(),
            attributes: {
              'tool.error.summary': trunc(event.data.summary, TRUNC_ERROR),
              'tool.failure_reason': reason,
            },
          },
        ];
      }
      break;

    // ── 人工交互 ──
    case 'need_approval':
      base.name = 'approval';
      base.attributes = {
        'openpx.approval.tool': event.data.tool,
        'openpx.approval.risk': event.data.risk,
        'openpx.approval.command': trunc(event.data.command, TRUNC_COMMAND),
        'openpx.approval.reason': trunc(event.data.reason, TRUNC_SUMMARY),
      };
      if (event.data.expectedEffects && event.data.expectedEffects.length > 0) {
        base.attributes['openpx.approval.expected_effects'] = trunc(
          event.data.expectedEffects.join('; '),
          TRUNC_SUMMARY,
        );
      }
      if (event.data.modelJustification) {
        base.attributes['openpx.approval.model_justification'] = trunc(
          event.data.modelJustification,
          TRUNC_SUMMARY,
        );
      }
      if (event.data.objective) {
        base.attributes['openpx.approval.objective'] = trunc(event.data.objective, TRUNC_SUMMARY);
      }
      break;

    case 'need_input':
      base.name = 'user_input';
      base.attributes = {
        'openpx.input.question': trunc(event.data.question, TRUNC_QUESTION),
      };
      if (event.data.options && event.data.options.length > 0) {
        base.attributes['openpx.input.options'] = safeStringify(event.data.options, TRUNC_SUMMARY);
      }
      if (event.data.context) {
        base.attributes['openpx.input.context'] = trunc(event.data.context, TRUNC_SUMMARY);
      }
      break;

    // ── 状态变更 ──
    case 'state_change':
      base.name = 'state_change';
      base.attributes = {};
      if (event.data.workspaceAccess)
        base.attributes['openpx.workspace_access'] = event.data.workspaceAccess;
      if (event.data.phase) base.attributes['openpx.phase'] = event.data.phase;
      if (event.data.modelProvider) base.attributes['gen_ai.system'] = event.data.modelProvider;
      if (event.data.modelName) base.attributes['gen_ai.request.model'] = event.data.modelName;
      if (event.data.plan) {
        base.attributes['openpx.plan'] = safeStringify(event.data.plan, TRUNC_SUMMARY);
      }
      if (event.data.authorization) {
        base.attributes['openpx.authorization_mode'] = event.data.authorization.mode;
      }
      break;

    case 'file_change':
      base.name = 'file_change';
      base.attributes = {
        'openpx.file.path': event.data.path,
        'openpx.file.kind': event.data.kind,
      };
      if (event.data.linesAdded != null)
        base.attributes['openpx.file.lines_added'] = event.data.linesAdded;
      if (event.data.linesRemoved != null)
        base.attributes['openpx.file.lines_removed'] = event.data.linesRemoved;
      if (event.data.preview)
        base.attributes['openpx.file.preview'] = trunc(event.data.preview, TRUNC_CONTENT);
      break;

    // ── 缓存指标 ──
    case 'cache_metrics':
      base.name = 'cache_metrics';
      base.attributes = {
        'gen_ai.usage.input_tokens': event.data.inputTokens,
        'gen_ai.usage.output_tokens': event.data.outputTokens ?? 0,
        'openpx.cache.hit_tokens': event.data.cacheHitTokens,
        'openpx.cache.miss_tokens': event.data.cacheMissTokens,
      };
      break;

    // ── 模型重试 ──
    case 'model_retry':
      base.name = 'model.retry';
      base.attributes = {
        'openpx.retry.attempt': event.data.attempt,
        'openpx.retry.max_attempts': event.data.maxAttempts,
        'model.retry.delay_ms': event.data.delayMs,
      };
      base.events = [
        {
          name: 'model.retry',
          timestamp: ts(),
          attributes: { 'model.retry.error': trunc(event.data.error, TRUNC_ERROR) },
        },
      ];
      break;

    // ── 异常 ──
    case 'error':
      base.name = 'error';
      base.status = { code: 'ERROR', message: trunc(event.data.message, TRUNC_ERROR) };
      base.attributes = {
        'openpx.error.recoverable': event.data.recoverable,
        'openpx.error.message': trunc(event.data.message, TRUNC_ERROR),
      };
      break;

    // ── 最终消息 ──
    case 'final':
      base.name = 'final';
      base.attributes = {
        'openpx.final.length': event.data.length,
        'openpx.final.content': trunc(event.data, TRUNC_CONTENT),
      };
      break;

    // ── 子 Agent ──
    case 'subagent_start':
      base.name = 'subagent.start';
      base.attributes = {
        'openpx.subagent.id': event.data.id,
        'openpx.subagent.role': event.data.role,
        'openpx.subagent.task': trunc(event.data.task, TRUNC_SUMMARY),
      };
      break;

    case 'subagent_step':
      base.name = `subagent.tool.${event.data.toolName}`;
      base.attributes = {
        'openpx.subagent.id': event.data.id,
        'openpx.tool.name': event.data.toolName,
        'openpx.tool.args': safeStringify(event.data.toolArgs, TRUNC_ARGS),
      };
      break;

    case 'subagent_tool_result':
      base.name = `subagent.tool.${event.data.toolName}.result`;
      base.attributes = {
        'openpx.subagent.id': event.data.id,
        'openpx.tool.name': event.data.toolName,
        'openpx.tool.ok': event.data.ok,
      };
      if (event.data.summary) {
        base.attributes['openpx.tool.summary'] = trunc(event.data.summary, TRUNC_SUMMARY);
      }
      if (event.data.durationMs != null) {
        base.attributes['openpx.tool.duration_ms'] = event.data.durationMs;
      }
      if (event.data.failureReason) {
        base.attributes['openpx.tool.failure_reason'] = event.data.failureReason;
      }
      if (!event.data.ok) {
        base.status = { code: 'ERROR', message: event.data.failureReason ?? 'tool failed' };
      }
      break;

    case 'subagent_done':
      base.name = 'subagent.done';
      base.attributes = {
        'openpx.subagent.id': event.data.id,
        'openpx.subagent.tool_call_count': event.data.toolCallCount,
        'openpx.subagent.duration_ms': event.data.durationMs,
        'openpx.subagent.summary': trunc(event.data.summary, TRUNC_SUMMARY),
      };
      break;

    case 'subagent_error':
      base.name = 'subagent.error';
      base.status = { code: 'ERROR', message: trunc(event.data.error, TRUNC_ERROR) };
      base.attributes = {
        'openpx.subagent.id': event.data.id,
        'openpx.subagent.error': trunc(event.data.error, TRUNC_ERROR),
      };
      if (event.data.toolCallCount != null)
        base.attributes['openpx.subagent.tool_call_count'] = event.data.toolCallCount;
      if (event.data.durationMs != null)
        base.attributes['openpx.subagent.duration_ms'] = event.data.durationMs;
      if (event.data.summary)
        base.attributes['openpx.subagent.summary'] = trunc(event.data.summary, TRUNC_SUMMARY);
      break;

    case 'subagent_cache_metrics':
      base.name = 'subagent.cache_metrics';
      base.attributes = {
        'openpx.subagent.id': event.data.subagentId,
        'openpx.cache.hit_tokens': event.data.cacheHitTokens,
        'openpx.cache.miss_tokens': event.data.cacheMissTokens,
        'gen_ai.usage.input_tokens': event.data.inputTokens,
      };
      break;

    // ── Turn 边界 ──
    case 'turn_begin':
      base.name = 'agent.turn.begin';
      base.attributes = { 'openpx.turn.index': event.data.index };
      break;

    case 'turn_end':
      base.name = 'agent.turn.end';
      base.attributes = { 'openpx.turn.index': event.data.index };
      break;

    // ── 用户消息 ──
    case 'user_message':
      base.name = event.data.kind === 'task' ? 'user.task' : 'user.answer';
      base.attributes = {
        'openpx.user.message': trunc(event.data.text, TRUNC_CONTENT),
        'openpx.user.kind': event.data.kind,
      };
      if (event.data.interruptType) {
        base.attributes['openpx.user.interrupt_type'] = event.data.interruptType;
      }
      break;

    // ── interrupt / update（原始 LangGraph 数据） ──
    case 'interrupt':
      base.name = 'interrupt';
      base.attributes = {
        'openpx.interrupt.type': 'graph_interrupt',
        'openpx.interrupt.data': safeStringify(event.data, TRUNC_SUMMARY),
      };
      break;

    case 'update':
      base.name = 'graph.update';
      base.attributes = {
        'openpx.update.data': safeStringify(event.data, TRUNC_SUMMARY),
      };
      break;
  }

  return base;
}
