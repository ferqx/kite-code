import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DynamicSqliteEngineManifest {
  readonly version: 1;
  readonly driver: 'bun:sqlite';
  readonly target: { readonly platform: string; readonly arch: string };
  readonly library: 'libsqlite3.dylib' | 'libsqlite3.so' | 'sqlite3.dll';
  readonly size: number;
  readonly sha256: string;
  readonly sqlite: { readonly version: string; readonly sourceId: string };
}
export interface BuiltinSqliteEngineManifest {
  readonly version: 1;
  readonly driver: 'bun:sqlite';
  readonly target: { readonly platform: string; readonly arch: string };
  readonly linkage: 'builtin';
  readonly sqlite: { readonly version: string; readonly sourceId: string };
}
export type SqliteEngineManifest = DynamicSqliteEngineManifest | BuiltinSqliteEngineManifest;
export interface SqliteEngineSelection {
  readonly root: string;
  readonly manifestSha256: string;
}
export interface VerifiedSqliteEngine {
  readonly root: string;
  readonly manifestSha256: string;
  readonly manifest: SqliteEngineManifest;
}
export interface SqliteEngineObservation {
  readonly qualification: 'selected';
  readonly linkage: 'dynamic' | 'builtin';
  readonly selection: SqliteEngineSelection;
  readonly version: string;
  readonly sourceId: string;
}
export class SqliteEngineError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SqliteEngineError';
    this.code = code;
  }
}
function fail(code: string): never {
  throw new SqliteEngineError(code);
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
export function parseSqliteEngineManifest(value: unknown): SqliteEngineManifest {
  if (closed(value, ['version', 'driver', 'target', 'linkage', 'sqlite'])) {
    if (
      value.version !== 1 ||
      value.driver !== 'bun:sqlite' ||
      value.linkage !== 'builtin' ||
      !closed(value.target, ['platform', 'arch']) ||
      typeof value.target.platform !== 'string' ||
      typeof value.target.arch !== 'string' ||
      !/^[a-z0-9_-]{1,32}$/.test(value.target.platform) ||
      !/^[a-z0-9_-]{1,32}$/.test(value.target.arch) ||
      !closed(value.sqlite, ['version', 'sourceId']) ||
      typeof value.sqlite.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(value.sqlite.version) ||
      typeof value.sqlite.sourceId !== 'string' ||
      value.sqlite.sourceId.length < 1 ||
      value.sqlite.sourceId.length > 256 ||
      /[^\x20-\x7e]/.test(value.sqlite.sourceId)
    )
      fail('sqlite_engine_manifest_invalid');
    return Object.freeze({
      version: 1,
      driver: 'bun:sqlite',
      linkage: 'builtin',
      target: Object.freeze({ platform: value.target.platform, arch: value.target.arch }),
      sqlite: Object.freeze({ version: value.sqlite.version, sourceId: value.sqlite.sourceId }),
    });
  }
  if (
    !closed(value, ['version', 'driver', 'target', 'library', 'size', 'sha256', 'sqlite']) ||
    value.version !== 1 ||
    value.driver !== 'bun:sqlite' ||
    !closed(value.target, ['platform', 'arch']) ||
    typeof value.target.platform !== 'string' ||
    typeof value.target.arch !== 'string' ||
    !/^[a-z0-9_-]{1,32}$/.test(value.target.platform) ||
    !/^[a-z0-9_-]{1,32}$/.test(value.target.arch) ||
    !['libsqlite3.dylib', 'libsqlite3.so', 'sqlite3.dll'].includes(String(value.library)) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 64 * 1024 * 1024 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !closed(value.sqlite, ['version', 'sourceId']) ||
    typeof value.sqlite.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.sqlite.version) ||
    typeof value.sqlite.sourceId !== 'string' ||
    value.sqlite.sourceId.length < 1 ||
    value.sqlite.sourceId.length > 256 ||
    /[^\x20-\x7e]/.test(value.sqlite.sourceId)
  )
    fail('sqlite_engine_manifest_invalid');
  const library = value.library;
  if (library !== 'libsqlite3.dylib' && library !== 'libsqlite3.so' && library !== 'sqlite3.dll')
    fail('sqlite_engine_manifest_invalid');
  return Object.freeze({
    version: 1,
    driver: 'bun:sqlite',
    target: Object.freeze({ platform: value.target.platform, arch: value.target.arch }),
    library,
    size: value.size,
    sha256: value.sha256,
    sqlite: Object.freeze({ version: value.sqlite.version, sourceId: value.sqlite.sourceId }),
  });
}
function owned(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    fail('sqlite_engine_asset_invalid');
  return stat;
}
/** Host-selected integrity metadata; never a JSONC/Model engine choice or publisher signature. */
export function verifySqliteEngineAsset(selection: SqliteEngineSelection): VerifiedSqliteEngine {
  if (
    !closed(selection, ['root', 'manifestSha256']) ||
    typeof selection.root !== 'string' ||
    !isAbsolute(selection.root) ||
    typeof selection.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(selection.manifestSha256)
  )
    fail('sqlite_engine_selection_invalid');
  try {
    owned(selection.root, true);
    const root = realpathSync.native(selection.root),
      manifestPath = join(root, 'engine-manifest.json');
    const manifestStat = owned(manifestPath, false);
    if (manifestStat.size > 1024 * 1024) fail('sqlite_engine_manifest_invalid');
    const bytes = readFileSync(manifestPath);
    if (digest(bytes) !== selection.manifestSha256) fail('sqlite_engine_manifest_changed');
    const manifest = parseSqliteEngineManifest(JSON.parse(bytes.toString('utf8')));
    if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch)
      fail('sqlite_engine_target_mismatch');
    if ('library' in manifest) {
      const expectedLibrary =
        process.platform === 'darwin'
          ? 'libsqlite3.dylib'
          : process.platform === 'linux'
            ? 'libsqlite3.so'
            : process.platform === 'win32'
              ? 'sqlite3.dll'
              : null;
      if (manifest.library !== expectedLibrary) fail('sqlite_engine_target_mismatch');
      const library = join(root, manifest.library),
        stat = owned(library, false);
      if (stat.size !== manifest.size || digest(readFileSync(library)) !== manifest.sha256)
        fail('sqlite_engine_asset_changed');
    }
    return Object.freeze({ root, manifestSha256: selection.manifestSha256, manifest });
  } catch (error) {
    if (error instanceof SqliteEngineError) throw error;
    fail('sqlite_engine_asset_unavailable');
  }
}
const require = createRequire(import.meta.url);
function sqlite(): typeof import('bun:sqlite') {
  try {
    return require('bun:sqlite');
  } catch {
    fail('sqlite_engine_runtime_unsupported');
  }
}
let loaded: SqliteEngineObservation | null = null;
let initializationFailed = false;
function measure(verified: VerifiedSqliteEngine): SqliteEngineObservation {
  const { Database } = sqlite();
  const db = new Database(':memory:');
  try {
    const row = db
      .query<{ version: string; sourceId: string }, []>(
        'SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId',
      )
      .get();
    if (
      !row ||
      row.version !== verified.manifest.sqlite.version ||
      row.sourceId !== verified.manifest.sqlite.sourceId
    )
      fail('sqlite_engine_identity_mismatch');
    return Object.freeze({
      qualification: 'selected',
      linkage: 'library' in verified.manifest ? 'dynamic' : 'builtin',
      selection: Object.freeze({ root: verified.root, manifestSha256: verified.manifestSha256 }),
      version: row.version,
      sourceId: row.sourceId,
    });
  } finally {
    db.close(true);
  }
}
function same(left: SqliteEngineSelection, right: SqliteEngineSelection) {
  return left.root === right.root && left.manifestSha256 === right.manifestSha256;
}
/** Call once in the parent before any DB/Worker. Bun's native SQLite selection is process-wide. */
export function initializeSqliteEngine(selection: SqliteEngineSelection): SqliteEngineObservation {
  const verified = verifySqliteEngineAsset(selection),
    canonical = { root: verified.root, manifestSha256: verified.manifestSha256 };
  if (loaded) {
    if (!same(loaded.selection, canonical)) fail('sqlite_engine_selection_changed');
    return loaded;
  }
  if (initializationFailed) fail('sqlite_engine_initialization_failed');
  initializationFailed = true;
  try {
    if ('library' in verified.manifest) {
      if (process.platform !== 'darwin') fail('sqlite_engine_platform_unsupported');
      if (!sqlite().Database.setCustomSQLite(join(verified.root, verified.manifest.library)))
        fail('sqlite_engine_load_failed');
    }
    loaded = measure(verified);
    verifySqliteEngineAsset(canonical);
    initializationFailed = false;
    return loaded;
  } catch (error) {
    loaded = null;
    if (error instanceof SqliteEngineError) throw error;
    fail('sqlite_engine_initialization_failed');
  }
}
/** Worker verifies the parent's exact asset and measures the existing shared native engine; no setter/retry. */
export function assertSelectedSqliteEngine(
  selection: SqliteEngineSelection,
): SqliteEngineObservation {
  const verified = verifySqliteEngineAsset(selection);
  if ('library' in verified.manifest && process.platform !== 'darwin')
    fail('sqlite_engine_platform_unsupported');
  return measure(verified);
}
/** Pure in-memory observation. null means unqualified, never evidence of a patched built-in engine. */
export function getLoadedSqliteEngine(): SqliteEngineObservation | null {
  return loaded;
}

export type DefaultSqliteEngineObservation =
  | SqliteEngineObservation
  | { readonly qualification: 'unqualified'; readonly reason: 'development_no_selection' };
export function defaultSqliteEngineAssets() {
  const root = new URL('./storage/engine/', import.meta.url);
  return Object.freeze({
    root,
    selection: new URL('engine-selection.json', root),
    manifest: new URL('engine-manifest.json', root),
  });
}
/** Package host entry, before profile access or any raw Database. Absence is development-only. */
export function initializeDefaultSqliteEngine(): DefaultSqliteEngineObservation {
  if (initializationFailed) fail('sqlite_engine_initialization_failed');
  const assets = defaultSqliteEngineAssets();
  let absent = false;
  try {
    lstatSync(assets.root);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      absent = true;
    else fail('sqlite_engine_asset_unavailable');
  }
  if (absent) {
    if (loaded) return initializeSqliteEngine(loaded.selection);
    return Object.freeze({ qualification: 'unqualified', reason: 'development_no_selection' });
  }
  try {
    const path = fileURLToPath(assets.selection);
    const stat = owned(path, false);
    if (stat.size > 4096) fail('sqlite_engine_selection_invalid');
    const selection: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !closed(selection, ['version', 'manifestSha256']) ||
      selection.version !== 1 ||
      typeof selection.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(selection.manifestSha256)
    )
      fail('sqlite_engine_selection_invalid');
    return initializeSqliteEngine({
      root: fileURLToPath(assets.root),
      manifestSha256: selection.manifestSha256,
    });
  } catch (error) {
    if (error instanceof SqliteEngineError) throw error;
    fail('sqlite_engine_asset_unavailable');
  }
}
