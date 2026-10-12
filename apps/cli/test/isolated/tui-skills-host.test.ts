import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { ClientError, createClient, createServiceLifecycleClient } from '@kite-ai/client';
import { bootstrapSchema, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';

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
for (const mode of ['paired', 'shared'] as const)
  test(`80x24 actual ${mode} TUI Skills reads full real catalogue and discards old scope replies without work`, async () => {
    const root = realpathSync(
      mkdtempSync(
        join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'kite-tui-skills-'),
      ),
    );
    const workspace = join(root, 'workspace'),
      ledger = join(root, 'catalogue-reads'),
      ownedPid = join(root, 'owned-pid');
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    let calls = 0;
    let releasePage!: () => void;
    const pageHeld = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/held-page') {
          await pageHeld;
          return new Response('released');
        }
        if (path === '/release-page') {
          releasePage();
          return new Response('released');
        }
        calls++;
        return new Response('unexpected Model', { status: 500 });
      },
    });
    const skills = [
      { id: 'a000', path: 'a000' },
      { id: 'a001-disabled', path: 'a001', enabled: false },
      { id: 'a002-broken', path: 'a002' },
      { id: 'a003-missing', path: 'a003' },
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `g${String(i).padStart(3, '0')}`,
        path: `g${String(i).padStart(3, '0')}`,
      })),
    ];
    for (const skill of skills) {
      mkdirSync(join(workspace, skill.path));
      writeFileSync(
        join(workspace, skill.path, 'SKILL.md'),
        skill.id === 'a002-broken'
          ? 'invalid\0'
          : `---\nname: ${skill.id === 'a000' ? 'Guide000' : skill.id}\ndescription: ${'metadata '.repeat(128)}\n${skill.id === 'a003-missing' ? 'required-capabilities: fixture.unavailable\n' : ''}---\nKnowledge only; never execute script.sh\n`,
      );
      writeFileSync(
        join(workspace, skill.path, 'script.sh'),
        `touch ${join(root, 'script-effect')}\n`,
      );
    }
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        skills,
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
    const entrypoint = join(repo, 'apps/service/dist/main.js');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      executable: realpathSync(process.execPath),
      executableSha256: sha(readFileSync(process.execPath)),
      buildId: 'owned-skills',
      apiMajor: 1,
    };
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let stopShared: () => Promise<void> = async () => {
      throw Error('skills lifecycle missing');
    };
    const socket = selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      ...(process.platform === 'win32' ? {} : { explicitSocket: join(root, 'd.sock') }),
    }).socket;
    try {
      let storeId: string;
      if (mode === 'paired') {
        const seed = await launchPairedService({
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
        } finally {
          await seed.close();
        }
      } else {
        const web = join(root, 'web');
        mkdirSync(web, { mode: 0o700 });
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
        daemon = Bun.spawn([process.execPath, join(repo, 'apps/service/dist/daemon-main.js')], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
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
              buildId: 'owned-skills',
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
            expected: {
              profile: {
                dataRoot: profile.dataRoot,
                name: profile.profile,
                accessKey: profile.profileAccessKey,
              },
              instanceId,
            },
          });
          try {
            try {
              await lifecycle.shutdown('if_idle');
            } catch (error) {
              if (!(error instanceof ClientError && error.code === 'network_outcome_unknown'))
                throw error;
            }
            if ((await daemon!.exited) !== 0) throw Error('skills shared exit not normal');
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
            requiredCapabilities: ['sessions', 'skill_catalogue'],
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
      const runner = join(repo, 'apps/cli/test/fixtures/tui-skills-runner.ts');
      const settings = {
        root,
        dataRoot: profile.dataRoot,
        workspace,
        control: provider.url.href,
        ...(mode === 'paired' ? { artifact } : { server: socket }),
      };
      driver = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          fileURLToPath(new URL('../fixtures/tui-skills-driver.ts', import.meta.url)),
          JSON.stringify({
            root,
            workspace,
            databasePath: profile.databasePath,
            ledger,
            runner,
            settings,
            control: provider.url.href,
          }),
        ],
        { stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? { ipc() {} } : {}) },
      );
      const [out, err, exitCode] = await Promise.all([
        new Response(driver.stdout).text(),
        new Response(driver.stderr).text(),
        driver.exited,
      ]);
      if (exitCode) {
        console.error(out, err);
        try {
          const pages = readFileSync(ledger, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          console.error(
            'Actual skill HTTP facts',
            JSON.stringify(
              pages.map((page) => ({
                query: page.query,
                ...(!page.value.entries
                  ? { body: page.value }
                  : {
                      availability: page.value.availability,
                      reason: page.value.reason,
                      count: page.value.entries.length,
                      revision: page.value.revision,
                      complete: page.value.complete,
                    }),
              })),
            ),
          );
        } catch {}
      }
      expect(exitCode).toBe(0);
      expect(out).toContain('SKILLS_ORIGINAL_COMPLETE');
      expect(calls).toBe(0);
      if (mode === 'paired') {
        const pid = Number(readFileSync(ownedPid, 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } else {
        expect(daemon!.exitCode).toBeNull();
        expect((await client!.verifyConnection()).storeId).toBe(storeId);
        expect((await client!.getView('b')).runs.length).toBe(0);
      }
    } finally {
      if (driver && driver.exitCode === null) {
        if (process.platform === 'win32') driver.send('skills-driver-stop');
        else driver.kill('SIGTERM');
        await driver.exited;
      }
      client?.disposeNetwork();
      if (daemon && daemon.exitCode === null) {
        if (process.platform === 'win32') await stopShared();
        else {
          daemon.kill('SIGTERM');
          await daemon.exited;
        }
      }
      releasePage();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
