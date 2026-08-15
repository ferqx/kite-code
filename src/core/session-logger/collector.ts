// src/core/session-logger/collector.ts
// SessionLogCollector — 伴随 runAgent() 生命周期，全量记录 + 聚合摘要
//
// Span 层级：
//   session.start (root)
//   ├── agent.turn [1]           ← nextTurn() 创建
//   │   ├── node.agent           ← step_begin 事件，parent = turn
//   │   │   ├── text             ← parent = node
//   │   │   ├── tool_call        ← parent = node
//   │   │   └── tool_done        ← parent = node
//   │   ├── node.tools
//   │   └── node.agent.end
//   ├── agent.turn [2]
//   │   └── ...
//   └── session.end (root)
//
// 子 Agent 事件通过 subagentEventSink → emitAndRecord() 写入，
// parentSpanId 使用当前活跃的 node span，归入主日志文件（子 agent 不创建独立日志）。

import type { SessionLoggingPolicyV1 } from '@/core/config/session-logging-policy';
import { genSpanId, genTraceId } from '@/core/id-utils';
import type { RuntimeEvent } from '@/core/runtime/events';
import { mapRuntimeMetadataV1, mapSessionBoundaryMetadataV1 } from './metadata-mapper';
import { recordContentRuntimeEvent } from './recorder';
import type {
  SessionLoggingContentInspectorV1,
  SessionLoggingContentProvenanceV1,
  SessionLoggingDiagnosticV1,
  SessionMetadataContextV1,
  TraceRecord,
} from './types';
import { SessionLogWriter } from './writer';

interface SessionLogWriterLike {
  write(record: unknown): void;
  finalize(status?: 'completed' | 'aborted' | 'fatal'): Promise<void>;
}

export interface SessionLogCollectorOptions {
  mode?: 'off' | 'metadata' | 'content';
  policy?: SessionLoggingPolicyV1;
  metadataContext?: SessionMetadataContextV1;
  contentInspector?: SessionLoggingContentInspectorV1;
  onDiagnostic?: (diagnostic: SessionLoggingDiagnosticV1) => void;
  writerFactory?: (
    frontend: string,
    threadId: string,
    basename: string,
    onDiagnostic: (diagnostic: SessionLoggingDiagnosticV1) => void,
    policy?: SessionLoggingPolicyV1,
  ) => SessionLogWriterLike;
}

export class SessionLogCollector {
  private _writer: SessionLogWriterLike | null = null;
  private _finalizationWriter: SessionLogWriterLike | null = null;
  private _mode: 'off' | 'metadata' | 'content';
  private _metadataContext: SessionMetadataContextV1;
  private _traceId: string;
  /** 当前 turn span ID，nextTurn() 时刷新 */
  private _currentTurnSpanId = '';
  private readonly _reportedDiagnostics = new Set<SessionLoggingDiagnosticV1['code']>();
  private readonly _contentInspector?: SessionLoggingContentInspectorV1;
  private readonly _onDiagnostic?: (diagnostic: SessionLoggingDiagnosticV1) => void;

  constructor(
    threadId: string,
    workspace: string,
    frontend: string,
    model: { provider: string; name: string },
    options: SessionLogCollectorOptions = {},
  ) {
    this._mode = options.policy?.mode ?? options.mode ?? 'off';
    this._metadataContext = options.metadataContext ?? {};
    this._contentInspector = options.contentInspector;
    this._onDiagnostic = options.onDiagnostic;
    this._traceId = genTraceId();
    const writerFactory =
      options.writerFactory ??
      ((writerFrontend, writerThreadId, basename, onDiagnostic, policy) =>
        new SessionLogWriter(writerFrontend, writerThreadId, basename, onDiagnostic, undefined, {
          policy,
        }));
    if (this._mode !== 'off') {
      try {
        let failedSynchronously = false;
        const writer = writerFactory(
          frontend,
          threadId,
          'events',
          (diagnostic) => {
            if (diagnostic.code === 'writer_unavailable') {
              failedSynchronously = true;
              this._tripLogging(diagnostic);
            } else {
              this._reportDiagnostic(diagnostic);
            }
          },
          options.policy,
        );
        if (!failedSynchronously) {
          this._writer = writer;
          this._finalizationWriter = writer;
        }
      } catch {
        this._tripLogging();
      }
    }
    if (this._mode === 'metadata') {
      this._write(mapSessionBoundaryMetadataV1('session.start', 'ok', this._metadataContext));
      return;
    }
    if (this._mode === 'off') return;

    // content 使用显式 allowlist；边界不携带 workspace、model 或设备标识。
    void workspace;
    void model;
    this._recordRaw({
      traceId: this._traceId,
      spanId: genSpanId(),
      parentSpanId: '',
      name: 'session.start',
      kind: 1,
      timestamp: new Date().toISOString(),
      attributes: {},
      status: { code: 'OK', message: '' },
    });
  }

  // ── 公开 API ──

  /** Record the canonical Runtime event path. */
  recordRuntime(event: RuntimeEvent): void {
    if (this._mode === 'off') return;
    if (this._mode === 'metadata') {
      try {
        this._write(mapRuntimeMetadataV1(event));
      } catch {
        this._tripLogging();
      }
      return;
    }
    if (event.type !== 'user.message_appended' && event.type !== 'model.responded') return;
    const text = event.type === 'user.message_appended' ? event.content : event.text;
    if (!text) return;
    if (
      !this._contentAllowed(
        text,
        event.type === 'user.message_appended' ? 'user_message' : 'model_visible_answer',
      )
    )
      return;
    try {
      const rec = recordContentRuntimeEvent(event, this._traceId, this._currentTurnSpanId);
      this._recordRaw(rec);
    } catch {
      this._tripLogging();
    }
  }

  /** Associate admitted content records with the current turn. */
  nextTurn(turnSpanId: string): void {
    if (this._mode !== 'content') return;
    this._currentTurnSpanId = turnSpanId;
  }

  /** 会话结束。需要 await 以保证日志完全落盘 */
  async finalize(status: 'completed' | 'aborted' | 'fatal'): Promise<void> {
    if (this._mode === 'off') {
      await this._finalizeWriter(status);
      return;
    }
    if (this._mode === 'metadata') {
      this._write(
        mapSessionBoundaryMetadataV1(
          'session.end',
          status === 'completed' ? 'ok' : status === 'aborted' ? 'cancelled' : 'error',
          this._metadataContext,
        ),
      );
      await this._finalizeWriter(status);
      return;
    }

    // session.end 记录
    this._recordRaw({
      traceId: this._traceId,
      spanId: genSpanId(),
      parentSpanId: '',
      name: 'session.end',
      kind: 1,
      timestamp: new Date().toISOString(),
      attributes: { 'kite_code.session.status': status },
      status: { code: status === 'completed' ? 'OK' : 'ERROR', message: status },
    });
    await this._finalizeWriter(status);
  }

  // ── private ──

  private _recordRaw(rec: TraceRecord): void {
    this._write(rec);
  }

  private _write(record: unknown): void {
    const writer = this._writer;
    if (!writer) return;
    try {
      writer.write(record);
    } catch {
      this._tripLogging();
    }
  }

  private async _finalizeWriter(status: 'completed' | 'aborted' | 'fatal'): Promise<void> {
    const writer = this._finalizationWriter;
    if (!writer) return;
    this._finalizationWriter = null;
    try {
      await writer.finalize(status);
    } catch {
      this._tripLogging();
    }
  }

  private _tripLogging(diagnostic?: SessionLoggingDiagnosticV1): void {
    this._mode = 'off';
    this._writer = null;
    this._currentTurnSpanId = '';
    this._reportDiagnostic(
      diagnostic ?? {
        code: 'writer_unavailable',
        message:
          'Session logging is unavailable; the Agent will continue without a logging fallback.',
      },
    );
  }

  private _contentAllowed(text: string, provenance: SessionLoggingContentProvenanceV1): boolean {
    if (!this._contentInspector) return false;
    try {
      const inspection = this._contentInspector({ text, provenance });
      return (
        inspection.schemaVersion === 1 &&
        inspection.detector === 'runtime_secret_detector' &&
        inspection.verdict === 'clear'
      );
    } catch {
      this._tripLogging();
      return false;
    }
  }

  private _reportDiagnostic(diagnostic: SessionLoggingDiagnosticV1): void {
    if (this._reportedDiagnostics.has(diagnostic.code)) return;
    this._reportedDiagnostics.add(diagnostic.code);
    try {
      this._onDiagnostic?.(diagnostic);
    } catch {
      // App diagnostics are advisory and cannot change Runtime control flow.
    }
  }
}
