import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertNoSymlinkPath } from './platform/profile-identity';
import { AgentError } from './storage/types';
import type { WorkspaceFileIo } from './tools/files-io';

export const filesNativeAbi = 'kite-files:2/cap-std:4.0.3';
/** Trusted assembly protection, including the loader chunk and every native companion asset. */
export function filesNativeAssets(): readonly URL[] {
  return [new URL(import.meta.url), new URL('./native/files', import.meta.url)];
}
interface NativeStat {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
  owner: string;
  kind: string;
}
interface NativeOwner {
  readonly root: number;
  verifyRoot(): void;
  stat(id: number): NativeStat;
  verifyOwner(id: number): void;
  openAt(parent: number, name: string, kind: string, strict: boolean): number;
  read(id: number, length: number): Uint8Array;
  write(id: number, bytes: Uint8Array): void;
  sync(id: number): void;
  publishAt(parent: number, temp: string, target: string, createOnly: boolean): void;
  unlinkAt(parent: number, name: string, strict: boolean): void;
  listAt(parent: number): ReturnType<WorkspaceFileIo['listAt']>;
  closeHandle(id: number): void;
  close(): void;
}
interface Binding {
  backendVersion(): string;
  NativeFiles: new (
    root: string,
    protectedPaths: readonly string[],
    protectReads: boolean,
  ) => NativeOwner;
}
let binding: Binding | undefined;
function load(): Binding {
  if (binding) return binding;
  if (
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['x64', 'arm64'].includes(process.arch) ||
    (process.platform === 'win32' && process.arch !== 'x64')
  )
    throw new AgentError('file_platform_unsupported');
  try {
    // Root-level source and split package chunks share this one fixed relative asset location.
    const asset = new URL('./native/files/files.node', import.meta.url);
    const metadata = new URL('./native/files/manifest.json', import.meta.url);
    for (const selected of [asset, metadata]) {
      assertNoSymlinkPath(fileURLToPath(selected));
      const stat = lstatSync(selected);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new AgentError('file_native_identity_mismatch');
    }
    const manifest = JSON.parse(readFileSync(metadata, 'utf8'));
    if (
      manifest.abi !== filesNativeAbi ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      createHash('sha256').update(readFileSync(asset)).digest('hex') !== manifest.sha256
    )
      throw new AgentError('file_native_identity_mismatch');
    const value: Binding = createRequire(import.meta.url)(fileURLToPath(asset));
    if (value.backendVersion?.() !== filesNativeAbi || typeof value.NativeFiles !== 'function')
      throw new AgentError('file_native_identity_mismatch');
    binding = value;
    return value;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('file_native_unavailable');
  }
}
function native<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof AgentError) throw error;
    const match = /^(file_[a-z_]+|ENOENT|ENOTDIR|EEXIST|EACCES|EPERM)(?::(-?\d+))?$/.exec(
      (error as Error).message,
    );
    throw Object.assign(
      new AgentError(match?.[1] ?? 'file_io_failed'),
      match?.[2] ? { errno: Number(match[2]) } : {},
    );
  }
}
export function createNativeWorkspaceFileIo(
  root: string,
  protectedPaths: readonly string[],
  protectReads: boolean,
): WorkspaceFileIo {
  if (Buffer.from(root).toString('utf8') !== root) throw new AgentError('file_path_invalid');
  const owner = native(() => new (load().NativeFiles)(root, protectedPaths, protectReads));
  return Object.freeze({
    root: owner.root,
    createOnlyLeavesTemporary: process.platform !== 'win32',
    verifyRoot: () => native(() => owner.verifyRoot()),
    stat(id: number) {
      const stat = native(() => owner.stat(id));
      return {
        dev: BigInt(stat.dev),
        ino: BigInt(stat.ino),
        size: BigInt(stat.size),
        mtimeNs: BigInt(stat.mtimeNs),
        ctimeNs: BigInt(stat.ctimeNs),
        nlink: BigInt(stat.nlink),
        owner: stat.owner,
        isFile: () => stat.kind === 'file',
        isDirectory: () => stat.kind === 'directory',
      };
    },
    verifyOwner: (id: number) => native(() => owner.verifyOwner(id)),
    openAt: (
      parent: number,
      name: string,
      kind: 'directory' | 'create-directory' | 'read' | 'temporary',
      strict = false,
    ) => native(() => owner.openAt(parent, name, kind, strict)),
    read(id: number, bytes: Uint8Array) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 65536)
        throw new AgentError('file_io_invalid');
      const read = native(() => owner.read(id, bytes.length));
      if (read.length > bytes.length) throw new AgentError('file_io_failed');
      bytes.set(read);
      return read.length;
    },
    write: (id: number, bytes: Uint8Array) => native(() => owner.write(id, bytes)),
    sync: (id: number) => native(() => owner.sync(id)),
    publishAt: (parent: number, temp: string, target: string, createOnly: boolean) =>
      native(() => owner.publishAt(parent, temp, target, createOnly)),
    unlinkAt: (parent: number, name: string, strict = false) =>
      native(() => owner.unlinkAt(parent, name, strict)),
    listAt: (parent: number) => native(() => owner.listAt(parent)),
    closeHandle: (id: number) => native(() => owner.closeHandle(id)),
    close: () => native(() => owner.close()),
  });
}
