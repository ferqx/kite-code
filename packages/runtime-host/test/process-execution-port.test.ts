import { describe, expect, test } from 'bun:test';
import { createRuntimeHostProcessExecutionPort } from '../src/process/execution-port';
import { readRuntimeHostProcessOutput } from '../src/process/output';

test('process output callback receives every byte beyond the terminal preview size', async () => {
  const complete = 'x'.repeat(300 * 1024);
  const chunks: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(complete));
      controller.close();
    },
  });
  const preview = await readRuntimeHostProcessOutput(stream, (chunk) => chunks.push(chunk));
  expect(chunks.join('')).toBe(complete);
  expect(preview).toContain('chars omitted during shell capture');
});

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
