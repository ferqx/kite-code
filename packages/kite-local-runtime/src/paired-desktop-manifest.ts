import { createHash } from 'node:crypto';

export interface PairedDesktopServiceManifest {
  readonly buildId: string;
  readonly environmentKeys: readonly string[];
  readonly executableSha256: string;
  readonly expectedServerVersion: string;
}

/** The exact four-field Desktop service manifest used by the paired Electron host. */
export function parsePairedDesktopServiceManifest(value: unknown): PairedDesktopServiceManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Paired Desktop service manifest is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = ['buildId', 'environmentKeys', 'executableSha256', 'expectedServerVersion'];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError('Paired Desktop service manifest fields are invalid.');
  }
  if (
    typeof record.buildId !== 'string' ||
    record.buildId.length < 1 ||
    record.buildId.length > 1024 ||
    typeof record.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.executableSha256) ||
    typeof record.expectedServerVersion !== 'string' ||
    record.expectedServerVersion.length < 1 ||
    !Array.isArray(record.environmentKeys) ||
    record.environmentKeys.length > 128 ||
    !record.environmentKeys.every(
      (key) =>
        typeof key === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) &&
        !/^KITE_/iu.test(key) &&
        !['HOME', 'USERPROFILE', 'NODE_ENV'].includes(key.toUpperCase()),
    )
  ) {
    throw new TypeError('Paired Desktop service manifest values are invalid.');
  }
  return Object.freeze({
    buildId: record.buildId,
    environmentKeys: Object.freeze([...record.environmentKeys] as string[]),
    executableSha256: record.executableSha256,
    expectedServerVersion: record.expectedServerVersion,
  });
}

/** Fixed-field JSON, independent of source-file whitespace and property order. */
export function pairedDesktopManifestDigest(value: unknown): string {
  const manifest = parsePairedDesktopServiceManifest(value);
  return createHash('sha256')
    .update(
      JSON.stringify({
        buildId: manifest.buildId,
        environmentKeys: manifest.environmentKeys,
        executableSha256: manifest.executableSha256,
        expectedServerVersion: manifest.expectedServerVersion,
      }),
    )
    .digest('hex');
}
