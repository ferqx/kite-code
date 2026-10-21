import { expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
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
import { cleanupOwnedNativeCandidate } from '../owned-native-cleanup.fixture';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free Native six-tool dual child approvals, same-Session follow-up, late answers, exact stop and cold zero replay',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-collaboration-'));
    // Isolated runner reuse only; normal product startup has no such switch.
    const reuseCandidate = process.env.KITE_TEST_COLLABORATION_CANDIDATE;
    const home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      moved = reuseCandidate ? realpathSync(reuseCandidate) : join(root, 'relocated');
    mkdirSync(workspace, { recursive: true });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    const held = new Map<string, () => void>();
    const bodies: {
      messages: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
    }[] = [];
    let agentId = '',
      provider: ReturnType<typeof Bun.serve> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let completed = false;
    try {
      if (!reuseCandidate) {
        const { buildTerminalBundle } = await import(
          resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
        );
        const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
        const built = await buildNativeCandidate({
          testDiagnostics: true,
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
          name: 'Collaboration',
          rootUri: pathToFileURL(workspace).href,
        });
        await seed.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create',
          sessionId: 'collaboration',
          workspaceId: 'w',
          title: 'Collaboration',
        });
      } finally {
        await seed.close();
      }
      const markers = [
        'NATIVE_COLLAB_START',
        'Follow up: NATIVE_COLLAB_FOLLOW',
        'CHILD_A',
        'CHILD_B',
        'CHILD_A_FOLLOWUP',
      ];
      function marker(content: unknown): string | undefined {
        if (typeof content !== 'string') return undefined;
        // Human Composer input is serialized Markdown; tool-authored child
        // prompts retain their exact original content without editor conversion.
        const human = markers.slice(0, 2).find((task) => task.replaceAll('_', '\\_') === content);
        if (human) return human;
        if (markers.slice(2).includes(content)) return content;
        try {
          const value = JSON.parse(content);
          return typeof value?.content === 'string' && markers.includes(value.content)
            ? value.content
            : undefined;
        } catch {
          return undefined;
        }
      }
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/state')
            return Response.json({ calls: bodies.length, held: [...held.keys()] });
          if (url.pathname === '/release') {
            for (const release of held.values()) release();
            held.clear();
            return new Response('released');
          }
          if (url.pathname === '/follow') {
            agentId = url.searchParams.get('agent')!;
            return new Response('recorded exact Agent');
          }
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          const reviews = body.messages.flatMap((message) => {
            if (message.role !== 'user' || typeof message.content !== 'string') return [];
            try {
              const value = JSON.parse(message.content);
              return value?.purpose === 'authorization_review' ? [value] : [];
            } catch {
              return [];
            }
          });
          let delta: unknown,
            reason = 'stop';
          if (reviews.length) {
            assert.equal(reviews.length, 1);
            assert.deepEqual(body.tools ?? [], []);
            assert.ok(['files.write', 'task.follow_up'].includes(reviews[0].target.definitionId));
            delta = {
              content: JSON.stringify({
                decision:
                  reviews[0].target.definitionId === 'task.follow_up' ? 'approve_once' : 'ask_user',
                reason: 'This exact child write requires its own human decision.',
              }),
            };
          } else {
            let index = -1,
              task: string | undefined;
            for (let i = body.messages.length - 1; i >= 0; i--) {
              const message = body.messages[i]!;
              if (message.role === 'user' && marker(message.content)) {
                index = i;
                task = marker(message.content);
                break;
              }
            }
            assert.ok(task);
            const tools = body.messages
              .slice(index + 1)
              .filter((message) => message.role === 'tool').length;
            const call = (name: string, args: unknown, id: string) => ({
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            });
            if (task === 'NATIVE_COLLAB_START' && tools === 0) {
              assert.ok(body.tools?.some((tool) => tool.function.name === 'spawn_agent'));
              delta = {
                tool_calls: ['CHILD_A', 'CHILD_B'].map((prompt, index) => ({
                  ...call('spawn_agent', { prompt, task_name: prompt }, `spawn-${index}`),
                  index,
                })),
              };
              reason = 'tool_calls';
            } else if (task === 'Follow up: NATIVE_COLLAB_FOLLOW' && tools === 0) {
              assert.notEqual(agentId, '');
              assert.ok(body.tools?.some((tool) => tool.function.name === 'follow_up_agent'));
              delta = {
                tool_calls: [
                  call(
                    'follow_up_agent',
                    { agent_id: agentId, content: 'CHILD_A_FOLLOWUP' },
                    'follow-exact-A',
                  ),
                ],
              };
              reason = 'tool_calls';
            } else if (task?.startsWith('CHILD_') && tools === 0) {
              if (task !== 'CHILD_A_FOLLOWUP')
                await new Promise<void>((release) => held.set(task!, release));
              const name =
                task === 'CHILD_A'
                  ? 'child-a.txt'
                  : task === 'CHILD_B'
                    ? 'child-b.txt'
                    : 'child-a-follow.txt';
              const content =
                task === 'CHILD_A'
                  ? 'A original approved\n'
                  : task === 'CHILD_B'
                    ? 'B must remain absent\n'
                    : 'A follow-up approved\n';
              delta = {
                tool_calls: [
                  call('write_file', { path: name, base: null, content }, `write-${task}`),
                ],
              };
              reason = 'tool_calls';
            } else delta = { content: `${task}_DONE` };
          }
          const frame = (value: unknown, finish: string | null) =>
            `data: ${JSON.stringify({ id: `collab-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
          return new Response(`${frame(delta, null)}${frame({}, reason)}data: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      const enabled = new Set([
        'ask_user',
        'files.write',
        'task.spawn',
        'task.follow_up',
        'task.message',
        'task.events',
        'task.list',
        'task.interrupt',
      ]);
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
          tools: ordinaryHostConfigurationDefaults(true, true).tools.map(({ id }) => ({
            id,
            enabled: enabled.has(id),
            ...(id === 'files.write' ? { definitionVersion: '2' } : {}),
          })),
        }),
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-collaboration-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
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
          storeId!,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text();
      let cleanup: Promise<void> | undefined;
      const timer = setTimeout(() => {
        driver!.kill('SIGTERM');
        cleanup = cleanupOwnedNativeCandidate(moved);
        void cleanup.catch(() => undefined);
      }, 90000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        console.log(stdout);
        writeFileSync(join(root, 'driver.stdout.log'), stdout);
        writeFileSync(join(root, 'driver.stderr.log'), stderr);
        if (code) console.error({ root, stderr });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
        await cleanup;
      }
      const report = JSON.parse(readFileSync(join(home, 'collaboration-report.json'), 'utf8')) as {
        a: string;
        b: string;
        next: string;
        agentId: string;
        oldRun: string;
        nextRun: string;
        coldZeroReplay: boolean;
      };
      expect(report.a).not.toBe(report.next);
      expect(report.oldRun).not.toBe(report.nextRun);
      expect(report.coldZeroReplay).toBe(true);
      expect(readFileSync(join(workspace, 'child-a.txt'), 'utf8')).toBe('A original approved\n');
      expect(readFileSync(join(workspace, 'child-a-follow.txt'), 'utf8')).toBe(
        'A follow-up approved\n',
      );
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        const first = await cold.getExecution(report.a),
          second = await cold.getExecution(report.next),
          stopped = await cold.getExecution(report.b);
        expect(first!.childSessionId).toBe(report.agentId);
        expect(second!.childSessionId).toBe(report.agentId);
        expect(stopped!.cancelRequestedAt).not.toBeNull();
        expect(first!.cancelRequestedAt).toBeNull();
        expect(second!.cancelRequestedAt).toBeNull();
      } finally {
        await cold.close();
      }
      completed = true;
    } finally {
      for (const release of held.values()) release();
      if (driver && driver.exitCode === null) {
        driver.kill('SIGTERM');
      }
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
      else console.error('collaboration_failed_candidate_retained', root);
    }
  },
  150000,
);
