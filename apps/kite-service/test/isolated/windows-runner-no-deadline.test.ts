import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWindowsRestrictedTokenTransport } from '@kite-ai/builtin-runtime/sandbox';
import * as runtimeHost from '@kite-ai/runtime-host';

let currentProcess: unknown;
mock.module('@kite-ai/runtime-host', () => ({
  ...runtimeHost,
  spawnRuntimeHostProcess: () => currentProcess,
}));
const {
  createWindowsSandboxControlSession,
  encodeWindowsSandboxRuntimeControlFrame,
  executeWindowsRestrictedTokenPrepared,
} = await import('../../src/sandbox/windows-restricted-token-runtime');

test('Windows adapter skips null lifetime timers and keeps finite timeout and cancellation watchdogs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-windows-adapter-'));
  const realSetTimeout = globalThis.setTimeout;
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    scheduled.push({ callback, delay });
    return realSetTimeout(callback, delay);
  }) as typeof setTimeout);
  try {
    for (const timeoutMs of [null, 1] as const) {
      scheduled.length = 0;
      const prepared = prepareWindowsRestrictedTokenTransport(
        { enabled: true, workspace: root },
        { workspace: root, command: 'printf complete', timeoutMs },
        root,
        {
          path: 'runner.exe',
          version: '0.8.3',
          digest: `sha256:${'a'.repeat(64)}`,
          minimumWindowsVersion: '10.0.19045',
          protocolVersion: 6,
          shellRuntimePath: 'C:\\shell',
          shellRuntime: 'busybox',
          shellRuntimeDigest: `sha256:${'b'.repeat(64)}`,
          coreutilsDigest: `sha256:${'c'.repeat(64)}`,
        },
      );
      if (!prepared.ok) throw new Error(prepared.error);
      const runnerControl = createWindowsSandboxControlSession({
        invocationId: prepared.prepared.request.invocationName,
        supervisorNonce: 'nonce',
      });
      let output!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
        },
      });
      output.enqueue(
        encodeWindowsSandboxRuntimeControlFrame(
          'ready',
          { invocationName: runnerControl.invocationId, runtimeValidated: true },
          runnerControl,
          'runner',
        ),
      );
      let killed = 0;
      currentProcess = {
        pid: 123,
        stdin: { write() {}, flush() {} },
        stdout,
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill() {
          killed += 1;
        },
      };
      let started!: () => void;
      const go = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const result = executeWindowsRestrictedTokenPrepared(
        { workspace: root, command: 'printf complete', signal: controller.signal },
        prepared.prepared,
        { acknowledgeSupervisorStarted: async () => true, onGoStarted: started },
        { supervisorNonce: 'nonce' },
      );
      await go;
      await Promise.resolve();
      expect(scheduled.some(({ delay }) => delay === 5001)).toBe(timeoutMs !== null);
      expect(scheduled.some(({ delay }) => delay === 10001)).toBe(timeoutMs !== null);
      if (timeoutMs === null) controller.abort();
      else scheduled.find(({ delay }) => delay === 5001)!.callback();
      const cancellationWatchdog = scheduled.at(-1)!;
      expect(cancellationWatchdog.delay).toBe(5000);
      cancellationWatchdog.callback();
      expect(killed).toBe(1);
      output.enqueue(
        encodeWindowsSandboxRuntimeControlFrame(
          'exit',
          {
            version: 6,
            exitCode: 0,
            timedOut: timeoutMs !== null,
            cancelled: timeoutMs === null,
            stdoutBytes: 0,
            stderrBytes: 0,
            peakProcesses: 1,
            activeProcessLimit: 31,
            cleanupConfirmed: true,
            invocationName: runnerControl.invocationId,
            error: null,
          },
          runnerControl,
          'runner',
        ),
      );
      output.close();
      const terminal = await result;
      expect(terminal.terminationReason).toBe(timeoutMs === null ? 'cancelled' : 'timed_out');
    }
  } finally {
    timerSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
