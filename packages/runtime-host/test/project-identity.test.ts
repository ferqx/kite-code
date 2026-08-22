import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectIdentityStoreV1 } from '../src/project-identity';

describe('RAV1-01 ProjectIdentityStore', () => {
  test('resolves canonically and verifies a Host-issued handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const store = createProjectIdentityStoreV1({
        path: join(root, 'projects.json'),
        installationId: 'install_test',
      });
      const first = await store.resolveOrCreate('/workspace/a');
      expect(await store.resolveOrCreate('/workspace/a')).toEqual(first);
      const handle = await store.issueHandle({
        workspace: '/workspace/a',
        bootstrapIdentity: 'boot-1',
      });
      expect(await store.verifyHandle({ handle, workspace: '/workspace/a' })).toEqual(first);
      await expect(
        store.verifyHandle({
          handle: { ...handle, project: { ...handle.project, projectId: 'project_attacker' } },
          workspace: '/workspace/a',
        }),
      ).rejects.toThrow('Invalid or stale');
      await expect(store.verifyHandle({ handle, workspace: '/workspace/moved' })).rejects.toThrow(
        'Invalid or stale',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not reuse an identity after a workspace move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const store = createProjectIdentityStoreV1({
        path: join(root, 'projects.json'),
        installationId: 'install_test',
      });
      expect((await store.resolveOrCreate('/workspace/a')).projectId).not.toBe(
        (await store.resolveOrCreate('/workspace/b')).projectId,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serializes a two-process-style race through one store lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const path = join(root, 'projects.json');
      const [left, right] = await Promise.all([
        createProjectIdentityStoreV1({ path, installationId: 'install_test' }).resolveOrCreate(
          '/workspace/race',
        ),
        createProjectIdentityStoreV1({ path, installationId: 'install_test' }).resolveOrCreate(
          '/workspace/race',
        ),
      ]);
      expect(left).toEqual(right);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
