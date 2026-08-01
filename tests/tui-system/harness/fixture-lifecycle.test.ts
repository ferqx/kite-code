import { describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from './fixture-lifecycle';
import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import type { TestWorkspace } from './test-workspace';

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
    const workspace = {
      cleanup: () => order.push('workspace'),
    } as unknown as TestWorkspace;

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
    const workspace = {
      cleanup: () => {
        order.push('workspace');
        throw new Error('workspace cleanup failed');
      },
    } as unknown as TestWorkspace;

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
