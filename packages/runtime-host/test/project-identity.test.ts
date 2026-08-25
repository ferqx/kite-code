import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectIdentity } from '../src/project-identity';

function windowsShortPath(path: string): string {
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], {
    encoding: 'utf8',
  }).trim();
}

describe('Workspace project identity', () => {
  test('is deterministic across canonical path aliases without persistent authority state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-project-identity-'));
    try {
      const workspace = join(root, 'workspace');
      const alias = join(root, 'alias');
      await mkdir(workspace);
      await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const first = resolveProjectIdentity(workspace);
      const second = resolveProjectIdentity(alias);
      expect(second).toEqual(first);
      expect(first.projectId).toBe(`project_${first.workspaceDigest.slice('sha256:'.length)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'keeps one native canonical identity across Windows path spellings',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'kite-project-identity-canonical-'));
      try {
        const workspace = join(root, 'WorkspaceWithANameLongerThanEight');
        await mkdir(workspace);
        const slashPath = workspace.replaceAll('\\', '/');
        const driveCasePath = `${workspace.slice(0, 1).toLowerCase()}${workspace.slice(1)}`;
        const shortPath = windowsShortPath(workspace);
        expect(shortPath).not.toBe('');

        const identities = [workspace, slashPath, driveCasePath, shortPath].map((path) =>
          resolveProjectIdentity(path),
        );

        for (const identity of identities) {
          expect(identity).toEqual(identities[0]!);
          expect(identity.projectId).toBe(
            `project_${identity.workspaceDigest.slice('sha256:'.length)}`,
          );
        }
        expect(new Set(identities.map((identity) => identity.workspaceDigest)).size).toBe(1);
        expect(new Set(identities.map((identity) => identity.projectId)).size).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
