import { createNativeWorkspaceFileIo } from '../files-native-binding';

export interface WorkspaceFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly owner: string;
  isFile(): boolean;
  isDirectory(): boolean;
}
/** Private live resources only; identifiers never travel through Tools, HTTP or persisted state. */
export interface WorkspaceFileIo {
  readonly root: number;
  readonly createOnlyLeavesTemporary: boolean;
  verifyRoot(): void;
  stat(id: number): WorkspaceFileStat;
  verifyOwner(id: number): void;
  openAt(
    parent: number,
    name: string,
    kind: 'directory' | 'create-directory' | 'read' | 'temporary',
    strict?: boolean,
  ): number;
  read(id: number, bytes: Uint8Array): number;
  write(id: number, bytes: Uint8Array): void;
  sync(id: number): void;
  publishAt(parent: number, temp: string, target: string, createOnly: boolean): void;
  unlinkAt(parent: number, name: string, strict?: boolean): void;
  listAt(parent: number): {
    name: string;
    kind: 'file' | 'directory' | 'symlink' | 'other';
  }[];
  closeHandle(id: number): void;
  close(): void;
}

export function createWorkspaceFileIo(
  root: string,
  protectedPaths: readonly string[],
  protectReads: boolean,
): WorkspaceFileIo {
  return createNativeWorkspaceFileIo(root, protectedPaths, protectReads);
}
