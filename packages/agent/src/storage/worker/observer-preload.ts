import { captureCurrentWorkerThread } from '../../platform/process/worker-thread.darwin';

// Runs synchronously before the unchanged main module, including main syntax errors.
// The parent consumes exactly this private frame before the original business handler.
let thread: ReturnType<typeof captureCurrentWorkerThread> | null = null;
let failure: {
  errors: { error: unknown; nativeResult: number | null }[];
  retainedResources: unknown;
} | null = null;
try {
  thread = captureCurrentWorkerThread();
} catch (error) {
  // Acquisition failure is unknown; it is never replaced by a runtime close marker.
  // Error cloning need not retain custom properties, so transfer the real native
  // result and any still-held original rights explicitly alongside the errors.
  const errors = error instanceof AggregateError ? error.errors : [error];
  failure = {
    errors: errors.map((cause) => ({
      error: cause,
      nativeResult:
        cause instanceof Error && 'nativeResult' in cause && typeof cause.nativeResult === 'number'
          ? cause.nativeResult
          : null,
    })),
    retainedResources:
      error instanceof Error && 'retainedResources' in error ? error.retainedResources : null,
  };
}
self.postMessage({ protocol: 'kite_worker_thread@1', thread, failure });
