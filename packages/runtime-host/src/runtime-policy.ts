import {
  assertAuthorizationElevation as assertKernelAuthorizationElevation,
  projectRuntimeEventToObservabilityFact as projectKernelRuntimeObservabilityFact,
} from '@kite/agent-kernel';
import type { ObservabilityRuntimeFact } from '@kite/runtime-contract';

/** Canonical facts supplied by App before it asks Host to admit authorization. */
export interface RuntimeAuthorizationElevationFacts {
  readonly mode: 'default' | 'full_access';
  readonly source?: 'user' | 'config' | 'test' | 'system';
  readonly sandboxAvailable: boolean;
  readonly autoReview?: boolean;
  readonly loopMode?: boolean;
}

/** Host policy port; the deterministic decision remains owned by Agent Kernel. */
export function assertRuntimeAuthorizationElevation(
  facts: RuntimeAuthorizationElevationFacts,
): void {
  assertKernelAuthorizationElevation(facts);
}

/** Host projection port; App never imports Kernel event or policy authority. */
export function projectRuntimeObservabilityFact(
  event: unknown,
  fallbackObservedAt: string,
): ObservabilityRuntimeFact | undefined {
  return projectKernelRuntimeObservabilityFact(event, fallbackObservedAt);
}
