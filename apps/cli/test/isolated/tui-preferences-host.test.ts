import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { ClientError, createClient, createServiceLifecycleClient } from '@kite-ai/client';
import { bootstrapSchema, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function seedTrust(client: ReturnType<typeof createClient>, storeId: string) {
  const state = await client.getWorkspaceTrust('w', { storeId });
  await client.setWorkspaceTrust('w', {
    expectedStoreId: storeId,
    commandId: randomUUID(),
    ifRevision: state.revision,
    trusted: true,
    canonicalIdentity: state.canonicalIdentity,
    externalReadScopeDigest: state.externalReadScopeDigest,
  });
}
async function seedModel(client: ReturnType<typeof createClient>, storeId: string) {
  await client.startRun('a', {
    expectedStoreId: storeId,
    commandId: 'original-model',
    kind: 'run.start',
    content: 'original seed',
  });
  const end = Date.now() + 10000;
  while ((await client.getView('a')).runs[0]?.status !== 'completed') {
    if (Date.now() > end) throw Error('seed_not_completed');
    await Bun.sleep(10);
  }
  expect((await client.getView('a')).runs[0]?.status).toBe('completed');
}
for (const mode of ['paired', 'shared'] as const)
  test(`80x24 actual ${mode} TUI preferences persist colors and language without extra work and retain old facts on save failure`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-preferences-')));
    const workspace = join(root, 'workspace'),
      ownedPid = join(root, 'owned-pid');
    privateDirectory(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    const userConfiguration = ownedUserConfiguration(join(root, 'home'));
    privateDirectory(profile.profilePath);
    privateDirectory(join(profile.profilePath, 'ui'));
    writeFileSync(
      join(profile.profilePath, 'ui', 'preferences.jsonc'),
      JSON.stringify({ language: 'en-US', colorPreset: 'teal' }),
      { mode: 0o600 },
    );
    let calls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        calls++;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: 'ORIGINAL English model body stays exact.' }, null) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      userConfiguration.path,
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await buildOwnedDaemon(join(root, 'service-artifact'));
    const entrypoint = join(root, 'service-artifact/node_modules/@kite-ai/service/main.js');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      executable: realpathSync(process.execPath),
      executableSha256: sha(readFileSync(process.execPath)),
      buildId: 'owned-preferences',
      apiMajor: 1,
    };
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined,
      python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let stopShared: () => Promise<void> = async () => {
      throw Error('preferences_daemon_lifecycle_missing');
    };
    const socket = selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      ...(process.platform === 'win32' ? {} : { explicitSocket: join(root, 'd.sock') }),
    }).socket;
    try {
      let storeId: string;
      if (mode === 'paired') {
        const seed = await launchPairedService({
          spawnChild: userConfiguration.spawnChild,
          profile,
          ...artifact,
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
          await seedTrust(seed.client, storeId);
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create-b',
            sessionId: 'b',
            workspaceId: 'w',
            title: 'Beta',
          });
          await seed.client.createSession({
            expectedStoreId: storeId,
            commandId: 'create',
            sessionId: 'a',
            workspaceId: 'w',
            title: 'status',
          });
          await seedModel(seed.client, storeId);
        } finally {
          await seed.close();
        }
      } else {
        const web = join(root, 'web');
        privateDirectory(web);
        const assets = [
          ['/index.html', 'text/html; charset=utf-8', '<title>owned</title>'],
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
            env: { ...process.env, ...userConfiguration.homeEnvironment },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        daemon.stdin.write(
          `${JSON.stringify({
            operation: 'start',
            startup: {
              profile: {
                dataRoot: profile.dataRoot,
                profile: profile.profile,
                profileAccessKey: profile.profileAccessKey,
              },
              instanceId,
              buildId: 'owned-preferences',
              token: 's'.repeat(64),
            },
            workspace,
            socket,
            web: { directory: web, manifestSha256: sha(manifest) },
          })}\n`,
        );
        daemon.stdin.end();
        const reader = daemon.stdout.getReader();
        let frame = '';
        try {
          while (!frame.includes('\n')) {
            const next = await reader.read();
            if (next.done) throw Error('status_daemon_start_failed');
            frame += new TextDecoder().decode(next.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const boot = bootstrapSchema.parse(JSON.parse(frame));
        stopShared = async () => {
          const lifecycle = createServiceLifecycleClient({
            endpoint: boot.httpEndpoint,
            token: boot.token,
            expected: { profile: boot.profile, instanceId: boot.instanceId },
          });
          try {
            try {
              await lifecycle.shutdown('if_idle');
            } catch (error) {
              if (!(error instanceof ClientError && error.code === 'network_outcome_unknown'))
                throw error;
            }
            if ((await daemon!.exited) !== 0) throw Error('preferences_daemon_exit_not_normal');
          } finally {
            lifecycle.disposeNetwork();
          }
        };
        client = createClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: {
            profile: boot.profile,
            instanceId,
            buildId: boot.buildId,
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'commands'],
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
        await seedTrust(client, storeId);
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create-b',
          sessionId: 'b',
          workspaceId: 'w',
          title: 'Beta',
        });
        await client.createSession({
          expectedStoreId: storeId,
          commandId: 'create',
          sessionId: 'a',
          workspaceId: 'w',
          title: 'status',
        });
      }
      if (client) await seedModel(client, storeId);
      const runner = join(repo, 'apps/cli/test/fixtures/tui-preferences-runner.ts');
      const preferencePath = join(profile.profilePath, 'ui', 'preferences.jsonc');
      const transcript = join(tmpdir(), `kite-tui-preferences-${mode}-${randomUUID()}.pty.log`);
      python = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          fileURLToPath(new URL('../fixtures/tui-preferences-pty.ts', import.meta.url)),
          JSON.stringify({
            root,
            dataRoot: profile.dataRoot,
            workspace,
            ...(mode === 'paired' ? { artifact } : { server: socket }),
            runner,
            preferencePath,
            databasePath: profile.databasePath,
            transcript,
            mode,
          }),
        ],
        {
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [out, err, exitCode] = await Promise.all([
        new Response(python.stdout).text(),
        new Response(python.stderr).text(),
        python.exited,
      ]);
      if (exitCode) {
        console.error(out, err);
        console.error('Preferences transcript:', transcript);
      }
      expect(exitCode).toBe(0);
      expect(out).toContain('PREFERENCES_ORIGINAL_COMPLETE');
      expect(out).toContain('CHINESE_OWNED_PANELS_AND_PASTE');
      expect(calls).toBe(1);
      if (mode === 'paired') {
        const pids = readFileSync(ownedPid, 'utf8').trim().split('\n').map(Number);
        expect(pids).toHaveLength(2);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } else {
        expect(daemon!.exitCode).toBeNull();
        expect((await client!.verifyConnection()).storeId).toBe(storeId);
        expect((await client!.getView('b')).runs.length).toBe(0);
      }
    } finally {
      if (python && python.exitCode === null) {
        python.kill('SIGTERM');
        await python.exited;
      }
      client?.disposeNetwork();
      if (daemon && daemon.exitCode === null) {
        if (process.platform === 'win32') {
          await ptyDeadline(stopShared(), 9000, 'preferences_daemon_exit_unconfirmed');
        } else {
          daemon.kill('SIGTERM');
          await daemon.exited;
        }
      }
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
