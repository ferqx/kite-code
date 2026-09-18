import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createKiteAppServerClient } from '@kite-ai/kite-local-runtime/client';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
import { projectEvent } from '../src/presentation';

test('desktop protocol configures a provider, modifies and verifies code, then continues durable history', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-development-')));
  const workspace = join(root, 'workspace');
  for (const name of ['workspace', 'home', 'runtime', 'config'])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(join(workspace, 'user.txt'), 'existing user content');
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      sandbox: { enabled: false },
      interactionMode: 'accept_edits',
      mcpServers: {},
    }),
  );
  const model = createMockModelServer();
  const replacement = createMockModelServer();
  replacement.setResponses([{ message: { content: 'Using the replaced provider endpoint.' } }]);
  model.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'write-code',
            name: 'write_file',
            args: {
              path: 'sum.test.ts',
              content:
                "import { expect, test } from 'bun:test';\ntest('sum', () => expect(1 + 2).toBe(3));\n",
            },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'write-code', contentIncludes: ['Wrote 2 lines'] }],
      },
      message: {
        tool_calls: [
          {
            id: 'verify-code',
            name: 'shell_execute',
            args: { command: 'bun test sum.test.ts 2>&1' },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'verify-code', contentIncludes: ['1 pass'] }],
      },
      message: { content: 'Code written and tests passed.' },
    },
    { message: { content: 'Continuing the same saved session.' } },
  ]);
  const connect = () =>
    createKiteAppServerClient({
      executable: process.execPath,
      argumentsPrefix: [resolve('scripts/release/entrypoints/service.ts')],
      buildId: 'desktop-development-test',
      runtimeRoot: join(root, 'runtime'),
      configRoot: join(root, 'config'),
      osHome: join(root, 'home'),
      workspace,
      cwd: '/',
      environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      clientInfo: {
        name: 'kite-desktop-development',
        version: '1',
        instanceId: crypto.randomUUID(),
      },
    });
  let client = connect();
  const sessionId = crypto.randomUUID();
  const settle = async () => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await client.runtime.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      if (result.status !== 'ok' || !result.session) throw new Error('Missing session projection');
      const projection = result.session;
      const interaction = projection.interactionQueue.interactions.find(
        (entry) => entry.interactionId === projection.interactionQueue.activeInteractionId,
      );
      if (interaction?.kind === 'approval') {
        const receipt = await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'respond_interaction',
          sessionId,
          expectedRevision: interaction.sessionRevision,
          interaction,
          response: { kind: 'approval', decision: 'approve_once' },
        });
        expect(receipt.status).toBe('applied');
      }
      if (projection.currentRun?.status === 'completed') return;
      if (
        projection.currentRun &&
        ['failed', 'cancelled', 'recovery_required'].includes(projection.currentRun.status)
      ) {
        model.assertComplete({ allowUnconsumedResponses: true });
        throw new Error(`Unexpected terminal ${projection.currentRun.status}`);
      }
      await Bun.sleep(30);
    }
    throw new Error('Development task timed out');
  };
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
    const saved = await client.credential.writeProviderCredential({
      schema: 'kite.local-runtime-credential-request.v1',
      operation: 'write_provider_api_key',
      mutationId: crypto.randomUUID(),
      providerId: 'openai-compatible',
      apiKey: 'local-fixture',
      baseURL: model.baseURL,
      modelName: 'mock-model',
    });
    expect(saved.outcome).toBe('applied');
    const models = await client.app.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace: trust.workspace,
    });
    const selected = await client.app.selectProviderModel({
      schema: 'kite.app.provider-model.select-request.v1',
      workspace: trust.workspace,
      expectedRevision: models.revision,
      provider: 'openai-compatible',
      name: 'mock-model',
    });
    expect(['applied', 'already_selected']).toContain(selected.outcome);
    expect(
      (
        await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'create_session',
          workspace,
          bootstrapSessionId: sessionId,
        })
      ).status,
    ).toBe('applied');
    expect(
      (
        await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'start_turn',
          sessionId,
          expectedRevision: 0,
          input: 'Write a sum test and run it.',
          phase: 'building',
        })
      ).status,
    ).toBe('applied');
    await settle();
    const transcript = await client.history.loadSession(sessionId);
    const messages = transcript.events.reduce(
      (current, event) => projectEvent(current, event),
      [] as ReturnType<typeof projectEvent>,
    );
    const change = messages.find((message) => message.changeConfirmed);
    expect(change?.changedFile).toBe('sum.test.ts');
    expect(change?.toolResult?.stdout).toContain("test('sum'");
    expect(
      messages.some(
        (message) =>
          message.toolResult?.ok &&
          `${message.toolResult.stdout}\n${message.toolResult.stderr}`.includes('1 pass'),
      ),
    ).toBe(true);
    expect(readFileSync(join(workspace, 'user.txt'), 'utf8')).toBe('existing user content');
    await client.close();
    client = connect();
    await client.prepareAppControl();
    await client.app.queryWorkspaceTrust({
      schema: 'kite.app.workspace-trust.query-request.v1',
      workspace,
    });
    await client.app.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace: trust.workspace,
    });
    expect((await client.history.loadSession(sessionId)).events).toEqual(transcript.events);
    expect(model.getRequestCount()).toBe(3);
    expect(
      (
        await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'resume_session',
          sessionId,
        })
      ).status,
    ).toBe('applied');
    const current = await client.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (current.status !== 'ok' || !current.session) throw new Error('Missing resumed session');
    expect(
      (
        await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'start_turn',
          sessionId,
          expectedRevision: current.session.revision,
          input: 'Continue.',
          phase: 'building',
        })
      ).status,
    ).toBe('applied');
    await settle();
    model.assertComplete();
    expect(
      (
        await client.credential.writeProviderCredential({
          schema: 'kite.local-runtime-credential-request.v1',
          operation: 'write_provider_api_key',
          mutationId: crypto.randomUUID(),
          providerId: 'openai-compatible',
          apiKey: 'replacement-fixture',
          baseURL: replacement.baseURL,
          modelName: 'mock-model',
        })
      ).outcome,
    ).toBe('applied');
    const replacedModels = await client.app.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace: trust.workspace,
    });
    expect(
      (
        await client.app.selectProviderModel({
          schema: 'kite.app.provider-model.select-request.v1',
          workspace: trust.workspace,
          expectedRevision: replacedModels.revision,
          provider: 'openai-compatible',
          name: 'mock-model',
        })
      ).outcome,
    ).toBe('already_selected');
    const replacedSession = await client.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (replacedSession.status !== 'ok' || !replacedSession.session)
      throw new Error('Missing session');
    expect(
      (
        await client.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: crypto.randomUUID(),
          type: 'start_turn',
          sessionId,
          expectedRevision: replacedSession.session.revision,
          input: 'Use the updated provider endpoint.',
          phase: 'building',
        })
      ).status,
    ).toBe('applied');
    await settle();
    expect(model.getRequestCount()).toBe(4);
    expect(replacement.getRequestCount()).toBe(1);
    replacement.assertComplete();
  } finally {
    await client.close();
    model.stop();
    replacement.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
