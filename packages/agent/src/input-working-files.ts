import { createHash } from 'node:crypto';
import type { ArtifactReference, InputFileReference } from './storage/types';

export interface WorkingInputScope {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  commandId: string;
  importId: string;
}
export interface WorkingInputRecord {
  commandId: string;
  importId: string;
  inputRefId: string;
  workingRelativePath: string;
  workspaceRootUri: string;
  state: 'ready' | 'bound';
  rootIdentity: { device: string; inode: string };
  fileIdentity: { device: string; inode: string };
}
/** Host-derived path. User filenames never choose directory components. */
export function workingInputPath(input: WorkingInputScope, name: string): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([input.expectedStoreId, input.sessionId, input.commandId, input.importId]),
    )
    .digest('hex');
  let safeName =
    Array.from(name.normalize('NFC'), (character) =>
      character.charCodeAt(0) < 32 ? '_' : character,
    )
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '') || 'input';
  while (Buffer.byteLength(safeName) > 180) safeName = Array.from(safeName).slice(1).join('');
  safeName = `input-${safeName}`;
  return `.kite-inputs/${digest}/${safeName}`;
}
export interface WorkingInputFilesPort {
  materialize(input: {
    rootUri: string;
    relativePath: string;
    reference: ArtifactReference;
    existing: WorkingInputRecord | null;
    content(): AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<Pick<WorkingInputRecord, 'rootIdentity' | 'fileIdentity'>>;
}
export interface PrepareWorkingInputsRequest {
  expectedStoreId: string;
  targetSessionId: string;
  subjectId: string;
  commandId: string;
  files: readonly InputFileReference[];
  signal?: AbortSignal;
}
