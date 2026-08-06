import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../../release/canonical-json';

/**
 * This is a strict, no-secret health/freshness *precondition* for the future
 * persistent scratch supervisor. It does not install, start, or emulate that
 * supervisor. Its absence is deliberately zero-network blocked.
 */
export const LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1 = 'live-scratch-supervisor-v1';
export const LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1 = 'health.v1.json';
export const LIVE_SCRATCH_SUPERVISOR_MAX_FRESHNESS_SECONDS_V1 = 60;
/** A health witness is deliberately bounded before it is parsed. */
export const LIVE_SCRATCH_SUPERVISOR_HEALTH_MAX_BYTES_V1 = 4_096;

/**
 * There is no separately authorized persistent scratch supervisor in this
 * repository yet. This source-literal gate intentionally stays false: a
 * writable ledger-root record may validate a future wire shape, but can never
 * activate real L3 work on its own.
 */
const LIVE_SCRATCH_SUPERVISOR_ACTIVATION_IMPLEMENTED_V1 = false as const;

export function liveScratchSupervisorActivationIsImplementedV1(): false {
  return LIVE_SCRATCH_SUPERVISOR_ACTIVATION_IMPLEMENTED_V1;
}

const HEALTH_SCHEMA_V1 = 'LiveScratchSupervisorHealthV1';
const HEALTH_SUPERVISOR_ID_V1 = 'qualification-live-scratch-supervisor-v1';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export type LiveScratchSupervisorTrustedParentV1 = 'darwin_private_tmp' | 'linux_var_tmp';

export interface LiveScratchSupervisorHealthMaterialV1 {
  readonly schema: typeof HEALTH_SCHEMA_V1;
  readonly version: 1;
  readonly supervisorId: typeof HEALTH_SUPERVISOR_ID_V1;
  readonly trustedScratchParent: LiveScratchSupervisorTrustedParentV1;
  readonly state: 'healthy';
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LiveScratchSupervisorHealthV1 extends LiveScratchSupervisorHealthMaterialV1 {
  readonly recordDigest: `sha256:${string}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function platformTrustedParentV1(): LiveScratchSupervisorTrustedParentV1 | undefined {
  if (process.platform === 'darwin') return 'darwin_private_tmp';
  if (process.platform === 'linux') return 'linux_var_tmp';
  return undefined;
}

function isOwnerOnly(stat: Stats, kind: 'directory' | 'file'): boolean {
  const uid = process.getuid?.();
  return (
    typeof uid === 'number' &&
    stat.uid === uid &&
    !stat.isSymbolicLink() &&
    (kind === 'directory' ? stat.isDirectory() : stat.isFile()) &&
    (stat.mode & 0o077) === 0 &&
    (kind === 'directory'
      ? (stat.mode & 0o777) === OWNER_ONLY_DIRECTORY_MODE
      : (stat.mode & 0o777) === OWNER_ONLY_FILE_MODE && stat.nlink === 1)
  );
}

export function computeLiveScratchSupervisorHealthDigestV1(
  material: LiveScratchSupervisorHealthMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-scratch-supervisor-health.v1',
    canonicalJsonBytes(material),
  );
}

export function buildLiveScratchSupervisorHealthV1(
  material: LiveScratchSupervisorHealthMaterialV1,
): LiveScratchSupervisorHealthV1 {
  if (!isHealthMaterialV1(material)) throw new Error('live_scratch_supervisor_health_invalid');
  return Object.freeze({
    ...material,
    recordDigest: computeLiveScratchSupervisorHealthDigestV1(material),
  });
}

function isHealthMaterialV1(value: unknown): value is LiveScratchSupervisorHealthMaterialV1 {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'expiresAtMs',
      'observedAtMs',
      'schema',
      'state',
      'supervisorId',
      'trustedScratchParent',
      'version',
    ])
  ) {
    return false;
  }
  const observedAtMs = value.observedAtMs;
  const expiresAtMs = value.expiresAtMs;
  if (typeof observedAtMs !== 'number' || typeof expiresAtMs !== 'number') return false;
  if (
    value.schema !== HEALTH_SCHEMA_V1 ||
    value.version !== 1 ||
    value.supervisorId !== HEALTH_SUPERVISOR_ID_V1 ||
    value.state !== 'healthy' ||
    (value.trustedScratchParent !== 'darwin_private_tmp' &&
      value.trustedScratchParent !== 'linux_var_tmp') ||
    !Number.isSafeInteger(observedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    observedAtMs < 0 ||
    expiresAtMs <= observedAtMs ||
    expiresAtMs - observedAtMs > LIVE_SCRATCH_SUPERVISOR_MAX_FRESHNESS_SECONDS_V1 * 1_000
  ) {
    return false;
  }
  return true;
}

function parseHealthV1(value: unknown): LiveScratchSupervisorHealthV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (
    !hasExactKeys(value, [
      'expiresAtMs',
      'observedAtMs',
      'recordDigest',
      'schema',
      'state',
      'supervisorId',
      'trustedScratchParent',
      'version',
    ])
  ) {
    return undefined;
  }
  const { recordDigest, ...material } = value;
  if (
    !isHealthMaterialV1(material) ||
    typeof recordDigest !== 'string' ||
    !DIGEST.test(recordDigest)
  ) {
    return undefined;
  }
  const expected = computeLiveScratchSupervisorHealthDigestV1(material);
  return recordDigest === expected
    ? (value as unknown as LiveScratchSupervisorHealthV1)
    : undefined;
}

/**
 * Validate a fixed owner-only health record under the already-authorized
 * ledger root. No caller supplies a child path, command, endpoint, lease, or
 * supervisor payload. False deliberately carries no filesystem detail.
 */
export function hasFreshLiveScratchSupervisorHealthV1(input: {
  readonly ledgerRoot: string | undefined;
  readonly nowMs?: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.ledgerRoot || !isAbsolute(input.ledgerRoot) || !Number.isSafeInteger(nowMs))
    return false;
  const expectedParent = platformTrustedParentV1();
  if (!expectedParent) return false;
  try {
    const root = lstatSync(input.ledgerRoot);
    if (!isOwnerOnly(root, 'directory')) return false;
    const directory = join(input.ledgerRoot, LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1);
    const directoryStat = lstatSync(directory);
    if (!isOwnerOnly(directoryStat, 'directory')) return false;
    const entries = readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1) {
      return false;
    }
    const file = join(directory, LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1);
    const fileStat = lstatSync(file);
    if (
      !isOwnerOnly(fileStat, 'file') ||
      fileStat.size <= 0 ||
      fileStat.size > LIVE_SCRATCH_SUPERVISOR_HEALTH_MAX_BYTES_V1
    ) {
      return false;
    }
    const health = parseHealthV1(parseCanonicalJson(readFileSync(file)));
    return (
      health !== undefined &&
      health.trustedScratchParent === expectedParent &&
      health.observedAtMs <= nowMs &&
      nowMs < health.expiresAtMs
    );
  } catch {
    return false;
  }
}

/** Test helper: keeps fixture generation platform-closed and path-free. */
export function liveScratchSupervisorTrustedParentForCurrentPlatformV1():
  | LiveScratchSupervisorTrustedParentV1
  | undefined {
  return platformTrustedParentV1();
}
