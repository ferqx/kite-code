import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from './fixture-lifecycle';
import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import type { TestWorkspace } from './test-workspace';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspaceFixture(order: string[], failCleanup = false): TestWorkspace {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-fixture-lifecycle-')));
  roots.push(home);
  const codeRoot = join(home, '.kite-code');
  mkdirSync(codeRoot, { mode: 0o700 });
  return {
    home,
    env: { HOME: home, KITE_CODE_HOME: codeRoot, PATH: process.env.PATH ?? '' },
    cleanup: () => {
      order.push('workspace');
      rmSync(home, { recursive: true, force: true });
      if (failCleanup) throw new Error('workspace cleanup failed');
    },
  } as unknown as TestWorkspace;
}

describe('TUI system fixture lifecycle', () => {
  test('terminates TUI before services and workspace cleanup', async () => {
    const order: string[] = [];
    const tui = {
      killAndWait: async () => {
        order.push('tui');
        return true;
      },
    } as unknown as PtyProcess;
    const server = {
      assertComplete: () => order.push('assert-model-queue'),
      stop: () => order.push('server'),
    } as unknown as MockModelServer;
    const workspace = workspaceFixture(order);

    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [server],
      workspaces: [workspace],
    });

    expect(order).toEqual(['tui', 'assert-model-queue', 'server', 'workspace']);
  });

  test('continues releasing every resource and aggregates cleanup failures', async () => {
    const order: string[] = [];
    const tui = {
      killAndWait: async () => {
        order.push('tui');
        throw new Error('tui cleanup failed');
      },
    } as unknown as PtyProcess;
    const server = {
      assertComplete: () => {
        order.push('assert-model-queue');
        throw new Error('unexpected model request');
      },
      stop: () => order.push('server'),
    } as unknown as MockModelServer;
    const workspace = workspaceFixture(order, true);

    let failure: unknown;
    try {
      await cleanupTuiSystemFixtures({
        tuis: [tui],
        mockServers: [server],
        workspaces: [workspace],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    expect(order).toEqual(['tui', 'assert-model-queue', 'server', 'workspace']);
  });
});
