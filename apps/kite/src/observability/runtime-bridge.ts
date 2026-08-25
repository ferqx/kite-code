import type { BuiltinObservabilityProjector } from '@kite/builtin-runtime';
import {
  OBSERVABILITY_METRIC_DRAFT_SCHEMA_,
  type ObservabilityFailureFact,
  type ObservabilityMetricDraft,
  type ObservabilityModelFact,
  type ObservabilityReceiptFact,
  type ObservabilityReleaseFact,
  type ObservabilityResourceFact,
  type ObservabilityRuntimeFact,
  type ObservabilityTaskStageFact,
} from '@kite/runtime-contract';
import {
  createMetricSample,
  METRIC_DEFINITIONS_,
  type MetricName,
  type MetricReporter,
  type MetricSample,
} from '@kite/runtime-host';

/** Shared Runtime-to-metadata pipeline for foreground, background and subagent callers. */
export class RuntimeMetricBridge {
  readonly #projector: BuiltinObservabilityProjector;
  readonly #reporter: MetricReporter;

  constructor(input: { projector: BuiltinObservabilityProjector; reporter: MetricReporter }) {
    this.#projector = input.projector;
    this.#reporter = input.reporter;
  }

  observeRuntimeFact(fact: ObservabilityRuntimeFact): void {
    this.#protect(() => this.#projector.mapRuntimeFact(fact));
  }

  observeFailure(failure: ObservabilityFailureFact, observedAt: string): void {
    this.#protect(() => this.#projector.mapFailure(failure, observedAt));
  }

  observeExecutionReceipt(receipt: ObservabilityReceiptFact, observedAt: string): void {
    this.#protect(() => this.#projector.mapExecutionReceipt(receipt, observedAt));
  }

  observeModel(input: ObservabilityModelFact): void {
    this.#protect(() => this.#projector.mapModelObservation(input));
  }

  observeResources(input: ObservabilityResourceFact): void {
    this.#protect(() => this.#projector.mapAppResource(input));
  }

  observeRelease(input: ObservabilityReleaseFact): void {
    this.#protect(() => this.#projector.mapReleaseProjection(input));
  }

  observeTaskStage(input: ObservabilityTaskStageFact): void {
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

  #protect(map: () => readonly ObservabilityMetricDraft[]): void {
    try {
      this.#reporter.reportMany(map().map(metricSampleFromDraft));
    } catch {
      // Observability is never allowed to change Runtime outcome semantics.
    }
  }
}

function metricSampleFromDraft(draft: ObservabilityMetricDraft): MetricSample {
  if (draft.schema !== OBSERVABILITY_METRIC_DRAFT_SCHEMA_) {
    throw new Error(`Unknown observability draft schema: ${draft.schema}`);
  }
  if (!isMetricName(draft.name)) {
    throw new Error(`Unknown observability metric: ${draft.name}`);
  }
  return createMetricSample({
    name: draft.name,
    ...(draft.value === undefined ? {} : { value: draft.value }),
    observedAt: draft.observedAt,
    ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
  });
}

function isMetricName(value: string): value is MetricName {
  return Object.hasOwn(METRIC_DEFINITIONS_, value);
}
