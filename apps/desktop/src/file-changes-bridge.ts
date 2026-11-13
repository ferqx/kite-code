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
  operation?: 'read' | 'write' | 'edit';
  snapshot?: boolean;
  diff?: boolean;
};
export type NativeFileChangePage = {
  kind: 'fileChanges.page';
  readId: string;
  scope: NativeFileChangeScope;
  entries: NativeFileChange[];
};
export type NativeFileChangeDetail = {
  kind: 'fileChanges.detail';
  format?: 'line_diff' | 'file_content';
  unavailableReason?: 'snapshot_too_large';
  changeId: string;
  text?: string;
  truncated?: boolean;
  snapshot?: boolean;
  offset?: number;
  nextOffset?: number | null;
};
export type NativeFileTargetPage = Omit<NativeFileChangePage, 'kind'> & {
  kind: 'fileTargets.page';
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
  | {
      method: 'fileTargets.list';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | {
      method: 'fileChanges.detail';
      generation: number;
      changeId: string;
      readId: string;
      offset?: number;
      view?: 'diff' | 'snapshot';
    }
  | { method: 'fileChanges.close'; generation: number; readId: string }
  | { method: 'fileChanges.open'; generation: number; changeId: string; editor: DesktopEditor }
  | {
      method: 'messageFile.open';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      messageId: string;
      path: string;
      line?: number;
      editor: DesktopEditor;
    };
