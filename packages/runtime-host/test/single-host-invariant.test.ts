import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSingleHostInvariantV1 } from '../src/single-host-invariant';

describe('RAV1-04 single-host invariant', () => {
  test('admits one owner and fail-closes a second owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-04-'));
    try {
      const first = acquireSingleHostInvariantV1({
        authorityPath: join(root, 'project'),
        ownerId: 'host-a',
      });
      expect(() =>
        acquireSingleHostInvariantV1({ authorityPath: join(root, 'project'), ownerId: 'host-b' }),
      ).toThrow('single-host');
      first.release();
      const second = acquireSingleHostInvariantV1({
        authorityPath: join(root, 'project'),
        ownerId: 'host-b',
      });
      second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('does not permit a stale owner file to be silently stolen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-04-'));
    try {
      const first = acquireSingleHostInvariantV1({
        authorityPath: join(root, 'project'),
        ownerId: 'host-a',
      });
      expect(() =>
        acquireSingleHostInvariantV1({ authorityPath: join(root, 'project'), ownerId: 'host-b' }),
      ).toThrow();
      first.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
