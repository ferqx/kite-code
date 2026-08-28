import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { RUNTIME_COMMAND_SCHEMA_, type RuntimeAccessNotification } from '@kite-ai/runtime-contract';
import type { AppShellExecutor } from '#kite-service/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  projectAppHostShellResult,
} from '#kite-service/sandbox/prepared-tool-pipeline';
import { createMockModelServer } from '../harness/fixtures';
import { createInProcessTuiServiceConnector } from './in-process-service-connector';

test('test-only Service connector executes and streams one injected shell through Runtime', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-tui-service-fixture-'));
  const codeRoot = join(root, '.kite-code');
  const workspace = join(root, 'workspace');
  mkdirSync(codeRoot);
  mkdirSync(workspace);
  const model = createMockModelServer();
  model.setResponses([
    {
      message: {
        content: 'Run shell.',
        tool_calls: [{ id: 'shell-1', name: 'shell_execute', args: { command: 'pwd' } }],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'shell-1', contentIncludes: ['fixture-progress'] }],
      },
      message: {
        reasoning_chunks: ['Checking completion.'],
        content_chunks: ['Done', '.'],
      },
    },
  ]);
  writeFileSync(
    join(codeRoot, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        fixture: {
          type: 'openai-compatible',
          apiKey: 'test',
          baseURL: model.baseURL,
          models: [{ name: 'mock-model', default: true }],
        },
      },
      interactionMode: 'full',
      sandbox: { enabled: false },
    }),
  );
  let calls = 0;
  let receivedProgressCallback = false;
  const shell = (async (input) => {
    calls += 1;
    receivedProgressCallback = input.onProgress !== undefined;
    input.onProgress?.('fixture-progress\n', 'stdout');
    return {
      ok: true as const,
      command: input.command,
      exitCode: 0,
      stdout: 'fixture-progress\n',
      stderr: '',
    };
  }) as AppShellExecutor;
  shell.prepare = async () => ({ mode: 'host_shell', backend: 'none' });
  Object.defineProperty(shell, APP_PREPARED_SHELL_EXECUTION_, {
    value: Object.freeze({
      execute: async (
        input: Parameters<
          NonNullable<(typeof shell)[typeof APP_PREPARED_SHELL_EXECUTION_]>['execute']
        >[0],
      ) =>
        projectAppHostShellResult(
          await shell({
            workspace: input.workspace,
            command: input.command,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            sandboxInvocationIdentity: input.identity,
          }),
        ),
    }),
  });
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = codeRoot;
  const connection = await createInProcessTuiServiceConnector(shell).connect({ workspace });
  try {
    const trust = await connection.app.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace,
    });
    await connection.app.decideWorkspaceTrust({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: trust.workspace,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
      externalReadScopeDigest: trust.externalReadScope.digest,
    });
    await connection.connect();
    const sessionId = 'fixture-shell-session';
    const created = await connection.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-fixture-shell',
      type: 'create_session',
      workspace: trust.workspace.canonicalPath,
      bootstrapSessionId: sessionId,
    });
    if (created.status !== 'applied') throw new Error('fixture create failed');
    const stream = await connection.runtime.subscribeReady({
      spec: { scope: 'session', sessionId, includeEphemeral: true },
    });
    const observed: string[] = [];
    const terminal = waitForTerminal(stream, observed);
    await connection.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'start-fixture-shell',
      type: 'start_turn',
      sessionId,
      expectedRevision: created.revision,
      input: 'run shell',
    });
    await Promise.race([
      terminal,
      Bun.sleep(3_000).then(() => {
        throw new Error(`fixture turn stalled; shellCalls=${calls}; events=${observed.join(',')}`);
      }),
    ]);
    expect(calls).toBe(1);
    expect(receivedProgressCallback).toBeTrue();
    expect(observed.some((event) => event.includes('"type":"tool.queued"'))).toBeTrue();
    expect(observed.some((event) => event.includes('"type":"tool.started"'))).toBeTrue();
    expect(observed.some((event) => event.includes('"type":"tool.progress"'))).toBeTrue();
    expect(
      observed.some(
        (event) => event.includes('"type":"run.terminal"') && event.includes('"completed"'),
      ),
    ).toBeTrue();
  } finally {
    await connection.close();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

async function waitForTerminal(
  stream: AsyncIterable<RuntimeAccessNotification>,
  observed: string[],
): Promise<void> {
  for await (const notification of stream) {
    if ('durability' in notification) {
      const event =
        notification.durability === 'ephemeral'
          ? notification.event
          : notification.projection.event;
      if (event) observed.push(JSON.stringify(event));
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      (notification.projection.event?.type === 'run.terminal' ||
        notification.projection.event?.type === 'turn.terminal')
    ) {
      return;
    }
  }
  throw new Error('fixture subscription closed before terminal');
}
