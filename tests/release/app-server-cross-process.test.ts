import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import { trustWorkspace } from '../../apps/kite-service/src/config/workspace-trust';
import { createManagedLocalAppServerComposition } from '../../scripts/release/app-server-client';
import { createMockModelServer } from '../tui-system/harness/fixtures';

test('independent App Servers observe one Store while only one executes a Session', async () => {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-two-services-')),
  );
  const systemHome = join(root, 'home');
  const kiteHome = join(root, 'kite-home');
  const workspace = join(root, 'workspace');
  for (const path of [systemHome, kiteHome, workspace]) mkdirSync(path, { mode: 0o700 });
  const model = createMockModelServer();
  model.setResponses([{ delay: 1_000, message: { content: 'cross-process answer' } }]);
  writeFileSync(
    join(kiteHome, 'kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'test-key',
          baseURL: model.baseURL,
          model: 'test-model',
          models: ['test-model'],
        },
      },
      model: { default: { provider: 'test', name: 'test-model' } },
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  const repositoryRoot = realpathSync.native(join(import.meta.dir, '../..'));
  const composition = createManagedLocalAppServerComposition({
    argv: ['kite-tui', '--kite-home', kiteHome],
    environment: { PATH: process.env.PATH },
    systemHome,
    repositoryRoot,
    executableMode: 'source',
  });
  trustWorkspace({ workspace, source: 'test', storePath: join(kiteHome, 'workspace-trust.jsonc') });
  const writer = composition.connect({
    workspace,
    clientInfo: { name: 'writer', version: '1', instanceId: 'writer' },
  });
  const observer = composition.connect({
    workspace,
    clientInfo: { name: 'observer', version: '1', instanceId: 'observer' },
  });
  const sessionId = 'cross-process-session';
  try {
    await Promise.all([writer.connect(), observer.connect()]);
    const created = await writer.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cross-process-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Session creation failed');
    expect((await observer.history.listSessions({ limit: 100 })).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId })]),
    );
    const initialSubscriptionAbort = new AbortController();
    const initialStream = await observer.runtime.subscribeReady({
      spec: { scope: 'session', sessionId },
      signal: initialSubscriptionAbort.signal,
    });
    const initialIterator = initialStream[Symbol.asyncIterator]();
    const initialSnapshot = await Promise.race([
      initialIterator.next(),
      Bun.sleep(3_000).then(() => {
        throw new Error('Observer did not receive the initial durable snapshot.');
      }),
    ]);
    expect(initialSnapshot).toMatchObject({
      done: false,
      value: { durability: 'durable', sessionId, revision: created.revision },
    });
    const started = await writer.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cross-process-start',
      type: 'start_turn',
      sessionId,
      expectedRevision: created.revision,
      input: 'run once',
    });
    expect(started.status).toBe('applied');
    for (let attempt = 0; attempt < 100 && model.getRequestCount() === 0; attempt++)
      await Bun.sleep(10);
    expect(model.getRequestCount()).toBe(1);
    // Another Host's Store commit does not push into this process-local subscription.
    const pendingUpdate = initialIterator.next();
    const unsolicitedUpdate = await Promise.race([
      pendingUpdate.then((item) => item),
      Bun.sleep(300).then(() => null),
    ]);
    expect(unsolicitedUpdate).toBeNull();
    const observed = await observer.runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(observed).toMatchObject({ status: 'ok', session: { sessionId } });
    if (observed.status !== 'ok' || !observed.session)
      throw new Error('Observer cannot read the active Session.');
    // Explicit read refreshes the observer's durable watermark and its waiting subscriber.
    const refreshedUpdate = await Promise.race([
      pendingUpdate,
      Bun.sleep(3_000).then(() => {
        throw new Error('Observer query did not refresh the pending subscription.');
      }),
    ]);
    expect(refreshedUpdate).toMatchObject({
      done: false,
      value: { durability: 'durable', sessionId, revision: observed.session.revision },
    });
    initialSubscriptionAbort.abort();
    expect((await initialIterator.next()).done).toBe(true);
    const competing = await observer.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cross-process-competing-start',
      type: 'start_turn',
      sessionId,
      expectedRevision: created.revision,
      input: 'must not run',
    });
    expect(competing).toMatchObject({ status: 'rejected', code: 'runtime_busy' });
    for (let attempt = 0; attempt < 200; attempt++) {
      const projection = await observer.runtime.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      });
      if (projection.status === 'ok' && projection.session?.currentRun?.status === 'completed')
        break;
      await Bun.sleep(20);
    }
    const terminal = await observer.runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(terminal).toMatchObject({
      status: 'ok',
      session: { currentRun: { status: 'completed' } },
    });
    expect(model.getRequestCount()).toBe(1);

    // A new subscription can read the durable Store watermark. The protocol does not promise
    // unsolicited cross-process token notifications for a subscription opened on the observer.
    const stream = await observer.runtime.subscribeReady({
      spec: { scope: 'session', sessionId, includeEphemeral: true },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const initial = await Promise.race([
      iterator.next(),
      Bun.sleep(3_000).then(() => {
        throw new Error('Observer did not receive the durable subscription snapshot.');
      }),
    ]);
    expect(initial.done).toBe(false);
    if (!initial.done) {
      expect(initial.value).toMatchObject({
        durability: 'durable',
        projection: { session: { currentRun: { status: 'completed' } } },
      });
    }
    await iterator.return?.();

    // A clean writer shutdown releases its generation; the observer can then acquire the same
    // Session and continue without replaying the completed turn.
    await writer[Symbol.asyncDispose]();
    model.setResponses([{ message: { content: 'continued in observer' } }]);
    if (terminal.status !== 'ok' || !terminal.session) throw new Error('Missing terminal state');
    const continued = await observer.runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cross-process-continue',
      type: 'start_turn',
      sessionId,
      expectedRevision: terminal.session.revision,
      input: 'continue once',
    });
    expect(continued.status).toBe('applied');
    for (let attempt = 0; attempt < 200 && model.getRequestCount() < 2; attempt++)
      await Bun.sleep(10);
    expect(model.getRequestCount()).toBe(2);
    for (let attempt = 0; attempt < 200; attempt++) {
      const projection = await observer.runtime.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      });
      if (
        projection.status === 'ok' &&
        projection.session?.currentRun?.status === 'completed' &&
        projection.session.revision > terminal.session.revision
      )
        break;
      await Bun.sleep(20);
    }
    const continuedProjection = await observer.runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(continuedProjection).toMatchObject({
      status: 'ok',
      session: { currentRun: { status: 'completed' } },
    });
    if (continuedProjection.status !== 'ok' || !continuedProjection.session)
      throw new Error('Missing continued state');
    expect(continuedProjection.session.revision).toBeGreaterThan(terminal.session.revision);
  } finally {
    await Promise.allSettled([writer[Symbol.asyncDispose](), observer[Symbol.asyncDispose]()]);
    model.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
