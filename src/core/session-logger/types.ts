// src/core/session-logger/types.ts
// OTel 兼容的会话日志记录类型
//
// 每条记录遵循 OTel Span 结构（traceId / spanId / name / attributes / status），
// 不依赖 @opentelemetry/api，但格式兼容 OTLP JSON 序列化。

// ── OTel 兼容的 Trace 记录 ──

/** OTel Span attribute value */
export type OtelValue = string | number | boolean;

/** 单条日志记录（等价于一个 OTel Span） */
export interface TraceRecord {
  /** OTel traceId：会话级标识，同一次 runAgent 内所有记录共用 */
  traceId: string;
  /** OTel spanId：本条记录的唯一标识 */
  spanId: string;
  /** OTel parentSpanId：父 span ID（turn / node），空字符串 = root */
  parentSpanId: string;
  /** Span 名称，同 OTel span.name */
  name: string;
  /** OTel SpanKind 数值：1=INTERNAL, 3=CLIENT */
  kind: number;
  /** 事件发生时间（ISO 8601 + ns） */
  timestamp: string;
  /** OTel Span attributes */
  attributes: Record<string, OtelValue>;
  /** OTel Span status */
  status: { code: 'OK' | 'ERROR'; message: string };
  /** OTel Span events（子事件，如 tool.error / model.retry） */
  events?: TraceEvent[];
}

export interface TraceEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, OtelValue>;
}

// ── Production metadata-only records ──

/**
 * Content-free schema shared by local metadata logging and future telemetry.
 * Producers construct this object from structured Runtime fields only; a full
 * RuntimeEvent is never serialized into this shape.
 */
export interface MetadataEventRecordV1 {
  schemaVersion: 1;
  eventType: string;
  timestamp: string;
  status: 'ok' | 'error' | 'cancelled' | 'blocked' | 'unknown';
  metadata: MetadataFieldsV1;
}

export interface MetadataFieldsV1 {
  durationMs?: number;
  toolKind?: string;
  capabilityKind?: string;
  failureKind?: import('@/core/runtime/failures').FailureKind;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  approvalType?: string;
  approvalResult?: string;
  verificationType?: string;
  verificationResult?: string;
  compactionInputTokensBefore?: number;
  compactionInputTokensAfter?: number;
  compactionFailureKind?: string;
  providerPolicyDigest?: string;
  providerPolicyRevision?: string;
  releaseVersion?: string;
  releaseProfile?: ReleaseProfileMetadataV1;
  releaseCohort?: string;
}

export type ReleaseProfileMetadataV1 = 'limited' | 'internal' | 'canary' | 'ga';

export interface SessionMetadataContextV1 {
  releaseVersion?: string;
  releaseProfile?: ReleaseProfileMetadataV1;
  releaseCohort?: string;
}

export type SessionLoggingDiagnosticV1 =
  | {
      code: 'writer_unavailable';
      message: 'Session logging is unavailable; the Agent will continue without a logging fallback.';
    }
  | {
      code: 'storage_quarantined';
      message: 'Unsafe legacy session-log storage was quarantined; the Agent will continue.';
    }
  | {
      code: 'session_limit_reached';
      message: 'The session log reached its configured size limit; further records were disabled.';
    };

export type SessionLoggingContentProvenanceV1 = 'user_message' | 'model_visible_answer';

/** Trusted, structured result from the Runtime secret detector. */
export interface SessionLoggingContentInspectionV1 {
  schemaVersion: 1;
  detector: 'runtime_secret_detector';
  verdict: 'clear' | 'secret' | 'unknown';
}

export type SessionLoggingContentInspectorV1 = (input: {
  text: string;
  provenance: SessionLoggingContentProvenanceV1;
}) => SessionLoggingContentInspectionV1;

// ── 会话摘要 ──

export interface RunSummary {
  threadId: string;
  traceId: string;
  startedAt: string;
  endedAt?: string;
  status: 'completed' | 'aborted' | 'fatal';
  workspace: string;
  frontend: string;
  modelProvider: string;
  modelName: string;
  device: {
    os: string;
    osVersion: string;
    arch: string;
    bunVersion: string;
    terminal?: string;
  };
  stats: {
    turns: number;
    toolCalls: { total: number; ok: number; failed: number };
    modelRetries: number;
    subAgents: { total: number; ok: number; failed: number; blocked: number };
    errors: number;
  };
}
