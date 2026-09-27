import type { TuiState } from '../types';

/** Start a fresh model stream projection at a run or viewport boundary. */
export function resetModelStreamProjection() {
  return {
    currentRunReasonId: undefined,
    currentThoughtSummaryId: undefined,
    currentModelRequestId: undefined,
    currentModelTextStreamed: undefined,
    currentModelTextSource: undefined,
    toolBearingModelRequestId: undefined,
    toolBearingPresentationGroupId: undefined,
    currentModelReasoningStreamed: false,
    currentModelReasoningText: undefined,
    currentModelReasoningRequestId: undefined,
    settledModelRequestIds: new Set<string>(),
  } satisfies Partial<TuiState>;
}
