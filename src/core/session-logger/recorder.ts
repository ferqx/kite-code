// src/core/session-logger/recorder.ts
// RuntimeEvent → TraceRecord 映射器（敏感正文按字段拒绝落盘）
//
// 截断策略：content 模式保留允许的用户/模型可见正文，同时控制文件体积。
// reasoning、工具输入输出、计划和子 Agent 正文不进入记录；允许正文仍执行脱敏。

import { genSpanId } from '@/core/id-utils';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { TraceRecord } from './types';

// 内容截断阈值（字符数）
const TRUNC_CONTENT = 10_000; // text / reason / final 正文
const TRUNC_SUMMARY = 4096; // tool_done summary / subagent summary
const TRUNC_ERROR = 500; // 错误消息
const TRUNC_QUESTION = 500; // 用户提问

/** 安全截断字符串，超过长度时追加 "…(truncated)" */
function trunc(s: string, max: number): string {
  const redacted = redactSensitiveText(s);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…(truncated, ${redacted.length} total)`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*)(["'])([^"'\r\n]+)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*)(?!["'])[^\s,;}\]\r\n]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)[-_][a-z0-9_-]{16,}\b/gi, '[REDACTED]');
}

/** ISO 8601 with ns (OTel 格式) */
function ts(): string {
  return new Date().toISOString();
}

type ContentRuntimeEvent = Extract<
  RuntimeEvent,
  { type: 'user.message_appended' | 'model.responded' }
>;

/**
 * Explicit content-mode allowlist. Only redacted user text and model-visible
 * text cross this boundary; IDs, reasoning, tool data, paths and errors do not.
 */
export function recordContentRuntimeEvent(
  event: ContentRuntimeEvent,
  traceId: string,
  parentSpanId: string,
): TraceRecord {
  const content = event.type === 'user.message_appended' ? event.content : (event.text ?? '');
  return {
    traceId,
    spanId: genSpanId(),
    parentSpanId,
    name: event.type === 'user.message_appended' ? 'user.message' : 'model.message',
    kind: event.type === 'model.responded' ? 3 : 1,
    timestamp: ts(),
    attributes: {
      'kite_code.text.length': content.length,
      'kite_code.text.content': trunc(content, TRUNC_CONTENT),
    },
    status: { code: 'OK', message: '' },
  };
}

/** Record a canonical RuntimeEvent. */
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
      // "Thinking · Xs" 语义（规则 22：elapsed 冻结于模型调用时长）；
      // 缺失时回放只能回退创建→settle 墙钟。
      // Persist model-call duration: offline timing analysis and log-replay
      // paths rely on it to reconstruct "Thinking · Xs" semantics (rule 22);
      // without it replay falls back to creation→settle wall clock.
      if (event.durationMs != null)
        base.attributes['kite_code.model.duration_ms'] = event.durationMs;
      if (event.text) base.attributes['kite_code.text.content'] = trunc(event.text, TRUNC_CONTENT);
      break;
    case 'tool.queued':
      base.name = `tool.${event.name}.call`;
      base.attributes['kite_code.tool.name'] = event.name;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
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
      if (!event.result.ok) base.status = { code: 'ERROR', message: 'tool failed' };
      break;
    case 'tool.failed':
    case 'tool.rejected':
      base.status = {
        code: 'ERROR',
        message: event.type === 'tool.failed' ? event.failure.message : event.reason,
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
    case 'user_input.cancelled':
      base.name = 'user_input.cancelled';
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.input.cancel_reason'] = trunc(event.reason, TRUNC_SUMMARY);
      base.status = { code: 'OK', message: 'user cancelled input' };
      break;
    case 'approval.requested':
      base.name = 'approval.requested';
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      base.attributes['kite_code.approval.tool'] = event.approval.tool;
      base.attributes['kite_code.approval.risk'] = event.approval.risk;
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
      if (event.toolCallId) base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      if (event.reason)
        base.attributes['kite_code.approval.reject_reason'] = trunc(event.reason, TRUNC_SUMMARY);
      break;
    case 'plan.review_requested':
      base.attributes['kite_code.interaction_id'] = event.interactionId;
      break;
    case 'auto_review.requested':
      base.name = 'auto_review.requested';
      base.attributes['kite_code.interaction_id'] = event.reviewId;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.tool.name'] = event.toolName;
      break;
    case 'auto_review.completed':
      base.name = 'auto_review.completed';
      base.attributes['kite_code.interaction_id'] = event.reviewId;
      base.attributes['kite_code.tool.call_id'] = event.toolCallId;
      base.attributes['kite_code.auto_review.approved'] = event.result.approved;
      base.attributes['kite_code.auto_review.model'] = event.result.reviewerModelName ?? 'unknown';
      base.attributes['kite_code.auto_review.duration_ms'] = event.result.durationMs;
      break;
    case 'verification.requested':
      base.attributes['kite_code.verification.id'] = event.verificationId;
      base.attributes['kite_code.verification.mode'] = event.mode;
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
      break;
    case 'subagent.step':
      base.name = 'subagent.step';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      base.attributes['kite_code.tool.name'] = event.subagent.toolName;
      break;
    case 'subagent.tool_result':
      base.name = 'subagent.tool_result';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      base.attributes['kite_code.tool.name'] = event.subagent.toolName;
      base.attributes['kite_code.tool.ok'] = event.subagent.ok;
      if (event.subagent.failureReason)
        base.attributes['kite_code.tool.failure_reason'] = event.subagent.failureReason;
      if (!event.subagent.ok) base.status = { code: 'ERROR', message: 'tool failed' };
      break;
    case 'subagent.suspended':
      base.name = 'subagent.suspended';
      base.attributes['kite_code.subagent.blocked_tool'] = event.snapshot.blockedTool.toolName;
      base.attributes['kite_code.subagent.id'] = event.snapshot.subagentId;
      base.attributes['kite_code.subagent.role'] = event.snapshot.role;
      if (!('storage' in event.snapshot)) {
        base.attributes['kite_code.subagent.tool_call_count'] = event.snapshot.toolCallCount;
      }
      break;
    case 'subagent.completed':
    case 'subagent.failed':
      base.name = event.type === 'subagent.completed' ? 'subagent.done' : 'subagent.error';
      base.attributes['kite_code.subagent.id'] = event.subagent.id;
      if (event.subagent.toolCallCount != null)
        base.attributes['kite_code.subagent.tool_call_count'] = event.subagent.toolCallCount;
      if (event.subagent.durationMs != null)
        base.attributes['kite_code.subagent.duration_ms'] = event.subagent.durationMs;
      if (event.type === 'subagent.failed')
        base.status = { code: 'ERROR', message: 'subagent failed' };
      break;
    case 'subagent.cache_metrics':
      base.name = 'subagent.cache_metrics';
      base.attributes['kite_code.subagent.id'] = event.subagent.subagentId;
      base.attributes['gen_ai.usage.input_tokens'] = event.subagent.inputTokens;
      break;
  }
  return base;
}
