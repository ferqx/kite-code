import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeHistorySessionTranscript } from '@kite-ai/runtime-contract';
import { HistoryPageSnapshotCache } from '../src/runtime-client/history-page-snapshots';

function transcript(): RuntimeHistorySessionTranscript {
  const records: RuntimeHistorySessionTranscript['records'] = Array.from(
    { length: 1_500 },
    (_, index) => ({
      sequence: index + 1,
      events: [
        {
          type: 'user.message',
          kind: 'task',
          messageId: `message-${index + 1}`,
          text: 'body'.repeat(600),
        },
      ],
    }),
  );
  return {
    session: {
      sessionId: 'snapshot',
      displayName: 'snapshot',
      needsSmartName: false,
      updatedAt: 1,
      lastSequence: 1_500,
    },
    records,
    events: records.flatMap((record) => record.events),
    interactionMode: 'auto',
    recovery: 'normal',
    snapshotDigest: 'a'.repeat(64),
  };
}

test('disk pages reuse stable generations and prove an appended prefix only once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  let fingerprintCalls = 0;
  const fingerprint = () => {
    fingerprintCalls++;
    return 'unchanged-prefix';
  };
  try {
    snapshots.set('key', source, 7, 'unchanged-prefix');
    const files = readdirSync(directory);
    let cursor = 0;
    let total = 0;
    for (;;) {
      const page = snapshots.get('key', source.session, 7, fingerprint, cursor)!;
      expect(page.records[0]?.sequence).toBe(cursor + 1);
      total += page.records.length;
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(total).toBe(1_500);
    expect(fingerprintCalls).toBe(0);
    const renamed = { ...source.session, displayName: 'renamed', updatedAt: 9 };
    const reused = snapshots.get('key', renamed, 8, fingerprint, 1_490)!;
    expect(reused.session).toEqual(renamed);
    expect(reused.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1_491),
    );
    expect(reused.snapshotDigest).toBe(source.snapshotDigest);
    expect(fingerprintCalls).toBe(1);
    expect(snapshots.get('key', renamed, 8, fingerprint, 0)).toBeDefined();
    expect(fingerprintCalls).toBe(1);
    expect(readdirSync(directory)).toEqual(files);
    expect(snapshots.get('key', renamed, 9, () => 'changed-prefix', 0)).toBeUndefined();
    expect(readdirSync(directory)).toHaveLength(0);
  } finally {
    snapshots.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing disposable snapshot can be rebuilt from the journal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  try {
    snapshots.set('key', source, 1, 'prefix');
    rmSync(join(directory, readdirSync(directory)[0]!));
    expect(snapshots.get('key', source.session, 1, () => 'prefix')).toBeUndefined();
    snapshots.set('key', source, 1, 'prefix');
    expect(snapshots.get('key', source.session, 1, () => 'prefix')).toMatchObject({
      type: 'history_session_page',
      snapshotDigest: source.snapshotDigest,
    });
  } finally {
    snapshots.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('valid JSON with changed page content cannot reuse the original snapshot digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  try {
    snapshots.set('key', source, 1, 'prefix');
    const path = join(directory, readdirSync(directory)[0]!);
    const bytes = readFileSync(path);
    bytes[bytes.indexOf('body')] = 'B'.charCodeAt(0);
    writeFileSync(path, bytes);
    expect(snapshots.get('key', source.session, 1, () => 'prefix')).toBeUndefined();
    expect(readdirSync(directory)).toHaveLength(0);
  } finally {
    snapshots.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown generations and unavailable prefix proof never authorize cache reuse', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  try {
    snapshots.set('key', source, undefined, 'prefix');
    expect(readdirSync(directory)).toHaveLength(0);
    snapshots.set('key', source, 1, null);
    expect(readdirSync(directory)).toHaveLength(0);
    snapshots.set('key', source, 1, 'prefix');
    expect(
      snapshots.get('key', source.session, 2, () => {
        throw new Error('proof unavailable');
      }),
    ).toBeUndefined();
    expect(readdirSync(directory)).toHaveLength(0);
  } finally {
    snapshots.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Store append proof avoids hashing even when every continuation has a new generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  const proof = { rewriteGeneration: 0, instanceId: 'a'.repeat(32) };
  let calls = 0;
  const fingerprint = () => {
    calls++;
    return 'never-needed';
  };
  try {
    snapshots.set('key', source, 1, null, proof);
    for (let generation = 2; generation < 12; generation++)
      expect(
        snapshots.get('key', source.session, generation, fingerprint, 1_400, proof),
      ).toBeDefined();
    expect(calls).toBe(0);
    expect(
      snapshots.get('key', source.session, 12, fingerprint, 0, { ...proof, rewriteGeneration: 1 }),
    ).toBeUndefined();
    expect(calls).toBe(1);
  } finally {
    snapshots.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('disposable cache cleanup errors do not replace a valid source cache miss', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const directory = mkdtempSync(join(tmpdir(), 'kite-history-snapshot-test-'));
  const snapshots = new HistoryPageSnapshotCache(directory);
  const source = transcript();
  try {
    snapshots.set('key', source, 1, 'old');
    chmodSync(directory, 0o500);
    expect(snapshots.get('key', source.session, 2, () => 'new')).toBeUndefined();
    expect(() => snapshots.set('key', source, 2, 'new')).not.toThrow();
    expect(() => snapshots.dispose()).not.toThrow();
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});
