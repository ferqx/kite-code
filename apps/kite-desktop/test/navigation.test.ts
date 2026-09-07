import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { DesktopClient } from '../src/client';
import type { DesktopInvoke } from '../src/transport';

test('desktop navigation isolates projects, rejects foreign sessions, and ignores a superseded selection', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-navigation-')));
  for (const name of ['a', 'b', 'home', 'runtime', 'config']) mkdirSync(join(root, name));
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: 'http://127.0.0.1:1/v1',
          model: 'test-model',
          models: ['test-model'],
        },
      },
      model: { default: { provider: 'test', name: 'test-model' } },
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  let workspace = join(root, 'a');
  let generation = 0;
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  let holdNextQuery = false;
  let heldId: unknown;
  let release!: () => void;
  let observed!: () => void;
  let held = Promise.resolve();
  let received = Promise.resolve();
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
          KITE_APP_SERVER_BUILD_ID: 'desktop-navigation',
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
        expectedServerVersion: kiteAppServerVersion('desktop-navigation'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number)!;
    if (command === 'runtime_send') {
      const message = JSON.parse(args?.frame as string);
      if (holdNextQuery && message.method === 'runtime/query') {
        holdNextQuery = false;
        heldId = message.id;
      }
      await carrier.connection.send(message);
    } else if (command === 'runtime_receive') {
      const item = await carrier.messages.next();
      if (item.done) throw new Error('closed');
      const message = item.value as { id?: unknown };
      if (heldId !== undefined && message.id === heldId) {
        heldId = undefined;
        observed();
        await held;
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
    const first = client.getSnapshot().selected!;
    await client.newSession();
    const second = client.getSnapshot().selected!;
    expect(
      client
        .getSnapshot()
        .sessions.map((session) => session.sessionId)
        .sort(),
    ).toEqual([first, second].sort());
    held = new Promise<void>((done) => {
      release = done;
    });
    received = new Promise<void>((done) => {
      observed = done;
    });
    holdNextQuery = true;
    const staleSelection = client.selectSession(first);
    await received;
    const currentSelection = client.selectSession(second);
    release();
    await Promise.all([staleSelection, currentSelection]);
    expect(client.getSnapshot().selected).toBe(second);
    expect(client.getSnapshot().projection?.sessionId).toBe(second);
    expect(client.getSnapshot().ready).toBe(true);
    await client.disconnect();
    workspace = join(root, 'b');
    await client.openProject();
    expect(client.getSnapshot().selected).toBeUndefined();
    expect(client.getSnapshot().messages).toEqual([]);
    expect(client.getSnapshot().sessions).toEqual([]);
    await expect(client.selectSession(first)).rejects.toThrow('不属于当前项目');
    expect(client.getSnapshot().ready).toBe(false);
    await client.disconnect();
    workspace = join(root, 'a');
    await client.openProject();
    expect(
      client
        .getSnapshot()
        .sessions.map((session) => session.sessionId)
        .sort(),
    ).toEqual([first, second].sort());
    await client.selectSession(first);
    expect(client.getSnapshot().ready).toBe(true);
  } finally {
    release?.();
    await client.disconnect();
    await Promise.all([...carriers.values()].map((carrier) => carrier.connection.close()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
