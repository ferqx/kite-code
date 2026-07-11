import { describe, expect, test } from 'bun:test';
import { resolveTuiLaunchPaths, waitForPtyExit, waitForPtyExitCode } from './pty-process';
import type { TestWorkspace } from './test-workspace';

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
});

describe('resolveTuiLaunchPaths', () => {
  test('runs a PTY child from its isolated test workspace', () => {
    const workspace = { workspace: '/tmp/kite-code-workspace' } as TestWorkspace;

    expect(resolveTuiLaunchPaths({ workspace }, '/project')).toEqual({
      cwd: '/tmp/kite-code-workspace',
      entryPath: '/project/src/app/tui/index.tsx',
    });
  });
});
