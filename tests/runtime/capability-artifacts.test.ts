import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityArtifactError,
  CapabilityArtifactStore,
} from '@/core/persistence/capability-artifacts';

const invocationId = 'a'.repeat(64);
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
    const store = new CapabilityArtifactStore();
    const result = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'sensitive provider output' }],
      structuredContent: { releaseUrl: 'https://example.test/release/1' },
    };

    const ref = store.write(invocationId, result);
    expect(ref.relativePath).toBe(`capability-results/${invocationId}.json`);
    expect(ref.byteLength).toBeGreaterThan(0);
    expect(store.read(ref)).toEqual(result);
  });

  test('rejects oversize results and unsafe invocation IDs', () => {
    const store = new CapabilityArtifactStore(20);
    expect(() =>
      store.write(invocationId, { status: 'success', content: [{ type: 'text', text: 'x' }] }),
    ).toThrow(CapabilityArtifactError);
    expect(() => store.write('../escape', { status: 'success', content: [] })).toThrow(
      CapabilityArtifactError,
    );
  });
});
