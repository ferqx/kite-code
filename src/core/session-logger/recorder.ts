// src/core/session-logger/recorder.ts
// AgentEvent → TraceRecord 映射器（全量记录，所有事件都留痕）
//
// 截断策略：本地会话日志用于调试回溯，保留完整语义但控制文件体积。
// 本地日志也必须执行最小敏感信息脱敏；遥测通道会再执行独立 scrubber。

import { genSpanId } from '@/core/id-utils';
import type { RuntimeEvent } from '@/core/runtime/events';
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
  const redacted = redactSensitiveText(s);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…(truncated, ${redacted.length} total)`;
}

/** 安全序列化对象为 JSON 字符串并截断 */
function safeStringify(value: unknown, max: number): string {
  try {
    return trunc(JSON.stringify(value), max);
  } catch {
    return '[unserializable]';
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(?:["']?)\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,
      '$1[REDACTED]$3',
    )
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{16,}\b/gi, '[REDACTED]');
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
        'kite_code.node': event.data.node,
        ...(event.data.internal ? { 'kite_code.internal': true } : {}),
      };
      break;

    case 'step_end':
      base.name = `node.${event.data.node}.end`;
      base.attributes = { 'kite_code.node': event.data.node };
      break;

    // ── 模型产出 ──
    case 'text':
      base.name = 'text';
      base.attributes = {
        'kite_code.text.length': event.data.text.length,
        'kite_code.text.content': trunc(event.data.text, TRUNC_CONTENT),
      };
      break;

    case 'reason':
      base.name = 'reason';
      base.attributes = {
        'kite_code.reason.length': event.data.text.length,
        'kite_code.reason.content': trunc(event.data.text, TRUNC_CONTENT),
      };
      break;

    // ── 工具调用 ──
    case 'tool_call':
      base.name = `tool.${event.data.name}.call`;
      base.attributes = {
        'kite_code.tool.name': event.data.name,
        'kite_code.tool.call_id': event.data.call_id,
        'kite_code.tool.args': safeStringify(event.data.args, TRUNC_ARGS),
      };
      break;

    case 'tool_done':
      base.name = `tool.${event.data.name}`;
      base.attributes = {
        'kite_code.tool.name': event.data.name,
        'kite_code.tool.call_id': event.data.call_id,
        'kite_code.tool.ok': event.data.ok,
        'kite_code.tool.summary': trunc(event.data.summary, TRUNC_SUMMARY),
      };
      if (event.data.totalLines != null) {
        base.attributes['kite_code.tool.total_lines'] = event.data.totalLines;
      }
      if (!event.data.ok) {
        const reason = classifyToolFailure(event.data.name, event.data.summary);
        base.attributes['kite_code.tool.failure_reason'] = reason;
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
        'kite_code.approval.tool': event.data.tool,
        'kite_code.approval.risk': event.data.risk,
        'kite_code.approval.command': trunc(event.data.command, TRUNC_COMMAND),
        'kite_code.approval.reason': trunc(event.data.reason, TRUNC_SUMMARY),
      };
      if (event.data.expectedEffects && event.data.expectedEffects.length > 0) {
        base.attributes['kite_code.approval.expected_effects'] = trunc(
          event.data.expectedEffects.join('; '),
          TRUNC_SUMMARY,
        );
      }
      if (event.data.subagentId) base.attributes['kite_code.subagent.id'] = event.data.subagentId;
      break;

    case 'need_input':
      base.name = 'user_input';
      base.attributes = {
        'kite_code.input.question': trunc(event.data.question, TRUNC_QUESTION),
      };
      if (event.data.options && event.data.options.length > 0) {
        base.attributes['kite_code.input.options'] = safeStringify(
          event.data.options,
          TRUNC_SUMMARY,
        );
      }
      if (event.data.context) {
        base.attributes['kite_code.input.context'] = trunc(event.data.context, TRUNC_SUMMARY);
      }
      break;

    // ── 状态变更 ──
    case 'state_change':
      base.name = 'state_change';
      base.attributes = {};
      if (event.data.workspaceAccess)
        base.attributes['kite_code.workspace_access'] = event.data.workspaceAccess;
      if (event.data.phase) base.attributes['kite_code.phase'] = event.data.phase;
      if (event.data.modelProvider) base.attributes['gen_ai.system'] = event.data.modelProvider;
      if (event.data.modelName) base.attributes['gen_ai.request.model'] = event.data.modelName;
      if (event.data.plan) {
        base.attributes['kite_code.plan'] = safeStringify(event.data.plan, TRUNC_SUMMARY);
      }
      if (event.data.authorization) {
        base.attributes['kite_code.authorization_mode'] = event.data.authorization.mode;
      }
      break;

    case 'file_change':
      base.name = 'file_change';
      base.attributes = {
        'kite_code.file.path': event.data.path,
        'kite_code.file.kind': event.data.kind,
      };
      if (event.data.linesAdded != null)
        base.attributes['kite_code.file.lines_added'] = event.data.linesAdded;
      if (event.data.linesRemoved != null)
        base.attributes['kite_code.file.lines_removed'] = event.data.linesRemoved;
      if (event.data.preview)
        base.attributes['kite_code.file.preview'] = trunc(event.data.preview, TRUNC_CONTENT);
      break;

    // ── 缓存指标 ──
    case 'cache_metrics':
      base.name = 'cache_metrics';
      base.attributes = {
        'gen_ai.usage.input_tokens': event.data.inputTokens,
        'gen_ai.usage.output_tokens': event.data.outputTokens ?? 0,
        'kite_code.cache.hit_tokens': event.data.cacheHitTokens,
        'kite_code.cache.miss_tokens': event.data.cacheMissTokens,
      };
      break;

    // ── 模型重试 ──
    case 'model_retry':
      base.name = 'model.retry';
      base.attributes = {
        'kite_code.retry.attempt': event.data.attempt,
        'kite_code.retry.max_attempts': event.data.maxAttempts,
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
        'kite_code.error.recoverable': event.data.recoverable,
        'kite_code.error.message': trunc(event.data.message, TRUNC_ERROR),
      };
      break;

    // ── 最终消息 ──
    case 'final':
      base.name = 'final';
      base.attributes = {
        'kite_code.final.length': event.data.length,
        'kite_code.final.content': trunc(event.data, TRUNC_CONTENT),
      };
      break;

    // ── 子 Agent ──
    case 'subagent_start':
      base.name = 'subagent.start';
      base.attributes = {
        'kite_code.subagent.id': event.data.id,
        'kite_code.subagent.role': event.data.role,
        'kite_code.subagent.task': trunc(event.data.task, TRUNC_SUMMARY),
      };
      break;

    case 'subagent_step':
      base.name = `subagent.tool.${event.data.toolName}`;
      base.attributes = {
        'kite_code.subagent.id': event.data.id,
        'kite_code.tool.name': event.data.toolName,
        'kite_code.tool.args': safeStringify(event.data.toolArgs, TRUNC_ARGS),
      };
      break;

    case 'subagent_tool_result':
      base.name = `subagent.tool.${event.data.toolName}.result`;
      base.attributes = {
        'kite_code.subagent.id': event.data.id,
        'kite_code.tool.name': event.data.toolName,
        'kite_code.tool.ok': event.data.ok,
      };
      if (event.data.summary) {
        base.attributes['kite_code.tool.summary'] = trunc(event.data.summary, TRUNC_SUMMARY);
      }
      if (event.data.durationMs != null) {
        base.attributes['kite_code.tool.duration_ms'] = event.data.durationMs;
      }
      if (event.data.failureReason) {
        base.attributes['kite_code.tool.failure_reason'] = event.data.failureReason;
      }
      if (!event.data.ok) {
        base.status = { code: 'ERROR', message: event.data.failureReason ?? 'tool failed' };
      }
      break;

    case 'subagent_done':
      base.name = 'subagent.done';
      base.attributes = {
        'kite_code.subagent.id': event.data.id,
        'kite_code.subagent.tool_call_count': event.data.toolCallCount,
        'kite_code.subagent.duration_ms': event.data.durationMs,
        'kite_code.subagent.summary': trunc(event.data.summary, TRUNC_SUMMARY),
      };
      break;

    case 'subagent_error':
      base.name = 'subagent.error';
      base.status = { code: 'ERROR', message: trunc(event.data.error, TRUNC_ERROR) };
      base.attributes = {
        'kite_code.subagent.id': event.data.id,
        'kite_code.subagent.error': trunc(event.data.error, TRUNC_ERROR),
      };
      if (event.data.toolCallCount != null)
        base.attributes['kite_code.subagent.tool_call_count'] = event.data.toolCallCount;
      if (event.data.durationMs != null)
        base.attributes['kite_code.subagent.duration_ms'] = event.data.durationMs;
      if (event.data.summary)
        base.attributes['kite_code.subagent.summary'] = trunc(event.data.summary, TRUNC_SUMMARY);
      break;

    case 'subagent_cache_metrics':
      base.name = 'subagent.cache_metrics';
      base.attributes = {
        'kite_code.subagent.id': event.data.subagentId,
        'kite_code.cache.hit_tokens': event.data.cacheHitTokens,
        'kite_code.cache.miss_tokens': event.data.cacheMissTokens,
        'gen_ai.usage.input_tokens': event.data.inputTokens,
      };
      break;

    // ── Turn 边界 ──
    case 'turn_begin':
      base.name = 'agent.turn.begin';
      base.attributes = { 'kite_code.turn.index': event.data.index };
      break;

    case 'turn_end':
      base.name = 'agent.turn.end';
      base.attributes = { 'kite_code.turn.index': event.data.index };
      break;

    // ── 用户消息 ──
    case 'user_message':
      base.name = event.data.kind === 'task' ? 'user.task' : 'user.answer';
      base.attributes = {
        'kite_code.user.message': trunc(event.data.text, TRUNC_CONTENT),
        'kite_code.user.kind': event.data.kind,
      };
      if (event.data.interruptType) {
        base.attributes['kite_code.user.interrupt_type'] = event.data.interruptType;
      }
      break;

    // ── interrupt / update（原始 LangGraph 数据） ──
    case 'interrupt':
      base.name = 'interrupt';
      base.attributes = {
        'kite_code.interrupt.type': 'graph_interrupt',
        'kite_code.interrupt.data': safeStringify(event.data, TRUNC_SUMMARY),
      };
      break;

    case 'update':
      base.name = 'graph.update';
      base.attributes = {
        'kite_code.update.data': safeStringify(event.data, TRUNC_SUMMARY),
      };
      break;
  }

  return base;
}

/** Record a RuntimeEvent directly, without converting it through AgentEvent. */
export function recordRuntimeEvent(
  event: RuntimeEvent,
  traceId: string,
  parentSpanId: string,
): TraceRecord {
  const base: TraceRecord = {
    traceId,
    spanId: genSpanId(),
    parentSpanId,
    name: `runtime.${event.type}`,
    kind: 1,
    timestamp: ts(),
    attributes: { 'kite_code.runtime_event': event.type },
    status: { code: 'OK', message: '' },
  };
  switch (event.type) {
    case 'context.compaction_requested':
      base.name = 'context.compaction.requested';
      base.attributes['kite_code.compaction.id'] = event.compactionId;
      base.attributes['kite_code.compaction.reason'] = event.reason;
      base.attributes['kite_code.compaction.input_tokens'] = event.estimate.totalInputTokens;
      break;
    case 'context.compaction_completed':
      base.name = 'context.compaction.completed';
      base.attributes['kite_code.compaction.id'] = event.compactionId;
      base.attributes['kite_code.compaction.reason'] = event.checkpoint.reason;
      base.attributes['kite_code.compaction.input_tokens_before'] =
        event.checkpoint.inputTokensBefore;
      base.attributes['kite_code.compaction.input_tokens_after'] =
        event.checkpoint.inputTokensAfter;
      base.attributes['kite_code.compaction.tokens_saved'] =
        event.checkpoint.inputTokensBefore - event.checkpoint.inputTokensAfter;
      if (event.durationMs != null)
        base.attributes['kite_code.compaction.duration_ms'] = event.durationMs;
      break;
    case 'context.compaction_failed':
      base.name = 'context.compaction.failed';
      base.attributes['kite_code.compaction.id'] = event.compactionId;
      base.attributes['kite_code.compaction.error_kind'] = event.errorKind;
      base.attributes['kite_code.compaction.retryable'] = event.retryable;
      if (event.durationMs != null)
        base.attributes['kite_code.compaction.duration_ms'] = event.durationMs;
      base.status = { code: 'ERROR', message: trunc(event.message, TRUNC_ERROR) };
      break;
    case 'context.hard_blocked':
      base.name = 'context.compaction.hard_blocked';
      base.attributes['kite_code.compaction.block_reason'] = event.reason;
      base.status = { code: 'ERROR', message: trunc(event.message, TRUNC_ERROR) };
      break;
    case 'model.context_metrics':
      base.name = 'model.context_metrics';
      base.attributes['gen_ai.request.model'] = event.modelName;
      base.attributes['kite_code.context.status'] = event.status;
      base.attributes['kite_code.context.input_tokens'] = event.totalInputTokens;
      if (event.contextWindowSource)
        base.attributes['kite_code.context.window_source'] = event.contextWindowSource;
      if (event.tokenizerSource)
        base.attributes['kite_code.context.tokenizer_source'] = event.tokenizerSource;
      if (event.usableInputTokens != null)
        base.attributes['kite_code.context.usable_input_tokens'] = event.usableInputTokens;
      if (event.utilization != null)
        base.attributes['kite_code.context.utilization'] = event.utilization;
      break;
    case 'model.responded':
      base.kind = 3;
      base.attributes['kite_code.model.message_id'] = event.messageId;
      // 模型调用耗时必须落盘：离线计时分析与日志回放路径依赖此字段重建
      // "Thought for Xs" 语义（规则 22：elapsed 冻结于模型调用时长）；
      // 缺失时回放只能回退创建→settle 墙钟。
      // Persist model-call duration: offline timing analysis and log-replay
      // paths rely on it to reconstruct "Thought for Xs" semantics (rule 22);
      // without it replay falls back to creation→settle wall clock.
      if (event.durationMs != null)
        base.attributes['kite_code.model.duration_ms'] = event.durationMs;
      if (event.text) base.attributes['kite_code.text.content'] = trunc(event.text, TRUNC_CONTENT);
      if (event.reasoningText)
        base.attributes['kite_code.reason.content'] = trunc(event.reasoningText, TRUNC_CONTENT);
      break;
    case 'tool.queued':
      base.name = `tool.${event.name}.call`;
      base.attributes['kite_code.tool.name'] = event.name;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.tool.args'] = safeStringify(event.args, TRUNC_ARGS);
      break;
    case 'tool.started':
      base.name = 'tool.start';
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      break;
    case 'tool.finished':
      base.name = `tool.${event.name}`;
      base.attributes['kite_code.tool.name'] = event.name;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.tool.ok'] = event.result.ok;
      base.attributes['kite_code.tool.summary'] = trunc(
        event.result.stdout || event.result.stderr,
        TRUNC_SUMMARY,
      );
      if (!event.result.ok)
        base.status = { code: 'ERROR', message: event.result.stderr || 'tool failed' };
      break;
    case 'tool.failed':
    case 'tool.rejected':
      base.status = {
        code: 'ERROR',
        message:
          event.type === 'tool.failed'
            ? (event.failure?.message ?? event.error ?? 'Tool failed.')
            : event.reason,
      };
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      if (event.type === 'tool.failed' && event.failure) {
        base.attributes['kite_code.failure.kind'] = event.failure.kind;
        base.attributes['kite_code.failure.retryable'] = event.failure.retryable;
      }
      break;
    case 'user_input.requested':
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.input.question'] = trunc(event.request.question, TRUNC_QUESTION);
      break;
    case 'approval.requested':
      base.name = 'approval.requested';
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.approval.tool'] = event.approval.tool;
      base.attributes['kite_code.approval.command'] = trunc(event.approval.command, TRUNC_COMMAND);
      base.attributes['kite_code.approval.risk'] = event.approval.risk;
      base.attributes['kite_code.approval.reason'] = trunc(event.approval.reason, TRUNC_SUMMARY);
      if (event.approval.subagentId)
        base.attributes['kite_code.subagent.id'] = event.approval.subagentId;
      break;
    case 'approval.granted':
      base.name = 'approval.granted';
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.approval.grant'] = event.grant;
      break;
    case 'approval.rejected':
      base.name = 'approval.rejected';
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      if (event.reason)
        base.attributes['kite_code.approval.reject_reason'] = trunc(event.reason, TRUNC_SUMMARY);
      break;
    case 'plan.review_requested':
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.plan'] = safeStringify(event.plan, TRUNC_SUMMARY);
      break;
    case 'auto_review.requested':
      base.name = 'auto_review.requested';
      base.attributes['kite_code.interaction_id'] = event.reviewId;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.tool.name'] = event.toolName;
      base.attributes['kite_code.auto_review.reason'] = trunc(event.reason, TRUNC_SUMMARY);
      break;
    case 'auto_review.completed':
      base.name = 'auto_review.completed';
      base.attributes['kite_code.interaction_id'] = event.reviewId;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.auto_review.approved'] = event.result.approved;
      base.attributes['kite_code.auto_review.reason'] = trunc(
        event.result.reason ?? '',
        TRUNC_SUMMARY,
      );
      base.attributes['kite_code.auto_review.model'] = event.result.reviewerModelName ?? 'unknown';
      base.attributes['kite_code.auto_review.duration_ms'] = event.result.durationMs;
      break;
    case 'verification.requested':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.mode'] = event.mode;
      base.attributes['kite_code.verification.subject'] = trunc(event.spec.subject, TRUNC_SUMMARY);
      break;
    case 'verification.started':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.attempt'] = event.attempt;
      break;
    case 'verification.check_completed':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.check_id'] = event.result.checkId;
      base.attributes['kite_code.verification.outcome'] = event.result.outcome;
      break;
    case 'verification.completed':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.outcome'] = event.outcome;
      if (event.outcome !== 'passed') base.status = { code: 'ERROR', message: event.outcome };
      break;
    case 'verification.waived':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.waived_by'] = event.actor;
      break;
    case 'verification.repair_requested':
    case 'verification.replan_requested':
    case 'verification.compensation_requested':
    case 'verification.compensation_completed':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      break;
    case 'subagent.started':
      base.name = 'subagent.start';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      base.attributes['kite_code.subagent.role'] = event.subagent.role;
      base.attributes['kite_code.subagent.task'] = trunc(event.subagent.task, TRUNC_SUMMARY);
      break;
    case 'subagent.step':
      base.name = 'subagent.step';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      base.attributes['kite_code.tool.name'] = event.subagent.toolName;
      base.attributes['kite_code.tool.args'] = safeStringify(event.subagent.toolArgs, TRUNC_ARGS);
      break;
    case 'subagent.tool_result':
      base.name = 'subagent.tool_result';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      base.attributes['kite_code.tool.name'] = event.subagent.toolName;
      base.attributes['kite_code.tool.ok'] = event.subagent.ok;
      if (event.subagent.failureReason)
        base.attributes['kite_code.tool.failure_reason'] = event.subagent.failureReason;
      if (!event.subagent.ok)
        base.status = { code: 'ERROR', message: event.subagent.summary ?? 'tool failed' };
      break;
    case 'subagent.suspended':
      base.name = 'subagent.suspended';
      base.attributes['kite_code.subagent.blocked_tool'] = event.snapshot.blockedTool.toolName;
      base.attributes['kite_code.subagent.blocked_command'] = trunc(
        event.snapshot.blockedTool.command,
        TRUNC_SUMMARY,
      );
      base.attributes['kite_code.subagent.id'] = event.snapshot.subagentId;
      base.attributes['kite_code.subagent.role'] = event.snapshot.role;
      base.attributes['kite_code.subagent.tool_call_count'] = event.snapshot.toolCallCount;
      break;
    case 'subagent.completed':
    case 'subagent.failed':
      base.name = event.type === 'subagent.completed' ? 'subagent.done' : 'subagent.error';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      if (event.subagent.summary)
        base.attributes['kite_code.subagent.summary'] = trunc(
          event.subagent.summary,
          TRUNC_SUMMARY,
        );
      if (event.subagent.toolCallCount != null)
        base.attributes['kite_code.subagent.tool_call_count'] = event.subagent.toolCallCount;
      if (event.subagent.durationMs != null)
        base.attributes['kite_code.subagent.duration_ms'] = event.subagent.durationMs;
      if (event.type === 'subagent.failed')
        base.status = { code: 'ERROR', message: event.subagent.error };
      break;
    case 'subagent.cache_metrics':
      base.name = 'subagent.cache_metrics';
      base.attributes['kite_code.subagent.id'] = event.subagent.subagentId;
      base.attributes['gen_ai.usage.input_tokens'] = event.subagent.inputTokens;
      break;
  }
  return base;
}
