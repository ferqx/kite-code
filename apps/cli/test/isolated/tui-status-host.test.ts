import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { ClientError, createClient, createServiceLifecycleClient } from '@kite-ai/client';
import { bootstrapSchema, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { launchPairedService } from '@kite-ai/service/paired';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import type { CLIServiceArtifact } from '../../host';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const retainedStatusOwners = new Set<unknown>();
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
for (const mode of ['paired', 'shared', 'shared-loss'] as const)
  test(`80x24 actual ${mode} TUI status checks original host with no work and preserves failed facts`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-status-')));
    const workspace = join(root, 'workspace'),
      ledger = join(root, 'reads'),
      ownedPid = join(root, 'owned-pid');
    const evidence = `${root}-${mode}`;
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    const userConfiguration = ownedUserConfiguration(join(root, 'home'));
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    // This fixture asserts English labels independently of the host device locale.
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    let calls = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        calls++;
        return new Response('unexpected Model', { status: 500 });
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
    const entrypoint = join(repo, 'apps/service/dist/main.js');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      executable: realpathSync(process.execPath),
      executableSha256: sha(readFileSync(process.execPath)),
      buildId: 'owned-status',
      apiMajor: 1,
    };
    let daemon: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let lifecycle: ReturnType<typeof createServiceLifecycleClient> | undefined;
    let daemonExit: number | undefined;
    let daemonIdentity: { instanceId: string; birth: string } | undefined;
    let abrupt: Promise<void> | undefined;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    const socket = selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      ...(process.platform === 'win32' ? {} : { explicitSocket: join(root, 'd.sock') }),
    }).socket;
    const settleDriver = async () => {
      if (driver?.exitCode === null) {
        if (process.platform === 'win32') driver.send('owned-status-driver-stop');
        else driver.kill('SIGTERM');
        await ptyDeadline(driver.exited, 9000, 'status_driver_cleanup_unconfirmed');
      }
      if (existsSync(`${evidence}.receipt.json`)) {
        const receipt = JSON.parse(readFileSync(`${evidence}.receipt.json`, 'utf8'));
        if (receipt.serviceDead === false) throw Error('status_service_cleanup_unconfirmed');
      } else if (driver) throw Error('status_driver_receipt_missing');
      if (existsSync(ownedPid)) {
        const record = JSON.parse(readFileSync(ownedPid, 'utf8'));
        if (!processGone(record.pid)) throw Error('status_owned_service_remains');
        if (!failure) {
          const exited = JSON.parse(readFileSync(`${ownedPid}.exit`, 'utf8'));
          if (exited.pid !== record.pid || exited.start !== record.start || exited.code !== 0)
            throw Error('status_owned_service_exit_not_normal');
          writeFileSync(`${evidence}.service-exit.json`, JSON.stringify(exited));
        }
      }
    };
    const settleDaemon = async () => {
      if (!daemon) return;
      const end = Date.now() + 9000;
      if (abrupt) {
        await ptyDeadline(abrupt, 9000, 'status_daemon_abrupt_exit_unknown');
        return;
      }
      if (daemonExit === undefined) {
        if (process.platform === 'win32') {
          if (!lifecycle) throw Error('status_daemon_lifecycle_missing');
          try {
            await lifecycle.shutdown('if_idle', { signal: AbortSignal.timeout(9000) });
          } catch (error) {
            if (!(error instanceof ClientError && error.code === 'network_outcome_unknown'))
              throw error;
          }
        } else daemon.kill('SIGTERM');
      }
      if (Date.now() >= end) throw Error('status_daemon_exit_unknown');
      const code = await ptyDeadline(daemon.exited, end - Date.now(), 'status_daemon_exit_unknown');
      if (code !== 0 || !processGone(daemon.pid)) throw Error('status_daemon_exit_not_normal');
      writeFileSync(
        `${evidence}.daemon-exit.json`,
        JSON.stringify({
          pid: daemon.pid,
          code,
          pidGone: true,
          waitConfirmed: true,
          ...daemonIdentity,
        }),
      );
    };
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
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        void daemon.exited.then((code) => {
          daemonExit = code;
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
              buildId: 'owned-status',
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
        if (boot.pid !== daemon.pid) throw Error('status_daemon_bootstrap_pid_mismatch');
        daemonIdentity = { instanceId, birth: boot.processStartIdentity };
        lifecycle = createServiceLifecycleClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: { profile: boot.profile, instanceId },
        });
        client = createClient({
          endpoint: boot.httpEndpoint,
          token: boot.token,
          expected: {
            profile: boot.profile,
            instanceId,
            buildId: boot.buildId,
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'host_status'],
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
          title: 'status',
        });
      }
      const runner = join(root, 'runner.ts');
      writeFileSync(
        runner,
        `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};import{readProcessStartIdentity}from${JSON.stringify(pathToFileURL(join(repo, 'apps/service/src/daemon/process-identity.ts')).href)};const actualSpawn=Bun.spawn.bind(Bun);Bun.spawn=(...args)=>{const actualChild=actualSpawn(...args),command=Array.isArray(args[0])?args[0]:args[0]?.cmd;if(command?.includes(${JSON.stringify(entrypoint)})){const record={pid:actualChild.pid,start:readProcessStartIdentity(actualChild.pid)};writeFileSync(${JSON.stringify(ownedPid)},JSON.stringify(record));void actualChild.exited.then(code=>writeFileSync(${JSON.stringify(`${ownedPid}.exit`)},JSON.stringify({...record,code})));}return actualChild;};const actual=globalThis.fetch;let gets=0;globalThis.fetch=async(...args)=>{const response=await actual(...args);if(String(args[0]).includes('/diagnostics/host-status')){const value=await response.clone().json();appendFileSync(${JSON.stringify(ledger)},JSON.stringify(value)+'\\n');if(++gets===2)throw Error('SECRET endpoint token')}return response};const exit=new AbortController();process.once('SIGTERM',()=>exit.abort());await runTUIHost({testDiagnostics:true,exitSignal:exit.signal,onLaunched:({pid})=>{const record=JSON.parse(readFileSync(${JSON.stringify(ownedPid)},'utf8'));if(record.pid!==pid)throw Error('status_service_spawn_identity_mismatch')},${mode === 'paired' ? `artifact:${JSON.stringify(artifact)}` : `server:${JSON.stringify(socket)}`},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)}});`,
      );
      driver = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          join(repo, 'apps/cli/test/fixtures/tui-status-driver.ts'),
          JSON.stringify({
            runner,
            ledger,
            databasePath: profile.databasePath,
            storeId,
            mode,
            profileAccessKey: profile.profileAccessKey,
            profilePath: profile.profilePath,
            ownedService: ownedPid,
            evidence,
          }),
        ],
        {
          env: { ...process.env, ...userConfiguration.homeEnvironment },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          ipc(message, subprocess) {
            if (
              message &&
              typeof message === 'object' &&
              'type' in message &&
              message.type === 'owned-status-daemon-abrupt' &&
              mode === 'shared-loss' &&
              !abrupt
            ) {
              abrupt = (async () => {
                if (!daemon || daemonExit !== undefined)
                  throw Error('status_original_daemon_not_alive');
                process.kill(daemon.pid, 0);
                let dispatchExitCode: number | null = null;
                if (process.platform === 'win32') {
                  const dispatch = Bun.spawnSync(
                    ['taskkill.exe', '/pid', String(daemon.pid), '/f'],
                    {
                      env: { ...process.env, ...userConfiguration.homeEnvironment },
                      stdout: 'pipe',
                      stderr: 'pipe',
                    },
                  );
                  dispatchExitCode = dispatch.exitCode;
                  if (dispatchExitCode !== 0) throw Error('status_daemon_native_dispatch_failed');
                } else daemon.kill('SIGKILL');
                const code = await ptyDeadline(
                  daemon.exited,
                  10000,
                  'status_daemon_abrupt_exit_unknown',
                );
                if (code === 0 || !processGone(daemon.pid))
                  throw Error('status_daemon_abrupt_exit_unconfirmed');
                if (process.platform !== 'win32' && daemon.signalCode !== 'SIGKILL')
                  throw Error('status_daemon_signal_not_sigkill');
                writeFileSync(
                  `${evidence}.daemon-abrupt.json`,
                  JSON.stringify({
                    pid: daemon.pid,
                    code,
                    signalCode: daemon.signalCode,
                    dispatchExitCode,
                    pidGone: true,
                    descendants: false,
                    ...daemonIdentity,
                  }),
                );
              })();
              void abrupt.then(
                () => subprocess.send({ type: 'owned-status-daemon-dead' }),
                () => subprocess.send({ type: 'owned-status-daemon-failed' }),
              );
            }
          },
        },
      );
      const [out, err, exit] = await Promise.all([
        new Response(driver.stdout).text(),
        new Response(driver.stderr).text(),
        driver.exited,
      ]);
      if (abrupt) await abrupt;
      writeFileSync(`${evidence}.driver.stdout`, out);
      writeFileSync(`${evidence}.driver.stderr`, err);
      writeFileSync(
        `${evidence}.facts.json`,
        JSON.stringify({
          storeId,
          calls,
          rows: existsSync(ledger)
            ? readFileSync(ledger, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line))
            : null,
          ledgerMissing: !existsSync(ledger),
        }),
      );
      if (exit) console.error(out, err);
      expect(exit).toBe(0);
      expect(out).toContain('STATUS_ORIGINAL_COMPLETE');
      expect(calls).toBe(0);
      if (mode === 'shared') {
        expect(daemon!.exitCode).toBeNull();
        expect((await client!.verifyConnection()).storeId).toBe(storeId);
      }
      const receipt = JSON.parse(readFileSync(`${evidence}.receipt.json`, 'utf8'));
      if (!receipt.normal || receipt.forcedCleanup || receipt.failure)
        throw Error('status_normal_driver_exit_unconfirmed');
      console.log('status retained', evidence);
    } catch (error) {
      failure = error;
    } finally {
      for (const action of [settleDriver, settleDaemon]) {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      client?.disposeNetwork();
      lifecycle?.disposeNetwork();
      provider.stop(true);
      if (!cleanupErrors.length) rmSync(root, { recursive: true, force: true });
      else retainedStatusOwners.add({ root, driver, daemon, lifecycle });
      writeFileSync(
        `${evidence}.cleanup.json`,
        JSON.stringify({
          originalFailure: failure ? String(failure) : null,
          cleanupErrors: cleanupErrors.map(String),
          retainedRoot: cleanupErrors.length ? root : null,
        }),
      );
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        'status_cleanup_unknown',
      );
    if (failure) throw failure;
  }, 40000);
