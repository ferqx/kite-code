import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import {
  hashWindowsArtifactFile,
  readWindowsArtifactFile,
  readWindowsArtifactObject,
  retainWindowsCandidateFiles,
  type WindowsInstallationRemoval,
  windowsInstallationRemovalReader,
} from '@kite-ai/agent/artifact-access';
import { verifySqliteEngineAsset } from '@kite-ai/agent/sqlite-engine';
import { createAssetFileHasher } from './asset-file-hash';
import {
  desktopSqliteEngineRoot,
  parseSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
  terminalSqliteEngineRoot,
} from './sqlite-release-assets';
export class TerminalRuntimeAssetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'TerminalRuntimeAssetError';
    this.code = code;
  }
}

interface RuntimeBundleManifest {
  readonly version: 1;
  readonly apiMajor: 1;
  readonly target: { readonly platform: string; readonly arch: string };
  readonly bunVersion?: string;
  readonly nodeVersion?: string;
  readonly sqlite: SqliteReleaseIdentity & {
    readonly driver: 'bun:sqlite' | 'node-api:sqlite';
    readonly manifestSha256: string;
  };
  readonly productVersion: string;
  readonly source: { readonly commit: string; readonly dirty: boolean };
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mode: 420 | 493;
  }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
}
const desktopServiceEntrypoint = 'code/@kite-ai/service/main.js';
export const windowsDesktopRuntimeEntries = Object.freeze({
  runtime: 'runtime/bun.exe',
  service: desktopServiceEntrypoint,
} as const);
export const windowsNodeDesktopRuntimeEntries = Object.freeze({
  runtime: 'runtime/node.exe',
  service: desktopServiceEntrypoint,
} as const);
export const macosDesktopRuntimeEntries = Object.freeze({
  runtime: 'runtime/bun',
  service: desktopServiceEntrypoint,
} as const);
export const macosNodeDesktopRuntimeEntries = Object.freeze({
  runtime: 'runtime/node',
  service: desktopServiceEntrypoint,
} as const);
const legacyWindowsDesktopRuntimeEntries = Object.freeze({
  runtime: 'runtime/bun.exe',
  service: 'node_modules/@kite-ai/service/main.js',
} as const);
export interface WindowsDesktopRuntimeManifest extends RuntimeBundleManifest {
  readonly bunVersion: string;
  readonly nodeVersion?: never;
  readonly entries: typeof windowsDesktopRuntimeEntries | typeof legacyWindowsDesktopRuntimeEntries;
}
interface MacosDesktopRuntimeManifest extends RuntimeBundleManifest {
  readonly bunVersion: string;
  readonly nodeVersion?: never;
  readonly entries: typeof macosDesktopRuntimeEntries;
}
interface MacosNodeDesktopRuntimeManifest extends RuntimeBundleManifest {
  readonly bunVersion?: never;
  readonly nodeVersion: string;
  readonly sqlite: RuntimeBundleManifest['sqlite'] & {
    readonly driver: 'node-api:sqlite';
    readonly linkage: 'dynamic';
  };
  readonly entries: typeof macosNodeDesktopRuntimeEntries;
}
interface WindowsNodeDesktopRuntimeManifest extends RuntimeBundleManifest {
  readonly bunVersion?: never;
  readonly nodeVersion: string;
  readonly sqlite: RuntimeBundleManifest['sqlite'] & {
    readonly driver: 'node-api:sqlite';
    readonly linkage: 'dynamic';
  };
  readonly entries: typeof windowsNodeDesktopRuntimeEntries;
}
export type DesktopRuntimeManifest =
  | MacosDesktopRuntimeManifest
  | MacosNodeDesktopRuntimeManifest
  | WindowsNodeDesktopRuntimeManifest
  | WindowsDesktopRuntimeManifest;
export interface TerminalBundleManifest extends RuntimeBundleManifest {
  readonly entries: {
    readonly runtime: string;
    readonly service: 'node_modules/@kite-ai/service/main.js';
    readonly daemon: 'node_modules/@kite-ai/service/daemon-main.js';
    readonly webManifest: 'web/manifest.json';
    readonly cli: 'entrypoints/cli.js';
    readonly tui: 'entrypoints/tui.js';
  };
}
export type EmbeddedRuntimeManifest = TerminalBundleManifest | DesktopRuntimeManifest;
export interface VerifiedTerminalRuntimeBundle<
  T extends EmbeddedRuntimeManifest = TerminalBundleManifest,
> {
  readonly root: string;
  readonly manifest: T;
  readonly digest: string;
}
/** Fixed empty installation assets, derived from the authenticated v1 file closure. */
export function terminalEmptyAssetDirectories(
  manifest: Pick<TerminalBundleManifest, 'files' | 'nodeVersion'>,
): string[] {
  const files = new Set(manifest.files.map((file) => file.path));
  const assets = ['worker.js', 'manifest.json'];
  if (manifest.nodeVersion === undefined) assets.push('empty-bunfig.toml');
  return ['code', 'node_modules'].flatMap((root) => {
    const directory = `${root}/@kite-ai/agent/tools/git-worktree`;
    return assets.every((name) => files.has(`${directory}/${name}`))
      ? [`${directory}/empty-hooks`]
      : [];
  });
}
function sqliteEngineRoot(entries: EmbeddedRuntimeManifest['entries']): string {
  return entries.service === desktopServiceEntrypoint
    ? desktopSqliteEngineRoot
    : terminalSqliteEngineRoot;
}
export interface TerminalRuntimeProtection {
  readonly kind: 'terminal.candidate';
  readonly root: string;
  readonly manifestSha256: string;
}
export const nodeNativeInstallerPath = 'entrypoints/kite-install.command';
export const nodeNativeMaintenancePath = 'node_modules/@kite-ai/agent/native-maintenance.mjs';
export const terminalBundleEntries = (
  platform: string,
  runtime: 'bun' | 'node' = 'bun',
): TerminalBundleManifest['entries'] =>
  Object.freeze({
    runtime: `runtime/${runtime}${platform === 'win32' ? '.exe' : ''}`,
    service: 'node_modules/@kite-ai/service/main.js',
    daemon: 'node_modules/@kite-ai/service/daemon-main.js',
    webManifest: 'web/manifest.json',
    cli: 'entrypoints/cli.js',
    tui: 'entrypoints/tui.js',
  });
export const terminalHostEntrypoints = Object.freeze([
  'entrypoints/standard-cli.js',
  'entrypoints/standard-tui.js',
  'entrypoints/native-cli.js',
  'entrypoints/native-tui.js',
]);
export const windowsTerminalFrontdoorFiles = Object.freeze([
  'windows-frontdoor/kite.exe',
  'windows-frontdoor/kite-tui.exe',
  'windows-frontdoor/terminal-verifier.exe',
]);
export const windowsTerminalVerifierAddonPath = 'windows-frontdoor/runtime-native.node';
export const windowsTerminalRuntimeConfigFiles = Object.freeze([
  'runtime/windows-bunfig.toml',
  'runtime/windows-tsconfig.json',
]);
/** Fixed candidate config prevents working-directory preloads, aliases and implicit installs. */
export function windowsTerminalRuntimeArguments(
  root: string,
  runtime: 'node' | 'bun' = 'bun',
): readonly string[] {
  if (runtime === 'node') return Object.freeze(['--no-global-search-paths']);
  return Object.freeze([
    '--no-env-file',
    '--no-install',
    `--config=${join(root, windowsTerminalRuntimeConfigFiles[0]!)}`,
    `--tsconfig-override=${join(root, windowsTerminalRuntimeConfigFiles[1]!)}`,
  ]);
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Windows' native final-path lookup preserves the same canonical-path check
// without repeating the JS ancestor walk for every leaf in the full closure.
const canonicalPath = process.platform === 'win32' ? realpathSync.native : realpathSync;
function fail(code: string): never {
  throw new TerminalRuntimeAssetError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function relativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
function inside(root: string, path: string) {
  return path.startsWith(root + sep);
}
/** Closed unsigned integrity metadata. This does not establish publisher authenticity. */
export function parseTerminalBundleManifest(value: unknown): TerminalBundleManifest;
export function parseTerminalBundleManifest(
  value: unknown,
  embedded: true,
): EmbeddedRuntimeManifest;
export function parseTerminalBundleManifest(
  value: unknown,
  embedded = false,
): EmbeddedRuntimeManifest {
  const node = record(value) && Object.hasOwn(value, 'nodeVersion');
  const versionKey = node ? 'nodeVersion' : 'bunVersion';
  const runtimeVersion = record(value) ? value[versionKey] : undefined;
  if (
    !closed(value, [
      'version',
      'apiMajor',
      'target',
      versionKey,
      'sqlite',
      'productVersion',
      'source',
      'entries',
      'files',
      'links',
    ]) ||
    value.version !== 1 ||
    value.apiMajor !== 1 ||
    !closed(value.target, ['platform', 'arch']) ||
    typeof value.target.platform !== 'string' ||
    typeof value.target.arch !== 'string' ||
    !['darwin', 'linux', 'win32'].includes(value.target.platform) ||
    !['x64', 'arm64'].includes(value.target.arch) ||
    typeof runtimeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(runtimeVersion) ||
    !closed(value.sqlite, ['driver', 'linkage', 'version', 'sourceId', 'manifestSha256']) ||
    value.sqlite.driver !== (node ? 'node-api:sqlite' : 'bun:sqlite') ||
    typeof value.sqlite.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sqlite.manifestSha256) ||
    typeof value.productVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.productVersion) ||
    !closed(value.source, ['commit', 'dirty']) ||
    typeof value.source.commit !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.source.commit) ||
    typeof value.source.dirty !== 'boolean' ||
    !record(value.entries) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.links)
  )
    fail('terminal_manifest_invalid');
  let sqlite: TerminalBundleManifest['sqlite'];
  try {
    const { manifestSha256, ...identity } = value.sqlite;
    sqlite = Object.freeze({
      ...parseSqliteReleaseIdentity(identity),
      driver: node ? 'node-api:sqlite' : 'bun:sqlite',
      manifestSha256: manifestSha256 as string,
    });
  } catch {
    fail('terminal_manifest_invalid');
  }
  const desktop = embedded && closed(value.entries, ['runtime', 'service']);
  const targetPlatform = value.target.platform;
  const rawEntries = value.entries;
  let entries: EmbeddedRuntimeManifest['entries'];
  if (!desktop) entries = terminalBundleEntries(value.target.platform, node ? 'node' : 'bun');
  else if (value.target.platform === 'win32') {
    if (node) entries = windowsNodeDesktopRuntimeEntries;
    else
      entries =
        rawEntries.service === legacyWindowsDesktopRuntimeEntries.service
          ? legacyWindowsDesktopRuntimeEntries
          : windowsDesktopRuntimeEntries;
  } else if (value.target.platform === 'darwin' && value.target.arch === 'arm64')
    entries = node ? macosNodeDesktopRuntimeEntries : macosDesktopRuntimeEntries;
  else fail('terminal_manifest_invalid');
  const bundledDesktop = entries.service === desktopServiceEntrypoint;
  const files = value.files;
  if (
    !closed(rawEntries, Object.keys(entries)) ||
    Object.entries(entries).some(([key, path]) => rawEntries[key] !== path) ||
    (bundledDesktop && value.links.length !== 0)
  )
    fail('terminal_manifest_invalid');
  const paths = new Set<string>();
  for (const item of value.files) {
    if (
      !closed(item, ['path', 'size', 'sha256', 'mode']) ||
      !relativePath(item.path) ||
      item.path === 'terminal-manifest.json' ||
      paths.has(item.path) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      (item.mode !== 420 && item.mode !== 493)
    )
      fail('terminal_manifest_invalid');
    paths.add(item.path);
  }
  for (const item of value.links) {
    if (
      !closed(item, ['path', 'target']) ||
      !relativePath(item.path) ||
      !item.path.startsWith('node_modules/') ||
      paths.has(item.path) ||
      typeof item.target !== 'string' ||
      !item.target ||
      item.target.includes('\\') ||
      item.target.includes('\0') ||
      isAbsolute(item.target) ||
      /^[A-Za-z]:/.test(item.target)
    )
      fail('terminal_manifest_invalid');
    const target = posix.normalize(posix.join(posix.dirname(item.path), item.target));
    if (!relativePath(target) || !target.startsWith('node_modules/'))
      fail('terminal_manifest_invalid');
    paths.add(item.path);
  }
  if (Object.values(entries).some((path) => !files.some((item) => item.path === path)))
    fail('terminal_manifest_invalid');
  if (!files.some((item) => item.path === entries.runtime && item.mode === 493))
    fail('terminal_manifest_invalid');
  if (
    node &&
    (!files.some((item) => item.path === 'runtime/LICENSE.node' && item.mode === 420) ||
      files.some((item) => /^runtime\/bun(?:[./]|$)/iu.test(item.path)))
  )
    fail('terminal_manifest_invalid');
  if (
    node &&
    !desktop &&
    (!files.some((item) => item.path === nodeNativeInstallerPath && item.mode === 493) ||
      !files.some((item) => item.path === nodeNativeMaintenancePath && item.mode === 420) ||
      !files.some((item) => item.path === 'entrypoints/package.json' && item.mode === 420))
  )
    fail('terminal_manifest_invalid');
  if (
    node &&
    ((desktop && !files.some((item) => item.path === 'code/package.json' && item.mode === 420)) ||
      !files.some(
        (item) =>
          item.path === `${desktop ? 'code' : 'node_modules'}/@kite-ai/agent/runtime-native.node` &&
          item.mode === 493,
      ))
  )
    fail('terminal_manifest_invalid');
  if (
    !desktop &&
    terminalHostEntrypoints.some(
      (path) => !files.some((item) => item.path === path && item.mode === 420),
    )
  )
    fail('terminal_manifest_invalid');
  if (
    value.target.platform === 'win32' &&
    (value.target.arch !== 'x64' ||
      value.links.length !== 0 ||
      (!desktop &&
        windowsTerminalFrontdoorFiles.some(
          (path) => !files.some((item) => item.path === path && item.mode === 493),
        )) ||
      (node &&
        !desktop &&
        !files.some(
          (item) => item.path === windowsTerminalVerifierAddonPath && item.mode === 493,
        )) ||
      (!node &&
        windowsTerminalRuntimeConfigFiles.some(
          (path) => !files.some((item) => item.path === path && item.mode === 420),
        )))
  )
    fail('terminal_manifest_invalid');
  if (
    desktop &&
    files.some(
      (file) =>
        (bundledDesktop && /(?:^|\/)node_modules(?:\/|$)/iu.test(file.path)) ||
        /^(?:entrypoints|web|windows-frontdoor|(?:code|node_modules)\/@kite-ai\/(?:cli|ui))(?:\/|$)/iu.test(
          file.path,
        ) ||
        /^(?:code|node_modules)\/@kite-ai\/service\/(?:daemon(?:-main)?|development-web)\.js$/iu.test(
          file.path,
        ),
    )
  )
    fail('terminal_manifest_invalid');
  const engineRoot = sqliteEngineRoot(entries);
  if (
    (node &&
      !files.some(
        (item) =>
          item.path ===
            `${engineRoot}/${targetPlatform === 'win32' ? 'sqlite3.dll' : targetPlatform === 'linux' ? 'libsqlite3.so' : 'libsqlite3.dylib'}` &&
          item.mode === 420,
      )) ||
    !['engine-selection.json', 'engine-manifest.json'].every((name) =>
      files.some((item) => item.path === `${engineRoot}/${name}` && item.mode === 420),
    ) ||
    !files.some(
      (item) =>
        item.path === `${engineRoot}/engine-manifest.json` && item.sha256 === sqlite.manifestSha256,
    )
  )
    fail('terminal_manifest_invalid');
  // Copy exact verified fields; neither arbitrary extra metadata nor caller mutations become authority.
  return Object.freeze({
    version: 1,
    apiMajor: 1,
    target: Object.freeze({ ...value.target }),
    ...(node ? { nodeVersion: runtimeVersion } : { bunVersion: runtimeVersion }),
    sqlite,
    productVersion: value.productVersion,
    source: Object.freeze({ ...value.source }),
    entries,
    files: Object.freeze(value.files.map((item) => Object.freeze({ ...item }))),
    links: Object.freeze(value.links.map((item) => Object.freeze({ ...item }))),
  }) as EmbeddedRuntimeManifest;
}
/** Exact native file ownership, independently retained by each actual Windows consumer. */
const windowsTerminalFileReaders = new WeakMap<
  object,
  {
    root: string;
    hash(path: string): string;
    bytes(path: string): Uint8Array;
    read(path: string): import('@kite-ai/agent/artifact-access').WindowsArtifactObject | undefined;
  }
>();

export function retainWindowsTerminalRuntimeFiles(root: string): {
  verify(): void;
  release(): void;
} {
  if (process.platform !== 'win32') fail('terminal_target_mismatch');
  const pins: ReturnType<typeof retainWindowsCandidateFiles>[] = [];
  let access: { verify(): void; release(): void } | undefined;
  const release = () => {
    if (access) windowsTerminalFileReaders.delete(access);
    while (pins.length) {
      pins.at(-1)!.release();
      pins.pop();
    }
  };
  try {
    pins.push(retainWindowsCandidateFiles(root, ['terminal-manifest.json']));
    const manifest = parseTerminalBundleManifest(
      JSON.parse(readFileSync(join(root, 'terminal-manifest.json'), 'utf8')),
      true,
    );
    if (manifest.target.platform !== 'win32' || manifest.target.arch !== process.arch)
      fail('terminal_target_mismatch');
    pins.push(
      retainWindowsCandidateFiles(
        root,
        manifest.files.map((file) => file.path),
        terminalEmptyAssetDirectories(manifest),
      ),
    );
    const verify = () => {
      for (const pin of pins) pin.verify();
      if (!pins.length) fail('terminal_bundle_unavailable');
    };
    // Each original scope has completed its own initial verification. The manifest
    // remains read-pinned while the second scope admits every exact declared path.
    access = Object.freeze({ verify, release });
    windowsTerminalFileReaders.set(access, {
      root,
      hash: (path) => hashWindowsArtifactFile(pins[1]!, path),
      bytes: (path) =>
        readWindowsArtifactFile(
          path === join(root, 'terminal-manifest.json') ? pins[0]! : pins[1]!,
          path,
        ),
      read: (path) => readWindowsArtifactObject(pins[1]!, path),
    });
    return access;
  } catch (error) {
    release();
    throw error;
  }
}
/** Raw original bytes only; callers still hash every file and reverify the genuine owner. */
export function readWindowsTerminalRuntimeFile(
  access: ReturnType<typeof retainWindowsTerminalRuntimeFiles>,
  path: string,
): Uint8Array {
  const state = windowsTerminalFileReaders.get(access);
  if (!state || !relativePath(path)) return fail('terminal_bundle_unavailable');
  return state.bytes(join(state.root, ...path.split('/')));
}
/** Verify the entire installed closure at its canonical startup root; no global executable fallback. */
export function verifyTerminalRuntimeBundle(
  bundleRoot: string,
  removal?: WindowsInstallationRemoval,
  retainedFiles?: ReturnType<typeof retainWindowsTerminalRuntimeFiles>,
): VerifiedTerminalRuntimeBundle {
  return terminalRuntimeBundleContent(
    bundleRoot,
    removal,
    false,
    retainedFiles,
    false,
  ) as VerifiedTerminalRuntimeBundle;
}
export function verifyEmbeddedRuntimeBundle(
  bundleRoot: string,
  removal?: WindowsInstallationRemoval,
  retainedFiles?: ReturnType<typeof retainWindowsTerminalRuntimeFiles>,
) {
  return terminalRuntimeBundleContent(bundleRoot, removal, false, retainedFiles, true);
}
/** Complete content/hash/inventory only. No ACL, native file pin or usage authority. */
export function readTerminalRuntimeBundleContent(
  bundleRoot: string,
): VerifiedTerminalRuntimeBundle {
  return terminalRuntimeBundleContent(
    bundleRoot,
    undefined,
    true,
    undefined,
    false,
  ) as VerifiedTerminalRuntimeBundle;
}
export function readEmbeddedRuntimeBundleContent(bundleRoot: string) {
  return terminalRuntimeBundleContent(bundleRoot, undefined, true, undefined, true);
}
function terminalRuntimeBundleContent(
  bundleRoot: string,
  removal: WindowsInstallationRemoval | undefined,
  contentOnly: boolean,
  retainedFiles: ReturnType<typeof retainWindowsTerminalRuntimeFiles> | undefined,
  embedded: boolean,
): VerifiedTerminalRuntimeBundle<EmbeddedRuntimeManifest> {
  let windowsFiles: ReturnType<typeof retainWindowsTerminalRuntimeFiles> | undefined;
  try {
    const root = realpathSync(bundleRoot);
    if (retainedFiles && (removal || windowsTerminalFileReaders.get(retainedFiles)?.root !== root))
      fail('terminal_bundle_unavailable');
    if (!lstatSync(root).isDirectory()) fail('terminal_bundle_unavailable');
    const manifestPath = join(root, 'terminal-manifest.json');
    if (
      !lstatSync(manifestPath).isFile() ||
      lstatSync(manifestPath).isSymbolicLink() ||
      lstatSync(manifestPath).nlink !== 1
    )
      fail('terminal_bundle_unavailable');
    const removing =
      removal &&
      (() => {
        if (process.platform !== 'win32') fail('terminal_target_mismatch');
        return windowsInstallationRemovalReader(removal, root);
      })();
    if (!removal && !contentOnly && process.platform === 'win32')
      windowsFiles = retainedFiles ?? retainWindowsTerminalRuntimeFiles(root);
    const retainedReader = windowsFiles && windowsTerminalFileReaders.get(windowsFiles)!;
    const bytes = readFileSync(manifestPath);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('terminal_manifest_invalid');
    }
    const manifest = embedded
      ? parseTerminalBundleManifest(json, true)
      : parseTerminalBundleManifest(json);
    if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch)
      fail('terminal_target_mismatch');
    const fileHash = createAssetFileHasher(),
      expected = new Map(manifest.files.map((item) => [item.path, item]));
    const links = new Map(manifest.links.map((item) => [item.path, item]));
    const directories = new Set<string>(terminalEmptyAssetDirectories(manifest));
    for (const path of [...expected.keys(), ...links.keys()]) {
      let parent = posix.dirname(path);
      while (parent !== '.') {
        directories.add(parent);
        parent = posix.dirname(parent);
      }
    }
    const actual = new Set<string>();
    const identities = new Set<string>();
    function walk(directory: string, prefix = '') {
      for (const name of readdirSync(directory)) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (path === 'terminal-manifest.json') continue;
        const absolute = join(directory, name);
        if (retainedReader || removing) {
          // The same original handles already checked kind, exact final path,
          // no reparse, single link and full 64-bit identity/size. Keep every
          // inventory and byte hash check; reverify all original stamps/ACLs below.
          const original = removing?.(absolute);
          const object = original ?? retainedReader?.read(absolute);
          if (!object) fail('terminal_bundle_identity_mismatch');
          if (object.directory) {
            if (!directories.has(path)) fail('terminal_bundle_identity_mismatch');
            walk(absolute, path);
          } else {
            const file = expected.get(path);
            if (
              !file ||
              object.size !== BigInt(file.size) ||
              (original ? original.sha256() : retainedReader!.hash(absolute)) !== file.sha256
            )
              fail('terminal_bundle_identity_mismatch');
            if (identities.has(object.identity)) fail('terminal_bundle_path_alias');
            identities.add(object.identity);
            actual.add(path);
          }
          continue;
        }
        const stat = lstatSync(absolute, { bigint: true });
        if (stat.isSymbolicLink()) {
          const link = links.get(path);
          if (!link || readlinkSync(absolute) !== link.target)
            fail('terminal_bundle_identity_mismatch');
          const target = resolve(dirname(absolute), link.target);
          if (
            !inside(join(root, 'node_modules'), target) ||
            !inside(join(root, 'node_modules'), realpathSync(absolute))
          )
            fail('terminal_bundle_link_invalid');
          actual.add(path);
        } else if (stat.isDirectory()) {
          if (!directories.has(path)) fail('terminal_bundle_identity_mismatch');
          if (canonicalPath(absolute) !== absolute) fail('terminal_bundle_path_alias');
          walk(absolute, path);
        } else if (stat.isFile()) {
          const file = expected.get(path);
          if (
            !file ||
            stat.nlink !== 1n ||
            stat.size !== BigInt(file.size) ||
            (process.platform !== 'win32' && (stat.mode & 0o777n) !== BigInt(file.mode)) ||
            canonicalPath(absolute) !== absolute ||
            fileHash(absolute, file.size) !== file.sha256
          )
            fail('terminal_bundle_identity_mismatch');
          const identity = `${stat.dev}:${stat.ino}`;
          if (identities.has(identity)) fail('terminal_bundle_path_alias');
          identities.add(identity);
          actual.add(path);
        } else fail('terminal_bundle_unavailable');
      }
    }
    walk(root);
    for (const directory of terminalEmptyAssetDirectories(manifest)) {
      const path = join(root, directory);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length !== 0)
        fail('terminal_bundle_identity_mismatch');
    }
    if (
      actual.size !== expected.size + links.size ||
      [...expected.keys(), ...links.keys()].some((path) => !actual.has(path))
    )
      fail('terminal_bundle_identity_mismatch');
    const engineRoot = join(root, sqliteEngineRoot(manifest.entries));
    const selection = JSON.parse(readFileSync(join(engineRoot, 'engine-selection.json'), 'utf8'));
    if (
      !closed(selection, ['version', 'manifestSha256']) ||
      selection.version !== 1 ||
      selection.manifestSha256 !== manifest.sqlite.manifestSha256
    )
      fail('terminal_sqlite_engine_mismatch');
    const engine = verifySqliteEngineAsset({
      root: engineRoot,
      manifestSha256: manifest.sqlite.manifestSha256,
    }).manifest;
    if (
      engine.driver !== manifest.sqlite.driver ||
      engine.sqlite.version !== manifest.sqlite.version ||
      engine.sqlite.sourceId !== manifest.sqlite.sourceId ||
      ('linkage' in engine && engine.linkage === 'builtin' ? 'builtin' : 'dynamic') !==
        manifest.sqlite.linkage
    )
      fail('terminal_sqlite_engine_mismatch');
    windowsFiles?.verify();
    return Object.freeze({ root, manifest, digest: digest(bytes) });
  } catch (error) {
    if (error instanceof TerminalRuntimeAssetError) throw error;
    return fail('terminal_bundle_unavailable');
  } finally {
    if (!retainedFiles) windowsFiles?.release();
  }
}
/** Host-only deny metadata. Parsing performs no filesystem or package access. */
export function parseTerminalRuntimeProtection(value: unknown): TerminalRuntimeProtection {
  if (
    !closed(value, ['kind', 'root', 'manifestSha256']) ||
    value.kind !== 'terminal.candidate' ||
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    value.root.length > 4096 ||
    value.root.includes('\0') ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256)
  )
    fail('terminal_runtime_protection_invalid');
  return Object.freeze({
    kind: 'terminal.candidate',
    root: value.root,
    manifestSha256: value.manifestSha256,
  });
}
/** Explicit verified closure; this is integrity protection, not publisher authenticity. */
export function verifyTerminalRuntimeProtection(
  proof: TerminalRuntimeProtection,
  actual: { entrypoint: string; executable: string; buildId: string },
  retainedFiles?: ReturnType<typeof retainWindowsTerminalRuntimeFiles>,
): string {
  const selected = parseTerminalRuntimeProtection(proof);
  const bundle = verifyTerminalRuntimeBundle(selected.root, undefined, retainedFiles);
  try {
    if (
      bundle.digest !== selected.manifestSha256 ||
      actual.buildId !== `terminal-${bundle.digest}` ||
      !isAbsolute(actual.entrypoint) ||
      !isAbsolute(actual.executable) ||
      lstatSync(actual.entrypoint).isSymbolicLink() ||
      lstatSync(actual.executable).isSymbolicLink() ||
      ![bundle.manifest.entries.service, bundle.manifest.entries.daemon].some(
        (entry) => realpathSync(actual.entrypoint) === join(bundle.root, entry),
      ) ||
      realpathSync(actual.executable) !== join(bundle.root, bundle.manifest.entries.runtime)
    )
      fail('terminal_runtime_protection_mismatch');
    return bundle.root;
  } catch (error) {
    if (error instanceof TerminalRuntimeAssetError) throw error;
    fail('terminal_runtime_protection_mismatch');
  }
}
