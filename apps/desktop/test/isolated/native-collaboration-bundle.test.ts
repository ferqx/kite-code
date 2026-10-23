import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
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
  'source-free Native child wake-up messages, active intake without bubbles, Session grants and cold zero replay',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-collaboration-'));
    const evidence = resolve('dist/acceptance', `child-result-message-${randomUUID()}`);
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
    const heldChecks = new Map<string, () => void>();
    const completions = new Map<string, number>();
    let heldParentReport: (() => void) | undefined;
    let heldActiveParent: (() => void) | undefined;
    let heldActiveResult: (() => void) | undefined;
    let gatedChecks = 0,
      titleCalls = 0;
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
          title: '',
        });
      } finally {
        await seed.close();
      }
      const markers = [
        'NATIVE_COLLAB_START',
        'Follow up: NATIVE_COLLAB_FOLLOW',
        'NATIVE_COLLAB_ACTIVE',
        'CHILD_A',
        'CHILD_B',
        'CHILD_A_FOLLOWUP',
        'CHILD_A_ACTIVE',
      ];
      function marker(content: unknown): string | undefined {
        if (typeof content !== 'string') return undefined;
        // Human Composer input is serialized Markdown; tool-authored child
        // prompts retain their exact original content without editor conversion.
        const human = markers.slice(0, 3).find((task) => task.replaceAll('_', '\\_') === content);
        if (human) return human;
        if (markers.slice(3).includes(content)) return content;
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
            return Response.json({
              calls: bodies.length,
              held: [...held.keys()],
              heldChecks: [...heldChecks.keys()],
              titleCalls,
              parentReportHeld: !!heldParentReport,
              activeParentHeld: !!heldActiveParent,
              activeResultHeld: !!heldActiveResult,
            });
          if (url.pathname === '/release') {
            for (const release of held.values()) release();
            held.clear();
            return new Response('released');
          }
          if (url.pathname === '/release-checks') {
            for (const release of heldChecks.values()) release();
            heldChecks.clear();
            return new Response('checks released');
          }
          if (url.pathname === '/release-report') {
            heldParentReport?.();
            heldParentReport = undefined;
            return new Response('parent report released');
          }
          if (url.pathname === '/release-active-parent') {
            heldActiveParent?.();
            heldActiveParent = undefined;
            return new Response('active parent checkpoint released');
          }
          if (url.pathname === '/release-active-result') {
            heldActiveResult?.();
            heldActiveResult = undefined;
            return new Response('active parent final reply released');
          }
          if (url.pathname === '/follow') {
            agentId = url.searchParams.get('agent')!;
            return new Response('recorded exact Agent');
          }
          if (url.pathname === '/active-intake') {
            // Private fixture observation of the actual ack; public Execution
            // intentionally does not expose resultAcceptance.
            const observed = new Database(profile.databasePath, { readonly: true });
            try {
              const row = observed
                .query(
                  `SELECT s.id AS sourceId,target.id AS runId,target.status,target.is_active AS isActive,
                    json_extract(report.receipt_json,'$.mode') AS mode
                   FROM execution e JOIN context_snapshot s ON s.execution_id=e.id
                    AND s.result_revision=e.result_revision AND s.kind='result_ref'
                   JOIN command report ON report.session_id=s.session_id AND report.status='applied'
                    AND report.kind IN('job.report','job.report.continue')
                    AND json_extract(report.receipt_json,'$.sourceId')=s.id
                    AND json_extract(report.receipt_json,'$.executionId')=e.id
                   JOIN run target ON target.id=json_extract(report.receipt_json,'$.runId')
                   WHERE e.id=? AND e.session_id='collaboration' AND e.delivery='consumed'`,
                )
                .get(url.searchParams.get('execution') ?? '') as {
                sourceId: string;
                runId: string;
                status: string;
                isActive: number;
                mode: string;
              } | null;
              return Response.json(row);
            } finally {
              observed.close();
            }
          }
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          const reviews = body.messages.flatMap((message) => {
            if (message.role !== 'user' || typeof message.content !== 'string') return [];
            try {
              const value = JSON.parse(message.content);
              return value?.purpose === 'authorization_check' ? [value] : [];
            } catch {
              return [];
            }
          });
          let delta: unknown,
            reason = 'stop';
          const naming = body.messages.some(
            (message) =>
              message.role === 'system' &&
              typeof message.content === 'string' &&
              message.content.includes('readable conversation title'),
          );
          if (naming) {
            titleCalls++;
            assert.deepEqual(body.tools ?? [], []);
            delta = { content: '协作审批测试' };
          } else if (reviews.length) {
            assert.equal(reviews.length, 1);
            assert.deepEqual(body.tools ?? [], []);
            assert.ok(
              ['files.write', 'shell.execute', 'shell.command', 'task.follow_up'].includes(
                reviews[0].target.definitionId,
              ),
            );
            if (reviews[0].target.definitionId === 'shell.execute' && gatedChecks++ < 2)
              await new Promise<void>((release) =>
                heldChecks.set(reviews[0].target.executionId, release),
              );
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
            } else if (task === 'NATIVE_COLLAB_ACTIVE' && tools === 0) {
              assert.notEqual(agentId, '');
              delta = {
                tool_calls: [
                  call(
                    'follow_up_agent',
                    { agent_id: agentId, content: 'CHILD_A_ACTIVE' },
                    'follow-A-during-parent-turn',
                  ),
                ],
              };
              reason = 'tool_calls';
            } else if (task === 'NATIVE_COLLAB_ACTIVE' && tools === 1) {
              await new Promise<void>((release) => {
                heldActiveParent = release;
              });
              delta = {
                tool_calls: [call('wait_agent_events', { wait_ms: 0 }, 'active-parent-events')],
              };
              reason = 'tool_calls';
            } else if ((task === 'CHILD_A' && tools < 2) || (task === 'CHILD_B' && tools === 0)) {
              if (tools === 0) await new Promise<void>((release) => held.set(task!, release));
              delta = {
                tool_calls: [
                  call(
                    'shell_execute',
                    {
                      key: `${task}-${tools}`,
                      command: `printf 'A original approved\\n' > child-a.txt; printf 'approved\\n' >> session-command.txt`,
                      permissions: { filesystem: 'full_access', network: 'none' },
                    },
                    `shell-${task}-${tools}`,
                  ),
                ],
              };
              reason = 'tool_calls';
            } else if (task === 'CHILD_A_FOLLOWUP' && tools === 0) {
              delta = {
                tool_calls: [
                  call(
                    'write_file',
                    { path: 'child-a-follow.txt', base: null, content: 'A follow-up approved\n' },
                    `write-${task}`,
                  ),
                ],
              };
              reason = 'tool_calls';
            } else {
              if (task === 'CHILD_A_ACTIVE')
                await new Promise<void>((release) => held.set(task!, release));
              if (task === 'NATIVE_COLLAB_ACTIVE')
                await new Promise<void>((release) => {
                  heldActiveResult = release;
                });
              const ordinal = (completions.get(task!) ?? 0) + 1;
              completions.set(task!, ordinal);
              if (task === 'NATIVE_COLLAB_START' && ordinal === 2) {
                // The result must be readable before the resumed parent has a
                // reply; a second model-facing copy would violate this boundary.
                assert.equal(
                  body.messages.filter(
                    (message) =>
                      typeof message.content === 'string' &&
                      message.content.includes('CHILD_A_DONE_1'),
                  ).length,
                  1,
                );
                await new Promise<void>((release) => {
                  heldParentReport = release;
                });
              }
              delta = { content: `${task}_DONE_${ordinal}` };
            }
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
        'shell.execute',
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
          resolve(import.meta.dir, '../../package.json'),
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
        staticCreationHistory: boolean;
        staticHistoryStages: { phase: string; cold: boolean; names: string[] }[];
        historyFrameErrors: unknown[];
        resultMessages: { id: string; executionId: string; content: string }[];
        active: { executionId: string; parentRunId: string; sourceId: string };
      };
      expect(report.a).not.toBe(report.next);
      expect(report.oldRun).not.toBe(report.nextRun);
      expect(report.coldZeroReplay).toBe(true);
      expect(report.staticCreationHistory).toBe(true);
      expect(report.staticHistoryStages.filter((stage) => !stage.cold).length).toBeGreaterThan(3);
      expect(report.staticHistoryStages.some((stage) => stage.cold)).toBe(true);
      expect(report.historyFrameErrors).toEqual([]);
      expect(report.resultMessages).toHaveLength(2);
      expect(report.resultMessages.map((message) => message.executionId)).toEqual([
        report.a,
        report.next,
      ]);
      expect(titleCalls).toBe(1);
      expect(readFileSync(join(workspace, 'child-a.txt'), 'utf8')).toBe('A original approved\n');
      expect(readFileSync(join(workspace, 'session-command.txt'), 'utf8')).toBe(
        'approved\napproved\n',
      );
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
        expect(stopped!.status).toBe('cancelled');
        expect(first!.cancelRequestedAt).toBeNull();
        expect(second!.cancelRequestedAt).toBeNull();
        const active = (await cold.getExecution(report.active.executionId))!;
        expect(active.resultAcceptance).toMatchObject({
          runId: report.active.parentRunId,
          sourceId: report.active.sourceId,
        });
        expect((await cold.getRun(report.active.parentRunId))!.status).toBe('completed');
        const snapshotDB = new Database(profile.databasePath, { readonly: true });
        try {
          expect(snapshotDB.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 3 });
        } finally {
          snapshotDB.close();
        }
        expect(await cold.listSessions()).toHaveLength(1);
        const rootView = await cold.getView('collaboration');
        const resultMessages = rootView.messages.filter((message) => message.agentResult);
        expect(
          resultMessages.map((message) => ({
            id: message.id,
            executionId: message.agentResult!.executionId,
            content: message.content,
          })),
        ).toEqual(report.resultMessages);
        expect(resultMessages.map((message) => message.agentResult!.childSessionId)).toEqual([
          report.agentId,
          report.agentId,
        ]);
        expect(resultMessages.map((message) => message.agentResult!.childRunId)).toEqual([
          report.oldRun,
          report.nextRun,
        ]);
        const lastCursor = (await cold.getMetadata()).lastChangeCursor;
        expect(await cold.listMessages('collaboration')).toEqual(rootView.messages);
        expect((await cold.getMetadata()).lastChangeCursor).toBe(lastCursor);
        const scopes = ['collaboration', report.agentId, stopped!.childSessionId!];
        const internalCalls: unknown[] = [];
        let checks = 0,
          titles = 0;
        for (const sessionId of scopes) {
          const view = await cold.getView(sessionId);
          expect(view.executions.filter((execution) => execution.childSessionId).length).toBe(
            sessionId === 'collaboration' ? 4 : 0,
          );
          for (const execution of view.executions) {
            const command = await cold.getCommand(execution.originCommandId);
            if (command?.kind !== 'authorization.check' && command?.kind !== 'session.title')
              continue;
            expect(execution).toMatchObject({ kind: 'model', runId: null, childSessionId: null });
            expect(execution.input).not.toBeNull();
            expect(execution.result).not.toBeNull();
            internalCalls.push({ execution, command });
            if (command.kind === 'authorization.check') checks++;
            else titles++;
          }
        }
        expect(checks).toBeGreaterThanOrEqual(4);
        expect(titles).toBe(1);
        const grants = await Promise.all(
          scopes.map((sessionId) =>
            cold.listPermissionGrants({
              expectedStoreId: storeId!,
              subjectId: 'local-user',
              sessionId,
            }),
          ),
        );
        expect(grants[0]!.items).toHaveLength(0);
        expect(grants[2]!.items).toHaveLength(0);
        expect(
          grants[1]!.items.map((item) => [
            item.grant.sessionId,
            item.grant.kind,
            item.grant.definitionId,
          ]),
        ).toEqual([
          [report.agentId, 'tool', 'shell.execute'],
          [report.agentId, 'job', 'shell.command'],
        ]);
        writeFileSync(
          join(home, 'cold-permission-evidence.json'),
          JSON.stringify({
            candidateDigest: bundle.digest,
            sessionCount: 3,
            checks,
            titles,
            scopes,
            grants,
            internalCalls,
          }),
        );
      } finally {
        await cold.close();
      }
      completed = true;
    } finally {
      for (const release of held.values()) release();
      for (const release of heldChecks.values()) release();
      heldParentReport?.();
      heldActiveParent?.();
      heldActiveResult?.();
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
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      for (const name of [
        '00-two-children-checks-title.png',
        '01-dual-child-pending.png',
        '02-child-session-approval-menu.png',
        '03-a-completed-b-pending.png',
        '03a-child-result-parent-continuing.png',
        '03b-child-result-followup.png',
        '03c-active-result-in-process.png',
        '03ca-active-result-detail.png',
        '03d-active-parent-completed.png',
        '03e-static-creation-after-cancel.png',
        '04-cold-reopened.png',
        'collaboration-report.json',
        'cold-permission-evidence.json',
      ]) {
        const source = join(home, name);
        if (existsSync(source)) copyFileSync(source, join(evidence, name));
      }
      if (existsSync(join(home, 'process-frames')))
        cpSync(join(home, 'process-frames'), join(evidence, 'process-frames'), { recursive: true });
      for (const name of ['driver.stdout.log', 'driver.stderr.log']) {
        const source = join(root, name);
        if (existsSync(source)) copyFileSync(source, join(evidence, name));
      }
      console.log('collaboration_evidence_retained', evidence);
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.error('collaboration_failed_candidate_retained', root);
    }
  },
  150000,
);
