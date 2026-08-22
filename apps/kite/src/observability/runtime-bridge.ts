import type { BuiltinObservabilityProjectorV1 } from '@kite/builtin-runtime';
import {
  OBSERVABILITY_METRIC_DRAFT_SCHEMA_V1,
  type ObservabilityFailureFactV1,
  type ObservabilityMetricDraftV1,
  type ObservabilityModelFactV1,
  type ObservabilityReceiptFactV1,
  type ObservabilityReleaseFactV1,
  type ObservabilityResourceFactV1,
  type ObservabilityRuntimeFactV1,
  type ObservabilityTaskStageFactV1,
} from '@kite/runtime-contract';
import {
  createMetricSampleV1,
  METRIC_DEFINITIONS_V1,
  type MetricNameV1,
  type MetricReporterV1,
  type MetricSampleV1,
} from '@kite/runtime-host';

/** Shared Runtime-to-metadata pipeline for foreground, background and subagent callers. */
export class RuntimeMetricBridgeV1 {
  readonly #projector: BuiltinObservabilityProjectorV1;
  readonly #reporter: MetricReporterV1;

  constructor(input: { projector: BuiltinObservabilityProjectorV1; reporter: MetricReporterV1 }) {
    this.#projector = input.projector;
    this.#reporter = input.reporter;
  }

  observeRuntimeFact(fact: ObservabilityRuntimeFactV1): void {
    this.#protect(() => this.#projector.mapRuntimeFact(fact));
  }

  observeFailure(failure: ObservabilityFailureFactV1, observedAt: string): void {
    this.#protect(() => this.#projector.mapFailure(failure, observedAt));
  }

  observeExecutionReceipt(receipt: ObservabilityReceiptFactV1, observedAt: string): void {
    this.#protect(() => this.#projector.mapExecutionReceipt(receipt, observedAt));
  }

  observeModel(input: ObservabilityModelFactV1): void {
    this.#protect(() => this.#projector.mapModelObservation(input));
  }

  observeResources(input: ObservabilityResourceFactV1): void {
    this.#protect(() => this.#projector.mapAppResource(input));
  }

  observeRelease(input: ObservabilityReleaseFactV1): void {
    this.#protect(() => this.#projector.mapReleaseProjection(input));
  }

  observeTaskStage(input: ObservabilityTaskStageFactV1): void {
    this.#protect(() => this.#projector.mapAgentTaskStage(input));
  }

  withdrawConsent(): void {
    this.#reporter.withdrawConsent();
  }

  async flush(timeoutMs: number): Promise<void> {
    await this.#reporter.flush(timeoutMs);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    await this.#reporter.shutdown(timeoutMs);
  }

  #protect(map: () => readonly ObservabilityMetricDraftV1[]): void {
    try {
      this.#reporter.reportMany(map().map(metricSampleFromDraftV1));
    } catch {
      // Observability is never allowed to change Runtime outcome semantics.
    }
  }
}

function metricSampleFromDraftV1(draft: ObservabilityMetricDraftV1): MetricSampleV1 {
  if (draft.schema !== OBSERVABILITY_METRIC_DRAFT_SCHEMA_V1) {
    throw new Error(`Unknown observability draft schema: ${draft.schema}`);
  }
  if (!isMetricNameV1(draft.name)) {
    throw new Error(`Unknown observability metric: ${draft.name}`);
  }
  return createMetricSampleV1({
    name: draft.name,
    ...(draft.value === undefined ? {} : { value: draft.value }),
    observedAt: draft.observedAt,
    ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
  });
}

function isMetricNameV1(value: string): value is MetricNameV1 {
  return Object.hasOwn(METRIC_DEFINITIONS_V1, value);
}
