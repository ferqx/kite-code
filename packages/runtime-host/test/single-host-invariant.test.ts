import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  test('reclaims an exact dead PID lease without weakening a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-04-'));
    try {
      const authorityPath = join(root, 'project');
      const lockPath = `${authorityPath}.kite-host.lock`;
      const exited = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const deadPid = exited.pid;
      await exited.exited;
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, 'owner'),
        `${JSON.stringify({
          schema: 'kite.runtime-single-host-owner.v2',
          ownerId: 'dead-host',
          pid: deadPid,
        })}\n`,
      );
      const lease = acquireSingleHostInvariantV1({ authorityPath, ownerId: 'host-b' });
      expect(JSON.parse(await readFile(join(lockPath, 'owner'), 'utf8'))).toMatchObject({
        ownerId: 'host-b',
        pid: process.pid,
      });
      lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not steal legacy, malformed, or unverifiable owner evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-04-'));
    try {
      const authorityPath = join(root, 'project');
      const lockPath = `${authorityPath}.kite-host.lock`;
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner'), 'host-without-process-identity\n');
      expect(() => acquireSingleHostInvariantV1({ authorityPath, ownerId: 'host-b' })).toThrow(
        'single-host',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
