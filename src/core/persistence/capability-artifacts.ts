import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import type { CapabilityResult } from '@/core/capabilities/result';
import {
  capabilityArtifactPath,
  capabilityArtifactRoot,
  userKiteCodeDir,
} from '@/core/config/paths';
import type { CapabilityArtifactRef } from '@/protocol/capabilities';

const SAFE_INVOCATION_ID = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 1_000_000;

export class CapabilityArtifactError extends Error {
  readonly code:
    | 'invalid_reference'
    | 'artifact_missing'
    | 'artifact_conflict'
    | 'artifact_too_large';

  constructor(
    message: string,
    code: 'invalid_reference' | 'artifact_missing' | 'artifact_conflict' | 'artifact_too_large',
  ) {
    super(message);
    this.name = 'CapabilityArtifactError';
    this.code = code;
  }
}

/** Immutable result store. Runtime events retain its reference/digest, never raw content. */
export class CapabilityArtifactStore {
  private readonly maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  write(invocationId: string, result: CapabilityResult): CapabilityArtifactRef {
    assertInvocationId(invocationId);
    const payload = JSON.stringify({ artifactFormatVersion: 1, invocationId, result });
    const byteLength = Buffer.byteLength(payload, 'utf8');
    if (byteLength > this.maxBytes) {
      throw new CapabilityArtifactError(
        `Capability result exceeds the ${this.maxBytes} byte artifact limit.`,
        'artifact_too_large',
      );
    }
    const digest = digestCapability(payload);
    const target = capabilityArtifactPath(invocationId);
    assertInsideRoot(target);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8');
      if (digestCapability(existing) !== digest) {
        throw new CapabilityArtifactError(
          `Capability Artifact ${invocationId} already exists with a different digest.`,
          'artifact_conflict',
        );
      }
      return makeRef(invocationId, target, existing);
    }
    const temporary = join(
      dirname(target),
      `.${invocationId}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return makeRef(invocationId, target, payload);
  }

  read(ref: CapabilityArtifactRef): CapabilityResult {
    assertInvocationId(ref.artifactId);
    const target = capabilityArtifactPath(ref.artifactId);
    assertInsideRoot(target);
    if (!existsSync(target)) {
      throw new CapabilityArtifactError(
        `Capability Artifact ${ref.artifactId} does not exist.`,
        'artifact_missing',
      );
    }
    const payload = readFileSync(target, 'utf8');
    if (digestCapability(payload) !== ref.digest || statSync(target).size !== ref.byteLength) {
      throw new CapabilityArtifactError(
        `Capability Artifact ${ref.artifactId} digest mismatch.`,
        'artifact_conflict',
      );
    }
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || !('result' in parsed)) {
      throw new CapabilityArtifactError(
        `Capability Artifact ${ref.artifactId} is invalid.`,
        'artifact_conflict',
      );
    }
    return (parsed as { result: CapabilityResult }).result;
  }
}

function makeRef(invocationId: string, target: string, payload: string): CapabilityArtifactRef {
  return {
    artifactId: invocationId,
    relativePath: relative(userKiteCodeDir(), target).replaceAll('\\', '/'),
    byteLength: Buffer.byteLength(payload, 'utf8'),
    digest: digestCapability(payload),
  };
}

function assertInvocationId(invocationId: string): void {
  if (!SAFE_INVOCATION_ID.test(invocationId)) {
    throw new CapabilityArtifactError('Invalid capability invocation ID.', 'invalid_reference');
  }
}

function assertInsideRoot(target: string): void {
  const root = resolve(capabilityArtifactRoot());
  const resolved = resolve(target);
  const path = relative(root, resolved);
  if (path.startsWith('..') || isAbsolute(path)) {
    throw new CapabilityArtifactError(
      'Capability Artifact path escapes the artifact root.',
      'invalid_reference',
    );
  }
}

export const defaultCapabilityArtifactStore = new CapabilityArtifactStore();
