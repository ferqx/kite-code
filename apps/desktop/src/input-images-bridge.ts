export const inputImageCount = 10;
export const inputImageWindowCount = 128;
export const pendingAttachmentBytesMissing = 'attachment_bytes_missing';

/** Pending UI attachments are private drafts, never authority to submit or read a path. */
export type NativePendingAttachment = {
  id: string;
  kind: 'image' | 'file' | 'reference';
  name: string;
  state: 'ready' | 'error';
  mediaType?: string;
  size?: number;
  hash?: string;
  uri?: string;
  error?: string;
};
export type NativePendingAttachmentWrite = Omit<NativePendingAttachment, 'state'> & {
  state?: 'ready' | 'error';
};
export type NativePendingAttachments = {
  kind: 'input.attachments';
  revision: number;
  sourceRevision?: number;
  attachments: NativePendingAttachment[];
};
export type NativeInputImageRequest =
  | {
      method: 'input.attachments.move';
      generation: number;
      sessionId: string;
      workspaceId: string;
      revision: number;
      targetRevision: number;
    }
  | {
      method: 'input.attachments.read';
      generation: number;
      sessionId: string;
      workspaceId?: string;
    }
  | {
      method: 'input.attachments.write';
      generation: number;
      sessionId: string;
      workspaceId?: string;
      revision: number;
      attachments: readonly NativePendingAttachmentWrite[];
    }
  | {
      method: 'input.attachments.preview';
      generation: number;
      sessionId: string;
      workspaceId?: string;
      id: string;
      offset: number;
    }
  | {
      method: 'input.files.begin';
      generation: number;
      id: string;
      name: string;
      mediaType: string;
      size: number;
    }
  | {
      method: 'input.files.append';
      generation: number;
      id: string;
      offset: number;
      data: Uint8Array;
    }
  | { method: 'input.files.finish' | 'input.files.release'; generation: number; id: string }
  | {
      method: 'input.images.begin';
      generation: number;
      id: string;
      name: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      size: number;
      hash: string;
    }
  | { method: 'input.images.append'; generation: number; id: string; offset: number; data: string }
  | { method: 'input.images.finish' | 'input.images.release'; generation: number; id: string }
  | {
      method: 'input.image.open';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageId: string;
      index: number;
    }
  | { method: 'input.image.read'; generation: number; readId: string; offset: number }
  | { method: 'input.image.close'; generation: number; readId: string };
export type NativeInputFileResult =
  | NativePendingAttachments
  | { kind: 'input.image.open'; readId: string; size: number; hash: string; mediaType: string }
  | {
      kind: 'input.image.chunk';
      readId: string;
      offset: number;
      nextOffset: number;
      data: string;
      done: boolean;
    };

export type NativeAttachmentRecovery = {
  phase: 'restored' | 'unavailable' | 'not_needed';
  sessionId: string;
  workspaceId: string;
  revision?: number;
  ids?: string[];
  error?: string;
};
