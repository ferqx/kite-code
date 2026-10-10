import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import type { WindowsInstallationRemoval } from '@kite-ai/agent/artifact-access';
import { verifySqliteEngineAsset } from '@kite-ai/agent/sqlite-engine';
import { createAssetFileHasher } from './asset-file-hash';
import {
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

export interface TerminalBundleManifest {
  readonly version: 1;
  readonly apiMajor: 1;
  readonly target: { readonly platform: string; readonly arch: string };
  readonly bunVersion: string;
  readonly sqlite: SqliteReleaseIdentity & {
    readonly driver: 'bun:sqlite';
    readonly manifestSha256: string;
  };
  readonly productVersion: string;
  readonly source: { readonly commit: string; readonly dirty: boolean };
  readonly entries: {
    readonly runtime: string;
    readonly service: 'node_modules/@kite-ai/service/main.js';
    readonly daemon: 'node_modules/@kite-ai/service/daemon-main.js';
    readonly webManifest: 'web/manifest.json';
    readonly cli: 'entrypoints/cli.js';
    readonly tui: 'entrypoints/tui.js';
  };
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mode: 420 | 493;
  }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
}
export interface VerifiedTerminalRuntimeBundle {
  readonly root: string;
  readonly manifest: TerminalBundleManifest;
  readonly digest: string;
}
export interface TerminalRuntimeProtection {
  readonly kind: 'terminal.candidate';
  readonly root: string;
  readonly manifestSha256: string;
}
export const terminalBundleEntries = (platform: string): TerminalBundleManifest['entries'] =>
  Object.freeze({
    runtime: platform === 'win32' ? 'runtime/bun.exe' : 'runtime/bun',
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
export const windowsTerminalRuntimeConfigFiles = Object.freeze([
  'runtime/windows-bunfig.toml',
  'runtime/windows-tsconfig.json',
]);
/** Fixed candidate config prevents working-directory preloads, aliases and implicit installs. */
export function windowsTerminalRuntimeArguments(root: string): readonly string[] {
  return Object.freeze([
    '--no-env-file',
    '--no-install',
    '--config',
    join(root, windowsTerminalRuntimeConfigFiles[0]!),
    '--tsconfig-override',
    join(root, windowsTerminalRuntimeConfigFiles[1]!),
  ]);
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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
export function parseTerminalBundleManifest(value: unknown): TerminalBundleManifest {
  if (
    !closed(value, [
      'version',
      'apiMajor',
      'target',
      'bunVersion',
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
    typeof value.bunVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.bunVersion) ||
    !closed(value.sqlite, ['driver', 'linkage', 'version', 'sourceId', 'manifestSha256']) ||
    value.sqlite.driver !== 'bun:sqlite' ||
    typeof value.sqlite.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sqlite.manifestSha256) ||
    typeof value.productVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.productVersion) ||
    !closed(value.source, ['commit', 'dirty']) ||
    typeof value.source.commit !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.source.commit) ||
    typeof value.source.dirty !== 'boolean' ||
    !closed(value.entries, ['runtime', 'service', 'daemon', 'webManifest', 'cli', 'tui']) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.links)
  )
    fail('terminal_manifest_invalid');
  let sqlite: TerminalBundleManifest['sqlite'];
  try {
    const { manifestSha256, ...identity } = value.sqlite;
    sqlite = Object.freeze({
      ...parseSqliteReleaseIdentity(identity),
      driver: 'bun:sqlite',
      manifestSha256: manifestSha256 as string,
    });
  } catch {
    fail('terminal_manifest_invalid');
  }
  const entries = terminalBundleEntries(value.target.platform);
  const rawEntries = value.entries as Record<string, unknown>;
  const files = value.files;
  if (Object.entries(entries).some(([key, path]) => rawEntries[key] !== path))
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
    terminalHostEntrypoints.some(
      (path) => !files.some((item) => item.path === path && item.mode === 420),
    )
  )
    fail('terminal_manifest_invalid');
  if (
    value.target.platform === 'win32' &&
    (value.target.arch !== 'x64' ||
      value.links.length !== 0 ||
      windowsTerminalFrontdoorFiles.some(
        (path) => !files.some((item) => item.path === path && item.mode === 493),
      ) ||
      windowsTerminalRuntimeConfigFiles.some(
        (path) => !files.some((item) => item.path === path && item.mode === 420),
      ))
  )
    fail('terminal_manifest_invalid');
  if (
    !['engine-selection.json', 'engine-manifest.json'].every((name) =>
      files.some(
        (item) => item.path === `${terminalSqliteEngineRoot}/${name}` && item.mode === 420,
      ),
    ) ||
    !files.some(
      (item) =>
        item.path === `${terminalSqliteEngineRoot}/engine-manifest.json` &&
        item.sha256 === sqlite.manifestSha256,
    )
  )
    fail('terminal_manifest_invalid');
  // Copy exact verified fields; neither arbitrary extra metadata nor caller mutations become authority.
  return Object.freeze({
    version: 1,
    apiMajor: 1,
    target: Object.freeze({ ...value.target }),
    bunVersion: value.bunVersion,
    sqlite,
    productVersion: value.productVersion,
    source: Object.freeze({ ...value.source }),
    entries,
    files: Object.freeze(value.files.map((item) => Object.freeze({ ...item }))),
    links: Object.freeze(value.links.map((item) => Object.freeze({ ...item }))),
  }) as TerminalBundleManifest;
}
/** Exact native file ownership, independently retained by each actual Windows consumer. */
export function retainWindowsTerminalRuntimeFiles(root: string): {
  verify(): void;
  release(): void;
} {
  if (process.platform !== 'win32') fail('terminal_target_mismatch');
  // Node/Electron also imports the pure verifier on POSIX. Native Bun ownership
  // loads only at this explicit Windows boundary, never during metadata parsing.
  const { retainWindowsCandidateFiles } =
    require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
  const pins: ReturnType<typeof retainWindowsCandidateFiles>[] = [];
  const release = () => {
    while (pins.length) {
      pins.at(-1)!.release();
      pins.pop();
    }
  };
  try {
    pins.push(retainWindowsCandidateFiles(root, ['terminal-manifest.json']));
    const manifest = parseTerminalBundleManifest(
      JSON.parse(readFileSync(join(root, 'terminal-manifest.json'), 'utf8')),
    );
    if (manifest.target.platform !== 'win32' || manifest.target.arch !== process.arch)
      fail('terminal_target_mismatch');
    pins.push(
      retainWindowsCandidateFiles(
        root,
        manifest.files.map((file) => file.path),
      ),
    );
    const verify = () => {
      for (const pin of pins) pin.verify();
      if (!pins.length) fail('terminal_bundle_unavailable');
    };
    verify();
    return Object.freeze({ verify, release });
  } catch (error) {
    release();
    throw error;
  }
}
/** Verify the entire installed closure at its canonical startup root; no global executable fallback. */
export function verifyTerminalRuntimeBundle(
  bundleRoot: string,
  removal?: WindowsInstallationRemoval,
): VerifiedTerminalRuntimeBundle {
  return terminalRuntimeBundleContent(bundleRoot, removal, false);
}
/** Complete content/hash/inventory only. No ACL, native file pin or usage authority. */
export function readTerminalRuntimeBundleContent(
  bundleRoot: string,
): VerifiedTerminalRuntimeBundle {
  return terminalRuntimeBundleContent(bundleRoot, undefined, true);
}
function terminalRuntimeBundleContent(
  bundleRoot: string,
  removal: WindowsInstallationRemoval | undefined,
  contentOnly: boolean,
): VerifiedTerminalRuntimeBundle {
  let windowsFiles: ReturnType<typeof retainWindowsTerminalRuntimeFiles> | undefined;
  try {
    const root = realpathSync(bundleRoot);
    if (!lstatSync(root).isDirectory()) fail('terminal_bundle_unavailable');
    const manifestPath = join(root, 'terminal-manifest.json');
    if (
      !lstatSync(manifestPath).isFile() ||
      lstatSync(manifestPath).isSymbolicLink() ||
      lstatSync(manifestPath).nlink !== 1
    )
      fail('terminal_bundle_unavailable');
    if (removal) {
      if (process.platform !== 'win32') fail('terminal_target_mismatch');
      const { assertWindowsInstallationRemoval } =
        require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
      assertWindowsInstallationRemoval(removal, root);
    } else if (!contentOnly && process.platform === 'win32')
      windowsFiles = retainWindowsTerminalRuntimeFiles(root);
    const bytes = readFileSync(manifestPath);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('terminal_manifest_invalid');
    }
    const manifest = parseTerminalBundleManifest(json);
    if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch)
      fail('terminal_target_mismatch');
    const fileHash = createAssetFileHasher(),
      expected = new Map(manifest.files.map((item) => [item.path, item]));
    const links = new Map(manifest.links.map((item) => [item.path, item]));
    const directories = new Set<string>();
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
        const absolute = join(directory, name),
          stat = lstatSync(absolute);
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
          if (realpathSync(absolute) !== absolute) fail('terminal_bundle_path_alias');
          walk(absolute, path);
        } else if (stat.isFile()) {
          const file = expected.get(path);
          if (
            !file ||
            stat.nlink !== 1 ||
            stat.size !== file.size ||
            (process.platform !== 'win32' && (stat.mode & 0o777) !== file.mode) ||
            realpathSync(absolute) !== absolute ||
            fileHash(absolute, stat.size) !== file.sha256
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
    if (
      actual.size !== expected.size + links.size ||
      [...expected.keys(), ...links.keys()].some((path) => !actual.has(path))
    )
      fail('terminal_bundle_identity_mismatch');
    const engineRoot = join(root, terminalSqliteEngineRoot);
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
      engine.sqlite.version !== manifest.sqlite.version ||
      engine.sqlite.sourceId !== manifest.sqlite.sourceId ||
      ('linkage' in engine && engine.linkage === 'builtin' ? 'builtin' : 'dynamic') !==
        manifest.sqlite.linkage
    )
      fail('terminal_sqlite_engine_mismatch');
    windowsFiles?.verify();
    if (removal) {
      const { assertWindowsInstallationRemoval } =
        require('@kite-ai/agent/artifact-access') as typeof import('@kite-ai/agent/artifact-access');
      assertWindowsInstallationRemoval(removal, root);
    }
    return Object.freeze({ root, manifest, digest: digest(bytes) });
  } catch (error) {
    if (error instanceof TerminalRuntimeAssetError) throw error;
    return fail('terminal_bundle_unavailable');
  } finally {
    windowsFiles?.release();
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
): string {
  const selected = parseTerminalRuntimeProtection(proof);
  const bundle = verifyTerminalRuntimeBundle(selected.root);
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
