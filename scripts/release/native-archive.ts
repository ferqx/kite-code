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
import { basename, dirname, join, posix, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  parseNativeBundleManifest,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import { parseTerminalBundleManifest } from '@kite-ai/service/runtime-assets';
import { readCandidateArchiveFiles } from './terminal-archive';
import { rejectBundleOutput } from './terminal-paths';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function fail(): never {
  throw Error('native_archive_invalid');
}
/** Regular bytes only: links and exact empty Electron dirs remain closed manifest declarations. */
export async function packNativeBundle(input: { bundleRoot: string; archivePath: string }) {
  const root = resolve(input.bundleRoot),
    leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  try {
    leases.push(acquireArtifactAccess({ root, mode: 'shared' }));
    leases.push(acquireArtifactAccess({ root: join(root, 'terminal'), mode: 'shared' }));
    const bundle = verifyNativeRuntimeBundle(root),
      archivePath = resolve(input.archivePath),
      checksumPath = `${archivePath}.sha256`;
    for (const path of [archivePath, checksumPath]) {
      rejectBundleOutput(root, path);
      if (lstatSync(path, { throwIfNoEntry: false })) throw Error('native_destination_exists');
    }
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const [path, digest] of [
      ['native-manifest.json', bundle.digest],
      ['terminal/terminal-manifest.json', bundle.terminal.digest],
    ] as const) {
      const bytes = readFileSync(join(root, path));
      if (hash(bytes) !== digest) fail();
      files[path] = bytes;
    }
    for (const file of [
      ...bundle.manifest.files,
      ...bundle.terminal.manifest.files.map((f) => ({ ...f, path: `terminal/${f.path}` })),
    ]) {
      const bytes = readFileSync(join(root, file.path));
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
      files[file.path] = bytes;
    }
    if (verifyNativeRuntimeBundle(root).digest !== bundle.digest) fail();
    const bytes = await new Bun.Archive(files, { compress: 'gzip', level: 6 }).bytes(),
      sha256 = hash(bytes);
    // Awaiting compression cannot silently change which source closure was selected.
    if (verifyNativeRuntimeBundle(root).digest !== bundle.digest) fail();
    mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
    const created: string[] = [];
    try {
      for (const [path, content] of [
        [archivePath, bytes],
        [checksumPath, `${sha256}  ${basename(archivePath)}\n`],
      ] as const) {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        created.push(path);
        try {
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      const directory = openSync(dirname(archivePath), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return { archivePath, sha256, candidateId: bundle.digest };
    } catch (error) {
      for (const path of created.reverse()) rmSync(path, { force: true });
      throw error;
    }
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
}
/** Archive bytes are bounded input, not a task/runtime quota. Never extract archive-controlled links. */
export function unpackNativeBundle(input: {
  archivePath: string;
  sha256: string;
  destination: string;
  maxUnpackedBytes?: number;
}) {
  const destination = resolve(input.destination);
  if (lstatSync(destination, { throwIfNoEntry: false })) throw Error('native_destination_exists');
  const files = readCandidateArchiveFiles(input),
    nativeBytes = files.get('native-manifest.json'),
    terminalBytes = files.get('terminal/terminal-manifest.json');
  if (!nativeBytes || !terminalBytes) fail();
  const manifest = parseNativeBundleManifest(JSON.parse(text(nativeBytes))),
    terminal = parseTerminalBundleManifest(JSON.parse(text(terminalBytes)));
  if (hash(terminalBytes) !== manifest.terminalManifestSha256) fail();
  const expected = [
    ...manifest.files,
    ...terminal.files.map((file) => ({ ...file, path: `terminal/${file.path}` })),
  ];
  if (files.size !== expected.length + 2) fail();
  for (const file of expected) {
    const bytes = files.get(file.path);
    if (!bytes || bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
  }
  const links = [
    ...manifest.links,
    ...terminal.links.map((link) => ({ path: `terminal/${link.path}`, target: link.target })),
  ];
  const declarations = [
    ...files.keys(),
    ...links.map((link) => link.path),
    ...manifest.directories,
  ];
  const paths = new Set(declarations);
  if (paths.size !== declarations.length) fail();
  for (const path of declarations) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (paths.has(parent)) fail();
      parent = posix.dirname(parent);
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  try {
    const modes = new Map(expected.map((file) => [file.path, file.mode]));
    for (const [path, bytes] of files) {
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        modes.get(path) ?? 0o644,
      );
      try {
        fchmodSync(fd, modes.get(path) ?? 0o644);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const directory of manifest.directories)
      mkdirSync(join(destination, directory), { recursive: true, mode: 0o700 });
    for (const link of links) {
      const target = join(destination, link.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      symlinkSync(link.target, target);
    }
    return verifyNativeRuntimeBundle(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
