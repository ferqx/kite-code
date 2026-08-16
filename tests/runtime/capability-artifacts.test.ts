import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import {
  CapabilityArtifactError,
  CapabilityArtifactStore,
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
    expect(
      store.read({
        artifactId: invocationId,
        relativePath: `capability-results/${invocationId}.json`,
        byteLength: Buffer.byteLength(payload, 'utf8'),
        digest: digestCapability(payload),
      }),
    ).toEqual(result);
  });
});
