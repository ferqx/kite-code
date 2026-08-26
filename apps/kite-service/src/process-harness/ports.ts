import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type { LocalRuntimeLifecycleResult } from '@kite-ai/kite-local-runtime/client';
import type {
  KiteServiceManager,
  KiteServiceManagerRequest,
} from '@kite-ai/kite-local-runtime/manager';
import type {
  KiteHomeIdentity,
  LocalRuntimeServiceDescriptor,
  LocalRuntimeServiceStatePaths,
} from '@kite-ai/kite-local-runtime/service';

/**
 * Faults are deliberately a closed, test-only fixture vocabulary.  They are serialized into the
 * generated internal child entry and are not a service protocol or a production configuration
 * surface.
 */
export interface KiteServiceProcessHarnessFaults {
  /** Delay the fake application start long enough to exercise the manager deadline. */
  readonly startupDelayMs?: number;
  /** Make the injected fake application reject during startup. */
  readonly failStartup?: boolean;
  /** Apply the first credential mutation and then make its response unavailable. */
  readonly dropCredentialResponse?: boolean;
}

export interface KiteServiceProcessHarnessOptions {
  /** Explicit isolated home. The harness never reads KITE_CODE_HOME from the environment. */
  readonly homeRoot: string;
  /** The one fake trusted Workspace admitted by the child application. */
  readonly workspace?: KiteWorkspaceIdentity;
  readonly serverVersion?: string;
  readonly buildId?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly managerOperationTimeoutMs?: number;
  readonly executableMode?: 'source' | 'installed';
  /** Optional canonical OS home used by the neutral child environment. */
  readonly systemHome?: string;
  readonly faults?: KiteServiceProcessHarnessFaults;
}

export interface KiteServiceProcessHarnessChildConfig {
  readonly homeRoot: string;
  readonly workspace: KiteWorkspaceIdentity;
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly buildId: string;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly faults: KiteServiceProcessHarnessFaults;
}

export interface KiteServiceProcessHarnessRequestOptions
  extends Omit<RequestInit, 'body' | 'headers'> {
  readonly body?: unknown;
  readonly headers?: HeadersInit;
}

/**
 * Parent-side process integration seam.  It owns only test process orchestration and access to
 * the child descriptor; the child itself constructs an injected fake Runtime/History/App Control
 * application behind the real Native state and loopback carrier.
 */
export interface KiteServiceProcessHarness extends AsyncDisposable {
  readonly home: KiteHomeIdentity;
  readonly paths: LocalRuntimeServiceStatePaths;
  readonly manager: KiteServiceManager;
  readonly workspace: KiteWorkspaceIdentity;
  readonly executableMode: 'source' | 'installed';
  readonly stdout: string;
  readonly stderr: string;
  readonly lastChildPid: number | undefined;
  ensure(request?: KiteServiceManagerRequest): Promise<LocalRuntimeLifecycleResult>;
  status(request?: KiteServiceManagerRequest): Promise<LocalRuntimeLifecycleResult>;
  stop(request?: KiteServiceManagerRequest): Promise<LocalRuntimeLifecycleResult>;
  restart(request?: KiteServiceManagerRequest): Promise<LocalRuntimeLifecycleResult>;
  readDescriptor(): LocalRuntimeServiceDescriptor | undefined;
  readToken(kind: 'access' | 'control'): string | undefined;
  /** Raw request helper for unauthenticated health/readiness routes. */
  request(pathname: string, options?: KiteServiceProcessHarnessRequestOptions): Promise<Response>;
  /** Access-token request helper for History and exact App Control routes. */
  requestAccess(
    pathname: string,
    options?: KiteServiceProcessHarnessRequestOptions,
  ): Promise<Response>;
  /** Control-token request helper. It never sends an Origin or cookie. */
  requestControl(
    pathname: string,
    options?: KiteServiceProcessHarnessRequestOptions,
  ): Promise<Response>;
  /** Issue one exact Workspace-bound Runtime ticket for connector integration tests. */
  issueRuntimeTicket(): Promise<string>;
  /** Wait for the detached child to exit; timeout is bounded by the caller. */
  waitForChildExit(timeoutMs?: number): Promise<number | null>;
}
