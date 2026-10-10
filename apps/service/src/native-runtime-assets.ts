import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import type { WindowsInstallationRemoval } from '@kite-ai/agent/artifact-access';
import { createAssetFileHasher } from './asset-file-hash';
import {
  readTerminalRuntimeBundleContent,
  type VerifiedTerminalRuntimeBundle,
  verifyTerminalRuntimeBundle,
} from './runtime-assets';
import { parseSqliteReleaseIdentity, type SqliteReleaseIdentity } from './sqlite-release-assets';

export class NativeRuntimeAssetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'NativeRuntimeAssetError';
    this.code = code;
  }
}
export interface NativeRuntimeProtection {
  readonly kind: 'native.candidate';
  readonly root: string;
  readonly manifestSha256: string;
}
export interface NativeBundleManifest {
  readonly version: 1;
  readonly apiMajor: 1;
  readonly target: { readonly platform: string; readonly arch: string };
  readonly electronVersion: string;
  readonly sqlite: SqliteReleaseIdentity & {
    readonly driver: 'node:sqlite';
    readonly linkage: 'builtin';
  };
  readonly terminalRoot: 'terminal';
  readonly terminalManifestSha256: string;
  readonly entries: {
    readonly main: 'app/main.cjs';
    readonly preload: 'app/preload.cjs';
    readonly renderer: 'app/renderer.js';
    readonly html: 'app/index.html';
    readonly package: 'app/package.json';
    readonly profileHelper: 'app/profile-access.js';
    readonly artifactHelper: 'app/artifact-access.js';
    readonly windowsAccess?: 'app/windows-access.node';
    readonly electron: string;
  };
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mode: 384 | 420 | 493;
  }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
  readonly directories: readonly string[];
}
export interface VerifiedNativeRuntimeBundle {
  readonly root: string;
  readonly manifest: NativeBundleManifest;
  readonly digest: string;
  readonly terminal: VerifiedTerminalRuntimeBundle;
}
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code: string): never {
  throw new NativeRuntimeAssetError(code);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function relative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
export function nativeBundleEntries(platform: string): NativeBundleManifest['entries'] {
  return Object.freeze({
    main: 'app/main.cjs',
    preload: 'app/preload.cjs',
    renderer: 'app/renderer.js',
    html: 'app/index.html',
    package: 'app/package.json',
    profileHelper: 'app/profile-access.js',
    artifactHelper: 'app/artifact-access.js',
    ...(platform === 'win32' ? { windowsAccess: 'app/windows-access.node' as const } : {}),
    electron:
      platform === 'darwin'
        ? 'electron/Electron.app/Contents/MacOS/Electron'
        : platform === 'linux'
          ? 'electron/electron'
          : 'electron/electron.exe',
  });
}
export function parseNativeRuntimeProtection(value: unknown): NativeRuntimeProtection {
  if (
    !closed(value, ['kind', 'root', 'manifestSha256']) ||
    value.kind !== 'native.candidate' ||
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    !hash(value.manifestSha256)
  )
    fail('native_protection_invalid');
  return Object.freeze({
    kind: 'native.candidate',
    root: value.root,
    manifestSha256: value.manifestSha256,
  });
}
export function parseNativeBundleManifest(value: unknown): NativeBundleManifest {
  if (
    !closed(value, [
      'version',
      'apiMajor',
      'target',
      'electronVersion',
      'sqlite',
      'terminalRoot',
      'terminalManifestSha256',
      'entries',
      'files',
      'links',
      'directories',
    ]) ||
    value.version !== 1 ||
    value.apiMajor !== 1 ||
    !closed(value.target, ['platform', 'arch']) ||
    !['darwin', 'linux', 'win32'].includes(String(value.target.platform)) ||
    !['arm64', 'x64'].includes(String(value.target.arch)) ||
    typeof value.electronVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.electronVersion) ||
    value.terminalRoot !== 'terminal' ||
    !hash(value.terminalManifestSha256) ||
    !closed(value.entries, [
      'main',
      'preload',
      'renderer',
      'html',
      'package',
      'profileHelper',
      'artifactHelper',
      'electron',
      ...(value.target.platform === 'win32' ? ['windowsAccess'] : []),
    ]) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.directories)
  )
    fail('native_manifest_invalid');
  let sqlite: NativeBundleManifest['sqlite'];
  try {
    const identity = parseSqliteReleaseIdentity(value.sqlite);
    if (identity.driver !== 'node:sqlite' || identity.linkage !== 'builtin')
      fail('native_manifest_invalid');
    sqlite = Object.freeze({ ...identity, driver: 'node:sqlite', linkage: 'builtin' });
  } catch {
    fail('native_manifest_invalid');
  }
  const entries = nativeBundleEntries(String(value.target.platform));
  const rawEntries = value.entries,
    rawFiles = value.files;
  if (Object.entries(entries).some(([key, path]) => rawEntries[key] !== path))
    fail('native_manifest_invalid');
  const paths = new Set<string>();
  for (const item of value.files) {
    if (
      !closed(item, ['path', 'size', 'sha256', 'mode']) ||
      !relative(item.path) ||
      paths.has(item.path) ||
      (!item.path.startsWith('app/') &&
        !item.path.startsWith('electron/') &&
        item.path !== '.use-terminal.lock') ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0 ||
      !hash(item.sha256) ||
      (item.path === '.use-terminal.lock'
        ? item.mode !== 384 || item.size !== 0 || item.sha256 !== sha(new Uint8Array())
        : ![420, 493].includes(Number(item.mode)))
    )
      fail('native_manifest_invalid');
    paths.add(item.path);
  }
  for (const item of value.links) {
    if (
      !closed(item, ['path', 'target']) ||
      !relative(item.path) ||
      !item.path.startsWith('electron/') ||
      paths.has(item.path) ||
      typeof item.target !== 'string' ||
      !item.target.length ||
      isAbsolute(item.target) ||
      item.target.includes('\\') ||
      item.target.includes('\0') ||
      /^[A-Za-z]:/.test(item.target)
    )
      fail('native_manifest_invalid');
    const target = posix.normalize(posix.join(posix.dirname(item.path), item.target));
    if (!target.startsWith('electron/') || target.includes('/../')) fail('native_manifest_invalid');
    paths.add(item.path);
  }
  if (
    Object.values(entries).some((path) => !rawFiles.some((item) => item.path === path)) ||
    !value.files.some((item) => item.path === '.use-terminal.lock') ||
    !value.files.some((item) => item.path === 'electron/version') ||
    !value.files.some((item) => item.path === entries.electron && item.mode === 493)
  )
    fail('native_manifest_invalid');
  for (const path of value.directories) {
    if (!relative(path) || !path.startsWith('electron/') || paths.has(path))
      fail('native_manifest_invalid');
    paths.add(path);
  }
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (paths.has(parent)) fail('native_manifest_invalid');
      parent = posix.dirname(parent);
    }
  }
  return Object.freeze({
    version: 1,
    apiMajor: 1,
    target: Object.freeze({
      platform: String(value.target.platform),
      arch: String(value.target.arch),
    }),
    electronVersion: value.electronVersion,
    sqlite,
    terminalRoot: 'terminal',
    terminalManifestSha256: value.terminalManifestSha256,
    entries,
    files: Object.freeze(value.files.map((item) => Object.freeze({ ...item }))),
    links: Object.freeze(value.links.map((item) => Object.freeze({ ...item }))),
    directories: Object.freeze([...value.directories]),
  });
}
/** Entire unsigned integrity closure. This does not establish publisher authenticity. Node-safe. */
export function verifyNativeRuntimeBundle(
  bundleRoot: string,
  removal?: WindowsInstallationRemoval,
): VerifiedNativeRuntimeBundle {
  return nativeRuntimeBundleContent(bundleRoot, removal, false);
}
/** Complete outer and inner content only; callers must separately acquire native admission. */
export function readNativeRuntimeBundleContent(bundleRoot: string): VerifiedNativeRuntimeBundle {
  return nativeRuntimeBundleContent(bundleRoot, undefined, true);
}
function nativeRuntimeBundleContent(
  bundleRoot: string,
  removal: WindowsInstallationRemoval | undefined,
  contentOnly: boolean,
): VerifiedNativeRuntimeBundle {
  let windowsFiles: ReturnType<typeof retainWindowsNativeRuntimeFiles> | undefined;
  let verificationError: unknown;
  let result: VerifiedNativeRuntimeBundle | undefined;
  try {
    if (!isAbsolute(bundleRoot)) fail('native_bundle_unavailable');
    const root = realpathSync(bundleRoot);
    for (let path = root; ; path = dirname(path)) {
      if (lstatSync(path).isSymbolicLink()) fail('native_bundle_path_alias');
      if (dirname(path) === path) break;
    }
    if (root !== bundleRoot || !lstatSync(root).isDirectory()) fail('native_bundle_path_alias');
    const manifestPath = join(root, 'native-manifest.json'),
      stat = lstatSync(manifestPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 420)
    )
      fail('native_bundle_unavailable');
    if (removal) {
      if (process.platform !== 'win32') fail('native_target_mismatch');
      const { assertWindowsInstallationRemoval } =
        require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
      assertWindowsInstallationRemoval(removal, root);
    } else if (!contentOnly && process.platform === 'win32')
      windowsFiles = retainWindowsNativeRuntimeFiles(root);
    const bytes = readFileSync(manifestPath);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('native_manifest_invalid');
    }
    const manifest = parseNativeBundleManifest(json);
    if (process.platform === 'win32' && manifest.links.length) fail('native_bundle_link_invalid');
    if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch)
      fail('native_target_mismatch');
    const terminalPath = join(root, 'terminal');
    if (!lstatSync(terminalPath).isDirectory() || lstatSync(terminalPath).isSymbolicLink())
      fail('native_bundle_path_alias');
    const terminal = contentOnly
      ? readTerminalRuntimeBundleContent(terminalPath)
      : verifyTerminalRuntimeBundle(terminalPath, removal);
    if (
      terminal.digest !== manifest.terminalManifestSha256 ||
      terminal.manifest.target.platform !== manifest.target.platform ||
      terminal.manifest.target.arch !== manifest.target.arch
    )
      fail('native_terminal_identity_mismatch');
    const fileHash = createAssetFileHasher(),
      files = new Map(manifest.files.map((file) => [file.path, file])),
      links = new Map(manifest.links.map((link) => [link.path, link]));
    const declaredEmpty = new Set(manifest.directories),
      actualEmpty = new Set<string>();
    const directories = new Set<string>(),
      actual = new Set<string>(),
      identities = new Set<string>();
    for (const path of [...files.keys(), ...links.keys(), ...declaredEmpty]) {
      let parent = posix.dirname(path);
      while (parent !== '.') {
        directories.add(parent);
        parent = posix.dirname(parent);
      }
    }
    function walk(directory: string, prefix = '') {
      for (const name of readdirSync(directory)) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (path === 'native-manifest.json' || path === 'terminal') continue;
        const absolute = join(directory, name),
          stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          const link = links.get(path),
            target = realpathSync(absolute),
            lexical = link ? resolve(dirname(absolute), link.target) : '';
          if (
            !link ||
            readlinkSync(absolute) !== link.target ||
            !target.startsWith(join(root, 'electron') + sep) ||
            !lexical.startsWith(join(root, 'electron') + sep)
          )
            fail('native_bundle_link_invalid');
          actual.add(path);
        } else if (stat.isDirectory()) {
          if (declaredEmpty.has(path)) {
            if (
              realpathSync(absolute) !== absolute ||
              readdirSync(absolute).length !== 0 ||
              (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
              (process.getuid && stat.uid !== process.getuid())
            )
              fail('native_bundle_identity_mismatch');
            actualEmpty.add(path);
            continue;
          }
          if (!directories.has(path) || realpathSync(absolute) !== absolute)
            fail('native_bundle_identity_mismatch');
          walk(absolute, path);
        } else if (stat.isFile()) {
          const file = files.get(path),
            identity = `${stat.dev}:${stat.ino}`;
          if (
            !file ||
            stat.nlink !== 1 ||
            stat.size !== file.size ||
            (process.platform !== 'win32' && (stat.mode & 0o777) !== file.mode) ||
            realpathSync(absolute) !== absolute ||
            fileHash(absolute, stat.size) !== file.sha256 ||
            identities.has(identity)
          )
            fail('native_bundle_identity_mismatch');
          if (path === '.use-terminal.lock' && process.getuid && stat.uid !== process.getuid())
            fail('native_bundle_identity_mismatch');
          identities.add(identity);
          actual.add(path);
        } else fail('native_bundle_unavailable');
      }
    }
    walk(root);
    if (
      actualEmpty.size !== declaredEmpty.size ||
      actual.size !== files.size + links.size ||
      [...files.keys(), ...links.keys()].some((path) => !actual.has(path))
    )
      fail('native_bundle_identity_mismatch');
    if (readFileSync(join(root, 'electron/version'), 'utf8').trim() !== manifest.electronVersion)
      fail('native_electron_identity_mismatch');
    const pkg = JSON.parse(readFileSync(join(root, manifest.entries.package), 'utf8'));
    if (
      !closed(pkg, ['name', 'version', 'main']) ||
      pkg.name !== 'kite-native' ||
      pkg.version !== '0.1.0' ||
      pkg.main !== 'main.cjs'
    )
      fail('native_app_identity_mismatch');
    if (removal) {
      const { assertWindowsInstallationRemoval } =
        require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
      assertWindowsInstallationRemoval(removal, root);
    }
    result = Object.freeze({ root, manifest, digest: sha(bytes), terminal });
  } catch (error) {
    verificationError =
      error instanceof NativeRuntimeAssetError || windowsRuntimePinCloseUnknown(error)
        ? error
        : new NativeRuntimeAssetError('native_bundle_unavailable');
  }
  try {
    windowsFiles?.release();
  } catch (cleanup) {
    verificationError = new AggregateError(
      verificationError ? [verificationError, cleanup] : [cleanup],
      'native_runtime_files_close_unknown',
    );
  }
  if (verificationError) throw verificationError;
  return result!;
}
export function verifyNativeRuntimeProtection(
  proof: NativeRuntimeProtection,
  actual: { entrypoint: string; executable: string; buildId: string },
): VerifiedNativeRuntimeBundle {
  const selected = parseNativeRuntimeProtection(proof),
    bundle = verifyNativeRuntimeBundle(selected.root);
  if (
    bundle.digest !== selected.manifestSha256 ||
    actual.buildId !== `native-${bundle.digest}` ||
    ![bundle.terminal.manifest.entries.service, bundle.terminal.manifest.entries.daemon].some(
      (entry) => realpathSync(actual.entrypoint) === join(bundle.terminal.root, entry),
    ) ||
    realpathSync(actual.executable) !==
      join(bundle.terminal.root, bundle.terminal.manifest.entries.runtime)
  )
    fail('native_protection_identity_mismatch');
  return bundle;
}

// Failed native closes keep the original manifest/file/directory owners reachable.
const windowsNativeOwners = new Set<{ release(): void }>();
/** Explicit Windows admission only; importing metadata/verifiers never loads Bun FFI. */
export function retainWindowsNativeRuntimeFiles(root: string): { verify(): void; release(): void } {
  if (process.platform !== 'win32') fail('native_target_mismatch');
  const { retainWindowsCandidateFiles } =
    require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
  const pins: ReturnType<typeof retainWindowsCandidateFiles>[] = [];
  const owner = {
    release() {
      try {
        while (pins.length) {
          pins.at(-1)!.release();
          pins.pop();
        }
      } catch (error) {
        throw new AggregateError([error], 'native_runtime_files_close_unknown');
      }
      windowsNativeOwners.delete(owner);
    },
  };
  windowsNativeOwners.add(owner);
  try {
    pins.push(retainWindowsCandidateFiles(root, ['native-manifest.json']));
    const manifest = parseNativeBundleManifest(
      JSON.parse(readFileSync(join(root, 'native-manifest.json'), 'utf8')),
    );
    if (manifest.target.platform !== 'win32' || manifest.target.arch !== process.arch)
      fail('native_target_mismatch');
    if (manifest.links.length) fail('native_bundle_link_invalid');
    pins.push(
      retainWindowsCandidateFiles(
        root,
        manifest.files.map((file) => file.path),
      ),
    );
    for (const directory of manifest.directories)
      pins.push(retainWindowsCandidateFiles(join(root, directory), []));
    const verify = () => {
      if (!pins.length) fail('native_bundle_unavailable');
      for (const pin of pins) pin.verify();
      for (const directory of manifest.directories)
        if (readdirSync(join(root, directory)).length) fail('native_bundle_identity_mismatch');
    };
    verify();
    return Object.freeze({ verify, release: owner.release });
  } catch (error) {
    try {
      owner.release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'native_runtime_files_close_unknown');
    }
    throw error;
  }
}

export function windowsRuntimePinCloseUnknown(error: unknown): boolean {
  return (
    error instanceof Error &&
    ([
      'native_runtime_files_close_unknown',
      'artifact_scope_release_failed',
      'artifact_access_acquire_close_unknown',
    ].includes(error.message) ||
      (error instanceof AggregateError && error.errors.some(windowsRuntimePinCloseUnknown)))
  );
}
