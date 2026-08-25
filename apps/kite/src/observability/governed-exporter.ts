import type { MetricExporter, MetricSample } from '@kite/runtime-host';
import { canonicalJsonBytes, sha256DomainSeparated } from '../release/canonical-json';

export interface GovernedMetricTransport {
  send(input: {
    endpointAlias: string;
    contentType: 'application/vnd.kite.metrics.v1+json';
    body: Uint8Array;
  }): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface GovernedMetricExportEnvelope {
  schema: 'GovernedMetricExportEnvelope';
  endpointAlias: string;
  sequence: number;
  sampleCount: number;
  samples: readonly MetricSample[];
  payloadDigest: `sha256:${string}`;
}

const ENDPOINT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

/**
 * Concrete metadata-only exporter. Network execution remains delegated to the
 * governed transport so this class cannot bypass the Runtime network boundary.
 */
export class GovernedMetricExporter implements MetricExporter {
  readonly #endpointAlias: string;
  readonly #transport: GovernedMetricTransport;
  readonly #maximumBatchSamples: number;
  readonly #maximumPayloadBytes: number;
  #sequence = 0;
  #shutdown = false;

  constructor(input: {
    endpointAlias: string;
    approvedEndpointAliases: ReadonlySet<string>;
    transport: GovernedMetricTransport;
    maximumBatchSamples?: number;
    maximumPayloadBytes?: number;
  }) {
    if (
      !ENDPOINT_ALIAS_PATTERN.test(input.endpointAlias) ||
      !input.approvedEndpointAliases.has(input.endpointAlias)
    ) {
      throw new Error('Metric endpoint alias is not approved by the Release Profile.');
    }
    this.#endpointAlias = input.endpointAlias;
    this.#transport = input.transport;
    this.#maximumBatchSamples = positiveInteger(input.maximumBatchSamples ?? 512, 'batch samples');
    this.#maximumPayloadBytes = positiveInteger(
      input.maximumPayloadBytes ?? 512 * 1024,
      'payload bytes',
    );
  }

  async export(samples: readonly MetricSample[]): Promise<void> {
    if (this.#shutdown) throw new Error('Metric exporter is shut down.');
    if (samples.length === 0) return;
    if (samples.length > this.#maximumBatchSamples) {
      throw new Error('Metric export batch exceeds its approved sample bound.');
    }
    this.#sequence += 1;
    const material = {
      schema: 'GovernedMetricExportEnvelope' as const,
      endpointAlias: this.#endpointAlias,
      sequence: this.#sequence,
      sampleCount: samples.length,
      samples: Object.freeze(structuredClone(samples)),
    };
    const envelope: GovernedMetricExportEnvelope = {
      ...material,
      payloadDigest: sha256DomainSeparated(
        'kite.observability.metric-export-envelope.v1',
        canonicalJsonBytes(material),
      ),
    };
    const body = canonicalJsonBytes(envelope);
    if (body.byteLength > this.#maximumPayloadBytes) {
      throw new Error('Metric export payload exceeds its approved byte bound.');
    }
    await this.#transport.send({
      endpointAlias: this.#endpointAlias,
      contentType: 'application/vnd.kite.metrics.v1+json',
      body,
    });
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await this.#transport.shutdown?.();
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Metric exporter ${label} bound must be a positive integer.`);
  }
  return value;
}
