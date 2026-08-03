import type {
  AppResourceObservationV1,
  ModelMetricObservationV1,
  ProductionMetricMapperV1,
} from '@/core/observability/mapper';
import type { MetricReporterV1 } from '@/core/observability/reporter';
import type { RuntimeEventInput } from '@/core/runtime/events';
import type { ExecutionReceipt } from '@/protocol/capabilities';

/** Shared Runtime-to-metadata pipeline for foreground, background and subagent callers. */
export class RuntimeMetricBridgeV1 {
  readonly #mapper: ProductionMetricMapperV1;
  readonly #reporter: MetricReporterV1;

  constructor(input: { mapper: ProductionMetricMapperV1; reporter: MetricReporterV1 }) {
    this.#mapper = input.mapper;
    this.#reporter = input.reporter;
  }

  observeRuntimeEvent(event: RuntimeEventInput, fallbackObservedAt: string): void {
    this.#protect(() => this.#mapper.mapRuntimeEvent(event, fallbackObservedAt));
  }

  observeExecutionReceipt(receipt: ExecutionReceipt, observedAt: string): void {
    this.#protect(() => this.#mapper.mapExecutionReceipt(receipt, observedAt));
  }

  observeModel(input: ModelMetricObservationV1): void {
    this.#protect(() => this.#mapper.mapModelObservation(input));
  }

  observeResources(input: AppResourceObservationV1): void {
    this.#protect(() => this.#mapper.mapAppResource(input));
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

  #protect(map: () => ReturnType<ProductionMetricMapperV1['mapRuntimeEvent']>): void {
    try {
      this.#reporter.reportMany(map());
    } catch {
      // Observability is never allowed to change Runtime outcome semantics.
    }
  }
}
