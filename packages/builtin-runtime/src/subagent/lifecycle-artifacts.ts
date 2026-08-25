import type { SubagentHandle, SubagentHandleArtifactRef } from '@kite/runtime-spi';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorage,
} from '../model';
import { subagentLifecycleArtifactRoot } from './artifact-paths';
import type { SubagentGrantVerifier } from './grant-authority';

export class SubagentLifecycleArtifactError extends Error {
  readonly code:
    | 'invalid_handle'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';
  constructor(code: SubagentLifecycleArtifactError['code'], message: string) {
    super(message);
    this.name = 'SubagentLifecycleArtifactError';
    this.code = code;
  }
}

export interface SubagentLifecycleArtifactAccess {
  write(handle: SubagentHandle, verifier: SubagentGrantVerifier): SubagentHandleArtifactRef;
  read(ref: SubagentHandleArtifactRef, verifier: SubagentGrantVerifier): Readonly<SubagentHandle>;
}

/** Provider-owned full handle store; Runtime facts retain only its path-free content ref. */
export class SubagentLifecycleArtifactStore implements SubagentLifecycleArtifactAccess {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_handle'>;

  constructor(options: { readonly root?: string } = {}) {
    try {
      this.#storage = new PrivateImmutableArtifactStorage({
        root: options.root ?? subagentLifecycleArtifactRoot(),
        namespace: 'subagent-lifecycles',
        partitions: [{ kind: 'subagent_handle', directory: 'handles', extension: '.json' }],
        maxArtifactBytes: 64 * 1024,
      });
    } catch (error) {
      throw map(error, 'storage_boundary_violation');
    }
  }

  write(handle: SubagentHandle, verifier: SubagentGrantVerifier): SubagentHandleArtifactRef {
    try {
      const verified = verifier.verifyHandle(handle);
      return this.#storage.write(
        'subagent_handle',
        Buffer.from(canonicalModelJson({ artifactFormatVersion: 1, handle: verified }), 'utf8'),
      );
    } catch (error) {
      throw map(error, 'invalid_handle');
    }
  }

  read(ref: SubagentHandleArtifactRef, verifier: SubagentGrantVerifier): Readonly<SubagentHandle> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (!plain(parsed) || !exact(parsed, ['artifactFormatVersion', 'handle'])) corrupt();
      if (parsed.artifactFormatVersion !== 1 || canonicalModelJson(parsed) !== text) corrupt();
      return verifier.verifyHandle(parsed.handle as SubagentHandle);
    } catch (error) {
      if (error instanceof SubagentLifecycleArtifactError) throw error;
      throw map(error, 'artifact_corrupt');
    }
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function corrupt(): never {
  throw new SubagentLifecycleArtifactError(
    'artifact_corrupt',
    'Subagent lifecycle Artifact is corrupt.',
  );
}
function map(error: unknown, fallback: SubagentLifecycleArtifactError['code']) {
  if (error instanceof SubagentLifecycleArtifactError) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentLifecycleArtifactError(
      code as SubagentLifecycleArtifactError['code'],
      'Subagent lifecycle Artifact operation failed.',
    );
  }
  return new SubagentLifecycleArtifactError(
    fallback,
    'Subagent lifecycle Artifact operation failed.',
  );
}
