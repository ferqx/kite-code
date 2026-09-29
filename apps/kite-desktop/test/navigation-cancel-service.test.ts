import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
import {
  RendererConnection,
  type ServiceProcessCarrier,
} from '../electron/runtime/renderer-connection';
import { DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

/** A real Service pipe behind the Electron renderer's frame and generation bridge. */
class BridgedService implements ServiceProcessCarrier {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #connection: RuntimeClientConnection;
  readonly #frames: string[] = [];
  #waiting?: { resolve: (frame: string) => void; reject: (error: Error) => void };
  #heldFrame?: string;
  holdSession?: string;
  heldRequestId?: string;
  finished = false;
  closeCount = 0;

  get hasHeldFrame(): boolean {
    return this.#heldFrame !== undefined;
  }

  constructor(connection: RuntimeClientConnection) {
    this.#connection = connection;
    void this.#pump().catch(() => undefined);
  }

  async #pump(): Promise<void> {
    try {
      for await (const value of this.#connection.messages()) {
        const frame = JSON.stringify(value);
        const message = value as { id?: unknown };
        if (this.heldRequestId && message.id === this.heldRequestId && !this.#heldFrame) {
          this.#heldFrame = frame;
          continue;
        }
        this.#deliver(frame);
      }
    } finally {
      this.finished = true;
      this.#waiting?.reject(new Error('Service closed.'));
      this.#waiting = undefined;
    }
  }

  #deliver(frame: string): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting.resolve(frame);
    } else this.#frames.push(frame);
  }

  async send(frame: string): Promise<void> {
    const message = JSON.parse(frame) as Record<string, unknown>;
    this.sent.push(message);
    const params = message.params as { sessionId?: string } | undefined;
    if (message.method === 'history/load_session' && params?.sessionId === this.holdSession) {
      this.heldRequestId = message.id as string;
      this.holdSession = undefined;
    }
    await this.#connection.send(message as RuntimeProtocolMessage);
  }

  receive(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('Receive cancelled.'));
    const frame = this.#frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.#waiting) return Promise.reject(new Error('Concurrent Service receive.'));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.#waiting?.resolve !== finish) return;
        this.#waiting = undefined;
        reject(new Error('Receive cancelled.'));
      };
      const finish = (value: string) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const fail = (error: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      this.#waiting = { resolve: finish, reject: fail };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async waitForReceiver(): Promise<void> {
    while (this.#waiting) await Bun.sleep(1);
  }

  releaseHeld(): void {
    if (this.#heldFrame) this.#deliver(this.#heldFrame);
    this.#heldFrame = undefined;
  }

  async close(): Promise<void> {
    this.closeCount++;
    await this.#connection.close();
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(10);
  }
}

test('Desktop keeps a running Session ready while cancelled History reads cross the real Service bridge', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-history-cancel-')));
  const workspace = join(root, 'workspace');
  for (const name of ['workspace', 'home', 'runtime', 'config'])
    mkdirSync(join(root, name), { mode: 0o700 });
  let releaseModel!: () => void;
  let modelEntered = false;
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const model = createMockModelServer();
  model.setResponses([
    {
      response: async () => {
        modelEntered = true;
        await modelGate;
        return { message: { content: 'background run survived navigation' } };
      },
    },
  ]);
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: model.baseURL,
          model: 'test-model',
          models: ['test-model'],
        },
      },
      model: { default: { provider: 'test', name: 'test-model' } },
      sandbox: { enabled: true },
      mcpServers: {},
    }),
  );
  let service: BridgedService | undefined;
  let client: DesktopClient | undefined;
  let detachCount = 0;
  try {
    const pipe = await createBunStdioChildRuntimeClientTransport({
      argv: [
        process.execPath,
        resolve('apps/kite-desktop/test/fixtures/isolated-store-service.ts'),
        'app-server',
        'run-stdio',
      ],
      cwd: '/',
      env: {
        KITE_CODE_HOME: join(root, 'runtime'),
        KITE_CODE_CONFIG_HOME: join(root, 'config'),
        KITE_APP_SERVER_WORKSPACE: workspace,
        KITE_APP_SERVER_BUILD_ID: 'desktop-history-cancel',
        KITE_DESKTOP_TEST_ROOT: root,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
    }).connect();
    service = new BridgedService(pipe);
    const bridge = new RendererConnection(service, kiteAppServerVersion('desktop-history-cancel'));
    const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === 'runtime_status') return { workspace, connectionId: null } as T;
      if (command === 'list_projects') return [{ path: workspace, lastOpenedAt: 1 }] as T;
      if (command === 'activate_workspace' || command === 'check_workspace') return workspace as T;
      if (command === 'query_workspace_branch')
        return {
          workspace,
          repository: false,
          root: workspace,
          current: null,
          head: null,
          branches: [],
          dirty: false,
          canSwitch: false,
        } as T;
      if (command === 'runtime_open') {
        await bridge.attach(1);
        return {
          connectionId: 1,
          workspace,
          expectedServerVersion: kiteAppServerVersion('desktop-history-cancel'),
        } as T;
      }
      if (command === 'runtime_send') {
        await bridge.send(args!.connectionId as number, args!.frame as string);
        return undefined as T;
      }
      if (command === 'runtime_receive')
        return (await bridge.receive(args!.connectionId as number)) as T;
      if (command === 'runtime_detach') {
        detachCount++;
        return undefined as T;
      }
      if (command === 'runtime_close') {
        await bridge.close();
        return undefined as T;
      }
      throw new Error(`Unexpected desktop bridge command: ${command}`);
    };
    client = new DesktopClient(createTestDesktopBridge(call));
    await client.refreshProjects();
    await client.restoreWorkspace();
    await client.activateProject(workspace);
    expect(client.getSnapshot().trust?.status).toBe('trusted');
    const sessionA = await client.newSession();
    const sessionB = await client.newSession();
    await client.selectSession(sessionA);
    await client.send('Complete the long background run.');
    await waitFor(() => modelEntered, 'model request for running Session A');
    expect(client.getSnapshot().projection?.currentRun?.status).toBe('running');

    await client.selectSession(sessionB);
    for (let index = 0; index < 3; index++) {
      const priorCancels = service.sent.filter(
        (message) => message.method === 'history/cancel',
      ).length;
      service.holdSession = sessionA;
      const staleA = client.selectSession(sessionA);
      await waitFor(() => service!.hasHeldFrame, 'held Session A History response');
      const originalWireId = service.heldRequestId;
      if (!originalWireId) throw new Error('History request never crossed the Electron bridge.');
      const backToB = client.selectSession(sessionB);
      await waitFor(
        () =>
          service!.sent.filter((message) => message.method === 'history/cancel').length >
          priorCancels,
        'History cancel reaching the Service pipe',
      );
      const cancel = service.sent.filter((message) => message.method === 'history/cancel').at(-1)!;
      expect(cancel).not.toHaveProperty('id');
      expect((cancel.params as { requestId: string }).requestId).toBe(originalWireId);
      service.releaseHeld();
      await Promise.all([staleA, backToB]);
      expect(client.getSnapshot()).toMatchObject({ selected: sessionB, ready: true });
    }

    for (let index = 0; index < 3; index++) {
      await client.selectSession(sessionA);
      expect(client.getSnapshot()).toMatchObject({ selected: sessionA, ready: true });
      await client.selectSession(sessionB);
      expect(client.getSnapshot()).toMatchObject({ selected: sessionB, ready: true });
    }
    await client.selectSession(sessionA);
    expect(client.getSnapshot()).toMatchObject({ selected: sessionA, ready: true });
    expect(client.getSnapshot().projection?.currentRun?.status).toBe('running');
    expect(detachCount).toBe(0);
    expect(service.closeCount).toBe(0);
    expect(service.finished).toBe(false);

    releaseModel();
    await waitFor(
      () => client!.getSnapshot().projection?.currentRun?.status === 'completed',
      'Session A completion after navigation',
      15_000,
    );
    expect(client.getSnapshot()).toMatchObject({ selected: sessionA, ready: true });
    expect(
      client
        .getSnapshot()
        .messages.some((message) => message.text === 'background run survived navigation'),
    ).toBe(true);
  } finally {
    releaseModel();
    await client?.disconnect().catch(() => undefined);
    await service?.close().catch(() => undefined);
    model.assertComplete({ allowUnconsumedResponses: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
