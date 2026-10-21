import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ordinaryHostConfigurationDefaults } from '../../../service/src/configuration-defaults';
import { userConfigurationPath } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildNativeCandidate } from '../../scripts/build-native';
import { readLivePermissionFacts } from '../native-live-permission-facts.fixture';
import { cleanupOwnedNativeCandidate } from '../owned-native-cleanup.fixture';

const require = createRequire(import.meta.url);
type ModelBody = {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
};

test.skipIf(process.platform !== 'darwin')(
  'ordinary Electron live permission changes govern the next original main and running child tools and synchronize from independent HTTP',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-live-permissions-'));
    const home = join(root, 'home');
    const workspace = join(home, 'workspace');
    // Isolated runner reuse only: no product startup argument or diagnostic switch.
    const reuseCandidate = process.env.KITE_TEST_LIVE_PERMISSIONS_CANDIDATE;
    const moved = reuseCandidate ? realpathSync(reuseCandidate) : join(root, 'relocated');
    const evidence = resolve('dist/acceptance', `live-permissions-electron-${randomUUID()}`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    const mainEffectPath = join(home, 'external-main.txt');
    const childEffectPath = join(home, 'external-child.txt');
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    let provider: ReturnType<typeof Bun.serve> | undefined;
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let completed = false;
    let calls = 0;
    let reviews = 0;
    let providerFailure: string | undefined;
    const requests: { actor: string; tools: number; tool?: string }[] = [];
    try {
      if (!reuseCandidate) {
        const { buildTerminalBundle } = await import(
          resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
        );
        const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
        const built = await buildNativeCandidate({
          testDiagnostics: false,
          terminalRoot: terminal.root,
          electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
          outdir: join(root, 'source'),
        });
        renameSync(join(root, 'source'), moved);
        rmSync(terminal.root, { recursive: true, force: true });
        const bundle = verifyNativeRuntimeBundle(moved);
        expect(bundle.digest).toBe(built.digest);
      }
      const bundle = verifyNativeRuntimeBundle(moved);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: bundle.terminal.root, mode: 'shared' }),
      );
      initializeSqliteEngine({
        root: join(bundle.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: bundle.terminal.manifest.sqlite.manifestSha256,
      });
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        await seed.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Live permissions',
          rootUri: pathToFileURL(workspace).href,
        });
        await seed.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create-root',
          sessionId: 'permission-root',
          workspaceId: 'w',
          title: 'Live permissions',
        });
        await seed.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create-queue',
          sessionId: 'queue-root',
          workspaceId: 'w',
          title: 'Queue prompts',
        });
      } finally {
        await seed.close();
      }
      function facts() {
        return readLivePermissionFacts({
          dbPath: profile.databasePath,
          workspace,
          mainEffectPath,
          childEffectPath,
          storeId,
          calls,
          reviews,
        });
      }
      function taskMarker(content: unknown): 'main' | 'child' | undefined {
        let text = content;
        if (typeof content === 'string') {
          try {
            text = JSON.parse(content)?.content ?? content;
          } catch {
            /* Plain original user text. */
          }
        }
        return text === 'LIVE PERMISSIONS'
          ? 'main'
          : text === 'CHILD PERMISSIONS'
            ? 'child'
            : undefined;
      }
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          try {
            const url = new URL(request.url);
            if (url.pathname === '/facts') return Response.json(facts());
            if (url.pathname === '/release') {
              for (const role of ['main', 'child'])
                writeFileSync(join(workspace, `${role}.release`), 'release\n');
              return new Response('released');
            }
            if (url.pathname === '/queue-held')
              return Response.json({ held: existsSync(join(workspace, 'queue.marker')) });
            if (url.pathname === '/queue-shell-facts') {
              const db = new Database(profile.databasePath, { readonly: true });
              try {
                return Response.json(
                  db
                    .query(
                      "SELECT id,state AS status,attempt,cancel_requested_at AS cancelRequestedAt FROM execution WHERE session_id='queue-root' AND kind='tool' AND adapter_id='shell.execute' ORDER BY rowid LIMIT 1",
                    )
                    .get(),
                );
              } finally {
                db.close();
              }
            }
            if (url.pathname === '/queue-release') {
              writeFileSync(join(workspace, 'queue.release'), 'release\n');
              return new Response('released');
            }
            assert.equal(url.pathname, '/v1/chat/completions');
            const body = (await request.json()) as ModelBody;
            calls++;
            assert.ok(calls < 25, 'bounded original model journey');
            const review = body.messages.flatMap((message) => {
              if (message.role !== 'user' || typeof message.content !== 'string') return [];
              try {
                const value = JSON.parse(message.content);
                return value?.purpose === 'authorization_review' ? [value] : [];
              } catch {
                return [];
              }
            });
            let delta: unknown;
            let finishReason = 'stop';
            const queueJourney = body.messages.some(
              (message) =>
                message.role === 'user' &&
                taskMarker(message.content) === undefined &&
                typeof message.content === 'string' &&
                message.content.includes('QUEUE JOURNEY'),
            );
            if (queueJourney && !review.length) {
              const tools = body.messages.filter((row) => row.role === 'tool');
              if (!tools.length) {
                assert.ok(body.tools?.some((tool) => tool.function.name === 'shell_execute'));
                requests.push({ actor: 'queue', tools: 0, tool: 'shell_execute' });
                finishReason = 'tool_calls';
                delta = {
                  tool_calls: [
                    {
                      index: 0,
                      id: `queue-${calls}`,
                      type: 'function',
                      function: {
                        name: 'shell_execute',
                        arguments: JSON.stringify({
                          key: 'queue-held',
                          command: `printf '%s' '${'LONG SAFE QUEUE SHELL '.repeat(18)}' > queue.marker; while [ ! -f queue.release ]; do sleep 0.05; done`,
                          execution_timeout_ms: 60000,
                          permissions: { filesystem: 'full_access', network: 'none' },
                        }),
                      },
                    },
                  ],
                };
              } else {
                requests.push({ actor: 'queue', tools: tools.length });
                delta = { content: 'QUEUE DONE' };
              }
            } else if (review.length) {
              assert.equal(review.length, 1);
              assert.deepEqual(body.tools ?? [], []);
              assert.equal(review[0].target.definitionId, 'files.write_path');
              reviews++;
              requests.push({ actor: 'review', tools: 0 });
              delta = {
                content: JSON.stringify({
                  decision: 'ask_user',
                  reason: 'This exact external file write requires a human decision.',
                }),
              };
            } else {
              let actor: 'main' | 'child' | undefined;
              let start = -1;
              for (let index = body.messages.length - 1; index >= 0; index--) {
                const row = body.messages[index]!;
                if (row.role === 'user' && taskMarker(row.content)) {
                  actor = taskMarker(row.content);
                  start = index;
                  break;
                }
              }
              assert.ok(actor, 'exact original task is in model input');
              const tools = body.messages.slice(start + 1).filter((row) => row.role === 'tool');
              const call = (name: string, args: unknown) => {
                assert.ok(
                  body.tools?.some((tool) => tool.function.name === name),
                  `available real tool: ${name}`,
                );
                requests.push({ actor, tools: tools.length, tool: name });
                finishReason = 'tool_calls';
                return {
                  tool_calls: [
                    {
                      index: 0,
                      id: `${actor}-${calls}`,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                };
              };
              if (actor === 'main' && tools.length === 0) {
                delta = call('spawn_agent', {
                  prompt: 'CHILD PERMISSIONS',
                  task_name: 'permission-child',
                });
              } else if (tools.length === (actor === 'main' ? 1 : 0)) {
                const label = actor.toUpperCase();
                delta = call('shell_execute', {
                  key: `held-${actor}`,
                  command: `printf '${label} STARTED\\n' > ${actor}.marker; while [ ! -f ${actor}.release ]; do sleep 0.05; done; printf '${label} FINISHED\\n' >> ${actor}.marker`,
                  execution_timeout_ms: 60000,
                });
              } else if (tools.length === (actor === 'main' ? 2 : 1)) {
                delta = call('write_user_file', {
                  path: actor === 'main' ? mainEffectPath : childEffectPath,
                  base: null,
                  content: `${actor.toUpperCase()} EFFECT\n`,
                });
              } else if (actor === 'child') {
                requests.push({ actor, tools: tools.length });
                delta = { content: 'CHILD PERMISSIONS DONE' };
              } else {
                const spawned = JSON.parse(String(tools[0]!.content));
                assert.equal(typeof spawned.agent_id, 'string');
                const events = tools.flatMap((row) => {
                  try {
                    const value = JSON.parse(String(row.content));
                    return typeof value?.next_seq === 'string' && Array.isArray(value.events)
                      ? [value]
                      : [];
                  } catch {
                    return [];
                  }
                });
                if (
                  events.some((value) =>
                    value.events.some(
                      (event: { kind: string; agent_id: string }) =>
                        event.kind === 'completed' && event.agent_id === spawned.agent_id,
                    ),
                  )
                ) {
                  requests.push({ actor, tools: tools.length });
                  delta = { content: 'MAIN PERMISSIONS DONE' };
                } else {
                  delta = call('wait_agent_events', {
                    after_seq: events.at(-1)?.next_seq ?? '0',
                    wait_ms: 180000,
                  });
                }
              }
            }
            const frame = (value: unknown, reason: string | null) =>
              `data: ${JSON.stringify({ id: `live-${calls}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
            return new Response(`${frame(delta, null)}${frame({}, finishReason)}data: [DONE]\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          } catch (error) {
            providerFailure = error instanceof Error ? error.message : 'provider_failed';
            return Response.json({ error: 'fixture_failed' }, { status: 500 });
          }
        },
      });
      const enabled = new Set(['shell.execute', 'task.spawn', 'task.events']);
      writeFileSync(
        userConfigurationPath(home),
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              modelCapabilities: { contextWindowTokens: 1000000 },
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools: [
            ...ordinaryHostConfigurationDefaults(true, true).tools.map(({ id }) => ({
              id,
              enabled: enabled.has(id),
            })),
            { id: 'files.write_path', enabled: true, definitionVersion: '1' },
          ],
        }),
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-live-permissions-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron, type Page } from 'playwright';",
          `import type {Page} from 'playwright';import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      expect(
        (
          await Bun.build({
            entrypoints: [fixture],
            target: 'node',
            format: 'esm',
            packages: 'external',
            outdir: root,
            naming: 'driver.js',
          })
        ).success,
      ).toBe(true);
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          provider.url.href.replace(/\/$/, ''),
          evidence,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const out = new Response(driver.stdout).text();
      const err = new Response(driver.stderr).text();
      let cleanup: Promise<void> | undefined;
      const timer = setTimeout(() => {
        driver!.kill('SIGTERM');
        cleanup = cleanupOwnedNativeCandidate(moved);
        void cleanup.catch(() => undefined);
      }, 150000);
      try {
        const code = await driver.exited;
        writeFileSync(join(evidence, 'driver.stdout.log'), await out);
        writeFileSync(join(evidence, 'driver.stderr.log'), await err);
        writeFileSync(
          join(evidence, 'provider.json'),
          JSON.stringify({ requests, calls, reviews, failure: providerFailure }, null, 2),
        );
        if (code)
          console.error({
            root,
            evidence,
            providerFailure,
            stderr: readFileSync(join(evidence, 'driver.stderr.log'), 'utf8'),
          });
        expect(code).toBe(0);
        expect(providerFailure).toBeUndefined();
      } finally {
        clearTimeout(timer);
        await cleanup;
      }
      const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
      expect(report.normalShutdown).toBe(true);
      expect(report.electronExitCode).toBe(0);
      expect(report.rendererVisibleModeSynchronized).toBe(true);
      expect(report.answerPosts).toBe(0);
      expect(report.reviews).toBe(2);
      expect(report.childCount).toBe(1);
      expect(report.queueWindowVerified).toBe(true);
      expect(report.queueAnswerPosts).toBe(1);
      expect(report.queueEvidence.hoverOpened).toBe(true);
      expect(readFileSync(mainEffectPath, 'utf8')).toBe('MAIN EFFECT\n');
      expect(readFileSync(childEffectPath, 'utf8')).toBe('CHILD EFFECT\n');
      const cold = facts();
      expect(cold.terminal).toBe(true);
      expect(cold.calls).toBe(report.calls);
      expect(cold.actors.main?.target?.controlRevisions).toContain(cold.mode.revision);
      expect(cold.actors.child?.target?.controlRevisions).toContain(cold.mode.revision);
      writeFileSync(join(evidence, 'cold-facts.json'), JSON.stringify(cold, null, 2));
      const processes = String(execFileSync('/bin/ps', ['-axo', 'comm='])).split('\n');
      expect(processes.filter((command) => command.trim().startsWith(`${moved}/`))).toEqual([]);
      completed = true;
      console.log(
        JSON.stringify({ stage: 'live_permissions_electron_passed', evidence, calls, reviews }),
      );
    } finally {
      writeFileSync(join(workspace, 'queue.release'), 'release\n');
      for (const role of ['main', 'child'])
        writeFileSync(join(workspace, `${role}.release`), 'release\n');
      if (driver && driver.exitCode === null) driver.kill('SIGTERM');
      await cleanupOwnedNativeCandidate(moved);
      if (driver) await driver.exited;
      provider?.stop(true);
      for (const lease of leases.reverse()) lease.release();
      for (const path of [moved, join(moved, 'terminal')]) {
        if (!existsSync(path)) continue;
        const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        exclusive.release();
      }
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.error('live_permissions_failed_candidate_retained', { root, evidence });
    }
  },
  210000,
);
