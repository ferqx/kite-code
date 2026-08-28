import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type {
  SqliteWorkspaceDirectoryOutbox,
  SqliteWorkspaceSessionCreationPort,
} from '@kite-ai/runtime-storage-sqlite';
import {
  assertWorkspaceWorkerStoreProfile as assertBootstrapWorkspaceWorkerStoreProfile,
  type WorkspaceWorkerStoreOwner as BootstrapWorkspaceWorkerStoreOwner,
  createWorkspaceWorkerStoreContext as createBootstrapWorkspaceWorkerStoreContext,
  openWorkspaceWorkerStore as openBootstrapWorkspaceWorkerStore,
  type WorkspaceWorkerStoreAuthority,
  type WorkspaceWorkerStoreCodec,
  type WorkspaceWorkerStoreContext,
  type WorkspaceWorkerStoreProfile,
  type WorkspaceWorkerStoreStorageOptions,
} from '../bootstrap';

export {
  WORKSPACE_WORKER_STATE_SCHEMA_VERSION_,
  WORKSPACE_WORKER_STORE_PROFILE,
  WORKSPACE_WORKER_STORE_PROFILE_,
  WORKSPACE_WORKER_STORE_SCHEMA_VERSION_,
} from '../bootstrap';
export type {
  WorkspaceWorkerStoreAuthority,
  WorkspaceWorkerStoreCodec,
  WorkspaceWorkerStoreContext,
  WorkspaceWorkerStoreProfile,
  WorkspaceWorkerStoreStorageOptions,
};

/** Store 7 Directory facts stay on the same already-open SQLite connection. */
export type WorkspaceWorkerStoreOwner = BootstrapWorkspaceWorkerStoreOwner & {
  readonly directoryOutbox: SqliteWorkspaceDirectoryOutbox;
  readonly workspaceSessionCreation: SqliteWorkspaceSessionCreationPort<
    import('../bootstrap/runtime/state-runtime').RuntimeEvent,
    import('../bootstrap/runtime/state-runtime').RuntimeState
  >;
};

export function createWorkspaceWorkerStoreContext(input: {
  readonly home: import('@kite-ai/kite-local-runtime/service').KiteHomeIdentity;
  readonly workspace: KiteWorkspaceIdentity;
  readonly workerScopeId: string;
  readonly layoutGeneration: string;
}): WorkspaceWorkerStoreContext {
  return createBootstrapWorkspaceWorkerStoreContext(input);
}

export function openWorkspaceWorkerStore(
  context: WorkspaceWorkerStoreContext,
  options: {
    readonly codec?: WorkspaceWorkerStoreCodec;
    readonly storageOptions?: WorkspaceWorkerStoreStorageOptions;
  } = {},
): WorkspaceWorkerStoreOwner {
  const storage = openBootstrapWorkspaceWorkerStore(
    context,
    options,
  ) as BootstrapWorkspaceWorkerStoreOwner & {
    readonly directoryOutbox?: SqliteWorkspaceDirectoryOutbox;
    readonly workspaceSessionCreation?: WorkspaceWorkerStoreOwner['workspaceSessionCreation'];
  };
  if (!storage.directoryOutbox || !storage.workspaceSessionCreation) {
    storage.close();
    throw new Error('Workspace Worker Store Directory/session creation is unavailable.');
  }
  return storage as WorkspaceWorkerStoreOwner;
}

export function assertWorkspaceWorkerStoreProfile(value: WorkspaceWorkerStoreProfile): void {
  assertBootstrapWorkspaceWorkerStoreProfile(value);
}
