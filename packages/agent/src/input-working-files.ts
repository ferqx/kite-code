import { createHash } from 'node:crypto';
import type { InputFileImport } from './storage/input-file-imports';
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
export const workingInputNamespace = 'builtin.files';
export const workingInputRecordType = 'builtin.files.input-preparation';
export const workingInputRecordVersion = 1;
export function workingInputRecordKey({
  commandId,
  importId,
}: Pick<WorkingInputScope, 'commandId' | 'importId'>): string {
  return `input-preparation/${commandId}/${importId}`;
}

function isFileIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { device, inode } = value as Partial<WorkingInputRecord['fileIdentity']>;
  return (
    Object.keys(value).length === 2 &&
    typeof device === 'string' &&
    /^\d+$/.test(device) &&
    typeof inode === 'string' &&
    /^\d+$/.test(inode)
  );
}

/** Shape of the existing host-only record. Original owner and binding require separate proof. */
export function isWorkingInputRecord(value: unknown): value is WorkingInputRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<WorkingInputRecord>;
  const validId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
  const name =
    typeof record.workingRelativePath === 'string'
      ? /^\.kite-inputs\/[a-f0-9]{64}\/input-([^/\\]+)$/.exec(record.workingRelativePath)?.[1]
      : undefined;
  return (
    Object.keys(value).length === 8 &&
    validId(record.commandId) &&
    validId(record.importId) &&
    record.inputRefId === `input-file-${record.importId}` &&
    name !== undefined &&
    Buffer.byteLength(name) <= 180 &&
    !/[<>:"|?*]/.test(name) &&
    Array.from(name).every((character) => character.charCodeAt(0) >= 32) &&
    typeof record.workspaceRootUri === 'string' &&
    URL.canParse(record.workspaceRootUri) &&
    new URL(record.workspaceRootUri).protocol === 'file:' &&
    (record.state === 'ready' || record.state === 'bound') &&
    isFileIdentity(record.rootIdentity) &&
    isFileIdentity(record.fileIdentity)
  );
}

export function isWorkingInputPreparation(
  row: {
    extensionId: string;
    contentType: string;
    contentVersion: number;
    originStoreId: string | null;
    forkProvenance: unknown;
    key: string;
  },
  value: unknown,
  sessionId: string,
): boolean {
  return (
    row.extensionId === workingInputNamespace &&
    row.contentType === workingInputRecordType &&
    row.contentVersion === workingInputRecordVersion &&
    !!row.originStoreId &&
    row.forkProvenance === null &&
    isWorkingInputRecord(value) &&
    row.key === workingInputRecordKey(value) &&
    value.workingRelativePath.startsWith(
      `${workingInputDirectory({
        expectedStoreId: row.originStoreId,
        sessionId,
        commandId: value.commandId,
        importId: value.importId,
      })}/`,
    )
  );
}

function workingInputDirectory(input: Omit<WorkingInputScope, 'subjectId'>): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([input.expectedStoreId, input.sessionId, input.commandId, input.importId]),
    )
    .digest('hex');
  return `.kite-inputs/${digest}`;
}

/** Host-derived path. User filenames never choose directory components. */
export function workingInputPath(input: WorkingInputScope, name: string): string {
  let safeName =
    Array.from(name.normalize('NFC'), (character) =>
      character.charCodeAt(0) < 32 ? '_' : character,
    )
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '') || 'input';
  while (Buffer.byteLength(safeName) > 180) safeName = Array.from(safeName).slice(1).join('');
  return `${workingInputDirectory(input)}/input-${safeName}`;
}
export interface WorkingInputAttachment {
  imported: InputFileImport;
  working: WorkingInputRecord;
  contextSelectionId: string;
}

export interface BoundInputFile {
  imported: InputFileImport;
  working: WorkingInputRecord | null;
}

/** Use one URI projection for ModelInput and the trusted exact-target resolver. */
export function workingInputUri(record: WorkingInputRecord): string {
  return new URL(
    record.workingRelativePath.split('/').map(encodeURIComponent).join('/'),
    record.workspaceRootUri.endsWith('/') ? record.workspaceRootUri : `${record.workspaceRootUri}/`,
  ).href;
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
