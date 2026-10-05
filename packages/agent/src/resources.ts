/** Explicit Workspace OS-lock backend; import alone opens no resources. */

export type { WorkspaceSerialLocks } from './execution/resource-port';
export {
  createWorkspaceSerialLocks,
  type WorkspaceSerialCoordinator,
} from './platform/workspace-resources';
