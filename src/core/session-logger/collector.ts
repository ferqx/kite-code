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

import { genSpanId, genTraceId } from '@/core/id-utils';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { AgentEvent } from '@/protocol/events';
import { mapRuntimeMetadataV1, mapSessionBoundaryMetadataV1 } from './metadata-mapper';
import { recordContentRuntimeEvent, recordEvent } from './recorder';
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
  finalize(): Promise<void>;
}

export interface SessionLogCollectorOptions {
  mode?: 'off' | 'metadata' | 'content';
  metadataContext?: SessionMetadataContextV1;
  contentInspector?: SessionLoggingContentInspectorV1;
  onDiagnostic?: (diagnostic: SessionLoggingDiagnosticV1) => void;
  writerFactory?: (
    frontend: string,
    threadId: string,
    basename: string,
    onFailure: () => void,
  ) => SessionLogWriterLike;
}

export class SessionLogCollector {
  private _writer: SessionLogWriterLike | null = null;
  private _mode: 'off' | 'metadata' | 'content';
  private _metadataContext: SessionMetadataContextV1;
  private _traceId: string;
  /** 当前 turn span ID，nextTurn() 时刷新 */
  private _currentTurnSpanId = '';
  private _diagnosticReported = false;
  private readonly _contentInspector?: SessionLoggingContentInspectorV1;
  private readonly _onDiagnostic?: (diagnostic: SessionLoggingDiagnosticV1) => void;

  constructor(
    threadId: string,
    workspace: string,
    frontend: string,
    model: { provider: string; name: string },
    options: SessionLogCollectorOptions = {},
  ) {
    this._mode = options.mode ?? 'off';
    this._metadataContext = options.metadataContext ?? {};
    this._contentInspector = options.contentInspector;
    this._onDiagnostic = options.onDiagnostic;
    this._traceId = genTraceId();
    const writerFactory =
      options.writerFactory ??
      ((writerFrontend, writerThreadId, basename, onFailure) =>
        new SessionLogWriter(writerFrontend, writerThreadId, basename, onFailure));
    if (this._mode !== 'off') {
      try {
        let failedSynchronously = false;
        const writer = writerFactory(frontend, threadId, 'events', () => {
          failedSynchronously = true;
          this._tripLogging();
        });
        if (!failedSynchronously) this._writer = writer;
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

  /** Content compatibility path: only user/model-visible/final text is admitted. */
  record(event: AgentEvent): void {
    if (this._mode !== 'content') return;
    if (event.type !== 'text' && event.type !== 'final' && event.type !== 'user_message') return;
    const text =
      event.type === 'text'
        ? event.data.text
        : event.type === 'final'
          ? event.data
          : event.data.text;
    const provenance = event.type === 'user_message' ? 'user_message' : 'model_visible_answer';
    if (!this._contentAllowed(text, provenance)) return;
    try {
      const rec = recordEvent(event, this._traceId, this._currentTurnSpanId);
      this._recordRaw(rec);
    } catch {
      this._tripLogging();
    }
  }

  /** Runtime-native log path; no AgentEvent projection is required. */
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
    if (this._mode === 'off') return;
    if (this._mode === 'metadata') {
      this._write(
        mapSessionBoundaryMetadataV1(
          'session.end',
          status === 'completed' ? 'ok' : status === 'aborted' ? 'cancelled' : 'error',
          this._metadataContext,
        ),
      );
      await this._finalizeWriter();
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
    await this._finalizeWriter();
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

  private async _finalizeWriter(): Promise<void> {
    const writer = this._writer;
    if (!writer) return;
    try {
      await writer.finalize();
    } catch {
      this._tripLogging();
    }
  }

  private _tripLogging(): void {
    this._mode = 'off';
    this._writer = null;
    this._currentTurnSpanId = '';
    this._reportDiagnostic();
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

  private _reportDiagnostic(): void {
    if (this._diagnosticReported) return;
    this._diagnosticReported = true;
    try {
      this._onDiagnostic?.({
        code: 'writer_unavailable',
        message:
          'Session logging is unavailable; the Agent will continue without a logging fallback.',
      });
    } catch {
      // App diagnostics are advisory and cannot change Runtime control flow.
    }
  }
}
