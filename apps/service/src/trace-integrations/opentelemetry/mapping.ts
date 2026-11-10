import { createHmac } from 'node:crypto';
import type { TraceEventView } from '@kite-ai/trajectory';
import {
  type Attributes,
  ROOT_CONTEXT,
  type SpanContext,
  type SpanKind,
  type SpanStatusCode,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, type ReadableSpan, TracerProvider } from '@opentelemetry/sdk-trace';

export const mappingVersion = 1;
export const semanticSources = Object.freeze({
  genAi: 'e6658f14c9d9ea0760825f029cb82e7673f48fab',
  openInference: '6be7118f789c9cd3c71b3375810fe9250050fe31',
});
export interface OtelSpanIdentity {
  identity: string;
  traceId: string;
  spanId: string;
}
export interface OtelSpanEnvelope extends OtelSpanIdentity {
  mappingVersion: 1;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  attributes: Attributes;
  status: SpanStatusCode;
  parent?: OtelSpanIdentity;
  links: OtelSpanIdentity[];
}
const hmac = (key: string, purpose: string, value: string, length: number) => {
  const hash = createHmac('sha256', key)
    .update(JSON.stringify(['kite.otel', mappingVersion, purpose, value]))
    .digest('hex')
    .slice(0, length);
  return /^0+$/.test(hash) ? `${hash.slice(0, -1)}1` : hash;
};
export function eventSpanIdentity(event: TraceEventView, key: string): OtelSpanIdentity | null {
  if (event.identityConfidence !== 'verified_origin') return null;
  const identity =
    event.kind === 'run' && event.scope.runRef && event.scope.runOriginStoreRef
      ? `run:${event.scope.runOriginStoreRef}:${event.scope.runRef}`
      : event.scope.executionRef && event.scope.executionOriginStoreRef
        ? `execution:${event.scope.executionOriginStoreRef}:${event.scope.executionRef}:${event.attempt ?? 1}`
        : null;
  if (!identity || !['run', 'model', 'tool', 'job'].includes(event.kind)) return null;
  const traceKey =
    event.scope.runRef && event.scope.runOriginStoreRef
      ? `run:${event.scope.runOriginStoreRef}:${event.scope.runRef}`
      : identity;
  return {
    identity,
    traceId: hmac(key, 'trace', traceKey, 32),
    spanId: hmac(key, 'span', identity, 16),
  };
}
export function mappingAttributes(first: TraceEventView, last: TraceEventView): Attributes {
  const attrs: Attributes = {
    'kite.trajectory.mapping.version': mappingVersion,
    'kite.trajectory.kind': last.kind,
    'kite.trajectory.phase': last.phase,
    'kite.trajectory.event.id': last.eventId,
    'kite.trajectory.first_event.id': first.eventId,
    'kite.trajectory.attempt': last.attempt ?? 1,
    'kite.trajectory.status': last.recordedStatus ?? 'unavailable',
    'openinference.span.kind':
      last.kind === 'model'
        ? 'LLM'
        : last.kind === 'tool' || last.kind === 'job'
          ? 'TOOL'
          : 'AGENT',
    'gen_ai.operation.name':
      last.kind === 'model'
        ? 'chat'
        : last.kind === 'tool' || last.kind === 'job'
          ? 'execute_tool'
          : 'invoke_agent',
  };
  if (last.kind === 'model' && last.attributes.usage) {
    for (const [source, genai, inference] of [
      ['inputTokens', 'gen_ai.usage.input_tokens', 'llm.token_count.prompt'],
      ['outputTokens', 'gen_ai.usage.output_tokens', 'llm.token_count.completion'],
    ] as const) {
      const value = last.attributes.usage[source];
      if (value !== undefined) {
        // OTel integer attributes are JS numbers; retain larger exact values as Kite strings.
        if (BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) {
          attrs[genai] = Number(value);
          attrs[inference] = Number(value);
        } else attrs[`kite.trajectory.usage.${source}`] = value;
      }
    }
  }
  return attrs;
}
/** Reconstruct an official SDK ReadableSpan from a durable, self-contained envelope. */
export function materializeSpan(envelope: OtelSpanEnvelope): ReadableSpan {
  const contextOf = (value: OtelSpanIdentity): SpanContext => ({
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
  let saved: ReadableSpan | undefined;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'kite-agent' }),
    sampler: new AlwaysOnSampler(),
    idGenerator: { generateTraceId: () => envelope.traceId, generateSpanId: () => envelope.spanId },
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          saved = span;
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  const parent = envelope.parent
    ? trace.setSpanContext(ROOT_CONTEXT, contextOf(envelope.parent))
    : ROOT_CONTEXT;
  const span = provider.getTracer('kite.trajectory', String(mappingVersion)).startSpan(
    envelope.name,
    {
      startTime: envelope.startTime,
      kind: envelope.kind,
      attributes: envelope.attributes,
      links: envelope.links.map((link) => ({ context: contextOf(link) })),
    },
    parent,
  );
  span.setStatus({ code: envelope.status });
  span.end(envelope.endTime);
  if (!saved) throw Error('otel_sdk_span_unavailable');
  return saved;
}
