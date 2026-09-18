import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { startTestHttpServer } from '../../../../tests/helpers/test-http-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { DesktopClient } from '../../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from '../desktop-bridge';

test('DesktopClient sends an unrelated turn through real Service with required MCP offline', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-mcp-offline-')));
  for (const name of ['workspace', 'home', 'runtime', 'config'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const workspace = join(root, 'workspace');
  let mcpRequests = 0;
  const mcp = startTestHttpServer({
    fetch: () => {
      mcpRequests += 1;
      return new Response('Unauthorized', { status: 401 });
    },
  });
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'Desktop turn completed.' } }]);
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
      features: { mcpProviderAction: true },
      sandbox: { enabled: true },
    }),
  );
  writeFileSync(
    join(root, 'config/mcp.json'),
    JSON.stringify({
      mcpServers: { oauth: { type: 'http', url: `${mcp.url.origin}/mcp`, required: true } },
    }),
  );
  let generation = 0;
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'runtime_status') return { workspace, connectionId: generation || null } as T;
    if (command === 'activate_workspace' || command === 'pick_workspace') return workspace as T;
    if (command === 'list_projects') return [{ path: workspace, lastOpenedAt: 1 }] as T;
    if (command === 'check_workspace' || command === 'runtime_detach') return undefined as T;
    if (command === 'query_workspace_branch')
      return {
        workspace,
        repository: false,
        root: null,
        current: null,
        head: null,
        branches: [],
        dirty: false,
        canSwitch: false,
      } as T;
    if (command === 'runtime_open') {
      const connection = await createBunStdioChildRuntimeClientTransport({
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
          KITE_APP_SERVER_BUILD_ID: 'desktop-global-gates-test',
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      }).connect();
      carriers.set(++generation, {
        connection,
        messages: connection.messages()[Symbol.asyncIterator](),
      });
      return {
        connectionId: generation,
        workspace,
        expectedServerVersion: kiteAppServerVersion('desktop-global-gates-test'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number);
    if (!carrier) throw new Error(`No Service carrier for ${command}`);
    if (command === 'runtime_send') {
      await carrier.connection.send(JSON.parse(args?.frame as string));
      return undefined as T;
    }
    if (command === 'runtime_receive') {
      const item = await carrier.messages.next();
      if (item.done) throw new Error('Service carrier closed');
      return JSON.stringify(item.value) as T;
    }
    if (command === 'runtime_close') {
      await carrier.connection.close();
      return undefined as T;
    }
    throw new Error(`Unexpected Desktop IPC command: ${command}`);
  };
  const client = new DesktopClient(createTestDesktopBridge(call));
  try {
    await client.activateProject(workspace);
    await client.trustProject();
    await client.refreshMcp();
    const sessionId = await client.newSession();
    await client.selectSession(sessionId);
    await client.send('Answer without using MCP.');
    const deadline = Date.now() + 15_000;
    while (
      !client
        .getSnapshot()
        .messages.some((message) => message.text === 'Desktop turn completed.') &&
      Date.now() < deadline
    )
      await Bun.sleep(20);
    expect(
      client.getSnapshot().messages.some((message) => message.text === 'Desktop turn completed.'),
    ).toBe(true);
    expect(model.getRequestCount()).toBe(1);
    const mcpDeadline = Date.now() + 10_000;
    while (mcpRequests === 0 && Date.now() < mcpDeadline) await Bun.sleep(20);
    expect(mcpRequests).toBeGreaterThan(0);
    model.assertComplete();
  } finally {
    await client.disconnect();
    await Promise.all([...carriers.values()].map((carrier) => carrier.connection.close()));
    model.stop();
    mcp.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
