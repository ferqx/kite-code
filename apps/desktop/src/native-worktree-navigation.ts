import type { NativeDirectory, NativeSelection } from './native-bridge';

const exitCommands = new Set(['返回来源项目', '返回来源会话']);

/** Explicit source navigation only. Worktree exit stays ordinary input for a safe Tool boundary. */
export function isNativeWorktreeExitCommand(text: string): boolean {
  return exitCommands.has(text.trim().toLowerCase());
}

export type NativeWorktreeExit =
  | { kind: 'source'; sessionId: string; workspaceId: string }
  | { kind: 'already_source' }
  | { kind: 'unavailable' };

/** Consume only the Store's historical relationship; navigation grants no execution scope. */
export function resolveNativeWorktreeExit(
  directory: NativeDirectory | undefined,
  selection: NativeSelection | undefined,
): NativeWorktreeExit {
  if (
    !directory ||
    directory.unavailable ||
    !selection ||
    selection.viewLoading ||
    directory.storeId !== selection.storeId ||
    selection.session.parentSessionId ||
    selection.session.deletedAt
  )
    return { kind: 'unavailable' };
  const selected = directory.sessions.filter((session) => session.id === selection.session.id);
  if (
    selected.length !== 1 ||
    selected[0]!.deletedAt ||
    selected[0]!.parentSessionId ||
    selected[0]!.workspaceId !== selection.session.workspaceId ||
    directory.workspaces.filter((workspace) => workspace.id === selection.session.workspaceId)
      .length !== 1
  )
    return { kind: 'unavailable' };
  const relation = selected[0]!.worktreeSource;
  if (!relation)
    return selected[0]!.activity?.hasCreatedWorktree
      ? { kind: 'already_source' }
      : { kind: 'unavailable' };
  const sources = directory.sessions.filter((session) => session.id === relation.sessionId);
  if (
    sources.length !== 1 ||
    sources[0]!.deletedAt ||
    sources[0]!.parentSessionId ||
    sources[0]!.workspaceId !== relation.workspaceId ||
    relation.workspaceId === selection.session.workspaceId ||
    directory.workspaces.filter((workspace) => workspace.id === relation.workspaceId).length !== 1
  )
    return { kind: 'unavailable' };
  return { kind: 'source', sessionId: relation.sessionId, workspaceId: relation.workspaceId };
}
