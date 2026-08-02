import {
  createMetricSampleV1,
  METRIC_DEFINITIONS_V1,
  type MetricControlledAliasRegistryV1,
  type MetricNameV1,
  type MetricPriorityV1,
  type MetricSampleV1,
  metricPriorityV1,
  parseMetricSampleV1,
} from './metrics';

export interface MetricExporterV1 {
  export(samples: readonly MetricSampleV1[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface MetricReporterStatusV1 {
  enabled: boolean;
  queued: number;
  capacity: number;
  dropped: number;
  exporterFailures: number;
  diskSpool: false;
}

export interface MetricReporterV1 {
  report(sample: MetricSampleV1): void;
  reportMany(samples: readonly MetricSampleV1[]): void;
  withdrawConsent(): void;
  flush(timeoutMs: number): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
  status(): MetricReporterStatusV1;
}

const PRIORITY_RANK: Readonly<Record<MetricPriorityV1, number>> = Object.freeze({
  low: 0,
  normal: 1,
  critical: 2,
});

export class BoundedMetricQueueV1 {
  readonly #capacity: number;
  readonly #samples: MetricSampleV1[] = [];
  #dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Metric queue capacity must be a positive integer.');
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#samples.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  enqueue(sample: MetricSampleV1): void {
    if (this.#samples.length < this.#capacity) {
      this.#samples.push(sample);
      return;
    }
    const incomingRank = PRIORITY_RANK[metricPriorityV1(sample)];
    let oldestLowestIndex = 0;
    let lowestRank = PRIORITY_RANK[metricPriorityV1(this.#samples[0]!)];
    for (let index = 1; index < this.#samples.length; index += 1) {
      const rank = PRIORITY_RANK[metricPriorityV1(this.#samples[index]!)];
      if (rank < lowestRank) {
        lowestRank = rank;
        oldestLowestIndex = index;
      }
    }
    if (lowestRank <= incomingRank) {
      this.#samples.splice(oldestLowestIndex, 1);
      this.#samples.push(sample);
    }
    this.#dropped += 1;
  }

  snapshot(): readonly MetricSampleV1[] {
    return Object.freeze([...this.#samples]);
  }

  drain(): readonly MetricSampleV1[] {
    return Object.freeze(this.#samples.splice(0));
  }

  clear(): number {
    const count = this.#samples.length;
    this.#samples.length = 0;
    return count;
  }

  recordDropped(count: number): void {
    if (Number.isInteger(count) && count > 0) this.#dropped += count;
  }
}

export class NoopMetricReporterV1 implements MetricReporterV1 {
  report(_sample: MetricSampleV1): void {}
  reportMany(_samples: readonly MetricSampleV1[]): void {}
  withdrawConsent(): void {}
  async flush(_timeoutMs: number): Promise<void> {}
  async shutdown(_timeoutMs: number): Promise<void> {}
  status(): MetricReporterStatusV1 {
    return {
      enabled: false,
      queued: 0,
      capacity: 0,
      dropped: 0,
      exporterFailures: 0,
      diskSpool: false,
    };
  }
}

export class BufferedMetricReporterV1 implements MetricReporterV1 {
  readonly #queue: BoundedMetricQueueV1;
  readonly #exporter: MetricExporterV1;
  readonly #allowedMetricNames?: ReadonlySet<MetricNameV1>;
  readonly #controlledAliases: MetricControlledAliasRegistryV1;
  readonly #seriesByMetric = new Map<MetricNameV1, Set<string>>();
  #enabled: boolean;
  #exporterFailures = 0;

  constructor(input: {
    enabled: boolean;
    capacity: number;
    exporter: MetricExporterV1;
    allowedMetricNames?: ReadonlySet<MetricNameV1>;
    controlledAliases?: MetricControlledAliasRegistryV1;
  }) {
    this.#enabled = input.enabled;
    this.#queue = new BoundedMetricQueueV1(input.capacity);
    this.#exporter = input.exporter;
    this.#allowedMetricNames = input.allowedMetricNames;
    this.#controlledAliases = Object.freeze({
      route: new Set(input.controlledAliases?.route ?? []),
      capability: new Set(input.controlledAliases?.capability ?? []),
    });
  }

  report(sample: MetricSampleV1): void {
    if (!this.#enabled) return;
    try {
      const rebuilt = parseMetricSampleV1(sample, this.#controlledAliases);
      if (this.#allowedMetricNames && !this.#allowedMetricNames.has(rebuilt.name)) {
        this.#queue.recordDropped(1);
        return;
      }
      const seriesKey = JSON.stringify(
        Object.entries(rebuilt.attributes).sort(([left], [right]) => left.localeCompare(right)),
      );
      const series = this.#seriesByMetric.get(rebuilt.name) ?? new Set<string>();
      if (
        !series.has(seriesKey) &&
        series.size >= METRIC_DEFINITIONS_V1[rebuilt.name].cardinalityLimit
      ) {
        this.#queue.recordDropped(1);
        return;
      }
      series.add(seriesKey);
      this.#seriesByMetric.set(rebuilt.name, series);
      this.#queue.enqueue(rebuilt);
    } catch {
      this.#queue.recordDropped(1);
    }
  }

  reportMany(samples: readonly MetricSampleV1[]): void {
    for (const sample of samples) this.report(sample);
  }

  withdrawConsent(): void {
    this.#enabled = false;
    this.#queue.clear();
    this.#seriesByMetric.clear();
  }

  async flush(timeoutMs: number): Promise<void> {
    if (!this.#enabled) {
      this.#queue.clear();
      return;
    }
    const batch = this.#queue.drain();
    if (batch.length === 0) return;
    try {
      await bounded(this.#exporter.export(batch), timeoutMs);
    } catch {
      this.#exporterFailures += 1;
      this.#queue.recordDropped(batch.length);
    }
  }

  async shutdown(timeoutMs: number): Promise<void> {
    await this.flush(timeoutMs);
    if (!this.#exporter.shutdown) return;
    try {
      await bounded(this.#exporter.shutdown(), timeoutMs);
    } catch {
      this.#exporterFailures += 1;
    }
  }

  status(): MetricReporterStatusV1 {
    return {
      enabled: this.#enabled,
      queued: this.#queue.size,
      capacity: this.#queue.capacity,
      dropped: this.#queue.dropped,
      exporterFailures: this.#exporterFailures,
      diskSpool: false,
    };
  }

  localDropMetric(observedAt: string): MetricSampleV1 | undefined {
    const dropped = this.#queue.dropped;
    return dropped === 0
      ? undefined
      : createMetricSampleV1({
          name: 'telemetry_dropped_total',
          value: dropped,
          observedAt,
          attributes: { reason: this.#exporterFailures > 0 ? 'exporter_failure' : 'queue_full' },
        });
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Flush timeout is invalid.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Metric exporter timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
