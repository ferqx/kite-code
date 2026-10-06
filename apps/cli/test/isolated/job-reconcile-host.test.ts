import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  inspectProcess,
  readDaemonReservation,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import { runSelectedDaemon } from '../../host/daemon';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { createLedgerExtension } from '../fixtures/job-reconcile-ledger';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('reconciliation_host_fixture_timeout');
    await Bun.sleep(5);
  }
}
nativeTest(
  'compiled CLI reconciles the exact cold Job through paired and shared Service without repeating its effect',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-cli-reconcile-'));
    let daemonClosed = true;
    try {
      const baseEntry = await buildOwnedDaemon(join(root, 'artifact'));
      const output = dirname(baseEntry);
      const built = await Bun.build({
        entrypoints: [
          'job-reconcile-paired-child',
          'job-reconcile-daemon-child',
          'job-reconcile-driver',
        ].map((name) => new URL(`../fixtures/${name}.ts`, import.meta.url).pathname),
        packages: 'external',
        target: 'bun',
        outdir: output,
      });
      expect(built.success).toBe(true);
      const driver = join(output, 'job-reconcile-driver.js');
      const executable = realpathSync(process.execPath);
      for (const mode of ['paired', 'shared'] as const) {
        const base = join(root, mode);
        mkdirSync(base, { mode: 0o700 });
        const dataRoot = join(base, 'data');
        const profile = selectProfile({ dataRoot, profile: 'owned' });
        const store = await openSqliteStore(profile);
        const expectedStoreId = (await store.getMetadata()).storeId;
        const finish: ModelEvent = {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        const runtime = createRuntime({
          store,
          artifacts: createArtifactStore({ store, profile }),
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'fixture' };
            },
          },
          extensions: [createLedgerExtension(join(base, 'ledger'))],
          model: createFixedModel([
            [
              { type: 'tool_call', id: 'launch', name: 'ledger.launch', arguments: '{}' },
              { ...finish, reason: 'tool_calls' },
            ],
            [finish],
          ]),
        });
        let job: NonNullable<Awaited<ReturnType<typeof store.getExecution>>>;
        try {
          await runtime.createWorkspace({
            expectedStoreId,
            id: 'w',
            rootUri: `file://${base}`,
            name: 'owned',
          });
          await runtime.createSession({
            expectedStoreId,
            commandId: 'create',
            sessionId: 's',
            subjectId: 'local-user',
            workspaceId: 'w',
            title: 'original',
          });
          await runtime.submitCommand({
            expectedStoreId,
            commandId: 'work',
            sessionId: 's',
            subjectId: 'local-user',
            request: { kind: 'run.start', content: 'one external effect' },
          });
          await runtime.waitForCommand('work');
          await until(async () =>
            (await store.getView('s')).executions.some(
              (e) => e.kind === 'job' && e.status === 'outcome_unknown',
            ),
          );
          job = (await store.getView('s')).executions.find((e) => e.kind === 'job')!;
        } finally {
          await runtime.close();
        }
        const ledgerBefore = readFileSync(join(base, 'ledger'), 'utf8');
        const entrypoint = join(
          output,
          mode === 'paired' ? 'job-reconcile-paired-child.js' : 'job-reconcile-daemon-child.js',
        );
        const artifact = {
          entrypoint,
          entrypointSha256: hash(readFileSync(entrypoint)),
          executable,
          executableSha256: hash(readFileSync(executable)),
          apiMajor: 1 as const,
          buildId: 'reconcile-owned',
        };
        const artifactFile = join(base, 'artifact.json');
        writeFileSync(artifactFile, JSON.stringify(artifact));
        const endpoint = selectDaemonEndpoint({
          profileAccessKey: profile.profileAccessKey,
          explicitSocket: join(base, 's.sock'),
        });
        const web = join(base, 'web');
        mkdirSync(web);
        const manifest = [
          ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
          ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
          ['/app.css', 'text/css; charset=utf-8', 'body{}'],
        ].map(([path, mediaType, content]) => {
          writeFileSync(join(web, path!.slice(1)), content!);
          return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
        });
        const raw = JSON.stringify(manifest);
        writeFileSync(join(web, 'manifest.json'), raw);
        const daemon = (action: 'start' | 'stop') =>
          runSelectedDaemon({
            arguments: {
              kind: 'server',
              action,
              server: endpoint.socket,
              cancel: false,
              json: false,
            },
            dataRoot,
            profile: 'owned',
            cwd: base,
            artifact: {
              ...artifact,
              daemon: {
                entrypoint,
                entrypointSha256: artifact.entrypointSha256,
                web: { directory: web, manifestSha256: hash(raw) },
              },
            },
            write() {},
          });
        let daemonStarted = false;
        async function stopWithObservationFault(persistent: boolean) {
          const actual = { ...(await import('@kite-ai/service/daemon')) };
          const record = actual.readDaemonReservation(endpoint)!;
          const bootstrap = await actual.requestDaemonBootstrap(endpoint, {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          });
          const origin = new URL(bootstrap.httpEndpoint).origin;
          const fetch = globalThis.fetch;
          let posts = 0,
            faults = 0;
          globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
            const input = args[0];
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = args[1]?.method ?? (input instanceof Request ? input.method : 'GET');
            if (
              url.origin === origin &&
              url.pathname === '/v1/lifecycle/shutdown' &&
              method === 'POST'
            )
              posts++;
            return fetch(...args);
          }, fetch);
          mock.module('@kite-ai/service/daemon', () => ({
            ...actual,
            inspectProcess(pid: number, start: string) {
              if (
                posts > 0 &&
                pid === record.pid &&
                start === record.processStartIdentity &&
                (persistent || faults === 0)
              ) {
                faults++;
                return 'uncertain' as const;
              }
              return actual.inspectProcess(pid, start);
            },
          }));
          const started = Date.now();
          try {
            if (persistent)
              await expect(daemon('stop')).rejects.toMatchObject({
                code: 'daemon_identity_uncertain',
              });
            else expect(await daemon('stop')).toBe(0);
            expect(posts).toBe(1);
            if (persistent) expect(faults).toBeGreaterThan(1);
            else expect(faults).toBe(1);
            console.log(
              JSON.stringify({
                stage: 'job_reconcile_daemon_stop_observation',
                persistent,
                posts,
                faults,
                elapsedMs: Date.now() - started,
              }),
            );
          } finally {
            globalThis.fetch = fetch;
            mock.module('@kite-ai/service/daemon', () => actual);
            // The injected observation is never death evidence. Cleanup separately waits
            // for the real kernel identity of this exact owned daemon, without signalling it.
            await until(
              async () => actual.inspectProcess(record.pid, record.processStartIdentity) === 'dead',
            );
            daemonStarted = false;
            daemonClosed = true;
          }
        }
        try {
          if (mode === 'shared') {
            daemonClosed = false;
            await daemon('start');
            daemonStarted = true;
          }
          const intent = {
            kind: 'job.reconcile',
            expectedStoreId,
            commandId: 'verify',
            executionId: job!.id,
            expectedResultRevision: job!.resultRevision,
          };
          for (let repeat = 0; repeat < 2; repeat++) {
            const child = Bun.spawn(
              [
                executable,
                driver,
                mode === 'shared' ? '-' : artifactFile,
                'job',
                'reconcile',
                's',
                '--data-root',
                dataRoot,
                '--input',
                JSON.stringify(intent),
                ...(mode === 'shared' ? ['--server', endpoint.socket] : []),
              ],
              { stdout: 'pipe', stderr: 'pipe' },
            );
            try {
              const out = new Response(child.stdout).text(),
                err = new Response(child.stderr).text();
              const exit = await child.exited;
              expect({ exit, err: await err }).toEqual({ exit: 0, err: '' });
              const fact = JSON.parse((await out).trim().split('\n').at(-1)!);
              expect(fact.status).toBe('verified');
              expect(fact.intent.request).toEqual(intent);
              expect(fact.command.receipt.evidenceSource).toBe('adapter_reconcile');
            } finally {
              if (child.exitCode === null) {
                child.kill('SIGKILL');
                await child.exited;
              }
            }
          }
          expect(readFileSync(join(base, 'queries'), 'utf8')).toBe('query\n');
          expect(readFileSync(join(base, 'ledger'), 'utf8')).toBe(ledgerBefore);
          expect(existsSync(join(base, 'unexpected-start'))).toBe(false);
          const observed = await openSqliteStore({ ...profile, mode: 'readonly' });
          try {
            const old = await observed.getExecution(job!.id);
            expect(old?.result).toEqual(job!.result);
            expect(old?.resultRevision).toBe(job!.resultRevision);
            expect(old?.status).toBe('outcome_unknown');
            expect((await observed.getView('s')).runs).toHaveLength(1);
          } finally {
            await observed.close();
          }
          if (mode === 'shared') {
            const reservation = readDaemonReservation(endpoint)!;
            expect(inspectProcess(reservation.pid, reservation.processStartIdentity)).toBe('alive');
          } else {
            for (const pid of readFileSync(join(base, 'hosts'), 'utf8')
              .trim()
              .split('\n')
              .map(Number))
              expect(() => process.kill(pid, 0)).toThrow();
          }
        } finally {
          if (daemonStarted) {
            await stopWithObservationFault(false);
            daemonClosed = false;
            await daemon('start');
            daemonStarted = true;
            await stopWithObservationFault(true);
            expect(readFileSync(join(base, 'queries'), 'utf8')).toBe('query\n');
            expect(readFileSync(join(base, 'ledger'), 'utf8')).toBe(ledgerBefore);
            expect(existsSync(join(base, 'unexpected-start'))).toBe(false);
          }
        }
      }
    } finally {
      if (daemonClosed) rmSync(root, { recursive: true, force: true });
      else console.error(JSON.stringify({ stage: 'job_reconcile_cleanup_unconfirmed', root }));
    }
  },
  60000,
);
