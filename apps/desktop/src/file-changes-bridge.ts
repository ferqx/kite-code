export type DesktopEditor = 'vscode' | 'zed' | 'textedit';
export type NativeFileChangeScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
export type NativeFileChange = {
  changeId: string;
  messageId: string;
  path?: string;
  preview: 'available' | 'unavailable';
  openable: boolean;
};
export type NativeFileChangePage = {
  kind: 'fileChanges.page';
  readId: string;
  scope: NativeFileChangeScope;
  entries: NativeFileChange[];
};
export type NativeFileChangeDetail = {
  kind: 'fileChanges.detail';
  changeId: string;
  text?: string;
  truncated?: boolean;
};
export type NativeFileChangeRequest =
  | {
      method: 'fileChanges.list';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | { method: 'fileChanges.detail'; generation: number; changeId: string; readId: string }
  | { method: 'fileChanges.close'; generation: number; readId: string }
  | { method: 'fileChanges.open'; generation: number; changeId: string; editor: DesktopEditor };
