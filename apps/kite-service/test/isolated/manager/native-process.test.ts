import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKiteServiceManagerNativeProcessPort,
  createKiteServiceManagerNativeSpawnPort,
} from '../../../src/manager/native-process';

let root: string | undefined;
let childPid: number | undefined;

afterEach(() => {
  if (childPid) {
    try {
      process.kill(childPid, 'SIGTERM');
    } catch {
      // The fixture may already have exited.
    }
  }
  childPid = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(process.platform === 'win32')('Kite Service Native process manager ports', () => {
  test('spawns detached with fd readiness and releases the handle without killing', async () => {
    root = mkdtempSync(join(tmpdir(), 'kite-service-native-spawn-'));
    const executable = join(root, 'service-fixture');
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { writeSync } from 'node:fs';\nwriteSync(Number(process.env.KITE_SERVICE_READINESS_FD), JSON.stringify({ instanceId: 'native-child' }) + '\\n');\nsetInterval(() => undefined, 1000);\n`,
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    const spawn = createKiteServiceManagerNativeSpawnPort();
    const child = await spawn.spawn({
      executable: { path: executable, mode: 'source', buildId: 'dev:test' },
      args: ['service', 'run'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      detached: true,
      stdout: 'ignore',
    });
    childPid = child.pid;

    await expect(child.waitForReady()).resolves.toEqual({ instanceId: 'native-child' });
    await child.readiness.release();
    expect(await createKiteServiceManagerNativeProcessPort().inspect(child.pid)).toBe('alive');
  });
});
