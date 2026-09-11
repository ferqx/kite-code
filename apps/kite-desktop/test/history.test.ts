import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
} from '@kite-ai/kite-local-runtime/client/protocol';
import { RUNTIME_PROTOCOL_LIMITS } from '@kite-ai/runtime-protocol';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
import { projectEvent } from '../src/presentation';

test('large durable history crosses frame boundaries and restores every response after restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-history-')));
  for (const name of ['workspace', 'home', 'runtime', 'config']) mkdirSync(join(root, name));
  const workspace = join(root, 'workspace');
  const model = createMockModelServer();
  const responses = Array.from(
    { length: 20 },
    (_, index) => `response-${index}:${'x'.repeat(32_768)}`,
  );
  model.setResponses(responses.map((content) => ({ message: { content } })));
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: model.baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'test', name: 'mock-model' } },
      interactionMode: 'accept_edits',
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  let largestFrame = 0;
  let historyRequests = 0;
  const connect = () => {
    const transport = createBunStdioChildRuntimeClientTransport({
      argv: [
        process.execPath,
        resolve('scripts/release/entrypoints/service.ts'),
        'app-server',
        'run-stdio',
      ],
      cwd: '/',
      env: {
        KITE_CODE_HOME: join(root, 'runtime'),
        KITE_CODE_CONFIG_HOME: join(root, 'config'),
        KITE_APP_SERVER_WORKSPACE: workspace,
        KITE_APP_SERVER_BUILD_ID: 'desktop-history',
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
    });
    return createAppServerProtocolConnection(
      {
        async connect() {
          const connection = await transport.connect();
          return {
            send(message) {
              if ('method' in message && message.method === 'history/load_session')
                historyRequests++;
              return connection.send(message);
            },
            async *messages() {
              for await (const message of connection.messages()) {
                largestFrame = Math.max(
                  largestFrame,
                  new TextEncoder().encode(JSON.stringify(message)).byteLength,
                );
                yield message;
              }
            },
            close: () => connection.close(),
          };
        },
      },
      kiteAppServerVersion('desktop-history'),
      { name: 'desktop-history', version: '1', instanceId: crypto.randomUUID() },
      KITE_APP_SERVER_PROTOCOL_METHODS_,
    );
  };
  let client = connect();
  const sessionId = crypto.randomUUID();
  try {
    await client.prepareAppControl();
    const trust = await client.app.queryWorkspaceTrust({
      schema: 'kite.app.workspace-trust.query-request.v1',
      workspace,
    });
    await client.app.decideWorkspaceTrust({
      schema: 'kite.app.workspace-trust.decision-request.v1',
      workspace: trust.workspace,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
      externalReadScopeDigest: trust.externalReadScope.digest,
    });
    const created = await client.runtime.command({
      schema: 'kite.runtime-command.v1',
      commandId: crypto.randomUUID(),
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Session creation failed');
    let revision = created.revision;
    for (let index = 0; index < responses.length; index++) {
      const admissionDeadline = Date.now() + 5_000;
      for (;;) {
        const started = await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'start_turn',
          sessionId,
          expectedRevision: revision,
          input:
            index === 0
              ? `Respond token=fixture-secret-value ${'long input '.repeat(40)}`
              : `Respond for turn ${index}.`,
          phase: 'building',
        });
        if (started.status === 'applied') break;
        // The terminal fact may precede release of the execution slot. Only an
        // explicit rejection is retried here; an unknown receipt is never replayed.
        expect(started).toMatchObject({ status: 'rejected', code: 'runtime_busy' });
        if (Date.now() > admissionDeadline) throw new Error('Execution slot did not release');
        await Bun.sleep(10);
      }
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = await client.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId,
        });
        if (result.status !== 'ok' || !('session' in result) || !result.session)
          throw new Error('Missing session');
        if (result.session.currentRun?.status === 'completed') {
          revision = result.session.revision;
          break;
        }
        if (
          Date.now() > deadline ||
          ['failed', 'cancelled', 'recovery_required'].includes(
            result.session.currentRun?.status ?? '',
          )
        )
          throw new Error('Large history turn failed');
        await Bun.sleep(10);
      }
    }
    await client.close();
    client = connect();
    await client.prepareAppControl();
    const directory = await client.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'list_sessions',
    });
    if (directory.status !== 'ok') throw new Error('Missing restored directory');
    expect(
      directory.sessions?.find((session) => session.sessionId === sessionId)?.currentRun?.status,
    ).toBe('completed');
    const restored = await client.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (restored.status !== 'ok') throw new Error('Missing restored projection');
    expect(restored.session?.currentRun?.status).toBe('completed');
    const summaries = await client.history.listSessions({ limit: 10 });
    const summary = summaries.entries.find((entry) => entry.sessionId === sessionId)!;
    expect(summary.displayName).toContain('[redacted]');
    expect(summary.displayName).not.toContain('fixture-secret-value');
    expect(summary.displayName.length).toBeLessThanOrEqual(80);
    expect(summary.workspace?.workspaceDigest).toBeDefined();
    const transcript = await client.history.loadSession(sessionId);
    expect(new TextEncoder().encode(JSON.stringify(transcript)).byteLength).toBeGreaterThan(
      RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
    );
    expect(historyRequests).toBeGreaterThan(1);
    expect(largestFrame).toBeLessThanOrEqual(RUNTIME_PROTOCOL_LIMITS.maxMessageBytes);
    const messages = transcript.events.reduce(
      projectEvent,
      [] as Parameters<typeof projectEvent>[0],
    );
    expect(
      messages.filter((message) => message.role === 'assistant').map((message) => message.text),
    ).toEqual(responses);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(responses.length);
    expect(new Set(transcript.records.map((record) => record.sequence)).size).toBe(
      transcript.records.length,
    );
    expect(model.getRequestCount()).toBe(responses.length);
    model.assertComplete();
  } finally {
    await client.close();
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
