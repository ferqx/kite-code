import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityArtifactStore } from '../src/capability-artifacts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'kite-capability-artifact-size-'));
  roots.push(path);
  return join(path, 'capability-artifacts');
}

describe('Capability Artifact size', () => {
  test('persists and verifies a result above the former default 16 MiB ceiling', () => {
    const store = new CapabilityArtifactStore({ root: root() });
    const result = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) }],
    };
    const ref = store.write('large-invocation', result);
    expect(ref.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(store.read(ref)).toEqual(result);
  });

  test('accepts a result beyond a legacy explicit storage size limit', () => {
    const store = new CapabilityArtifactStore({ root: root(), maxArtifactBytes: 64 });
    const result = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'x'.repeat(128) }],
    };
    const ref = store.write('limited-invocation', result);
    expect(ref.byteLength).toBeGreaterThan(64);
    expect(store.read(ref)).toEqual(result);
  });
});
