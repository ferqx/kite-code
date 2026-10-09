import { expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeProcessOwner } from '../../electron/native-processes';

class GatedChild extends ChildProcess {
  kills = 0;
  requested!: () => void;
  readonly killedRequest = new Promise<void>((resolve) => {
    this.requested = resolve;
  });
  override kill() {
    this.kills++;
    this.requested();
    return true;
  }
}
const options = { timeoutMs: 1000, timeoutError: 'owned timeout', launchError: 'owned launch' };

test('Main owner close seals serial admission and waits for its actual child close', async () => {
  const child = new GatedChild();
  let spawns = 0;
  const owner = new NativeProcessOwner(() => {
    spawns++;
    return child;
  });
  const task = owner.start('owned', [], { stdio: 'ignore' }, options);
  const terminal = task.result.catch((error: unknown) => error);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  expect(() => owner.start('second', [], {}, options)).toThrow();
  await child.killedRequest;
  expect(spawns).toBe(1);
  expect(closed).toBe(false);
  child.emit('close', null, 'SIGKILL');
  await closing;
  expect(closed).toBe(true);
  expect(await terminal).toBeInstanceOf(Error);
  await owner.close();
  expect(spawns).toBe(1);
});

test('launch error and timeout keep the first failure pending until actual close', async () => {
  for (const cause of ['error', 'timeout'] as const) {
    const child = new GatedChild();
    const owner = new NativeProcessOwner(() => child);
    const task = owner.start(
      'owned',
      [],
      {},
      { ...options, timeoutMs: cause === 'timeout' ? 1 : 1000 },
    );
    let settled = false;
    const terminal = task.result.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    if (cause === 'error') child.emit('error', Error('actual spawn failure'));
    await child.killedRequest;
    expect(settled).toBe(false);
    task.stop(Error('late stop cannot replace first failure'));
    child.emit('close', 0, null);
    const result = await terminal;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      cause === 'error' ? options.launchError : options.timeoutError,
    );
    await owner.close();
  }
});

test('actual Node Main owner closes its original child and both output streams', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-process-owner-')));
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../native-processes-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      outdir: root,
      naming: 'driver.js',
    });
    if (!built.success) throw new AggregateError(built.logs, 'native_process_fixture_build');
    const node = Bun.which('node');
    if (!node) throw Error('native_process_fixture_node_missing');
    driver = Bun.spawn([node, built.outputs[0]!.path, root], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(driver.stdout).text(),
      stderr = new Response(driver.stderr).text();
    expect(await driver.exited).toBe(0);
    expect(await stderr).toBe('');
    const facts = JSON.parse(await stdout) as {
      actualNode: boolean;
      pid: number;
      closePid: number;
      stdout: string;
      stderr: string;
      stdoutEOF: boolean;
      stderrEOF: boolean;
      closed: boolean;
      absent: boolean;
      admissionDenied: boolean;
      branch: {
        workspace: string;
        root: string;
        repository: boolean;
        current: string;
        head: string;
        branches: string[];
        dirty: boolean;
        canSwitch: boolean;
      };
      calls: { command: string; args: string[]; timeoutMs: number }[];
      helpersAbsent: boolean;
      editorStopped: boolean;
      callerWaitedForEditor: boolean;
      closedCallerDenied: boolean;
      networkDisposed: number;
      callsStableAfterClose: boolean;
    };
    expect(facts.actualNode).toBe(true);
    expect(facts.pid).toBeGreaterThan(1);
    expect(facts.closePid).toBe(facts.pid);
    expect(facts.stdout).toBe('OWNED_NODE_READY\n');
    expect(facts.stderr).toBe('OWNED_NODE_STDERR\n');
    expect(facts.stdoutEOF).toBe(true);
    expect(facts.stderrEOF).toBe(true);
    expect(facts.closed).toBe(true);
    expect(facts.absent).toBe(true);
    expect(facts.admissionDenied).toBe(true);
    expect(facts.branch).toEqual({
      workspace: root,
      repository: true,
      root,
      current: 'main',
      head: 'a'.repeat(40),
      branches: ['main'],
      dirty: false,
      canSwitch: true,
    });
    expect(facts.calls.filter((call) => call.command === 'git')).toHaveLength(5);
    expect(
      facts.calls
        .filter((call) => call.command === 'git')
        .every(
          (call) =>
            call.timeoutMs === 15000 &&
            call.args.slice(0, 4).join(' ') ===
              '-c core.hooksPath=/dev/null -c core.fsmonitor=false',
        ),
    ).toBe(true);
    if (process.platform === 'darwin')
      expect(facts.calls.at(-1)).toEqual({
        command: '/usr/bin/open',
        args: ['-a', 'Visual Studio Code', '--', join(root, 'owned.txt')],
        timeoutMs: 10000,
      });
    expect(facts.helpersAbsent).toBe(true);
    expect(facts.editorStopped).toBe(true);
    expect(facts.callerWaitedForEditor).toBe(true);
    expect(facts.closedCallerDenied).toBe(true);
    expect(facts.networkDisposed).toBeGreaterThan(0);
    expect(facts.callsStableAfterClose).toBe(true);
  } finally {
    driver?.kill('SIGTERM');
    await driver?.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
