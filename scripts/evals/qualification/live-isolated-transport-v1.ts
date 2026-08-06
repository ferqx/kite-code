import type { LiveRouteModelBoundaryLeaseV1 } from '../contracts/qualification/live-route-resolver-v1';
import type {
  LiveIsolatedTransportRequestV1,
  LiveIsolatedTransportResultFrameV1,
  LiveIsolatedTransportTestModeV1,
} from './live-isolated-transport-protocol-v1';

/**
 * The full policy deadline includes this bounded process-kill/exit window.
 * A normal 600s L3 budget therefore never waits an additional grace period.
 */
export const LIVE_ISOLATED_TRANSPORT_MAX_EXIT_GRACE_MS_V1 = 1_000;

export interface LiveIsolatedTransportFixtureV1 {
  readonly fixtureId: string;
  readonly fixtureDigest: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export interface RunLiveIsolatedTransportInputV1 {
  readonly fixture: LiveIsolatedTransportFixtureV1;
  readonly request: LiveIsolatedTransportRequestV1;
  /** Required for AQ-8/AQ-9B; no credential test mode can omit it. */
  readonly modelBoundary?: LiveRouteModelBoundaryLeaseV1;
  /** Absolute monotonic-wall-clock cutoff reserved before exit grace. */
  readonly cutoffAtMs: number;
  /** Absolute full policy deadline. No completion waits past this instant. */
  readonly exitDeadlineAtMs: number;
  /** User cancellation: forwarded to child, never reclassified as timeout. */
  readonly operationSignal?: AbortSignal;
  /**
   * Future persistent-supervisor health location. It is ignored by closed
   * no-credential transport tests and cannot activate production work today.
   */
  readonly supervisorLedgerRoot?: string;
}

export interface RunLiveIsolatedTransportTestDependenciesV1 {
  /** Fixed no-credential behavior only; no caller command/path/function reaches the child. */
  readonly testMode?: LiveIsolatedTransportTestModeV1;
  /** Test-only lifecycle witness; it receives no route, frame, endpoint, or key. */
  readonly onChildSpawn?: (pid: number) => void;
  /** Test-only lifecycle witness, called after the sealed dispatch write. */
  readonly onDispatched?: () => void;
  /** Test-only witness after a closed fixture's delayed quarantine scrub. */
  readonly onQuarantineScrubbed?: () => void;
  /** Test-only fixed-byte drift fault; it never accepts a caller source path. */
  readonly forceSourceDriftForTest?: true;
}

export type LiveIsolatedTransportTerminalStatusV1 =
  | 'result'
  | 'deadline_exceeded'
  | 'cancelled_before_dispatch'
  | 'child_failure'
  | 'child_exit_unconfirmed';

export interface LiveIsolatedTransportTerminalV1 {
  readonly status: LiveIsolatedTransportTerminalStatusV1;
  readonly result?: LiveIsolatedTransportResultFrameV1;
  readonly dispatched: 'known_zero' | 'known_one' | 'unknown';
  readonly exitConfirmed: boolean;
}

/** Derive a cutoff that reserves exit grace inside, never after, a policy budget. */
export function liveIsolatedTransportDeadlineV1(
  timeoutMs: number,
  nowMs = Date.now(),
):
  | {
      readonly cutoffAtMs: number;
      readonly exitDeadlineAtMs: number;
    }
  | undefined {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20) return undefined;
  const grace = Math.min(
    LIVE_ISOLATED_TRANSPORT_MAX_EXIT_GRACE_MS_V1,
    Math.max(10, Math.floor(timeoutMs / 5)),
  );
  return { cutoffAtMs: nowMs + timeoutMs - grace, exitDeadlineAtMs: nowMs + timeoutMs };
}
