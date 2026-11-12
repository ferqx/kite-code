import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type MacosElectronResize,
  macosElectronResize,
  verifyMacosElectronFramework,
} from '../electron/macos-electron-resize';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const resources =
  'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources';
type Entry = { value: string; inode?: string };
function fail(): never {
  throw Error('macos_electron_runtime_input_invalid');
}
function inside(path: string, root: string) {
  return path === root || path.startsWith(root + sep);
}
function canonical(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== realpathSync(path) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isDirectory()
  )
    fail();
  return resolve(path);
}
function separate(source: string, target: string) {
  if (
    inside(source, target) ||
    inside(target, source) ||
    target.split(sep).includes('node_modules')
  )
    fail();
}
function inventory(root: string): Map<string, Entry> {
  const result = new Map<string, Entry>();
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        item = relative(root, path),
        stat = lstatSync(path);
      if (!inside(realpathSync(path), root)) fail();
      if (stat.isSymbolicLink()) result.set(item, { value: `link:${readlinkSync(path)}` });
      else if (stat.isDirectory()) {
        result.set(item, { value: 'directory' });
        walk(path);
      } else if (stat.isFile() && stat.nlink === 1)
        result.set(item, {
          value: `file:${stat.mode & 0o777}:${stat.size}:${sha(readFileSync(path))}`,
          inode: `${stat.dev}:${stat.ino}`,
        });
      else fail();
    }
  };
  walk(root);
  return result;
}
function equalInventory(a: Map<string, Entry>, b: Map<string, Entry>, independent = false) {
  if (a.size !== b.size) fail();
  for (const [name, record] of a) {
    const other = b.get(name);
    if (
      !other ||
      record.value !== other.value ||
      (independent && record.inode && record.inode === other.inode)
    )
      fail();
  }
}
function sourceInput(sourceDist: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail();
  const source = canonical(sourceDist);
  if (readFileSync(join(source, 'version'), 'utf8').trim() !== macosElectronResize.version) fail();
  const snapshot = inventory(source);
  if (
    snapshot.has(resources) ||
    !snapshot.get(macosElectronResize.framework)?.value.startsWith('file:')
  )
    fail();
  verifyMacosElectronFramework(
    readFileSync(join(source, macosElectronResize.framework)),
    'original',
  );
  if (!snapshot.get(macosElectronResize.executable)?.value.startsWith('file:')) fail();
  return { source, snapshot };
}

/** Patch only the builder's already copied, fully independent Electron dist. */
export function patchMacosElectronRuntime(input: {
  sourceDist: string;
  targetDist: string;
}): MacosElectronResize {
  return patchCopiedRuntime(sourceInput(input.sourceDist), input.targetDist);
}

/** A distribution signature changes the Framework bytes but must preserve the reviewed payload. */
export function fingerprintPatchedMacosElectron(dist: string): MacosElectronResize {
  const bytes = readFileSync(join(canonical(dist), macosElectronResize.framework));
  verifyMacosElectronFramework(bytes, 'patched');
  return Object.freeze({ frameworkSha256: sha(bytes) });
}

function patchCopiedRuntime(
  { source, snapshot }: ReturnType<typeof sourceInput>,
  targetDist: string,
): MacosElectronResize {
  const target = canonical(targetDist);
  separate(source, target);
  const copiedInventory = inventory(target);
  equalInventory(snapshot, copiedInventory, true);
  const framework = join(target, macosElectronResize.framework);
  const before = readFileSync(framework);
  verifyMacosElectronFramework(before, 'original');
  const fd = openSync(framework, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      `${opened.dev}:${opened.ino}` !== copiedInventory.get(macosElectronResize.framework)?.inode
    )
      fail();
    for (const patch of macosElectronResize.patches) {
      const bytes = Buffer.from(patch.patched, 'hex');
      if (writeSync(fd, bytes, 0, bytes.length, patch.offset) !== bytes.length) fail();
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const patched = readFileSync(framework);
  verifyMacosElectronFramework(patched, 'patched');
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      '-',
      '--preserve-metadata=identifier,requirements,entitlements,flags',
      framework,
    ],
    { stdio: 'pipe' },
  );
  execFileSync('/usr/bin/codesign', ['--verify', '--ignore-resources', '--verbose=4', framework], {
    stdio: 'pipe',
  });
  const signed = readFileSync(framework);
  verifyMacosElectronFramework(signed, 'patched');
  const after = inventory(target),
    additions = new Set([dirname(resources), resources]);
  for (const [name, record] of snapshot) {
    if (name !== macosElectronResize.framework && record.value !== after.get(name)?.value) fail();
    const copied = after.get(name);
    if (!copied || (record.inode && copied.inode === record.inode)) fail();
  }
  for (const name of after.keys()) if (!snapshot.has(name) && !additions.has(name)) fail();
  if (!after.get(resources)?.value.startsWith('file:')) fail();
  equalInventory(snapshot, inventory(source));
  return Object.freeze({ frameworkSha256: sha(signed) });
}

/** Never patches installed dependencies; the returned runtime belongs to this build. */
export function prepareMacosElectronRuntime(input: { sourceDist: string; outdir: string }): {
  executable: string;
  resize: MacosElectronResize;
} {
  const prepared = sourceInput(input.sourceDist);
  const { source } = prepared;
  if (!isAbsolute(input.outdir) || existsSync(input.outdir)) fail();
  const target = resolve(input.outdir),
    parent = canonical(dirname(target));
  separate(source, target);
  if (target !== join(parent, relative(parent, target))) fail();
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    // APFS can clone independent files; unsupported filesystems use the normal copy.
    mode: constants.COPYFILE_FICLONE,
  });
  // Keep the initial source snapshot through the copied inventory and final source
  // check rather than taking another baseline after copying.
  const resize = patchCopiedRuntime(prepared, target);
  return { executable: join(target, macosElectronResize.executable), resize };
}
