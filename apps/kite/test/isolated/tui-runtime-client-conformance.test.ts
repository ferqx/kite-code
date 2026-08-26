import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeState } from '@kite-ai/agent-kernel';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { sqliteCurrentRuntimeStorePath } from '@kite-ai/runtime-storage-sqlite';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteTuiSessionManager } from '../../src/bootstrap';
import type { SessionPresentationAction } from '../../src/runtime/session/contracts';
import type { AppShellExecutor } from '../../src/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  projectAppHostShellResult,
} from '../../src/sandbox/prepared-tool-pipeline';
import { TuiUserInputProvider } from '../../src/tui/provider';

test('TUI App composition receives safe live and terminal events through its Runtime Client subscription', async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-tui-runtime-client-cutover-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  model.setResponses([
    {
      message: {
        content_chunks: ['Subscription-safe ', 'terminal projection.'],
      },
    },
  ]);
  const provider = new TuiUserInputProvider();
  const shellExecutor = createHostShellExecutor();
  const manager = createKiteTuiSessionManager({
    workspace,
    checkpointPath: join(workspace, 'runtime.sqlite'),
    config: {
      providerName: 'integration-model',
      providerType: 'openai-compatible',
      apiKey: 'test-key',
      baseURL: model.baseURL,
      modelName: 'mock-model',
      interactionMode: 'accept_edits',
      sandbox: { enabled: false },
    },
    provider,
    skillManifests: [],
    skillOptions: {
      userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    },
    mcpManager: null,
    shellExecutor,
  });

  try {
    const sessionId = manager.createSession(workspace);
    await manager.waitForSessionReady(sessionId);
    const runtime = manager.getRuntime(sessionId);
    expect(runtime).toBeDefined();

    const events: RuntimeClientEvent[] = [];
    try {
      await runtime!.runTask('Reply once without calling a tool.', {
        dispatch: (action: SessionPresentationAction) => {
          if (action.type === 'RUNTIME_EVENT') events.push(action.event);
        },
        provider,
        config: {
          providerName: 'integration-model',
          providerType: 'openai-compatible',
          apiKey: 'test-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          interactionMode: 'accept_edits',
          sandbox: { enabled: false },
        },
      });
    } catch (error) {
      const runtimeError = error as {
        code?: unknown;
        message?: unknown;
        protocol?: unknown;
      };
      throw new Error(
        `start_turn via TUI Runtime Client failed: ${JSON.stringify({
          code: runtimeError.code,
          message: runtimeError.message,
          protocol: runtimeError.protocol,
        })}`,
      );
    }
    await runtime!.waitForRunCompletion();

    const failuresBeforeLateAbort = runtime!.eventBuffer.filter(
      (event) => event.type === 'run.failure',
    ).length;
    runtime!.abort();
    await Bun.sleep(25);
    expect(runtime!.eventBuffer.filter((event) => event.type === 'run.failure')).toHaveLength(
      failuresBeforeLateAbort,
    );

    // The bridge's Host callback never dispatches presentation events
    // directly. Both of these arrive only after the Runtime Client's
    // subscribed Protocol notification pump projects them back to the UI.
    expect(events.some((event) => event.type === 'model.text_delta')).toBe(true);
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('test-key');
    expect(JSON.stringify(events)).not.toContain(workspace);
    expect(model.getRequestCount()).toBe(1);

    const stateStore = openStateStoreForTest(
      sqliteCurrentRuntimeStorePath(join(workspace, 'runtime.sqlite')),
    );
    try {
      const state = stateStore.sessions.loadSnapshot<RuntimeState>(sessionId);
      expect(state).not.toBeNull();
      stateStore.checkpoints.saveNamedSnapshot(
        sessionId,
        'tui-rewind-checkpoint',
        state!,
        stateStore.sessions.getLastEventPosition(sessionId),
      );
    } finally {
      stateStore.close();
    }
    const rewind = await manager.executeRewind({
      sourceThreadId: sessionId,
      snapshotId: 'tui-rewind-checkpoint',
      scope: 'conversation_only',
      workspace,
    });
    expect(rewind?.targetThreadId).not.toBe(sessionId);
    expect(manager.getRuntime(rewind!.targetThreadId)).toBeDefined();
    expect(model.getRequestCount()).toBe(1);

    const compaction = await manager.handleContextCompaction(sessionId);
    expect(compaction?.events).toContainEqual({
      type: 'context.compaction',
      status: 'failed',
      summary: 'Context compaction failed.',
    });
    // The committed manual request has one terminal projection and no
    // duplicate turn dispatch.
    expect(model.getRequestCount()).toBe(1);
  } finally {
    await manager.dispose();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    model.stop();
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
});

function createHostShellExecutor(): AppShellExecutor {
  const executor = (async ({ command }: Parameters<AppShellExecutor>[0]) => ({
    ok: true,
    command,
    exitCode: 0,
    stdout: '',
    stderr: '',
  })) as AppShellExecutor;
  Object.defineProperty(executor, APP_PREPARED_SHELL_EXECUTION_, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      execute: async (input: { command: string }) =>
        projectAppHostShellResult({
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
    }),
  });
  executor.prepare = async () => ({ mode: 'host_shell', backend: 'none' });
  return executor;
}
