// tests/session-logger/recorder.test.ts
// 验证 RuntimeEvent → TraceRecord 映射

import { describe, expect, test } from 'bun:test';
import { recordRuntimeEvent } from '@/core/session-logger/recorder';

const TRACE = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const PARENT = 'cccccccccccccccc';

describe('recordRuntimeEvent — compaction telemetry', () => {
  test('records the rejected approval tool identity', () => {
    const record = recordRuntimeEvent(
      {
        type: 'approval.rejected',
        interactionId: 'approval-rejected',
        toolCallId: 'shell-rejected',
        reason: 'Rejected by user.',
      },
      TRACE,
      PARENT,
    );

    expect(record.attributes['kite_code.tool.call_id']).toBe('shell-rejected');
  });

  test('persists completed token savings and real effect duration', () => {
    const r = recordRuntimeEvent(
      {
        type: 'context.compaction_completed',
        compactionId: 'compact-1',
        sourceRevision: 3,
        durationMs: 27,
        checkpoint: {
          compactionId: 'compact-1',
          version: 1,
          sourceRevision: 3,
          sourceDigest: 'sha256:source',
          coveredThroughMessageId: 'message-1',
          coveredThroughTurnId: 'turn-1',
          summary: 'Retain the important historical facts.',
          inputTokensBefore: 10_000,
          inputTokensAfter: 4_000,
          reason: 'auto',
          createdAt: '2026-07-21T00:00:00.000Z',
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('context.compaction.completed');
    expect(r.attributes['kite_code.compaction.tokens_saved']).toBe(6_000);
    expect(r.attributes['kite_code.compaction.duration_ms']).toBe(27);
  });

  test('persists validation failure and model context pressure', () => {
    const failed = recordRuntimeEvent(
      {
        type: 'context.compaction_failed',
        compactionId: 'compact-2',
        sourceRevision: 4,
        errorKind: 'invalid_candidate',
        message: 'fabricated question',
        retryable: false,
        durationMs: 12,
      },
      TRACE,
      PARENT,
    );
    expect(failed.attributes['kite_code.compaction.error_kind']).toBe('invalid_candidate');
    expect(failed.status.code).toBe('ERROR');

    const pressure = recordRuntimeEvent(
      {
        type: 'model.context_metrics',
        modelName: 'adapter-only',
        contextWindowTokens: 32_000,
        usableInputTokens: 28_976,
        reservedOutputTokens: 2_000,
        providerSafetyMarginTokens: 1_024,
        totalInputTokens: 27_000,
        utilization: 0.9318,
        status: 'compact_due',
        estimate: {
          systemTokens: 1_000,
          toolSchemaTokens: 1_000,
          transcriptTokens: 24_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 500,
          framingTokens: 500,
          totalInputTokens: 27_000,
        },
      },
      TRACE,
      PARENT,
    );
    expect(pressure.name).toBe('model.context_metrics');
    expect(pressure.attributes['kite_code.context.utilization']).toBe(0.9318);
  });

  test('model.responded — 记录模型调用耗时（规则 22：Thought 计时与日志回放的依据）', () => {
    const r = recordRuntimeEvent(
      {
        type: 'model.responded',
        messageId: 'msg-1',
        durationMs: 2093,
        text: 'Let me read the core files systematically.',
        reasoningText: 'The user wants to understand the TUI module.',
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('runtime.model.responded');
    expect(r.kind).toBe(3);
    expect(r.attributes['kite_code.model.message_id']).toBe('msg-1');
    expect(r.attributes['kite_code.model.duration_ms']).toBe(2093);
    expect(r.attributes['kite_code.text.content']).toContain('core files');
    expect(r.attributes['kite_code.reason.content']).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('TUI module');

    // 旧事件无 durationMs 时不写入该属性（回放走创建→settle 墙钟回退）
    const legacy = recordRuntimeEvent(
      { type: 'model.responded', messageId: 'msg-2' },
      TRACE,
      PARENT,
    );
    expect(legacy.attributes['kite_code.model.duration_ms']).toBeUndefined();
  });
});
