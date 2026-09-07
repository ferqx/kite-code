import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
import { DesktopClient } from '../src/client';
import type { DesktopInvoke } from '../src/transport';

test('lost start-turn receipt preserves the actual file effect and reconnect does not replay it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-lost-receipt-')));
  for (const name of ['workspace', 'home', 'runtime', 'config']) mkdirSync(join(root, name));
  const workspace = join(root, 'workspace');
  const marker = join(workspace, 'marker.txt');
  const model = createMockModelServer();
  model.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'write-marker',
            name: 'write_file',
            args: { path: 'marker.txt', content: 'one actual write' },
          },
        ],
      },
    },
    { message: { content: 'Write completed.' } },
  ]);
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
  let generation = 0;
  let startCommands = 0;
  let lostReceipt: unknown;
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  const call: DesktopInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'select_workspace') return workspace as T;
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
          KITE_APP_SERVER_BUILD_ID: 'desktop-resilience',
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
        expectedServerVersion: kiteAppServerVersion('desktop-resilience'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number)!;
    if (command === 'runtime_send') {
      const message = JSON.parse(args?.frame as string);
      if (message.method === 'runtime/command' && message.params.command.type === 'start_turn') {
        startCommands++;
        lostReceipt = message.id;
      }
      await carrier.connection.send(message);
    } else if (command === 'runtime_receive') {
      const item = await carrier.messages.next();
      if (item.done) throw new Error('closed');
      const message = item.value as { id?: unknown; result?: { status?: string } };
      if (lostReceipt !== undefined && message.id === lostReceipt) {
        lostReceipt = undefined;
        expect(message.result?.status).toBe('applied');
        const deadline = Date.now() + 10_000;
        while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
        expect(readFileSync(marker, 'utf8')).toBe('one actual write');
        throw new Error('injected lost receipt');
      }
      return JSON.stringify(message) as T;
    } else if (command === 'runtime_close') await carrier.connection.close();
    else throw new Error(`Unexpected IPC ${command}`);
    return undefined as T;
  };
  const client = new DesktopClient(call);
  try {
    await client.openProject();
    await client.trustProject();
    await client.newSession();
    const sessionId = client.getSnapshot().selected;
    let failed = false;
    try {
      await client.send('Write the marker exactly once.');
    } catch (error) {
      failed = true;
      client.report(error);
    }
    expect(failed).toBe(true);
    expect(client.getSnapshot().connected).toBe(false);
    expect(client.getSnapshot().ready).toBe(false);
    expect(client.getSnapshot().error).toContain('未知');
    await client.connect();
    expect(client.getSnapshot().selected).toBe(sessionId);
    expect(client.getSnapshot().ready).toBe(true);
    expect(
      client
        .getSnapshot()
        .messages.filter(
          (message) => message.role === 'user' && message.text === 'Write the marker exactly once.',
        ),
    ).toHaveLength(1);
    expect(startCommands).toBe(1);
    expect(readFileSync(marker, 'utf8')).toBe('one actual write');
    expect(client.getSnapshot().messages.filter((message) => message.changeConfirmed)).toHaveLength(
      1,
    );
  } finally {
    await client.disconnect();
    await Promise.all([...carriers.values()].map((carrier) => carrier.connection.close()));
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
