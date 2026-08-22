import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectIdentityStoreV1 } from '../src/project-identity';

const KEY = new Uint8Array(32).fill(7);
const KEY_ID = `sha256:${'7'.repeat(64)}` as const;

function createStore(path: string, key = KEY, installationId = 'install_test') {
  return createProjectIdentityStoreV1({
    path,
    installationId,
    keyId: KEY_ID,
    authenticatorKey: key,
  });
}

describe('RAV1-01 ProjectIdentityStore', () => {
  test('canonicalizes aliases and verifies only an authenticated Host-issued handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const workspace = join(root, 'workspace');
      const alias = join(root, 'workspace-alias');
      await mkdir(workspace);
      await symlink(workspace, alias);
      const store = createStore(join(root, 'authority', 'projects.json'));
      const first = await store.resolveOrCreate(workspace);
      expect(await store.resolveOrCreate(alias)).toEqual(first);
      const handle = await store.issueHandle({ workspace, bootstrapIdentity: 'boot-1' });
      expect(await store.verifyHandle({ handle, workspace: alias })).toEqual(first);
      await expect(
        store.verifyHandle({
          handle: { ...handle, project: { ...handle.project, projectId: 'project_attacker' } },
          workspace,
        }),
      ).rejects.toThrow('Invalid, expired, revoked, or stale');
      await expect(
        createStore(
          join(root, 'authority', 'projects.json'),
          new Uint8Array(32).fill(8),
        ).verifyHandle({
          handle,
          workspace,
        }),
      ).rejects.toThrow('authenticator mismatch');
      await store.revokeHandle(handle.nonce);
      await expect(store.verifyHandle({ handle, workspace })).rejects.toThrow('revoked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not create authority while verifying an unknown workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const workspace = join(root, 'workspace');
      const unknown = join(root, 'unknown');
      await mkdir(workspace);
      await mkdir(unknown);
      const path = join(root, 'authority', 'projects.json');
      const store = createStore(path);
      const handle = await store.issueHandle({ workspace, bootstrapIdentity: 'boot-1' });
      await expect(store.verifyHandle({ handle, workspace: unknown })).rejects.toThrow(
        'verification cannot create',
      );
      const record = JSON.parse(await readFile(path, 'utf8')) as { projects: object };
      expect(Object.keys(record.projects)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on corruption, unknown fields, installation reset, and stale handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const path = join(root, 'authority', 'projects.json');
      const store = createStore(path);
      const handle = await store.issueHandle({ workspace, bootstrapIdentity: 'boot-1', ttlMs: 10 });
      await expect(
        store.verifyHandle({ handle, workspace, now: new Date(Date.parse(handle.expiresAt) + 1) }),
      ).rejects.toThrow('expired');
      expect(() => createStore(path, KEY, 'install_reset').resolveOrCreateSync(workspace)).toThrow(
        'installation mismatch',
      );
      const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(
        path,
        `${JSON.stringify({ ...record, revokedHandleNonces: ['tampered'] })}\n`,
        { mode: 0o600 },
      );
      await expect(store.resolveOrCreate(workspace)).rejects.toThrow('authenticator mismatch');
      await writeFile(path, `${JSON.stringify({ ...record, unexpected: true })}\n`, {
        mode: 0o600,
      });
      await expect(store.resolveOrCreate(workspace)).rejects.toThrow('invalid shape');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serializes repeated resolution to one identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-'));
    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const path = join(root, 'authority', 'projects.json');
      const left = createStore(path).resolveOrCreateSync(workspace);
      const right = createStore(path).resolveOrCreateSync(workspace);
      expect(left).toEqual(right);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('converges two production processes racing to resolve the same workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kite-rav1-01-process-race-'));
    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const path = join(root, 'authority', 'projects.json');
      const child = join(import.meta.dir, 'fixtures', 'project-identity-child.ts');
      const run = async () => {
        const childProcess = Bun.spawn([process.execPath, child, path, workspace], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(childProcess.stdout).text(),
          new Response(childProcess.stderr).text(),
          childProcess.exited,
        ]);
        if (exitCode !== 0) throw new Error(stderr);
        return JSON.parse(stdout);
      };
      const [left, right] = await Promise.all([run(), run()]);
      expect(left).toEqual(right);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
