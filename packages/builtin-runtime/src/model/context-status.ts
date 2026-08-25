import type { ContextPressure, ContextTokenEstimate } from './context-budget';

/** Fresh, presentation-neutral context status produced by Core. */
export interface ContextStatusSnapshot {
  estimate: ContextTokenEstimate;
  status: ContextPressure;
  usableInputTokens?: number;
  utilization?: number;
  activeCheckpointId?: string;
  inputTokensBefore?: number;
  inputTokensAfter?: number;
}
