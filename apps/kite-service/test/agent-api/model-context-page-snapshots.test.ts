import { expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelContextPageSnapshots,
  ModelContextSnapshotCursorError,
} from '../../src/agent-api/model-context-page-snapshots';

test('keeps Model Context page files private and reclaims expired snapshots', () => {
  const snapshots = new ModelContextPageSnapshots();
  const owner = {};
  const otherOwner = {};
  try {
    const first = snapshots.create({
      owner,
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      sequence: 3,
      json: JSON.stringify({ text: '内容'.repeat(60_000) }),
    });
    const directory = readdirSync(tmpdir())
      .filter((name) => name.startsWith('kite-model-context-'))
      .map((name) => join(tmpdir(), name))
      .find((path) => existsSync(join(path, first.snapshotId)));
    expect(directory).toBeDefined();
    const file = join(directory!, first.snapshotId);
    expect(statSync(directory!).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(first.nextCursor).toBeDefined();
    expect(() =>
      snapshots.read(owner, 'session-1', 'different-invocation', first.nextCursor!),
    ).toThrow(ModelContextSnapshotCursorError);
    expect(() =>
      snapshots.read(otherOwner, 'session-1', 'invocation-1', first.nextCursor!),
    ).toThrow(ModelContextSnapshotCursorError);
    expect(
      snapshots.read(owner, 'session-1', 'invocation-1', first.nextCursor!).offset,
    ).toBeGreaterThan(0);
    const second = snapshots.create({
      owner: otherOwner,
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      sequence: 3,
      json: JSON.stringify({ text: `Other owner ${'y'.repeat(100_000)}` }),
    });
    snapshots.dispose(owner);
    expect(existsSync(file)).toBe(false);
    expect(
      snapshots.read(otherOwner, 'session-1', 'invocation-1', second.nextCursor!).offset,
    ).toBeGreaterThan(0);
    snapshots.sweep(Date.now() + 61_000);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(directory!)).toBe(false);
  } finally {
    snapshots.dispose();
  }
});
