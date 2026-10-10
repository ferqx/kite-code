import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  parseTerminalBundleManifest,
  verifyTerminalBundle,
} from '../../apps/cli/host/terminal-artifact';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import { rejectBundleOutput } from './terminal-paths';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function fail(): never {
  throw Error('terminal_archive_invalid');
}
function safe(path: string) {
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail();
}
function string(bytes: Uint8Array) {
  const end = bytes.indexOf(0);
  return text(end < 0 ? bytes : bytes.subarray(0, end));
}
function number(bytes: Uint8Array) {
  const value = string(bytes).trim();
  if (!/^[0-7]+$/.test(value)) fail();
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) fail();
  return result;
}
/** Parse only regular files and per-file PAX metadata. No archive-controlled link is extracted. */
function regularFiles(tar: Uint8Array): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  let offset = 0,
    pax: Record<string, string> | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (pax || tar.subarray(offset).some((byte) => byte !== 0)) fail();
      return result;
    }
    const checksum = number(header.subarray(148, 156));
    if (
      header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) !==
      checksum
    )
      fail();
    const size = number(header.subarray(124, 136)),
      end = offset + 512 + size,
      next = offset + 512 + Math.ceil(size / 512) * 512;
    if (end > tar.length || next > tar.length) fail();
    const body = tar.subarray(offset + 512, end),
      type = header[156];
    if (type === 120) {
      if (pax) fail();
      pax = Object.create(null) as Record<string, string>;
      let position = 0;
      while (position < body.length) {
        const space = body.indexOf(32, position);
        if (space < 0) fail();
        const digits = text(body.subarray(position, space));
        if (!/^[1-9][0-9]*$/.test(digits)) fail();
        const length = Number(digits),
          recordEnd = position + length;
        if (
          !Number.isSafeInteger(length) ||
          recordEnd > body.length ||
          recordEnd <= space + 1 ||
          body[recordEnd - 1] !== 10
        )
          fail();
        const record = text(body.subarray(space + 1, recordEnd - 1)),
          equal = record.indexOf('=');
        if (equal <= 0) fail();
        const key = record.slice(0, equal);
        if (Object.hasOwn(pax, key)) fail();
        pax[key] = record.slice(equal + 1);
        position = recordEnd;
      }
    } else {
      if (type !== 0 && type !== 48) fail();
      const prefix = string(header.subarray(345, 500)),
        name = string(header.subarray(0, 100));
      const path = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
      if (pax?.linkpath || (pax?.size !== undefined && pax.size !== String(size))) fail();
      safe(path);
      if (result.has(path)) fail();
      result.set(path, body);
      pax = undefined;
    }
    offset = next;
  }
  fail();
}
/** Shared finite archive decoder; callers still enforce their own exact manifest closure. */
export function readCandidateArchiveFiles(input: {
  archivePath: string;
  sha256: string;
  maxUnpackedBytes?: number;
}): Map<string, Uint8Array> {
  const bytes = readFileSync(input.archivePath);
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || hash(bytes) !== input.sha256) fail();
  const maxOutputLength = input.maxUnpackedBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1) fail();
  return regularFiles(gunzipSync(bytes, { maxOutputLength }));
}
/** Archive stores regular bytes and integrity-checked relative-link declarations, never external links. */
export async function packTerminalBundle(input: { bundleRoot: string; archivePath: string }) {
  const bundle = verifyTerminalBundle(input.bundleRoot),
    archivePath = resolve(input.archivePath);
  const checksumPath = `${archivePath}.sha256`;
  rejectBundleOutput(bundle.root, archivePath);
  rejectBundleOutput(bundle.root, checksumPath);
  if ([archivePath, checksumPath].some((path) => lstatSync(path, { throwIfNoEntry: false })))
    throw Error('terminal_destination_exists');
  const files: Record<string, Uint8Array> = Object.create(null);
  files['terminal-manifest.json'] = readFileSync(join(bundle.root, 'terminal-manifest.json'));
  if (hash(files['terminal-manifest.json']) !== bundle.digest) fail();
  for (const file of bundle.manifest.files) {
    const bytes = readFileSync(join(bundle.root, file.path));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
    files[file.path] = bytes;
  }
  if (process.platform === 'win32') privateDirectory(dirname(archivePath));
  else mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  const bytes = await new Bun.Archive(files, { compress: 'gzip', level: 6 }).bytes();
  const sha256 = hash(bytes);
  const created: string[] = [];
  try {
    for (const [path, content] of [
      [archivePath, bytes],
      [checksumPath, `${sha256}  ${basename(archivePath)}\n`],
    ] as const) {
      if (process.platform === 'win32') {
        defaultWindowsPathSecurity()!.writePrivateArtifactFile(
          path,
          typeof content === 'string' ? new TextEncoder().encode(content) : content,
        );
        created.push(path);
        defaultWindowsPathSecurity()!.syncPrivateFile(path);
        continue;
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      created.push(path);
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(archivePath), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    return { archivePath, sha256, candidateId: bundle.candidateId };
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true });
    throw error;
  }
}
/** Explicit decompressed-byte budget is an archive input bound, not an Agent execution quota. */
export function unpackTerminalBundle(input: {
  archivePath: string;
  sha256: string;
  destination: string;
  maxUnpackedBytes?: number;
}) {
  const destination = resolve(input.destination);
  if (lstatSync(destination, { throwIfNoEntry: false })) throw Error('terminal_destination_exists');
  const files = readCandidateArchiveFiles(input);
  const manifestBytes = files.get('terminal-manifest.json');
  if (!manifestBytes) fail();
  const manifest = parseTerminalBundleManifest(JSON.parse(text(manifestBytes)));
  if (files.size !== manifest.files.length + 1) fail();
  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (!content || content.length !== file.size || hash(content) !== file.sha256) fail();
  }
  if (process.platform === 'win32' && manifest.links.length) fail();
  const links = new Set(manifest.links.map((link) => link.path));
  for (const path of [...files.keys(), ...links]) {
    let parent = dirname(path);
    while (parent !== '.') {
      if (files.has(parent) || links.has(parent)) fail();
      parent = dirname(parent);
    }
  }
  if (process.platform === 'win32') privateDirectory(destination);
  else {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    mkdirSync(destination, { mode: 0o700 });
  }
  try {
    for (const [path, content] of files) {
      const target = join(destination, path);
      if (process.platform === 'win32') {
        privateDirectory(dirname(target));
        defaultWindowsPathSecurity()!.writePrivateArtifactFile(target, content);
        defaultWindowsPathSecurity()!.syncPrivateFile(target);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const mode = manifest.files.find((file) => file.path === path)?.mode ?? 0o644;
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try {
        fchmodSync(fd, mode);
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const link of manifest.links) {
      const target = join(destination, link.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      symlinkSync(link.target, target);
    }
    return verifyTerminalBundle(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
