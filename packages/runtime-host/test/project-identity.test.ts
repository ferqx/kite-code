import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectIdentity } from '../src/project-identity';

describe('Workspace project identity', () => {
  test('is deterministic across canonical path aliases without persistent authority state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-project-identity-'));
    try {
      const workspace = join(root, 'workspace');
      const alias = join(root, 'alias');
      await mkdir(workspace);
      await symlink(workspace, alias);
      const first = resolveProjectIdentity(workspace);
      const second = resolveProjectIdentity(alias);
      expect(second).toEqual(first);
      expect(first.projectId).toBe(`project_${first.workspaceDigest.slice('sha256:'.length)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
