import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { assertNoSymlinkPath } from '../platform/profile-identity';
import { AgentError } from '../storage/types';
import { directoryFlags, listAt, openAt, publishAt, unlinkAt } from './files-native';
import { createWindowsWorkspaceFileIo } from './files-windows';

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
    kind: 'directory' | 'read' | 'temporary',
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
  if (process.platform === 'win32')
    return createWindowsWorkspaceFileIo(root, protectedPaths, protectReads);
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new AgentError('file_platform_unsupported');
  assertNoSymlinkPath(root);
  const rootFd = openSync(root, directoryFlags);
  const initial = fstatSync(rootFd, { bigint: true });
  if (!initial.isDirectory()) {
    closeSync(rootFd);
    throw new AgentError('file_root_invalid');
  }
  const stat = (id: number): WorkspaceFileStat => {
    const value = fstatSync(id, { bigint: true });
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
      nlink: value.nlink,
      owner: String(value.uid),
      isFile: () => value.isFile(),
      isDirectory: () => value.isDirectory(),
    };
  };
  let closed = false;
  return {
    root: rootFd,
    createOnlyLeavesTemporary: true,
    verifyRoot() {
      assertNoSymlinkPath(root);
      const current = lstatSync(root, { bigint: true });
      if (current.dev !== initial.dev || current.ino !== initial.ino || realpathSync(root) !== root)
        throw new AgentError('file_root_changed');
    },
    stat,
    verifyOwner(id) {
      if (stat(id).owner !== String(process.getuid?.())) throw new AgentError('file_owner_invalid');
    },
    openAt(parent, name, kind) {
      return openAt(
        parent,
        name,
        kind === 'directory'
          ? directoryFlags
          : kind === 'temporary'
            ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
            : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        kind === 'temporary' ? 0o600 : 0,
      );
    },
    read: (id, bytes) => readSync(id, bytes, 0, bytes.length, null),
    write: (id, bytes) => writeFileSync(id, bytes),
    sync: fsyncSync,
    publishAt,
    unlinkAt,
    listAt,
    closeHandle: closeSync,
    close() {
      if (closed) return;
      closeSync(rootFd);
      closed = true;
    },
  };
}
