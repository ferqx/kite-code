import { describe, expect, test } from 'bun:test';
import { createRuntimeHostProcessExecutionPort } from '../src/process/execution-port';

describe.skipIf(process.platform === 'win32')('Runtime Host watched process execution port', () => {
  test('preserves output and exit status through the POSIX watchdog', async () => {
    const port = createRuntimeHostProcessExecutionPort();
    const process = port.spawn({
      argv: ['/bin/sh', '-c', "printf 'watched-output'"],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
    });
    const output = port.readOutput(process.stdout);
    expect(await process.exited).toBe(0);
    expect(await output).toBe('watched-output');
    process.processTree.dispose();
  });

  test('terminates the watchdog process group and its command', async () => {
    const port = createRuntimeHostProcessExecutionPort();
    const process = port.spawn({
      argv: ['/bin/sh', '-c', 'sleep 30'],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
    });
    const terminated = await process.processTree.terminate();
    expect(terminated).toMatchObject({ confirmedExited: true, unconfirmedProcessCount: 0 });
    process.processTree.dispose();
  });
});
