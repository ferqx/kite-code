import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runWithTuiSystemStepSignal } from './cancellation';
import {
  createPtyOutputBuffer,
  resolveTuiLaunchPaths,
  shouldDetachTuiProcess,
  terminateOwnedProcessTree,
  verifiedOwnedProcessGroupId,
  waitForPtyExit,
  waitForPtyExitCode,
  writeExactPtyInput,
} from './pty-process';
import type { TestWorkspace } from './test-workspace';

test('keeps ordinary TUI groups detached but joins the fault-soak owned group', () => {
  expect(shouldDetachTuiProcess('darwin', undefined)).toBe(true);
  expect(shouldDetachTuiProcess('linux', undefined)).toBe(true);
  expect(shouldDetachTuiProcess('darwin', 'attempt-nonce')).toBe(false);
  expect(shouldDetachTuiProcess('linux', 'attempt-nonce')).toBe(false);
  expect(shouldDetachTuiProcess('win32', undefined)).toBe(false);
});

describe('exact PTY input transport', () => {
  test('writes one transaction when Bun reports the complete synchronous flush count', async () => {
    const writes: string[] = [];

    await writeExactPtyInput('Ask a question', {
      write(data) {
        writes.push(data);
        return new TextEncoder().encode(data).byteLength;
      },
    });

    expect(writes).toEqual(['Ask a question']);
  });

  test('does not replay when Bun reports zero synchronously flushed bytes', async () => {
    let writes = 0;

    await writeExactPtyInput('Ask a question', {
      write() {
        writes++;
        return 0;
      },
    });

    expect(writes).toBe(1);
  });

  test('does not replay a Bun partial synchronous flush count', async () => {
    let writes = 0;

    await writeExactPtyInput('Ask a question', {
      write() {
        writes++;
        return 3;
      },
    });

    expect(writes).toBe(1);
  });
});

describe('waitForPtyExit', () => {
  test('resolves when the child reports an exit before the deadline', async () => {
    let exited = false;
    setTimeout(() => {
      exited = true;
    }, 10);

    await expect(waitForPtyExit(() => exited, 100, 1)).resolves.toBeUndefined();
  });

  test('rejects when the child remains alive after the deadline', async () => {
    await expect(waitForPtyExit(() => false, 10, 1)).rejects.toThrow(
      'PTY child did not exit within 10ms',
    );
  });
});

describe('waitForPtyExitCode', () => {
  test('rejects instead of waiting forever when the TUI does not exit', async () => {
    const neverExits = new Promise<number>(() => {});

    await expect(waitForPtyExitCode(neverExits, 10)).rejects.toThrow(
      'PTY child did not exit within 10ms',
    );
  });

  test('rejects immediately when the active journey step is cancelled', async () => {
    const controller = new AbortController();
    const wait = runWithTuiSystemStepSignal(controller.signal, () =>
      waitForPtyExitCode(new Promise<number>(() => {}), 10_000),
    );
    controller.abort(new Error('step deadline reached'));

    await expect(wait).rejects.toThrow('step deadline reached');
  });
});

const posixTest = process.platform === 'win32' ? test.skip : test;

posixTest(
  'terminates a verified detached child process group including its grandchild',
  async () => {
    const proc = Bun.spawn(['/bin/sh', '-c', 'sleep 30 & child=$!; echo $child; wait'], {
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const processGroupId = verifiedOwnedProcessGroupId(proc.pid);
    const reader = proc.stdout.getReader();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const grandchildPid = Number(output.trim().split(/\s+/)[0]);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    await terminateOwnedProcessTree(proc, processGroupId);
    await waitForPtyExit(
      () => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      },
      5_000,
      25,
    );
  },
);

describe('resolveTuiLaunchPaths', () => {
  test('runs a PTY child from its isolated test workspace', () => {
    const workspace = { workspace: '/tmp/kite-code-workspace' } as TestWorkspace;

    expect(resolveTuiLaunchPaths({ workspace }, '/project')).toEqual({
      cwd: '/tmp/kite-code-workspace',
      entryPath: join('/project', 'apps/kite-cli/src/tui/executable.tsx'),
    });
  });

  test('uses an installed standalone executable without the Bun source launcher', () => {
    const workspace = { workspace: '/tmp/kite-code-workspace' } as TestWorkspace;

    expect(
      resolveTuiLaunchPaths(
        { workspace, executablePath: '/opt/kite-code/bin/kite-tui' },
        '/project',
      ),
    ).toEqual({
      cwd: '/tmp/kite-code-workspace',
      entryPath: '/opt/kite-code/bin/kite-tui',
    });
  });
  test('uses a test-owned TypeScript composition root', () => {
    const workspace = { workspace: '/tmp/kite-code-workspace' } as TestWorkspace;

    expect(
      resolveTuiLaunchPaths({ workspace, entryPath: '/project/tests/fixture.tsx' }, '/project'),
    ).toEqual({
      cwd: '/tmp/kite-code-workspace',
      entryPath: '/project/tests/fixture.tsx',
    });
  });
});

describe('PTY output checkpoints', () => {
  test('separates output emitted before and after an action checkpoint', () => {
    const output = createPtyOutputBuffer();
    output.publishThrough(output.append(new TextEncoder().encode('old prompt\n')));
    const action = output.mark();
    output.publishThrough(output.append(new TextEncoder().encode('new modal\n')));

    expect(output.output()).toBe('old prompt\nnew modal\n');
    expect(output.outputSince(action)).toBe('new modal\n');
  });

  test('keeps UTF-8 output intact across multiple chunks', () => {
    const output = createPtyOutputBuffer();
    output.publishThrough(output.append(new TextEncoder().encode('历史提示\n')));
    const action = output.mark();
    const current = new TextEncoder().encode('当前确认\n');
    output.publishThrough(output.append(current.subarray(0, 2)));
    output.publishThrough(output.append(current.subarray(2)));

    expect(output.outputSince(action)).toBe('当前确认\n');
  });

  test('excludes a UTF-8 code point that started before the action checkpoint', () => {
    const output = createPtyOutputBuffer();
    const splitCharacter = new TextEncoder().encode('你');
    output.publishThrough(output.append(splitCharacter.subarray(0, 1)));
    const action = output.mark();
    output.publishThrough(output.append(splitCharacter.subarray(1)));
    output.publishThrough(output.append(new TextEncoder().encode('新')));

    expect(output.output()).toBe('你新');
    expect(output.outputSince(action)).toBe('新');
  });

  test('rejects marks outside the current output stream', () => {
    const output = createPtyOutputBuffer();
    output.publishThrough(output.append(new TextEncoder().encode('ready')));

    expect(() => output.outputSince(99 as ReturnType<typeof output.mark>)).toThrow(
      'Invalid PTY output mark 99',
    );
  });

  test('does not expose received bytes until their terminal frame is published', () => {
    const output = createPtyOutputBuffer();
    const action = output.mark();
    const receivedThrough = output.append(new TextEncoder().encode('parsed later'));

    expect(output.outputSince(action)).toBe('');
    expect(output.output()).toBe('parsed later');

    output.publishThrough(receivedThrough);
    expect(output.outputSince(action)).toBe('parsed later');
  });
});
