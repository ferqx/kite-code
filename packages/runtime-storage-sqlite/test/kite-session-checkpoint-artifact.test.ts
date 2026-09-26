import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteHomeArtifactStore, KiteHomeArtifactError } from '../src/kite-home-artifacts';
import { openKiteSessionStoreDatabase } from '../src/kite-session-runtime-file';

describe('Store11 private subagent checkpoint Artifact', () => {
  test('persists across reopen, accepts exact retry, and rejects conflicting bytes', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-checkpoint-')));
    const path = join(root, 'kite-session.sqlite');
    const ref = {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: `sha256:${createHash('sha256').update('{"artifactFormatVersion":1,"messages":[]}').digest('hex')}`,
      byteLength: Buffer.byteLength('{"artifactFormatVersion":1,"messages":[]}'),
    };
    const input = {
      ref,
      artifactFormatVersion: 1,
      canonicalJson: '{"artifactFormatVersion":1,"messages":[]}',
      createdAt: 5,
    };
    try {
      const first = openKiteSessionStoreDatabase(path);
      try {
        const store = createKiteHomeArtifactStore(first);
        store.writeSubagentCheckpoint(input);
        store.writeSubagentCheckpoint(input);
      } finally {
        first.close(false);
      }
      const reopened = openKiteSessionStoreDatabase(path);
      try {
        const store = createKiteHomeArtifactStore(reopened);
        expect(store.readSubagentCheckpoint(ref)).toEqual({
          artifactFormatVersion: 1,
          canonicalJson: input.canonicalJson,
        });
        expect(() =>
          store.writeSubagentCheckpoint({
            ...input,
            canonicalJson: '{"artifactFormatVersion":1,"messages":[1]}',
          }),
        ).toThrow(KiteHomeArtifactError);
      } finally {
        reopened.close(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
