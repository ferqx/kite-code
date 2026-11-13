import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

declare const __KITE_EMBEDDED_RUNTIME_NATIVE__: { readonly path: string; readonly sha256: string };

type Handle = object;
type Changes = { changes: number; lastInsertRowid: number | bigint };
interface NativeRuntime {
  ffiOpen(path: string): Handle;
  ffiClose(library: Handle): void;
  ffiBind(
    library: Handle,
    symbol: string,
    args: readonly string[],
    returns: string,
  ): CallableFunction;
  ffiPtr(value: ArrayBufferLike | ArrayBufferView): number;
  ffiView(address: number | bigint, offset: number, length: number): ArrayBuffer;
  ffiCString(address: number | bigint, offset: number, maxLength: number): string;
  sqliteSelect(path: string, unqualified?: boolean): boolean;
  sqliteIsSelected(path?: string): boolean;
  sqliteOpen(path: string, flags: number): Handle;
  sqliteClose(database: Handle): void;
  sqlitePrepare(database: Handle, sql: string): Handle;
  sqliteFinalize(statement: Handle): void;
  sqliteExec(database: Handle, sql: string): void;
  sqliteStart(statement: Handle, values: unknown, named: boolean, strict: boolean): void;
  sqliteNext(statement: Handle, safe: boolean, values: boolean, skip: boolean): unknown;
  sqliteReset(statement: Handle): void;
  sqliteChanges(database: Handle): Changes;
  sqliteInTransaction(database: Handle): boolean;
}

let loaded: NativeRuntime | undefined;
let loadedPath: string | undefined;
export function runtimeNativeAsset(): URL {
  return new URL(
    import.meta.url.endsWith('.ts') ? '../dist/runtime-native.node' : './runtime-native.node',
    import.meta.url,
  );
}
function load(path: string): NativeRuntime {
  const module = { exports: {} };
  process.dlopen(module, path);
  loaded = module.exports as NativeRuntime;
  loadedPath = path;
  return loaded;
}

/** Standalone verified bootstrap only. Its native parent retains the exact Windows file. */
export function initializePinnedNativeRuntime(path: string, expectedDigest: string): void {
  const stat = lstatSync(path);
  if (
    !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
    realpathSync.native(path) !== path ||
    createHash('sha256').update(readFileSync(path)).digest('hex') !== expectedDigest
  )
    throw Error('native_node_runtime_asset_changed');
  if (loadedPath !== undefined && loadedPath !== path)
    throw Error('native_node_runtime_selection_changed');
  if (!loaded) load(path);
}

export function nativeRuntime(): NativeRuntime {
  if (loaded) return loaded;
  if (typeof __KITE_EMBEDDED_RUNTIME_NATIVE__ !== 'undefined') {
    const { path, sha256 } = __KITE_EMBEDDED_RUNTIME_NATIVE__;
    initializePinnedNativeRuntime(fileURLToPath(new URL(path, import.meta.url)), sha256);
    return loaded!;
  }
  return load(fileURLToPath(runtimeNativeAsset()));
}
