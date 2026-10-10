import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { probeNativeSqliteEngine } from '../../scripts/sqlite-engine';

test('failed probe stream retains its original error and waits for the actual owned child despite a failed signal', async () => {
  const streamFailure = Error('owned_probe_stream_failed');
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let scratch: string | undefined;
  let signals = 0;
  const spawn = new Proxy(Bun.spawn, {
    apply(target, receiver, args) {
      // The trusted fixture preserves the actual Bun child; it does not invent exit/reap.
      scratch = args[1].env.HOME;
      child = Reflect.apply(target, receiver, [
        [process.execPath, '-e', 'setTimeout(() => process.exit(0), 150);'],
        args[1],
      ]);
      return new Proxy(child!, {
        get(actual, key) {
          if (key === 'stderr')
            return new ReadableStream({
              start(controller) {
                controller.error(streamFailure);
              },
            });
          if (key === 'kill')
            return () => {
              signals++;
              throw Error('owned_probe_signal_failed');
            };
          const value = Reflect.get(actual, key, actual);
          return typeof value === 'function' ? value.bind(actual) : value;
        },
      });
    },
  });
  try {
    const error = await probeNativeSqliteEngine(
      {
        executable: process.execPath,
        root: process.cwd(),
        electronVersion: 'fixture-does-not-claim-Electron',
      },
      spawn,
    ).catch((error) => error);
    expect(error).toBe(streamFailure);
    expect(signals).toBe(1);
    expect(child).toBeDefined();
    expect(await child!.exited).toBe(0);
    expect(child!.exitCode).toBe(0);
    expect(scratch).toBeDefined();
    expect(existsSync(scratch!)).toBe(false);
    // Consume the original stderr only after its actual process exit; no second probe reader.
    expect(await new Response(child!.stderr).text()).toBe('');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    if (scratch && (!child || child.exitCode !== null))
      rmSync(scratch, { recursive: true, force: true });
  }
}, 10_000);
