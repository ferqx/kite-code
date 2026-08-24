import { projectRuntimeEventToObservabilityFact as projectKernelRuntimeObservabilityFact } from '@kite/agent-kernel';
import type { ObservabilityRuntimeFact } from '@kite/runtime-contract';

/** Host projection port; App never imports Kernel event or policy authority. */
export function projectRuntimeObservabilityFact(
  event: unknown,
  fallbackObservedAt: string,
): ObservabilityRuntimeFact | undefined {
  return projectKernelRuntimeObservabilityFact(event, fallbackObservedAt);
}
