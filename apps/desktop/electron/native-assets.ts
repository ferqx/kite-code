import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type NativeRuntimeProtection,
  readNativeRuntimeBundleContent,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import type { SqliteReleaseIdentity } from '@kite-ai/service/sqlite-release-assets';
export interface NativeAssets {
  readonly kind?: 'development';
  readonly serviceEntrypoint: string;
  readonly bunExecutable: string;
  readonly serviceSha256: string;
  readonly bunSha256: string;
  readonly buildId: string;
  readonly apiMajor: number;
  readonly requiredCapabilities: readonly string[];
  readonly profile?: { readonly dataRoot: string; readonly profile: string };
}
export function resolveNativeCandidate(appPath: string): NativeAssets & {
  runtimeProtection: NativeRuntimeProtection;
  candidateRoot: string;
  terminalRoot: string;
  artifactHelper: { path: string; sha256: string };
  sqlite: SqliteReleaseIdentity;
  windowsAsset?: { path: string; sha256: string };
  windowsCandidateFiles?: readonly (readonly [string, string, string])[];
} {
  // Electron's patched fs expands .asar paths. Integrity observes the physical archive,
  // synchronously, and restores the host flag before any application work can run.
  const original = Reflect.get(process, 'noAsar');
  const hadFlag = Object.hasOwn(process, 'noAsar');
  let bundle: ReturnType<typeof verifyNativeRuntimeBundle>;
  let manifestSize: number, terminalManifestSize: number;
  try {
    if (process.versions.electron) Reflect.set(process, 'noAsar', true);
    bundle = (
      process.platform === 'win32' ? readNativeRuntimeBundleContent : verifyNativeRuntimeBundle
    )(dirname(appPath));
    manifestSize = readFileSync(join(bundle.root, 'native-manifest.json')).length;
    terminalManifestSize = readFileSync(
      join(bundle.terminal.root, 'terminal-manifest.json'),
    ).length;
  } finally {
    if (process.versions.electron) {
      if (hadFlag) Reflect.set(process, 'noAsar', original);
      else Reflect.deleteProperty(process, 'noAsar');
    }
  }
  if (join(bundle.root, 'app') !== appPath) throw Error('native_app_identity_mismatch');
  if (
    process.versions.electron &&
    (process.versions.electron !== bundle.manifest.electronVersion ||
      realpathSync(process.execPath) !== join(bundle.root, bundle.manifest.entries.electron))
  )
    throw Error('native_electron_identity_mismatch');
  const terminal = bundle.terminal,
    files = new Map(bundle.manifest.files.map((file) => [file.path, file]));
  const serviceEntrypoint = join(terminal.root, terminal.manifest.entries.service),
    bunExecutable = join(terminal.root, terminal.manifest.entries.runtime);
  const inner = new Map(terminal.manifest.files.map((file) => [file.path, file]));
  return Object.freeze({
    serviceEntrypoint,
    bunExecutable,
    serviceSha256: inner.get(terminal.manifest.entries.service)!.sha256,
    bunSha256: inner.get(terminal.manifest.entries.runtime)!.sha256,
    buildId: `native-${bundle.digest}`,
    apiMajor: 1,
    requiredCapabilities: Object.freeze(['file_recovery']),
    runtimeProtection: Object.freeze({
      kind: 'native.candidate',
      root: bundle.root,
      manifestSha256: bundle.digest,
    }),
    candidateRoot: bundle.root,
    terminalRoot: terminal.root,
    sqlite: bundle.manifest.sqlite,
    artifactHelper: {
      path: join(bundle.root, bundle.manifest.entries.artifactHelper),
      sha256: files.get(bundle.manifest.entries.artifactHelper)!.sha256,
    },
    ...(bundle.manifest.entries.windowsAccess
      ? {
          windowsCandidateFiles: Object.freeze([
            Object.freeze(['native-manifest.json', bundle.digest, String(manifestSize)] as const),
            ...bundle.manifest.files.map((file) =>
              Object.freeze([file.path, file.sha256, String(file.size)] as const),
            ),
            Object.freeze([
              'terminal/terminal-manifest.json',
              terminal.digest,
              String(terminalManifestSize),
            ] as const),
            ...terminal.manifest.files.map((file) =>
              Object.freeze([`terminal/${file.path}`, file.sha256, String(file.size)] as const),
            ),
          ]),
          windowsAsset: {
            path: join(bundle.root, bundle.manifest.entries.windowsAccess),
            sha256: files.get(bundle.manifest.entries.windowsAccess)!.sha256,
          },
        }
      : {}),
  });
}
export function parseNativeAssets(value: unknown): NativeAssets {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_native_assets');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'serviceEntrypoint',
          'bunExecutable',
          'serviceSha256',
          'bunSha256',
          'buildId',
          'apiMajor',
          'requiredCapabilities',
          'profile',
          'kind',
        ].includes(key),
    )
  )
    throw Error('invalid_native_assets');
  if (input.kind !== undefined && input.kind !== 'development')
    throw Error('invalid_native_assets');
  for (const key of ['serviceEntrypoint', 'bunExecutable'])
    if (typeof input[key] !== 'string' || !isAbsolute(input[key] as string))
      throw Error('invalid_native_assets');
  if (!/\.m?js$/.test(input.serviceEntrypoint as string)) throw Error('invalid_native_assets');
  for (const key of ['serviceSha256', 'bunSha256'])
    if (typeof input[key] !== 'string' || !/^[0-9a-f]{64}$/.test(input[key] as string))
      throw Error('invalid_native_assets');
  if (
    typeof input.buildId !== 'string' ||
    !input.buildId.length ||
    input.buildId.length > 256 ||
    input.apiMajor !== 1 ||
    !Array.isArray(input.requiredCapabilities) ||
    input.requiredCapabilities.length > 64 ||
    input.requiredCapabilities.some(
      (value) => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value),
    )
  )
    throw Error('invalid_native_assets');
  if (input.profile !== undefined) {
    const profile = input.profile as Record<string, unknown>;
    if (
      !profile ||
      typeof profile !== 'object' ||
      Array.isArray(profile) ||
      Object.keys(profile).some((key) => !['dataRoot', 'profile'].includes(key)) ||
      typeof profile.dataRoot !== 'string' ||
      !isAbsolute(profile.dataRoot) ||
      typeof profile.profile !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile.profile)
    )
      throw Error('invalid_native_assets');
  }
  return { ...structuredClone(input), kind: 'development' } as unknown as NativeAssets;
}
export function verifyNativeAsset(path: string, expected: string): void {
  let current = path;
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw Error('native_asset_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1048576) throw Error('native_asset_invalid');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(262144);
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
    if (hash.digest('hex') !== expected) throw Error('native_asset_identity_mismatch');
  } finally {
    closeSync(fd);
  }
}
