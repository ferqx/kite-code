import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { ClientError, createClient, createServiceLifecycleClient } from '@kite-ai/client';
import { bootstrapSchema, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const mode of ['paired', 'shared'] as const)
  test(`actual ${mode} TUI model/default/effort CAS preserves held Run and lost original reply never resubmits`, async () => {
    const root = realpathSync(temporaryDirectory('kite-tui-model-')),
      workspace = join(root, 'workspace'),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    const home = join(root, 'home');
    const userConfiguration = ownedUserConfiguration(home);
    const userEnvironment = { ...process.env, ...userConfiguration.homeEnvironment };
    privateDirectory(workspace);
    privateDirectory(profile.profilePath);
    // This fixture asserts English labels independently of the host device locale.
    privateDirectory(join(profile.profilePath, 'ui'));
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const calls: { model: string; reasoning_effort?: string }[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 30,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/release') {
          release();
          return new Response('released');
        }
        if (url.pathname === '/calls') return Response.json(calls);
        const body = (await req.json()) as {
          model: string;
          reasoning_effort?: string;
          messages: { role: string; content: string }[];
        };
        calls.push({ model: body.model, reasoning_effort: body.reasoning_effort });
        if (body.messages.some((m) => m.content === 'held-original') && calls.length === 1)
          await held;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: `DONE ${body.model}` }, null) + frame({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let stopShared: (() => Promise<void>) | undefined;
    let seed: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    let passed = false;
    const ownedPath = join(root, 'owned-service.json');
    const transcript = `${root}.models.pty`;
    let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      writeFileSync(
        userConfiguration.path,
        JSON.stringify({
          modelId: 'one',
          models: ['one', 'two'].map((id) => ({
            id,
            provider: 'compatible',
            model: id,
            baseURL: provider.url.href + 'v1',
          })),
        }),
        { mode: 0o600 },
      );
      await buildOwnedDaemon(join(root, 'service-artifact'));
      const entrypoint = join(root, 'service-artifact/node_modules/@kite-ai/service/main.js'),
        artifact = {
          entrypoint,
          entrypointSha256: sha(readFileSync(entrypoint)),
          executable: realpathSync(process.execPath),
          executableSha256: sha(readFileSync(process.execPath)),
          buildId: 'owned-models',
          apiMajor: 1,
        };
      let storeId: string;
      const socket = selectDaemonEndpoint({
        profileAccessKey: profile.profileAccessKey,
        ...(process.platform === 'win32' ? {} : { explicitSocket: join(root, 'd.sock') }),
      }).socket;
      if (mode === 'paired') {
        seed = await launchPairedService({
          profile,
          ...artifact,
          spawnChild: userConfiguration.spawnChild,
          instanceId: randomUUID(),
          requiredCapabilities: ['sessions'],
        });
        try {
          storeId = seed.bootstrap.storeId!;
          await seed.client.createWorkspace({
            expectedStoreId: storeId,
            id: 'w',
            rootUri: pathToFileURL(workspace).href,
            name: 'owned',
          });
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create',
            sessionId: 'a',
            workspaceId: 'w',
            title: 'models',
          });
        } finally {
          await seed.close();
          seed = undefined;
        }
      } else {
        const web = join(root, 'web');
        privateDirectory(web);
        const assets = [
          ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>owned</title>'],
          ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
          ['/app.css', 'text/css; charset=utf-8', 'body{color:black}'],
        ].map(([path, mediaType, content]) => {
          writeFileSync(join(web, path!.slice(1)), content!);
          return { path, mediaType, size: Buffer.byteLength(content!), sha256: sha(content!) };
        });
        const manifest = JSON.stringify(assets);
        writeFileSync(join(web, 'manifest.json'), manifest);
        const instanceId = randomUUID();
        daemon = Bun.spawn(
          [
            process.execPath,
            join(root, 'service-artifact/node_modules/@kite-ai/service/daemon-main.js'),
          ],
          {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: userEnvironment,
          },
        );
        daemon.stdin.write(
          JSON.stringify({
            operation: 'start',
            startup: {
              profile: {
                dataRoot: profile.dataRoot,
                profile: profile.profile,
                profileAccessKey: profile.profileAccessKey,
              },
              instanceId,
              buildId: 'owned-models',
              token: 's'.repeat(64),
            },
            workspace,
            socket,
            web: { directory: web, manifestSha256: sha(manifest) },
          }) + '\n',
        );
        daemon.stdin.end();
        const reader = daemon.stdout.getReader();
        let frame = '';
        while (!frame.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw Error('daemon_start_failed');
          frame += new TextDecoder().decode(next.value);
        }
        await reader.cancel();
        reader.releaseLock();
        const boot = bootstrapSchema.parse(JSON.parse(frame));
        stopShared = async () => {
          if (!daemon) throw Error('models original daemon missing');
          if (daemon.exitCode !== null) {
            if (daemon.exitCode !== 0) throw Error('models original daemon exit not normal');
            return;
          }
          if (process.platform === 'win32') {
            const lifecycle = createServiceLifecycleClient({
              endpoint: boot.httpEndpoint,
              token: boot.token,
              expected: { profile: boot.profile, instanceId },
            });
            try {
              try {
                await lifecycle.shutdown('if_idle');
              } catch (error) {
                if (!(error instanceof ClientError && error.code === 'network_outcome_unknown'))
                  throw error;
              }
            } finally {
              lifecycle.disposeNetwork();
            }
          } else daemon.kill('SIGTERM');
          const code = await ptyDeadline(
            daemon.exited,
            9000,
            'models original daemon exit unknown',
          );
          if (code !== 0) throw Error('models original daemon exit not normal');
          writeFileSync(
            `${transcript}.daemon-exit.json`,
            JSON.stringify({
              pid: daemon.pid,
              code,
              waitConfirmed: true,
              instanceId,
              birth: boot.processStartIdentity,
            }),
          );
        };
        client = createClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: {
            profile: boot.profile,
            instanceId,
            buildId: boot.buildId,
            apiMajor: 1,
            requiredCapabilities: ['sessions'],
          },
        });
        const info = await client.connect();
        storeId = info.storeId!;
        await client.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          rootUri: pathToFileURL(workspace).href,
          name: 'owned',
        });
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'models',
        });
      }
      const runner = join(root, 'runner.ts'),
        count = join(root, 'post-count'),
        lookupCount = join(root, 'lookup-count');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';import{readProcessStartIdentity}from${JSON.stringify(pathToFileURL(join(repo, 'apps/service/src/daemon/process-identity.ts')).href)};import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};const originalSpawn=Bun.spawn.bind(Bun);Bun.spawn=(...args)=>{const child=originalSpawn(...args);const command=Array.isArray(args[0])?args[0]:args[0]?.cmd;if(command?.includes(${JSON.stringify(entrypoint)})){const record={pid:child.pid,start:readProcessStartIdentity(child.pid)};void child.exited.then(code=>writeFileSync(${JSON.stringify(`${ownedPath}.exit`)},JSON.stringify({...record,code})));}return child;};const actual=globalThis.fetch;let lost=false;globalThis.fetch=async(...args)=>{const response=await actual(...args);const u=String(args[0]);if(u.includes('/host-mutations/'))appendFileSync(${JSON.stringify(lookupCount)},'get\\n');if(args[1]?.method==='POST'&&u.endsWith('/models')){appendFileSync(${JSON.stringify(count)},'post\\n');if(!lost){lost=true;throw Error('owned_lost_reply')}}return response};const exit=new AbortController();process.once('SIGTERM',()=>exit.abort());await runTUIHost({testDiagnostics:true,exitSignal:exit.signal,onLaunched:c=>{const record={pid:c.pid,start:readProcessStartIdentity(c.pid)};writeFileSync(${JSON.stringify(ownedPath)},JSON.stringify(record));},${mode === 'paired' ? `artifact:${JSON.stringify(artifact)}` : `server:${JSON.stringify(socket)}`},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)}});`,
      );
      python = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          fileURLToPath(new URL('../fixtures/tui-models-driver.ts', import.meta.url)),
          JSON.stringify({
            runner,
            storeId,
            databasePath: profile.databasePath,
            count,
            callsURL: provider.url.href + 'calls',
            releaseURL: provider.url.href + 'release',
            mode,
            ownedPath,
            transcript,
          }),
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
          env: userEnvironment,
          ...(process.platform === 'win32' ? { ipc() {} } : {}),
        },
      );
      const [out, err, exit] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exit) console.error(out, err);
      expect(exit).toBe(0);
      expect(out).toContain('MODEL_ORIGINAL_COMPLETE');
      expect(calls).toEqual([
        { model: 'one', reasoning_effort: undefined },
        { model: 'two', reasoning_effort: 'high' },
      ]);
      expect(readFileSync(count, 'utf8')).toBe('post\npost\n');
      expect(readFileSync(lookupCount, 'utf8')).toBe('get\n');
      if (mode === 'shared') {
        if (!daemon || daemon.exitCode !== null)
          throw Error('models shared TUI stopped original daemon');
        process.kill(daemon.pid, 0);
        writeFileSync(
          `${transcript}.shared-detach.json`,
          JSON.stringify({ pid: daemon.pid, exitCode: daemon.exitCode, alive: true }),
        );
      }
      passed = true;
    } catch (error) {
      failure = error;
    } finally {
      release();
      for (const action of [
        async () => {
          if (python && python.exitCode === null) {
            if (process.platform === 'win32') python.send('models-driver-stop');
            else python.kill('SIGTERM');
            await ptyDeadline(python.exited, 9000, 'models driver cleanup unknown');
          }
        },
        async () => {
          if (seed) await seed.close();
        },
        async () => {
          client?.disposeNetwork();
        },
        async () => {
          if (stopShared) await stopShared();
          else if (daemon && daemon.exitCode === null)
            throw Error('models daemon identity not admitted');
        },
      ])
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      provider.stop(true);
      if (passed && cleanupErrors.length === 0) rmSync(root, { recursive: true, force: true });
      writeFileSync(
        `${transcript}.cleanup.json`,
        JSON.stringify({
          failure: failure ? String(failure) : null,
          cleanupErrors: cleanupErrors.map(String),
          retainedRoot: passed && cleanupErrors.length === 0 ? null : root,
        }),
      );
      console.log('models evidence', transcript);
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        'models fixture cleanup unknown',
        { cause: failure },
      );
    if (failure) throw failure;
  }, 40000);
test('model host review: pending 409 and wrong ifMatch stay original unknown; known CAS failure remains finite', async () => {
  const { createTuiModelPort } = await import('../../host/tui');
  const { TuiController } = await import('@kite-ai/ui/tui');
  const { ClientError } = await import('@kite-ai/client');
  const readSet = {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'c'.repeat(64),
    effectiveDigest: 'd'.repeat(64),
  };
  const facts = {
    storeId: 'store',
    scope: 'user' as const,
    readSet,
    defaultModelId: 'one',
    models: ['one', 'two'].map((id) => ({ id, enabled: true, configured: true, diagnostics: [] })),
    errors: [],
  };
  let writes = 0,
    gets = 0,
    command = 0,
    cas = false,
    wrong = true;
  let saved: import('@kite-ai/client').ModelSettingsRequest | undefined;
  const models = createTuiModelPort(
    {
      getModelSettings: async () => facts,
      updateModelSettings: async (_scope, request) => {
        writes++;
        saved = request;
        throw new ClientError(
          cas ? 'model_settings_conflict' : 'mutation_incomplete',
          'owned 409',
          409,
        );
      },
      getHostMutation: async () => {
        gets++;
        return {
          commandId: saved!.commandId,
          originStoreId: 'store',
          kind: 'model_settings.update',
          scope: 'user',
          ifMatch: wrong ? 'e'.repeat(64) : readSet.userEtag,
          state: 'applied',
          receipt: { status: 'applied', etag: 'f'.repeat(64) },
          modelSettings: {
            operation: { modelId: 'two', kind: 'default' },
            expectedReadSet: {
              effectiveDigest: readSet.effectiveDigest,
              explicitDigest: readSet.explicitDigest,
              workspaceEtag: readSet.workspaceEtag,
              userEtag: readSet.userEtag,
            },
          },
        };
      },
    } as Parameters<typeof createTuiModelPort>[0],
    'store',
  );
  const controller = new TuiController({
    storeId: 'store',
    models,
    nextCommandId: () => `c${++command}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id, workspaceId: 'w', rootSessionId: id, parentSessionId: null },
          runs: [],
          executions: [],
          messages: [],
        },
        messages: [],
        interactions: [],
      }) as unknown as import('@kite-ai/ui/tui').TuiSnapshot,
    submit: async () => {
      throw Error('zero work');
    },
    answer: async () => {
      throw Error('zero answer');
    },
    cancel: async () => {
      throw Error('zero cancel');
    },
    getCommand: async () => {
      throw Error('zero command');
    },
  });
  try {
    await controller.select('a');
    await controller.openModels();
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    expect(controller.state.modelOutcome?.status).toBe('outcome_unknown');
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    await controller.lookupModel();
    expect(gets).toBe(1);
    expect(controller.state.modelOutcome?.status).toBe('outcome_unknown');
    expect(controller.state.models?.defaultModelId).toBe('one');
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(1);
    wrong = false;
    await controller.lookupModel();
    expect(gets).toBe(2);
    cas = true;
    await controller.chooseModel({ kind: 'default', modelId: 'two' });
    expect(writes).toBe(2);
    expect(controller.state.modelOutcome?.status).toBe('failed');
    expect(controller.state.models?.defaultModelId).toBe('one');
    expect(controller.state.error).toBe('model_settings_save_failed');
    await controller.openModels();
    expect(writes).toBe(2);
  } finally {
    controller.dispose();
  }
});
