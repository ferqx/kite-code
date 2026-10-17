import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

for (const mode of ['workspace', 'workspace-closing', 'profile'])
  test(`actual ${mode} unlock failure rejects close and preserves a successful release retry`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./workspace-release-fault.fixture.ts', import.meta.url)),
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(stdout).toContain('fault recovered with real OS authority');
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  }, 5000);
