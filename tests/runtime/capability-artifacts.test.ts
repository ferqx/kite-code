import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import {
  CapabilityArtifactError,
  CapabilityArtifactStore,
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
  readBoundCapabilityArtifactV1,
} from '@/core/persistence/capability-artifacts';

const invocationId = 'a'.repeat(64);
const integrityKey = Buffer.alloc(32, 7);
const previousHome = process.env.KITE_CODE_HOME;
let tempHome: string | undefined;

afterEach(() => {
  if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('CapabilityArtifactStore', () => {
  test('stores structured result content outside Runtime state and verifies its digest on read', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kite-capability-artifact-'));
    process.env.KITE_CODE_HOME = tempHome;
    const store = new CapabilityArtifactStore({ integrityKey });
    const result = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'sensitive provider output' }],
      structuredContent: { releaseUrl: 'https://example.test/release/1' },
    };

    const ref = store.write(invocationId, result);
    expect(ref.kind).toBe('capability_result');
    expect(ref.artifactId).toMatch(/^pa_[0-9a-f]{64}$/);
    expect(ref.integrityIdentifier).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(ref.byteLength).toBeGreaterThan(0);
    expect(store.read(ref)).toEqual(result);
    expect(store.readEnvelope(ref)).toMatchObject({
      artifactFormatVersion: 2,
      invocationId,
      result,
    });
  });

  test('binds owner, result/evidence digests, and filesystem observation symmetrically', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kite-capability-artifact-binding-'));
    process.env.KITE_CODE_HOME = tempHome;
    const store = new CapabilityArtifactStore({ integrityKey });
    const observation = {
      actorIdentityDigest: 'a'.repeat(64),
      lexicalTargetDigest: `sha256:${'b'.repeat(64)}`,
      canonicalTargetDigest: `sha256:${'c'.repeat(64)}`,
      targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
      contentDigest: `sha256:${'e'.repeat(64)}`,
    };
    const result = {
      status: 'success' as const,
      content: [],
      structuredContent: { filesystemObservation: observation },
    };
    const ref = store.write(invocationId, result);
    const binding = {
      invocationId,
      resultDigest: capabilityResultDigestV1(result),
      evidenceDigest: capabilityResultEvidenceDigestV1(result),
      filesystemObservation: observation,
    };

    expect(readBoundCapabilityArtifactV1(store, ref, binding)).toEqual(result);
    expect(() =>
      readBoundCapabilityArtifactV1(store, ref, { ...binding, invocationId: 'wrong-owner' }),
    ).toThrow('does not match its Runtime receipt');
    expect(() =>
      readBoundCapabilityArtifactV1(store, ref, {
        ...binding,
        resultDigest: 'f'.repeat(64),
      }),
    ).toThrow('does not match its Runtime receipt');
    expect(() =>
      readBoundCapabilityArtifactV1(store, ref, {
        ...binding,
        evidenceDigest: 'f'.repeat(64),
      }),
    ).toThrow('does not match its Runtime receipt');
    expect(() =>
      readBoundCapabilityArtifactV1(store, ref, {
        ...binding,
        filesystemObservation: { ...observation, contentDigest: `sha256:${'f'.repeat(64)}` },
      }),
    ).toThrow('filesystem observation');
    expect(() =>
      readBoundCapabilityArtifactV1(store, ref, {
        invocationId,
        resultDigest: binding.resultDigest,
        evidenceDigest: binding.evidenceDigest,
      }),
    ).toThrow('filesystem observation');
  });

  test('rejects oversize results and unsafe invocation IDs', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kite-capability-artifact-limit-'));
    process.env.KITE_CODE_HOME = tempHome;
    const store = new CapabilityArtifactStore({ integrityKey, maxArtifactBytes: 20 });
    expect(() =>
      store.write(invocationId, { status: 'success', content: [{ type: 'text', text: 'x' }] }),
    ).toThrow(CapabilityArtifactError);
    expect(() => store.write('../escape', { status: 'success', content: [] })).toThrow(
      CapabilityArtifactError,
    );
  });

  test('retains read-only compatibility for the previous current-epoch reference', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kite-capability-artifact-legacy-'));
    process.env.KITE_CODE_HOME = tempHome;
    const result = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'legacy fixture' }],
    };
    const payload = JSON.stringify({ artifactFormatVersion: 1, invocationId, result });
    const directory = join(tempHome, '.kite-code', 'capability-results');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${invocationId}.json`), payload, 'utf8');

    const store = new CapabilityArtifactStore({ integrityKey });
    const ref = {
      artifactId: invocationId,
      relativePath: `capability-results/${invocationId}.json`,
      byteLength: Buffer.byteLength(payload, 'utf8'),
      digest: digestCapability(payload),
    };
    expect(store.read(ref)).toEqual(result);
    expect(store.readEnvelope(ref)).toMatchObject({
      artifactFormatVersion: 1,
      invocationId,
      result,
    });
  });
});
