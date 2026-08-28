// apps/kite-service/src/session-logger/collector.ts
// SessionLogCollector — 伴随 Runtime run 生命周期的窄类型日志边界。
// metadata 模式只写 allowlist 投影；content 模式只写用户正文与模型可见回答。
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

import type { StateRuntimeEvent as RuntimeEvent } from '@kite-ai/runtime-host';
import type { SessionLoggingPolicy } from '#kite-service/config/session-logging-policy';
import { genSpanId, genTraceId } from './ids';
import { mapRuntimeMetadata, mapSessionBoundaryMetadata } from './metadata-mapper';
import { recordContentRuntimeEvent } from './recorder';
import type {
  SessionLoggingContentInspector,
  SessionLoggingContentProvenance,
  SessionLoggingDiagnostic,
  SessionMetadataContext,
  TraceRecord,
} from './types';
import { SessionLogWriter } from './writer';

interface SessionLogWriterLike {
  write(record: unknown): void;
  finalize(status?: 'completed' | 'aborted' | 'fatal'): Promise<void>;
}

export interface SessionLogCollectorOptions {
  mode?: 'off' | 'metadata' | 'content';
  policy?: SessionLoggingPolicy;
  metadataContext?: SessionMetadataContext;
  contentInspector?: SessionLoggingContentInspector;
  onDiagnostic?: (diagnostic: SessionLoggingDiagnostic) => void;
  writerFactory?: (
    frontend: string,
    threadId: string,
    basename: string,
    onDiagnostic: (diagnostic: SessionLoggingDiagnostic) => void,
    policy?: SessionLoggingPolicy,
  ) => SessionLogWriterLike;
}

export class SessionLogCollector {
  private _writer: SessionLogWriterLike | null = null;
  private _finalizationWriter: SessionLogWriterLike | null = null;
  private _mode: 'off' | 'metadata' | 'content';
  private _metadataContext: SessionMetadataContext;
  private _traceId: string;
  /** 当前 turn span ID，nextTurn() 时刷新 */
  private _currentTurnSpanId = '';
  private readonly _reportedDiagnostics = new Set<SessionLoggingDiagnostic['code']>();
  private readonly _contentInspector?: SessionLoggingContentInspector;
  private readonly _onDiagnostic?: (diagnostic: SessionLoggingDiagnostic) => void;

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
      this._write(mapSessionBoundaryMetadata('session.start', 'ok', this._metadataContext));
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
        this._write(mapRuntimeMetadata(event));
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
        mapSessionBoundaryMetadata(
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

  private _tripLogging(diagnostic?: SessionLoggingDiagnostic): void {
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

  private _contentAllowed(text: string, provenance: SessionLoggingContentProvenance): boolean {
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

  private _reportDiagnostic(diagnostic: SessionLoggingDiagnostic): void {
    if (this._reportedDiagnostics.has(diagnostic.code)) return;
    this._reportedDiagnostics.add(diagnostic.code);
    try {
      this._onDiagnostic?.(diagnostic);
    } catch {
      // App diagnostics are advisory and cannot change Runtime control flow.
    }
  }
}
