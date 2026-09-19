import { describe, expect, test } from 'bun:test';
import type { BuiltinShellTerminalExecutionResult } from '@kite-ai/builtin-runtime';
import { ManagedShellRuntime } from '../../src/bootstrap/runtime/managed-shell';

const terminal = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  command: 'echo ok',
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  intent: 'other' as const,
  ...overrides,
});

describe('ManagedShellRuntime', () => {
  test('turns execution rejection into a failed terminal and wakes all waiters', async () => {
    const runtime = new ManagedShellRuntime();
    let reject!: (error: Error) => void;
    const started = await runtime.start({
      ownerKey: 'reject\0workspace',
      yieldMs: 0,
      execute: () => new Promise((_, fail) => (reject = fail)),
    });
    const ownerChanged = runtime.waitForOwnerChange(
      'reject\0workspace',
      runtime.ownerWatermark('reject\0workspace'),
    );
    const terminalRead = runtime.readWaiting({
      shellId: started.shellId,
      ownerKey: 'reject\0workspace',
      waitUntil: 'terminal',
    });
    reject(new Error('spawn failed'));
    await ownerChanged;
    expect(await terminalRead).toMatchObject({
      status: 'exited',
      returnReason: 'terminal',
      result: { ok: false, exitCode: 1, stderr: 'spawn failed' },
    });
    expect(runtime.listSnapshot('reject', 'reject\0workspace').executions[0]).toMatchObject({
      status: 'unavailable',
      cleanupConfirmed: false,
    });
    await expect(runtime.stop(started.shellId, 'reject\0workspace')).resolves.toMatchObject({
      status: 'exited',
    });
    await runtime.disposeOwner('reject\0workspace');
    expect(runtime.listSnapshot('reject', 'reject\0workspace').executions[0]).toMatchObject({
      status: 'unavailable',
      cleanupConfirmed: false,
    });
  });

  test('bounds consumed terminal retention without evicting live or unread handles', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'retention\0workspace';
    const live = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(terminal()), { once: true }),
        ),
    });
    const unread: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const completed = await runtime.start({
        ownerKey,
        yieldMs: 0,
        execute: async () => terminal(),
      });
      if (index < 3) unread.push(completed.shellId);
      else await runtime.wait(completed.shellId, ownerKey);
    }
    expect(runtime.read(live.shellId, ownerKey).status).toBe('running');
    for (const shellId of unread) expect(runtime.read(shellId, ownerKey).status).toBe('exited');
    expect(runtime.listSnapshot('retention', ownerKey).executions.length).toBeLessThanOrEqual(68);
    await runtime.disposeOwner(ownerKey);
  });
  test('precise stop exposes stopping before terminal cleanup', async () => {
    const runtime = new ManagedShellRuntime();
    let terminalCallback = 0;
    const started = await runtime.start({
      ownerKey: 'stop\0workspace',
      yieldMs: 0,
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve(terminal({ terminationReason: 'cancelled' })),
            { once: true },
          ),
        ),
    });
    expect(runtime.requestStop(started.shellId, 'wrong', () => {})).toBe(false);
    expect(
      runtime.requestStop(started.shellId, 'stop\0workspace', () => {
        terminalCallback += 1;
      }),
    ).toBe(true);
    await runtime.wait(started.shellId, 'stop\0workspace');
    await Bun.sleep(0);
    expect(terminalCallback).toBe(1);
    expect(runtime.listSnapshot('stop', 'stop\0workspace').executions[0]).toMatchObject({
      status: 'cancelled',
      cleanupConfirmed: true,
    });
  });
  test('lists owner-scoped background snapshots with generation and monotonic watermark', async () => {
    const runtime = new ManagedShellRuntime();
    let finish!: (result: BuiltinShellTerminalExecutionResult) => void;
    const started = await runtime.start({
      ownerKey: 'session-1\0workspace',
      mode: 'service',
      yieldMs: 0,
      execute: () => new Promise((resolve) => (finish = resolve)),
    });
    const running = runtime.listSnapshot('session-1', 'session-1\0workspace');
    expect(running).toMatchObject({
      sessionId: 'session-1',
      executions: [
        {
          executionId: started.shellId,
          kind: 'service',
          status: 'running',
          cleanupConfirmed: false,
        },
      ],
    });
    expect(runtime.listSnapshot('other', 'other\0workspace').executions).toEqual([]);
    finish(terminal());
    await runtime.wait(started.shellId, 'session-1\0workspace');
    const completed = runtime.listSnapshot('session-1', 'session-1\0workspace');
    expect(completed.watermark).toBeGreaterThan(running.watermark);
    expect(completed.executions[0]).toMatchObject({
      status: 'completed',
      cleanupConfirmed: true,
    });
  });
  test('returns a stable handle after yielding and supports independent cursors', async () => {
    const runtime = new ManagedShellRuntime();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      yieldMs: 0,
      execute: async (_signal, progress) => {
        progress('first', 'stdout');
        await gate;
        progress('second', 'stderr');
        return terminal();
      },
    });
    expect(started.status).toBe('running');
    expect(started.gap).toBe(false);
    expect(started.shellId).toMatch(/^sh_/);
    expect(runtime.read(started.shellId, 'thread\0workspace', 0).stdout).toBe('first');
    expect(runtime.read(started.shellId, 'thread\0workspace', 1).stdout).toBe('');
    expect(() => runtime.read(started.shellId, 'other\0workspace', 0)).toThrow(
      'Managed Shell handle is unavailable.',
    );
    finish();
    const settled = await runtime.wait(started.shellId, 'thread\0workspace');
    expect(settled.status).toBe('exited');
    expect(settled.stderr).toBe('second');
    expect(settled.result?.exitCode).toBe(0);
  });

  test('cancelling a terminal wait does not cancel the managed execution', async () => {
    const runtime = new ManagedShellRuntime();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      yieldMs: 0,
      execute: async () => {
        await gate;
        return terminal();
      },
    });
    const wait = new AbortController();
    const pending = runtime.wait(started.shellId, 'thread\0workspace', wait.signal);
    wait.abort('new_input');
    expect((await pending).status).toBe('running');
    finish();
    expect((await runtime.wait(started.shellId, 'thread\0workspace')).status).toBe('exited');
  });

  test('a bounded read wakes on new output before its timer expires', async () => {
    const runtime = new ManagedShellRuntime();
    let progress!: (chunk: string, stream: 'stdout' | 'stderr') => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      yieldMs: 0,
      execute: async (_signal, onProgress) => {
        progress = onProgress;
        await gate;
        return terminal();
      },
    });
    const pending = runtime.readWaiting({
      shellId: started.shellId,
      ownerKey: 'thread\0workspace',
      cursor: 0,
      waitMs: 30_000,
    });
    progress('arrived', 'stdout');
    expect((await pending).stdout).toBe('arrived');
    finish();
    await runtime.wait(started.shellId, 'thread\0workspace');
  });

  test('new input yields a terminal wait without stopping the managed execution', async () => {
    const runtime = new ManagedShellRuntime();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      yieldMs: 0,
      execute: async () => {
        await gate;
        return terminal();
      },
    });
    const pending = runtime.readWaiting({
      shellId: started.shellId,
      ownerKey: 'thread\0workspace',
      waitUntil: 'terminal',
    });
    runtime.notifyInput('thread\0workspace');
    expect(await pending).toMatchObject({ status: 'running', returnReason: 'new_input' });
    finish();
    expect((await runtime.wait(started.shellId, 'thread\0workspace')).status).toBe('exited');
  });

  test('stop uses the execution cancellation signal and waits for terminal cleanup', async () => {
    const runtime = new ManagedShellRuntime();
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      yieldMs: 0,
      execute: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve(terminal({ ok: false, exitCode: 130, terminationReason: 'cancelled' })),
            { once: true },
          );
        }),
    });
    const stopped = await runtime.stop(started.shellId, 'thread\0workspace');
    expect(stopped.status).toBe('exited');
    expect(stopped.result?.terminationReason).toBe('cancelled');
  });

  test('owner change wait wakes on terminal completion and cannot lose an earlier wake', async () => {
    const runtime = new ManagedShellRuntime();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const ownerKey = 'thread\0workspace';
    const started = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async () => {
        await gate;
        return terminal();
      },
    });
    const watermark = runtime.ownerWatermark(ownerKey);
    const waiting = runtime.waitForOwnerChange(ownerKey, watermark);
    finish();
    await waiting;
    expect(runtime.read(started.shellId, ownerKey).status).toBe('exited');
    await expect(runtime.waitForOwnerChange(ownerKey, watermark)).resolves.toBeUndefined();
  });

  test('retains an explicit service under the session owner and disposal awaits cleanup', async () => {
    const runtime = new ManagedShellRuntime();
    let cleaned = false;
    const started = await runtime.start({
      ownerKey: 'thread\0workspace',
      mode: 'service',
      yieldMs: 0,
      execute: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              cleaned = true;
              resolve(terminal({ ok: false, exitCode: 130, terminationReason: 'cancelled' }));
            },
            { once: true },
          );
        }),
    });
    expect(started).toMatchObject({ mode: 'service', status: 'running' });
    // A later Run has no signal reference to this retained service; the stable
    // session owner can still read and explicitly stop it.
    expect(runtime.read(started.shellId, 'thread\0workspace')).toMatchObject({
      mode: 'service',
      status: 'running',
    });
    await runtime.dispose();
    expect(cleaned).toBe(true);
    expect(() => runtime.read(started.shellId, 'thread\0workspace')).toThrow(
      'Managed Shell handle is unavailable.',
    );
  });

  test('owner disposal cannot stop a retained service from another session', async () => {
    const runtime = new ManagedShellRuntime();
    const start = (ownerKey: string) =>
      runtime.start({
        ownerKey,
        mode: 'service' as const,
        yieldMs: 0,
        execute: (signal: AbortSignal) =>
          new Promise<ReturnType<typeof terminal>>((resolve) => {
            signal.addEventListener(
              'abort',
              () =>
                resolve(
                  terminal({
                    ok: false,
                    exitCode: 130,
                    terminationReason: 'cancelled',
                  }),
                ),
              { once: true },
            );
          }),
      });
    const older = await start('older\0workspace');
    const newer = await start('newer\0workspace');
    await runtime.disposeOwner('newer\0workspace', 'newer_run_cancelled');
    expect(() => runtime.read(newer.shellId, 'newer\0workspace')).toThrow(
      'Managed Shell handle is unavailable.',
    );
    expect(runtime.read(older.shellId, 'older\0workspace').status).toBe('running');
    await runtime.disposeOwner('older\0workspace');
    expect(runtime.listSnapshot('older', 'older\0workspace').executions).toEqual([]);
  });

  test('owner disposal is bounded and retains an unresolved provider for recovery', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'hung\0workspace';
    const started = await runtime.start({
      ownerKey,
      mode: 'service',
      yieldMs: 0,
      execute: () => new Promise(() => {}),
    });
    const startedAt = performance.now();
    await runtime.disposeOwner(ownerKey, 'test_shutdown', 5);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(runtime.read(started.shellId, ownerKey)).toMatchObject({ status: 'running' });
    expect(runtime.listSnapshot('hung', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: started.shellId,
        status: 'stopping',
        cleanupConfirmed: false,
      }),
    ]);
  });
});
