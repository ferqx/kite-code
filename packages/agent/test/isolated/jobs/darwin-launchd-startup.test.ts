import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const darwinTest = process.platform === 'darwin' ? test : test.skip;

darwinTest(
  'original listen refusal retains its error, cleans unregistered preparation, and never bootstraps',
  () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./darwin-launchd-startup.fixture.ts', import.meta.url))],
      { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0 || result.error)
      console.error(
        JSON.stringify({
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('original-listen-error-and-cleanup-confirmed');
  },
);

darwinTest(
  'unknown bootstrap reply confirms original registration absence before removing preparation',
  () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./darwin-launchd-startup.fixture.ts', import.meta.url)),
        'bootstrap-unknown',
      ],
      { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0 || result.error)
      console.error(
        JSON.stringify({
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('original-bootstrap-unknown-cleanup-confirmed');
  },
);
