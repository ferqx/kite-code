import {
  assertAuthorizationElevation as assertKernelAuthorizationElevation,
  projectRuntimeEventToObservabilityFactV1 as projectKernelRuntimeObservabilityFactV1,
} from '@kite/agent-kernel';
import type { ObservabilityRuntimeFactV1 } from '@kite/runtime-contract';

/** Canonical facts supplied by App before it asks Host to admit authorization. */
export interface RuntimeAuthorizationElevationFactsV1 {
  readonly mode: 'default' | 'full_access';
  readonly source?: 'user' | 'config' | 'test' | 'system';
  readonly sandboxAvailable: boolean;
  readonly autoReview?: boolean;
  readonly loopMode?: boolean;
}

/** Host policy port; the deterministic decision remains owned by Agent Kernel. */
export function assertRuntimeAuthorizationElevationV1(
  facts: RuntimeAuthorizationElevationFactsV1,
): void {
  assertKernelAuthorizationElevation(facts);
}

/** Host projection port; App never imports Kernel event or policy authority. */
export function projectRuntimeObservabilityFactV1(
  event: unknown,
  fallbackObservedAt: string,
): ObservabilityRuntimeFactV1 | undefined {
  return projectKernelRuntimeObservabilityFactV1(event, fallbackObservedAt);
}
