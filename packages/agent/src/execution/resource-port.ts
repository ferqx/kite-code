/** Host-owned coordination for one shared Workspace key. No I/O is imported by the core. */
export interface WorkspaceSerialLocks {
  acquire(input: { workspaceId: string; key: string }, signal: AbortSignal): Promise<() => void>;
}
