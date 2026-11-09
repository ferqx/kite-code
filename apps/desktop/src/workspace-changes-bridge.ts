export type NativeWorkspaceChangeScope = {
  generation: number;
  viewSelection: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
export type NativeWorkspaceChange = {
  changeId: string;
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
};
export type NativeWorkspaceChangePage = {
  kind: 'workspaceChanges.page';
  readId: string;
  scope: NativeWorkspaceChangeScope;
  repository: boolean;
  entries: NativeWorkspaceChange[];
  truncated: boolean;
};
export type NativeWorkspaceChangeDetail = {
  kind: 'workspaceChanges.detail';
  readId: string;
  changeId: string;
  text?: string;
  truncated: boolean;
  reason?: 'binary' | 'too_large' | 'unsupported' | 'unavailable';
};
export type NativeWorkspaceChangeRequest =
  | { method: 'workspaceChanges.list'; generation: number; viewSelection: number; readId: string }
  | { method: 'workspaceChanges.detail'; generation: number; readId: string; changeId: string }
  | { method: 'workspaceChanges.close'; generation: number; readId: string };

export type NativeWorkspaceChangeEvent = {
  kind: 'workspaceChanges.changed';
  generation: number;
  readId: string;
  scope: NativeWorkspaceChangeScope;
};
