import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DesktopHost } from '../electron/host';

export interface PairedServiceSmokeOptions {
  home: string;
  workspace: string;
  serviceDirectory?: string;
}

/** Real paired candidate regression used by the desktop native qualification entrypoint. */
export async function runElectronPairedServiceSmoke(
  options: PairedServiceSmokeOptions,
): Promise<{ startupMilliseconds: number }> {
  const serviceDirectory = options.serviceDirectory ?? resolve('apps/kite-desktop/service');
  const manifest = JSON.parse(readFileSync(join(serviceDirectory, 'desktop.json'), 'utf8')) as {
    expectedServerVersion: string;
  };
  const host = new DesktopHost({
    appDataDirectory: join(options.home, 'electron-app-data'),
    homeDirectory: options.home,
    serviceDirectory,
    repositoryDirectory: resolve('.'),
    debug: false,
    serviceManifest: manifest,
  });
  try {
    await host.rememberPickedWorkspace(options.workspace);
    await host.activateWorkspace(options.workspace);
    const startup = performance.now();
    let opened = await host.runtimeOpen();
    const firstGeneration = opened.connectionId;
    await host.runtimeSend(
      firstGeneration,
      rpc('abandoned-init', 'initialize', {
        protocolVersion: 2,
        clientInfo: {
          name: 'desktop-smoke',
          version: '1',
          instanceId: 'native-peer',
        },
      }),
    );
    opened = await host.runtimeOpen();
    let generation = opened.connectionId;
    const initialized = await request(host, generation, 'init', 'initialize', {
      protocolVersion: 2,
      clientInfo: {
        name: 'desktop-smoke',
        version: '1',
        instanceId: 'desktop-smoke',
      },
    });
    assertEqual(
      at(initialized, 'serverInfo', 'version'),
      manifest.expectedServerVersion,
      'paired server version',
    );
    const directory = await request(
      host,
      generation,
      'startup-directory',
      'history/list_sessions',
      {
        request: { limit: 100 },
      },
    );
    assert(Array.isArray(at(directory, 'entries')), 'initial history directory must be available');
    const startupMilliseconds = performance.now() - startup;

    const abandonedReceive = host.runtimeReceive(generation).then(
      () => undefined,
      (error: unknown) => error,
    );
    await delay(20);
    opened = await host.runtimeOpen();
    generation = opened.connectionId;
    assert((await abandonedReceive) instanceof Error, 'reload must cancel the old pending receive');
    const reinitialized = await request(host, generation, 'init', 'initialize', {
      protocolVersion: 2,
      clientInfo: {
        name: 'desktop-smoke',
        version: '1',
        instanceId: 'new-renderer',
      },
    });
    assertDeepEqual(reinitialized, initialized, 'reload must reuse the same initialize result');

    const trust = at(
      await request(host, generation, 'trust-query', 'app/workspace_trust/query', {
        request: {
          schema: 'kite.app.workspace-trust.query-request.v1',
          workspace: options.workspace,
        },
      }),
      'response',
    );
    const trusted = await request(host, generation, 'trust', 'app/workspace_trust/decide', {
      request: {
        schema: 'kite.app.workspace-trust.decision-request.v1',
        workspace: at(trust, 'workspace'),
        observedStatus: at(trust, 'status'),
        expectedRevision: at(trust, 'revision'),
        decision: 'trust',
        externalReadScopeDigest: at(trust, 'externalReadScope', 'digest'),
      },
    });
    assertEqual(at(trusted, 'response', 'status'), 'trusted', 'workspace trust');

    const created = await request(host, generation, 'create', 'runtime/command', {
      command: {
        schema: 'kite.runtime-command.v1',
        commandId: 'smoke-create',
        type: 'create_session',
        bootstrapSessionId: 'desktop-smoke-session',
      },
    });
    assertEqual(at(created, 'status'), 'applied', 'create session');
    await request(host, generation, 'subscribe', 'runtime/subscribe', {
      subscription: {
        scope: 'session',
        sessionId: 'desktop-smoke-session',
        includeEphemeral: true,
      },
    });
    const started = await request(host, generation, 'turn', 'runtime/command', {
      command: {
        schema: 'kite.runtime-command.v1',
        commandId: 'smoke-start',
        type: 'start_turn',
        sessionId: 'desktop-smoke-session',
        expectedRevision: at(created, 'revision'),
        input: 'Reply with desktop smoke complete.',
        phase: 'building',
      },
    });
    assertEqual(at(started, 'status'), 'applied', 'start turn');

    let streamed = false;
    let reloadedDuringStream = false;
    await deadline(
      (async () => {
        for (;;) {
          const frame = await host.runtimeReceive(generation);
          const message = JSON.parse(frame) as unknown;
          if (frame.includes('model.text_delta') && frame.includes('desktop smoke')) {
            streamed = true;
            if (!reloadedDuringStream) {
              reloadedDuringStream = true;
              await host.runtimeSend(
                generation,
                rpc('reused-id', 'runtime/query', {
                  query: {
                    schema: 'kite.runtime-query.v1',
                    type: 'get_session_projection',
                    sessionId: 'desktop-smoke-session',
                  },
                }),
              );
              await host.runtimeDetach(generation);
              opened = await host.runtimeOpen();
              generation = opened.connectionId;
              const resumed = await request(host, generation, 'init', 'initialize', {
                protocolVersion: 2,
                clientInfo: {
                  name: 'desktop-smoke',
                  version: '1',
                  instanceId: 'stream-renderer',
                },
              });
              assertEqual(
                at(resumed, 'serverInfo', 'instanceId'),
                at(initialized, 'serverInfo', 'instanceId'),
                'Service instance across renderer reload',
              );
              const sessions = await request(host, generation, 'reused-id', 'runtime/query', {
                query: { schema: 'kite.runtime-query.v1', type: 'list_sessions' },
              });
              assert(
                Array.isArray(at(sessions, 'sessions')),
                'new generation query must win reused id',
              );
              await request(host, generation, 'resubscribe', 'runtime/subscribe', {
                subscription: {
                  scope: 'session',
                  sessionId: 'desktop-smoke-session',
                  includeEphemeral: true,
                },
              });
            }
          }
          const terminal =
            frame.includes('run.terminal') ||
            frame.includes('turn.completed') ||
            atOptional(
              message,
              'params',
              'message',
              'projection',
              'session',
              'currentRun',
              'status',
            ) === 'completed';
          if (terminal) {
            assert(streamed, 'durable terminal must follow streaming evidence');
            return;
          }
        }
      })(),
      30_000,
      'no terminal event',
    );

    const history = await request(host, generation, 'history', 'history/load_session', {
      sessionId: 'desktop-smoke-session',
    });
    assert(
      JSON.stringify(history).includes('desktop smoke complete'),
      'history must retain output',
    );

    let attempt = 0;
    await deadline(
      (async () => {
        for (;;) {
          const projection = await request(host, generation, 'projection', 'runtime/query', {
            query: {
              schema: 'kite.runtime-query.v1',
              type: 'get_session_projection',
              sessionId: 'desktop-smoke-session',
            },
          });
          const second = await request(host, generation, 'turn2', 'runtime/command', {
            command: {
              schema: 'kite.runtime-command.v1',
              commandId: `smoke-second-${attempt}`,
              type: 'start_turn',
              sessionId: 'desktop-smoke-session',
              expectedRevision: at(projection, 'session', 'revision'),
              input: 'wait',
              phase: 'building',
            },
          });
          if (at(second, 'status') === 'applied') return;
          assertEqual(at(second, 'code'), 'runtime_busy', 'second turn admission');
          attempt += 1;
          await delay(100);
        }
      })(),
      10_000,
      'previous run never released execution admission',
    );
    await delay(500);
    await deadline(host.runtimeClose(generation), 20_000, 'Service EOF cleanup timed out');
    assert(
      existsSync(join(options.home, '.kite-code/kite-session.sqlite')),
      'durable store missing',
    );
    assert(
      !existsSync(join(options.home, '.kite-code/service.sock')),
      'stdio must not create daemon state',
    );

    opened = await host.runtimeOpen();
    generation = opened.connectionId;
    await request(host, generation, 'init2', 'initialize', {
      protocolVersion: 2,
      clientInfo: {
        name: 'desktop-smoke',
        version: '1',
        instanceId: 'desktop-smoke-successor',
      },
    });
    const restored = await request(host, generation, 'history2', 'history/load_session', {
      sessionId: 'desktop-smoke-session',
    });
    assert(
      JSON.stringify(restored).includes('desktop smoke complete'),
      'successor must read history',
    );
    await host.runtimeClose(generation);
    return { startupMilliseconds };
  } finally {
    await host.quit().catch(() => undefined);
  }
}

async function request(
  host: DesktopHost,
  generation: number,
  id: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  await host.runtimeSend(generation, rpc(id, method, params));
  return deadline(
    (async () => {
      for (;;) {
        const value = JSON.parse(await host.runtimeReceive(generation)) as unknown;
        if (atOptional(value, 'id') !== id) continue;
        assert(atOptional(value, 'error') === undefined, `RPC failed: ${JSON.stringify(value)}`);
        return at(value, 'result');
      }
    })(),
    20_000,
    `${method} did not reply`,
  );
}

function rpc(id: string, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function at(value: unknown, ...path: string[]): unknown {
  const result = atOptional(value, ...path);
  if (result === undefined)
    throw new Error(`Missing ${path.join('.')} in ${JSON.stringify(value)}`);
  return result;
}

function atOptional(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
