import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeMcpCredentialStore } from '@kite-ai/builtin-runtime/mcp';
import { compileOssReleaseExecutable } from '../../scripts/release/oss-candidate';

const nativeSmoke = process.env.KITE_RUN_NATIVE_KEYRING_SMOKE === '1' ? test : test.skip;

nativeSmoke('native MCP keyring write/read/delete smoke', async () => {
  const store = new NativeMcpCredentialStore();
  const nonce = randomBytes(16).toString('hex');
  const key = {
    workspaceKey: `platform-smoke-${nonce}`,
    source: 'user' as const,
    server: 'keyring-smoke',
    profile: 'roundtrip',
  };
  const secret = randomBytes(32).toString('base64url');
  try {
    expect(await store.status()).toBe('available');
    await store.put(key, {
      version: 1,
      kind: 'bearer',
      secret,
      updatedAt: new Date().toISOString(),
    });
    expect(await store.get(key)).toMatchObject({ kind: 'bearer', secret });
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  } finally {
    await store.delete(key);
  }
});

const compiledSmoke =
  process.env.KITE_RUN_NATIVE_KEYRING_SMOKE === '1' && process.platform === 'darwin'
    ? test
    : test.skip;

compiledSmoke(
  'macOS standalone release embeds the native credential store',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compiled-keyring-'));
    const entrypoint = join(root, 'probe.ts');
    const executable = join(root, 'probe');
    writeFileSync(
      entrypoint,
      `import assert from 'node:assert/strict';
import { NativeMcpCredentialStore } from ${JSON.stringify(resolve('packages/builtin-runtime/src/mcp/credential-store.ts'))};
const store = new NativeMcpCredentialStore({ service: 'kite-code.release.qualification' });
const key = { workspaceKey: crypto.randomUUID(), source: 'user', server: 'compiled-smoke', profile: 'roundtrip' };
const material = { version: 1, kind: 'bearer', secret: crypto.randomUUID(), updatedAt: new Date().toISOString() };
try {
  assert.equal(await store.status(), 'available');
  await store.put(key, material);
  assert.deepEqual(await store.get(key), material);
  await store.delete(key);
  assert.equal(await store.get(key), null);
  console.log('compiled keyring roundtrip passed');
} finally { await store.delete(key); }
`,
    );
    try {
      await compileOssReleaseExecutable(entrypoint, executable);
      // No source entrypoint, package loader, or Bun/Node executable is available
      // through this process's working directory or PATH.
      rmSync(entrypoint);
      const child = Bun.spawn([executable], {
        cwd: root,
        env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(exit).toBe(0);
      expect(stdout).toContain('compiled keyring roundtrip passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
