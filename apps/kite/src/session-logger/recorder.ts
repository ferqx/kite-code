// apps/kite/src/session-logger/recorder.ts
// Narrow content-mode RuntimeEvent → TraceRecord projection.
//
// Only user text and model-visible text may cross this boundary. Reasoning,
// tool inputs/outputs, plans, paths, errors, and arbitrary RuntimeEvent fields
// have no serializer here.

import type { StateRuntimeEventV1 as RuntimeEvent } from '@kite/runtime-host';
import { genSpanId } from './ids';
import type { TraceRecord } from './types';

const TRUNC_CONTENT = 10_000;

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
