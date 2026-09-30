import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import type { BuiltinShellTerminalExecutionResult } from '@kite-ai/builtin-runtime';
import type { RuntimeBackgroundExecutionSnapshot } from '@kite-ai/runtime-contract';
import {
  assertProtocolJsonValue,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
} from '@kite-ai/runtime-protocol';
import { pageBackgroundExecutionSnapshot } from '../../src/bootstrap/runtime/CliRuntimeBridge';
import { resolveLocalDeletionCleanupContext } from '../../src/bootstrap/runtime/deletion-cleanup-context';
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
  test('spools terminal-only Host output and keeps streamed output single-copy', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'terminal-only\0workspace';
    const terminalOnly = 'terminal-only-output'.repeat(3_000);
    const started = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async () => terminal({ stdout: terminalOnly, stderr: 'terminal-error' }),
    });
    const complete = await runtime.wait(started.shellId, ownerKey);
    let stdout = '';
    let stderr = '';
    let cursor = 0;
    for (;;) {
      const page = runtime.read(started.shellId, ownerKey, cursor);
      stdout += page.stdout;
      stderr += page.stderr;
      cursor = page.cursor;
      if (!page.moreOutput) break;
    }
    expect(stdout).toBe(terminalOnly);
    expect(stderr).toBe('terminal-error');
    expect(complete.result?.stdout.length).toBeLessThan(terminalOnly.length);

    const streamed = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async (_signal, progress) => {
        progress('streamed', 'stdout');
        return terminal({ stdout: 'streamed', stderr: 'terminal-only-stderr' });
      },
    });
    const mixed = await runtime.wait(streamed.shellId, ownerKey);
    const mixedPage = runtime.read(streamed.shellId, ownerKey, 0);
    expect(mixedPage.stdout).toBe('streamed');
    expect(mixedPage.stderr).toBe('terminal-only-stderr');
    expect(mixed.result?.stdout).toBe('streamed');
    await runtime.dispose();
  });

  test('retains a failed execution reason beyond the old 1024-character cut', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'long-failure\0workspace';
    const reason = 'failure detail '.repeat(3_000);
    const started = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async () => {
        throw new Error(reason);
      },
    });
    const completed = await runtime.wait(started.shellId, ownerKey);
    let stderr = '';
    let cursor = 0;
    for (;;) {
      const page = runtime.read(started.shellId, ownerKey, cursor);
      stderr += page.stderr;
      cursor = page.cursor;
      if (!page.moreOutput) break;
    }
    expect(stderr).toBe(reason);
    expect(completed.result?.stderr.length).toBeLessThan(reason.length);
    await runtime.dispose();
  });

  test('pages a directory beyond one protocol frame without losing terminal identities', () => {
    const snapshot: RuntimeBackgroundExecutionSnapshot = {
      sessionId: 'session-1',
      sessionRevision: 1,
      aggregateGeneration: 'generation-1',
      watermark: 11_000,
      executions: Array.from({ length: 11_000 }, (_, index) => ({
        executionId: `sh_${String(index).padStart(5, '0')}`,
        displayName: 'completed shell '.repeat(12),
        sessionId: 'session-1',
        sessionRevision: 1,
        kind: 'shell' as const,
        status: 'completed' as const,
        ownerGeneration: 'owner-1',
        revision: index + 1,
        cleanupConfirmed: true,
      })),
    };
    const ids: string[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = pageBackgroundExecutionSnapshot(snapshot, cursor);
      const response = { status: 'ok', queryType: 'list_background_executions', ...page };
      assertProtocolJsonValue(response);
      expect(RUNTIME_PROTOCOL_RESULT_SCHEMA_.safeParse(response).success).toBe(true);
      ids.push(...page.backgroundSnapshot.executions.map((entry) => entry.executionId));
      pages += 1;
      if (page.nextBackgroundCursor === undefined) break;
      expect(page.nextBackgroundCursor).toBeGreaterThan(cursor);
      cursor = page.nextBackgroundCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(ids).toEqual(snapshot.executions.map((entry) => entry.executionId));
  });

  test('spools output beyond the old capture size and delivers every page by cursor', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'large-output\0workspace';
    const output = 'x'.repeat(1024 * 1024 + 260 * 1024);
    const first = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async (_signal, progress) => {
        progress(output, 'stdout');
        return terminal({ stdout: 'preview' });
      },
    });
    expect(first.moreOutput).toBe(true);
    expect(first.stdout.length).toBeLessThanOrEqual(32 * 1024);
    // Reading remains available while the Session owner exists. Disposal is
    // the final ownership boundary and reclaims even unread completed output.
    await Promise.resolve();
    let reconstructed = first.stdout;
    let cursor = first.cursor;
    let pages = 1;
    const terminalCursor = runtime.listSnapshot('large-output', ownerKey).executions[0]?.cursor;
    if (terminalCursor === undefined) throw new Error('Missing terminal output cursor.');
    while (cursor < terminalCursor) {
      const page = runtime.read(first.shellId, ownerKey, cursor);
      reconstructed += page.stdout;
      cursor = page.cursor;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(8);
    expect(reconstructed).toBe(output);
    expect(runtime.read(first.shellId, ownerKey, 0).stdout).toBe(first.stdout);
    await runtime.disposeOwner(ownerKey);
    expect(() => runtime.read(first.shellId, ownerKey, 0)).toThrow('unavailable');
  });

  test('preserves multibyte characters across spool frames and output pages', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'unicode-output\0workspace';
    const output = `${'a'.repeat(16 * 1024 - 1)}😀`.repeat(5);
    const first = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async (_signal, progress) => {
        progress(output, 'stdout');
        return terminal();
      },
    });
    let reconstructed = '';
    let cursor = 0;
    for (;;) {
      const page = runtime.read(first.shellId, ownerKey, cursor);
      reconstructed += page.stdout;
      cursor = page.cursor;
      if (!page.moreOutput) break;
    }
    expect(reconstructed).toBe(output);
    await runtime.disposeOwner(ownerKey);
  });

  test('finds a live Shell for deletion while its coordinator is closing', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'closing-session\0workspace';
    const started = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(terminal()), { once: true }),
        ),
    });
    let identityReads = 0;
    expect(
      resolveLocalDeletionCleanupContext({
        getCoordinatorState: () => {
          throw new Error('Runtime session is closing.');
        },
        shellWorkspace: () => runtime.liveWorkspaceForSession('closing-session'),
        backgroundRecoveryIdentity: () => null,
        readRecoveryIdentity: () => {
          identityReads += 1;
          return 'recovery-id';
        },
      }),
    ).toEqual({ workspace: 'workspace', recoveryIdentityKey: 'recovery-id' });
    expect(identityReads).toBe(1);
    expect(runtime.read(started.shellId, ownerKey).status).toBe('running');
    await runtime.disposeOwner(ownerKey);
  });

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

  test('keeps serial terminal handles readable beyond the former owner capacity', async () => {
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
    for (let index = 0; index < 1_100; index += 1) {
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
    expect(runtime.getProjection('retention', ownerKey, unread[0]!)).toMatchObject({
      executionId: unread[0],
      status: 'completed',
    });
    expect(runtime.listSnapshot('retention', ownerKey).executions.length).toBe(1_101);
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
    expect(runtime.read(started.shellId, 'thread\0workspace', started.cursor).stdout).toBe('');
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

  test('completed long polls remove cancellation listeners and cancelled reads return immediately', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerKey = 'poll-cleanup\0workspace';
    let progress!: (chunk: string, stream: 'stdout' | 'stderr') => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const started = await runtime.start({
      ownerKey,
      yieldMs: 0,
      execute: async (_signal, onProgress) => {
        progress = onProgress;
        await gate;
        return terminal();
      },
    });
    const controller = new AbortController();
    let cursor = started.cursor;
    for (let index = 0; index < 24; index++) {
      const pending = runtime.readWaiting({
        shellId: started.shellId,
        ownerKey,
        cursor,
        waitMs: 30_000,
        signal: controller.signal,
      });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      progress(`output-${index}`, 'stdout');
      const page = await pending;
      expect(page.returnReason).toBe('output');
      cursor = page.cursor;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    controller.abort();
    const before = performance.now();
    expect(
      await runtime.readWaiting({
        shellId: started.shellId,
        ownerKey,
        cursor,
        waitMs: 30_000,
        signal: controller.signal,
      }),
    ).toMatchObject({ status: 'running', returnReason: 'cancelled' });
    expect(performance.now() - before).toBeLessThan(1_000);
    const terminalController = new AbortController();
    const pendingTerminal = runtime.wait(started.shellId, ownerKey, terminalController.signal);
    expect(getEventListeners(terminalController.signal, 'abort')).toHaveLength(1);
    finish();
    expect((await pendingTerminal).status).toBe('exited');
    expect(getEventListeners(terminalController.signal, 'abort')).toHaveLength(0);
    await runtime.dispose();
  });

  test('other owners cannot change the directory watermark and unread output is reclaimed on disposal', async () => {
    const runtime = new ManagedShellRuntime();
    const ownerA = 'owner-a\0workspace';
    const ownerB = 'owner-b\0workspace';
    let progressB!: (chunk: string, stream: 'stdout' | 'stderr') => void;
    let finishB!: () => void;
    const gate = new Promise<void>((resolve) => (finishB = resolve));
    const shellA = await runtime.start({
      ownerKey: ownerA,
      yieldMs: 0,
      execute: async () => terminal({ stdout: 'unread'.repeat(20_000) }),
    });
    await Promise.resolve();
    const watermarkA = runtime.listSnapshot('owner-a', ownerA).watermark;
    const shellB = await runtime.start({
      ownerKey: ownerB,
      yieldMs: 0,
      execute: async (_signal, progress) => {
        progressB = progress;
        await gate;
        return terminal();
      },
    });
    progressB('other-owner-output', 'stdout');
    expect(runtime.listSnapshot('owner-a', ownerA).watermark).toBe(watermarkA);
    await runtime.disposeOwner(ownerA);
    expect(() => runtime.read(shellA.shellId, ownerA)).toThrow('unavailable');
    expect(runtime.read(shellB.shellId, ownerB).status).toBe('running');
    finishB();
    await runtime.dispose();
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
                    stdout: '',
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
