import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJsonBytes, parseCanonicalJson } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const canonicalBase64Schema = z.string().min(1).refine(isCanonicalBase64);
const canonicalTimestampSchema = z.string().refine(isCanonicalTimestamp);

export const rolloutArtifactIdentityV1Schema = z
  .object({
    canonicalRepository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('R_kgDOSKbi8g'),
    commit: commitSchema,
    payloadSha256: digestSchema,
    releaseProfileDigest: digestSchema,
  })
  .strict();

export type RolloutArtifactIdentityV1 = z.infer<typeof rolloutArtifactIdentityV1Schema>;

export const rolloutCacheRecordV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('signed-rollout-cache-v1'),
    artifactIdentity: rolloutArtifactIdentityV1Schema,
    sequence: z.number().int().positive().safe(),
    expiresAt: canonicalTimestampSchema,
    manifestBase64: canonicalBase64Schema,
    signatureBase64: canonicalBase64Schema,
    nonDistributable: z.literal(true),
    realRolloutSigningEnabled: z.literal(false),
  })
  .strict();

export type RolloutCacheRecordV1 = z.infer<typeof rolloutCacheRecordV1Schema>;

export class RolloutCacheError extends Error {
  readonly code: 'cache_invalid' | 'cache_identity_mismatch' | 'cache_io';

  constructor(code: 'cache_invalid' | 'cache_identity_mismatch' | 'cache_io') {
    super(`Signed rollout cache failed closed: ${code}`);
    this.name = 'RolloutCacheError';
    this.code = code;
  }
}

export function createRolloutCacheRecordV1(input: {
  artifactIdentity: RolloutArtifactIdentityV1;
  sequence: number;
  expiresAt: string;
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
}): RolloutCacheRecordV1 {
  return rolloutCacheRecordV1Schema.parse({
    version: 1,
    kind: 'signed-rollout-cache-v1',
    artifactIdentity: input.artifactIdentity,
    sequence: input.sequence,
    expiresAt: input.expiresAt,
    manifestBase64: Buffer.from(input.manifestBytes).toString('base64'),
    signatureBase64: Buffer.from(input.signatureBytes).toString('base64'),
    nonDistributable: true,
    realRolloutSigningEnabled: false,
  });
}

export function decodeIdentityBoundRolloutCacheV1(input: {
  record: unknown;
  expectedIdentity: RolloutArtifactIdentityV1;
}): {
  record: RolloutCacheRecordV1;
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
} {
  const parsed = rolloutCacheRecordV1Schema.safeParse(input.record);
  if (!parsed.success) throw new RolloutCacheError('cache_invalid');
  if (!sameArtifactIdentity(parsed.data.artifactIdentity, input.expectedIdentity)) {
    throw new RolloutCacheError('cache_identity_mismatch');
  }
  return {
    record: parsed.data,
    manifestBytes: new Uint8Array(Buffer.from(parsed.data.manifestBase64, 'base64')),
    signatureBytes: new Uint8Array(Buffer.from(parsed.data.signatureBase64, 'base64')),
  };
}

export function loadRolloutCacheFileV1(path: string): RolloutCacheRecordV1 | undefined {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > 512 * 1024) throw new RolloutCacheError('cache_invalid');
    return rolloutCacheRecordV1Schema.parse(parseCanonicalJson(readFileSync(descriptor)));
  } catch (error) {
    if (error instanceof RolloutCacheError) throw error;
    throw new RolloutCacheError('cache_io');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeRolloutCacheFileV1(path: string, record: RolloutCacheRecordV1): void {
  const parsed = rolloutCacheRecordV1Schema.parse(record);
  const encoded = canonicalJsonBytes(parsed);
  const absolute = resolve(path);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync.native(parent);
  const target = resolve(canonicalParent, basename(absolute));
  if (dirname(target) !== canonicalParent) throw new RolloutCacheError('cache_io');
  if (existsSync(target)) {
    const existing = lstatSync(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new RolloutCacheError('cache_io');
    const current = loadRolloutCacheFileV1(target);
    if (!current || !sameArtifactIdentity(current.artifactIdentity, parsed.artifactIdentity)) {
      throw new RolloutCacheError('cache_identity_mismatch');
    }
    if (parsed.sequence < current.sequence) throw new RolloutCacheError('cache_invalid');
    if (
      parsed.sequence === current.sequence &&
      !Buffer.from(encoded).equals(Buffer.from(canonicalJsonBytes(current)))
    ) {
      throw new RolloutCacheError('cache_invalid');
    }
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, encoded);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (error instanceof RolloutCacheError) throw error;
    throw new RolloutCacheError('cache_io');
  }
}

function sameArtifactIdentity(
  left: RolloutArtifactIdentityV1,
  right: RolloutArtifactIdentityV1,
): boolean {
  return (
    left.canonicalRepository === right.canonicalRepository &&
    left.repositoryId === right.repositoryId &&
    left.commit === right.commit &&
    left.payloadSha256 === right.payloadSha256 &&
    left.releaseProfileDigest === right.releaseProfileDigest
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value;
}
