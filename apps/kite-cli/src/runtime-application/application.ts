import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createRuntimeOperationGate,
  type RuntimeOperationGate,
  type RuntimeOperationQuiesceLease,
} from './operation-gate';

export type KiteAppControlService = KiteAppControlClient;

export interface RuntimeApplicationQuiesceLease {
  readonly activeOperations: boolean;
  resume(): void;
  commitDrain(): Promise<void>;
}

export interface KiteRuntimeApplication extends AsyncDisposable {
  readonly runtime: RuntimeAccess;
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly appControl: KiteAppControlService;
  readonly operationGate: RuntimeOperationGate;
  start(): Promise<void>;
  quiesceMutations(): Promise<RuntimeApplicationQuiesceLease>;
  cancelAll(reason: string): Promise<void>;
}

export interface KiteRuntimeApplicationDependencies {
  readonly runtime: RuntimeAccess;
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly appControl: KiteAppControlService;
  readonly operationGate?: RuntimeOperationGate;
  readonly start?: () => Promise<void>;
  readonly cancelAll: (reason: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

function leaseFromGate(lease: RuntimeOperationQuiesceLease): RuntimeApplicationQuiesceLease {
  return Object.freeze({
    activeOperations: lease.activeOperations,
    resume: lease.resume,
    commitDrain: lease.commitDrain,
  });
}

/**
 * App-local Runtime/Application seam. It wires injected owners together but never constructs a
 * Store, Host, Server, listener, or TUI object itself.
 */
export function createKiteRuntimeApplication(
  dependencies: KiteRuntimeApplicationDependencies,
): KiteRuntimeApplication {
  const operationGate = dependencies.operationGate ?? createRuntimeOperationGate();
  let started = false;
  let disposed = false;
  let disposing = false;
  let startPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  const application: KiteRuntimeApplication = {
    runtime: dependencies.runtime,
    server: dependencies.server,
    history: dependencies.history,
    appControl: dependencies.appControl,
    operationGate,

    start(): Promise<void> {
      if (disposed || disposing)
        return Promise.reject(new Error('Runtime application is disposed.'));
      if (started) return Promise.resolve();
      startPromise ??= (async () => {
        await dependencies.start?.();
        started = true;
      })();
      return startPromise;
    },

    async quiesceMutations(): Promise<RuntimeApplicationQuiesceLease> {
      if (disposed) throw new Error('Runtime application is disposed.');
      return leaseFromGate(await operationGate.quiesce());
    },

    cancelAll(reason: string): Promise<void> {
      if (disposed) return Promise.reject(new Error('Runtime application is disposed.'));
      if (reason.length === 0) throw new TypeError('Cancellation reason must not be empty.');
      return dependencies.cancelAll(reason);
    },

    [Symbol.asyncDispose](): Promise<void> {
      disposePromise ??= (async () => {
        if (disposed) return;
        disposing = true;
        let failure: unknown;
        let failed = false;
        const recordFailure = (error: unknown): void => {
          if (failed) return;
          failure = error;
          failed = true;
        };
        // A concurrent start must finish before the injected owner is disposed.  The
        // application has no cancellation authority for an arbitrary start hook.
        try {
          if (startPromise) await startPromise;
        } catch (error) {
          recordFailure(error);
        }
        try {
          if (operationGate.phase !== 'draining') {
            const lease = await operationGate.quiesce();
            await lease.commitDrain();
          }
        } catch (error) {
          recordFailure(error);
        }
        try {
          await dependencies.dispose();
        } catch (error) {
          recordFailure(error);
        } finally {
          disposed = true;
        }
        if (failed) throw failure;
      })();
      return disposePromise;
    },
  };
  return Object.freeze(application);
}
