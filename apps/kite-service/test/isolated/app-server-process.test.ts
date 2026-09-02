import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteAppServerClient } from '@kite-ai/kite-local-runtime/client';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteSessionAppServerStorageComposition } from '../../src/bootstrap';
import { trustWorkspace } from '../../src/config/workspace-trust';

describe('KASD parent-owned App Server process', () => {
  test('the same-build client composes Runtime, History and App Control over one child', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-server-client-')),
    );
    const runtimeRoot = join(root, 'runtime');
    const configRoot = join(root, 'config');
    const osHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    for (const path of [runtimeRoot, configRoot, osHome, workspace]) mkdirSync(path);
    const client = createKiteAppServerClient({
      executable: process.execPath,
      argumentsPrefix: [
        join(import.meta.dir, '../../../../scripts/release/entrypoints/service.ts'),
      ],
      buildId: 'source-client-build',
      runtimeRoot,
      configRoot,
      osHome,
      workspace,
      cwd: '/',
      environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      clientInfo: { name: 'app-client-test', version: '1', instanceId: 'app-client-test-1' },
    });
    try {
      await client.connect();
      await expect(client.history.listSessions({ limit: 10 })).resolves.toEqual({
        entries: [],
        hasMore: false,
      });
      await expect(
        client.app.getReleaseStatus({ schema: 'kite.app.release-status.request.v1' }),
      ).resolves.toMatchObject({ schema: 'kite.app.release-status.response.v1' });
    } finally {
      await client[Symbol.asyncDispose]();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('serves exact Runtime JSONL and exits cleanly on parent EOF without a global endpoint', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-server-')),
    );
    const runtimeRoot = join(root, 'runtime');
    const configRoot = join(root, 'config');
    const osHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    for (const path of [runtimeRoot, configRoot, osHome, workspace]) mkdirSync(path);
    const buildId = 'test-app-server-build';
    const entrypoint = join(import.meta.dir, '../../../../scripts/release/entrypoints/service.ts');
    const child = Bun.spawn([process.execPath, entrypoint, 'app-server', 'run-stdio'], {
      cwd: '/',
      env: {
        ...process.env,
        KITE_CODE_HOME: runtimeRoot,
        KITE_CODE_CONFIG_HOME: configRoot,
        KITE_APP_SERVER_WORKSPACE: workspace,
        KITE_APP_SERVER_BUILD_ID: buildId,
        HOME: osHome,
        USERPROFILE: osHome,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'initialize-1',
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientInfo: { name: 'process-test', version: '1', instanceId: 'process-test-1' },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'list-1',
          method: 'runtime/query',
          params: { query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' } },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'history-1',
          method: 'history/list_sessions',
          params: { request: { limit: 10 } },
        })}\n`,
      );
      child.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
      const frames = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'initialize-1',
            result: expect.objectContaining({
              protocolVersion: 1,
              serverInfo: expect.objectContaining({
                version: `kite-app-server-v1-${createHash('sha256').update(buildId).digest('hex')}`,
              }),
              capabilities: expect.objectContaining({
                methods: expect.arrayContaining(['history/list_sessions', 'app/release/status']),
              }),
            }),
          }),
          expect.objectContaining({
            id: 'list-1',
            result: expect.objectContaining({
              queryType: 'list_sessions',
              sessions: [],
            }),
          }),
          expect.objectContaining({
            id: 'history-1',
            result: { entries: [], hasMore: false },
          }),
        ]),
      );
      expect(existsSync(join(runtimeRoot, 'kite-session.sqlite'))).toBe(true);
      expect(existsSync(join(runtimeRoot, 'service.sock'))).toBe(false);
      expect(existsSync(join(runtimeRoot, 'service.lock'))).toBe(false);
      expect(
        readdirSync(runtimeRoot).every((entry) => entry.startsWith('kite-session.sqlite')),
      ).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('cancels an active model on EOF and cleanly hands off after confirmed cleanup', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-server-active-')),
    );
    const runtimeRoot = join(root, 'runtime');
    const configRoot = join(root, 'config');
    const osHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    for (const path of [runtimeRoot, configRoot, osHome, workspace]) mkdirSync(path);
    const model = createMockModelServer();
    model.setResponses([{ delay: 10_000, message: { content: 'must-not-complete-late' } }]);
    writeAppServerConfig(configRoot, model.baseURL);
    expect(
      trustWorkspace({
        workspace,
        source: 'test',
        storePath: join(configRoot, 'workspace-trust.jsonc'),
      }).status,
    ).toBe('recorded');

    const entrypoint = join(import.meta.dir, '../../../../scripts/release/entrypoints/service.ts');
    const child = Bun.spawn([process.execPath, entrypoint, 'app-server', 'run-stdio'], {
      cwd: '/',
      env: {
        ...process.env,
        KITE_CODE_HOME: runtimeRoot,
        KITE_CODE_CONFIG_HOME: configRoot,
        KITE_APP_SERVER_WORKSPACE: workspace,
        KITE_APP_SERVER_BUILD_ID: 'active-build',
        HOME: osHome,
        USERPROFILE: osHome,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = new JsonlReader(child.stdout);
    const sessionId = 'active-eof-session';
    try {
      child.stdin.write(
        line('init', 'initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'active-test', version: '1', instanceId: 'active-test-1' },
        }),
      );
      expect(await output.next()).toMatchObject({ id: 'init', result: { protocolVersion: 1 } });
      child.stdin.write(
        line('app-release', 'app/release/status', {
          request: { schema: 'kite.app.release-status.request.v1' },
        }),
      );
      expect(await output.next()).toMatchObject({
        id: 'app-release',
        result: {
          method: 'app/release/status',
          response: { schema: 'kite.app.release-status.response.v1' },
        },
      });
      child.stdin.write(
        line('create', 'runtime/command', {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'create-active-eof',
            type: 'create_session',
            bootstrapSessionId: sessionId,
          },
        }),
      );
      expect(await output.next()).toMatchObject({ id: 'create', result: { status: 'applied' } });
      child.stdin.write(line('history-created', 'history/load_session', { sessionId }));
      expect(await output.next()).toMatchObject({
        id: 'history-created',
        result: {
          session: { sessionId },
          records: expect.any(Array),
          events: expect.any(Array),
        },
      });
      child.stdin.write(
        line('turn', 'runtime/command', {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'turn-active-eof',
            type: 'start_turn',
            sessionId,
            expectedRevision: 0,
            input: 'wait for model',
          },
        }),
      );
      expect(await output.next()).toMatchObject({ id: 'turn', result: { status: 'applied' } });
      await eventually(() => model.getRequestCount() === 1);
      child.stdin.end();
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

      const successor = createKiteSessionAppServerStorageComposition({
        databasePath: join(runtimeRoot, 'kite-session.sqlite'),
        hostInstanceId: 'successor-after-eof',
      });
      try {
        const recovery = successor.recovery.inspect(sessionId);
        expect(recovery).toMatchObject({
          authority: { status: 'idle', cleanupConfirmed: true },
          pendingEffects: [],
        });
        successor.runWithSessionExecution(sessionId, () => {
          successor.storage.sessions.setSessionName(sessionId, 'Recovered after EOF');
        });
        expect(model.getRequestCount()).toBe(1);
        successor.releaseExecutions(true);
      } finally {
        successor.disposeStorage();
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      model.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('fences a SIGKILLed active model as unknown and never replays its Provider request', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-server-sigkill-')),
    );
    const runtimeRoot = join(root, 'runtime');
    const configRoot = join(root, 'config');
    const osHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    for (const path of [runtimeRoot, configRoot, osHome, workspace]) mkdirSync(path);
    const model = createMockModelServer();
    model.setResponses([{ delay: 5_000, message: { content: 'late-response' } }]);
    writeAppServerConfig(configRoot, model.baseURL);
    expect(
      trustWorkspace({
        workspace,
        source: 'test',
        storePath: join(configRoot, 'workspace-trust.jsonc'),
      }).status,
    ).toBe('recorded');

    const childPath = join(import.meta.dir, '../fixtures/app-server-short-lease-child.ts');
    const child = Bun.spawn([process.execPath, childPath], {
      cwd: '/',
      env: {
        ...process.env,
        KITE_CODE_HOME: runtimeRoot,
        KITE_CODE_CONFIG_HOME: configRoot,
        KITE_APP_SERVER_WORKSPACE: workspace,
        KITE_APP_SERVER_BUILD_ID: 'sigkill-build',
        HOME: osHome,
        USERPROFILE: osHome,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = new JsonlReader(child.stdout);
    const sessionId = 'sigkill-session';
    try {
      child.stdin.write(
        line('init', 'initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'sigkill-test', version: '1', instanceId: 'sigkill-test-1' },
        }),
      );
      await output.next();
      child.stdin.write(
        line('create', 'runtime/command', {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'create-sigkill',
            type: 'create_session',
            bootstrapSessionId: sessionId,
          },
        }),
      );
      expect(await output.next()).toMatchObject({ id: 'create', result: { status: 'applied' } });
      child.stdin.write(
        line('turn', 'runtime/command', {
          command: {
            schema: 'kite.runtime-command.v1',
            commandId: 'turn-sigkill',
            type: 'start_turn',
            sessionId,
            expectedRevision: 0,
            input: 'dispatch once',
          },
        }),
      );
      expect(await output.next()).toMatchObject({ id: 'turn', result: { status: 'applied' } });
      await eventually(() => model.getRequestCount() === 1);
      child.kill('SIGKILL');
      await child.exited;
      await Bun.sleep(650);

      const successor = createKiteSessionAppServerStorageComposition({
        databasePath: join(runtimeRoot, 'kite-session.sqlite'),
        hostInstanceId: 'successor-after-sigkill',
      });
      try {
        expect(() => successor.runWithSessionExecution(sessionId, () => undefined)).toThrow(
          'explicit effect reconciliation',
        );
        const recovery = successor.recovery.inspect(sessionId);
        expect(recovery).toMatchObject({
          authority: { status: 'recovery_required' },
          pendingEffects: [],
        });
        const reconciled = successor.recovery.reconcile({
          sessionId,
          expectedAuthorityRevision: recovery.authority.revision,
        });
        expect(reconciled.unknownEffects).toEqual([]);
      } finally {
        successor.disposeStorage();
      }

      const resumed = Bun.spawn([process.execPath, childPath], {
        cwd: '/',
        env: {
          ...process.env,
          KITE_CODE_HOME: runtimeRoot,
          KITE_CODE_CONFIG_HOME: configRoot,
          KITE_APP_SERVER_WORKSPACE: workspace,
          KITE_APP_SERVER_BUILD_ID: 'sigkill-build',
          HOME: osHome,
          USERPROFILE: osHome,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const resumedOutput = new JsonlReader(resumed.stdout);
      try {
        resumed.stdin.write(
          line('resume-init', 'initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'resume-test', version: '1', instanceId: 'resume-test-1' },
          }),
        );
        await resumedOutput.next();
        resumed.stdin.write(
          line('resume', 'runtime/command', {
            command: {
              schema: 'kite.runtime-command.v1',
              commandId: 'resume-after-sigkill',
              type: 'resume_session',
              sessionId,
            },
          }),
        );
        expect(await resumedOutput.next()).toMatchObject({
          id: 'resume',
          result: { status: 'applied' },
        });
        await Bun.sleep(100);
        expect(model.getRequestCount()).toBe(1);
        resumed.stdin.end();
        expect(await resumed.exited).toBe(0);
      } finally {
        if (resumed.exitCode === null) resumed.kill('SIGKILL');
        await resumed.exited;
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      model.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function line(id: string, method: string, params: object): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

class JsonlReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = '';

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<Record<string, unknown>> {
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return JSON.parse(line) as Record<string, unknown>;
      }
      const next = await this.#reader.read();
      if (next.done) throw new Error('App Server stdout closed before the expected frame.');
      this.#buffer += this.#decoder.decode(next.value, { stream: true });
    }
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for App Server process evidence.');
}

function writeAppServerConfig(configRoot: string, baseURL: string): void {
  writeFileSync(
    join(configRoot, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'test-secret',
          baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'test', name: 'mock-model' } },
      interactionMode: 'auto',
      sandbox: { enabled: false },
      features: {},
      mcpServers: {},
    }),
  );
}
