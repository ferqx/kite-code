import { isIP } from 'node:net';
import { ExportResultCode } from '@opentelemetry/core';
import {
  createOtlpHttpExportDelegate,
  httpAgentFactoryFromOptions,
} from '@opentelemetry/otlp-exporter-base/node-http';
import {
  type IExportTraceServiceResponse,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from '@opentelemetry/otlp-transformer';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';

export interface OtelSendAuthorization {
  headers: Record<string, string>;
  target: { address: string; family: 4 | 6 };
}

export type OtelExportOutcome =
  | { kind: 'full' }
  | { kind: 'partial'; rejectedCount: number; code: 'partial_success' }
  | { kind: 'permanent'; code: string }
  | { kind: 'transient'; code: string }
  | { kind: 'unconfirmed'; code: string };
const retryStatuses = new Set([429, 502, 503, 504]);
const retryErrors = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** Official serializer and official HTTP/retry transport. SUCCESS alone never proves acceptance. */
export async function exportOtelSpans(input: {
  endpoint: string;
  spans: ReadableSpan[];
  timeoutMs?: number;
  /** Called by the official transport before every actual send, including internal retries. */
  authorizeSend(): Promise<OtelSendAuthorization>;
}): Promise<OtelExportOutcome & { attempts: number; possibleDuplicate: boolean }> {
  const endpoint = new URL(input.endpoint);
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw Error('otel_endpoint_invalid');
  let decoded: IExportTraceServiceResponse | undefined,
    decodeFailed = false,
    attempts = 0,
    lastStatus: number | undefined;
  const agents: import('node:http').Agent[] = [];
  let pinned: OtelSendAuthorization['target'] | undefined;
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
  const factory = httpAgentFactoryFromOptions({
    keepAlive: false,
    maxSockets: 1,
    lookup: (name, _options, callback) => {
      if (!pinned || name !== hostname) {
        callback(Error('otel_target_denied'), '', 4);
        return;
      }
      if (_options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    },
  });
  const delegate = createOtlpHttpExportDelegate(
    {
      url: endpoint.href,
      timeoutMillis: input.timeoutMs ?? 5000,
      concurrencyLimit: 1,
      compression: 'none',
      headers: async () => {
        lastStatus = undefined;
        const { headers, target } = await input.authorizeSend();
        if (
          !target ||
          isIP(target.address) !== target.family ||
          (isIP(hostname) && hostname !== target.address)
        )
          throw Error('otel_target_denied');
        pinned = target;
        attempts++;
        return { ...headers, 'Content-Type': 'application/x-protobuf' };
      },
      agentFactory: async (protocol) => {
        const agent = await factory(protocol);
        agents.push(agent);
        // Observe actual response status for failure classification, never infer full success from it.
        const observed = agent as typeof agent & {
          addRequest(
            request: import('node:http').ClientRequest,
            options: import('node:http').RequestOptions,
          ): void;
        };
        const original = observed.addRequest.bind(agent);
        observed.addRequest = (request, options) => {
          request.once('response', (response) => {
            lastStatus = response.statusCode;
          });
          original(request, options);
        };
        return agent;
      },
    },
    {
      serializeRequest: ProtobufTraceSerializer.serializeRequest,
      deserializeResponse(data) {
        try {
          decoded = ProtobufTraceSerializer.deserializeResponse(data);
          return decoded;
        } catch (error) {
          decodeFailed = true;
          throw error;
        }
      },
    },
    'kite.trajectory',
    TraceExporterMetricsHelper,
    undefined,
  );
  try {
    const result = await new Promise<import('@opentelemetry/core').ExportResult>((resolve) =>
      delegate.export(input.spans, resolve),
    );
    const common = { attempts, possibleDuplicate: attempts > 1 };
    if (result.code === ExportResultCode.SUCCESS) {
      if (!decoded || decodeFailed)
        return { ...common, kind: 'unconfirmed', code: 'response_unavailable' };
      const rejected = decoded.partialSuccess?.rejectedSpans ?? 0;
      if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > input.spans.length)
        return { ...common, kind: 'unconfirmed', code: 'response_invalid' };
      return rejected > 0
        ? { ...common, kind: 'partial', rejectedCount: rejected, code: 'partial_success' }
        : { ...common, kind: 'full' };
    }
    const error = result.error as (Error & { code?: string | number }) | undefined;
    if (lastStatus && retryStatuses.has(lastStatus))
      return { ...common, kind: 'transient', code: `http_${lastStatus}` };
    if (lastStatus && lastStatus >= 300 && lastStatus <= 599)
      return { ...common, kind: 'permanent', code: `http_${lastStatus}` };
    if (typeof error?.code === 'string' && retryErrors.has(error.code))
      return { ...common, kind: 'transient', code: error.code, possibleDuplicate: attempts > 0 };
    return {
      ...common,
      kind: 'unconfirmed',
      code: attempts ? 'transport_unconfirmed' : 'send_not_authorized',
      possibleDuplicate: attempts > 0,
    };
  } finally {
    await delegate.shutdown();
    for (const agent of agents) agent.destroy();
  }
}
