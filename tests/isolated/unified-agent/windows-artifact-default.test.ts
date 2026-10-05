import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOwnedDefaultArtifactConsumer } from '../../fixtures/unified-agent/windows-artifact-default/build';

// All supported platforms execute this public path, including actual win32 without availability skip.
// Large run.start User content invokes the default sealer; there is no Artifact-upload HTTP API.
test('source-free default paired Service seals >64KiB actual Model media and cold public readers do not replay or register', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-windows-media-')));
  try {
    const built = await buildOwnedDefaultArtifactConsumer(root);
    expect(existsSync(join(root, 'original'))).toBe(false);
    const home = join(root, 'home');
    mkdirSync(home);
    const child = Bun.spawn([process.execPath, built.entry, root], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        BUN_OPTIONS: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw Error(`owned_default_media_failed:${exit}\n${stdout}\n${stderr}`);
      expect(stderr).toBe('');
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        platform: process.platform,
        sourceFree: true,
        defaultConfiguration: true,
        providerCalls: 1,
        sessionId: 's',
        workspaceId: 'w',
        originalCommand: 'applied',
        completeClose: true,
        coldNoNewRecords: true,
      });
      expect(BigInt(result.bodyBytes)).toBeGreaterThan(65536n);
      expect(result.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.originalInputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.runId).toBeTruthy();
      expect(result.executionId).toBeTruthy();
      expect(result.refId).toBeTruthy();
      console.log(`owned_default_artifact_media:${stdout.trim()}`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
