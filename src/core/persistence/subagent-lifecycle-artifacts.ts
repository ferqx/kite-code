import { subagentLifecycleArtifactRoot } from '@/core/config/paths';
import {
  allPrivateArtifactEvidenceRootsV1,
  loadOrCreateModelArtifactIntegrityKeyV1,
} from '@/core/model/model-artifact-key';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import {
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorageV1,
} from '@/core/persistence/private-immutable-artifacts';
import type { SubagentGrantVerifierV1 } from '@/core/subagent/grant-authority';
import type { SubagentHandleArtifactRefV1, SubagentHandleV1 } from '@/protocol/subagent-provider';

export class SubagentLifecycleArtifactErrorV1 extends Error {
  readonly code:
    | 'invalid_handle'
    | 'key_unavailable'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';
  constructor(code: SubagentLifecycleArtifactErrorV1['code'], message: string) {
    super(message);
    this.name = 'SubagentLifecycleArtifactErrorV1';
    this.code = code;
  }
}

export interface SubagentLifecycleArtifactAccessV1 {
  write(handle: SubagentHandleV1, verifier: SubagentGrantVerifierV1): SubagentHandleArtifactRefV1;
  read(
    ref: SubagentHandleArtifactRefV1,
    verifier: SubagentGrantVerifierV1,
  ): Readonly<SubagentHandleV1>;
}

/** Provider-owned full handle store; Runtime facts retain only its opaque keyed ref. */
export class SubagentLifecycleArtifactStoreV1 implements SubagentLifecycleArtifactAccessV1 {
  readonly #storage: PrivateImmutableArtifactStorageV1<'subagent_handle'>;

  constructor(options: { readonly integrityKey?: Uint8Array; readonly root?: string } = {}) {
    let integrityKey: Uint8Array;
    try {
      integrityKey =
        options.integrityKey ??
        loadOrCreateModelArtifactIntegrityKeyV1({
          additionalArtifactRoots: allPrivateArtifactEvidenceRootsV1(),
        });
    } catch {
      throw new SubagentLifecycleArtifactErrorV1(
        'key_unavailable',
        'Subagent lifecycle Artifact integrity key is unavailable.',
      );
    }
    try {
      this.#storage = new PrivateImmutableArtifactStorageV1({
        root: options.root ?? subagentLifecycleArtifactRoot(),
        namespace: 'subagent-lifecycles',
        integrityKey,
        partitions: [{ kind: 'subagent_handle', directory: 'handles', extension: '.json' }],
        maxArtifactBytes: 64 * 1024,
      });
    } catch (error) {
      throw map(error, 'storage_boundary_violation');
    }
  }

  write(handle: SubagentHandleV1, verifier: SubagentGrantVerifierV1): SubagentHandleArtifactRefV1 {
    try {
      const verified = verifier.verifyHandle(handle);
      return this.#storage.write(
        'subagent_handle',
        Buffer.from(canonicalModelJsonV1({ artifactFormatVersion: 1, handle: verified }), 'utf8'),
      );
    } catch (error) {
      throw map(error, 'invalid_handle');
    }
  }

  read(
    ref: SubagentHandleArtifactRefV1,
    verifier: SubagentGrantVerifierV1,
  ): Readonly<SubagentHandleV1> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (!plain(parsed) || !exact(parsed, ['artifactFormatVersion', 'handle'])) corrupt();
      if (parsed.artifactFormatVersion !== 1 || canonicalModelJsonV1(parsed) !== text) corrupt();
      return verifier.verifyHandle(parsed.handle as SubagentHandleV1);
    } catch (error) {
      if (error instanceof SubagentLifecycleArtifactErrorV1) throw error;
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
  throw new SubagentLifecycleArtifactErrorV1(
    'artifact_corrupt',
    'Subagent lifecycle Artifact is corrupt.',
  );
}
function map(error: unknown, fallback: SubagentLifecycleArtifactErrorV1['code']) {
  if (error instanceof SubagentLifecycleArtifactErrorV1) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentLifecycleArtifactErrorV1(
      code as SubagentLifecycleArtifactErrorV1['code'],
      'Subagent lifecycle Artifact operation failed.',
    );
  }
  return new SubagentLifecycleArtifactErrorV1(
    fallback,
    'Subagent lifecycle Artifact operation failed.',
  );
}
