import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import {
  collectProfileGarbage,
  createProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free default Native background overview retains original tasks, full child logs and exact stop across actual backup restore cold reopen plus original PC Workspace removal',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-background-bundle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    const workspace = join(home, 'workspace'),
      secondWorkspace = join(home, 'workspace-two');
    mkdirSync(workspace);
    mkdirSync(secondWorkspace);
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const unicode = '原始子模型完整日志🙂漢字𠮷\n'.repeat(6000);
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(65536);
    const calls: { marker: string; tools: number }[] = [];
    const releases = new Map<string, () => void>();
    let baseline: Awaited<ReturnType<typeof snapshot>> | undefined,
      restoredStoreId: string | undefined;
    let restoreStarted = false;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/verify-cold-baseline') {
          const current = await snapshot(profile);
          expect(current).toEqual(baseline!);
          return Response.json(current);
        }
        if (url.pathname === '/count')
          return Response.json({ count: calls.length, held: [...releases.keys()] });
        if (url.pathname.startsWith('/release/')) {
          const marker = decodeURIComponent(url.pathname.slice('/release/'.length));
          if (marker === 'all') for (const release of releases.values()) release();
          else releases.get(marker)?.();
          return new Response('released');
        }
        if (url.pathname === '/restore') {
          if (restoreStarted) return new Response('restore_already_started', { status: 409 });
          restoreStarted = true;
          const pid = Number(url.searchParams.get('pid'));
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          expect(() => process.kill(pid, 0)).toThrow();
          try {
            const before = await snapshot(profile);
            const backup = await createProfileBackup({
              profile,
              destinationRoot: join(root, 'backup'),
            });
            // Public maintenance obtains the exclusive profile-use lease after the
            // ordinary Electron/Service exit; no metadata or SQL relabeling.
            const restored = await restoreProfileBackup({
              profile,
              expectedStoreId: before.storeId,
              backup,
              intent: 'replace_with_selected_backup',
            });
            expect(restored.outcome).toBe('restored');
            expect(restored.storeId).not.toBe(before.storeId);
            restoredStoreId = restored.storeId;
            baseline = await snapshot(profile);
            expect(baseline.storeId).toBe(restoredStoreId);
            const identities = (value: typeof before) =>
              value.sessions.map((session) => ({
                id: session.id,
                runs: session.runs.map((run) => ({ id: run.id, originStoreId: run.originStoreId })),
                executions: session.executions.map((execution) => ({
                  id: execution.id,
                  sessionId: execution.sessionId,
                  childSessionId: execution.childSessionId,
                  originStoreId: execution.originStoreId,
                  cancelRequestedAt: execution.cancelRequestedAt,
                })),
              }));
            expect(identities(baseline)).toEqual(identities(before));
            const evidence = {
              originalStoreId: before.storeId,
              restoredStoreId,
              restoreId: restored.restoreId,
              backupVersion: backup.manifest.version,
              originalServicePid: pid,
              serviceAbsent: true,
              exclusiveProfileLease: true,
              cursor: baseline.cursor,
              calls: calls.length,
            };
            writeFileSync(join(root, 'restore-evidence.json'), JSON.stringify(evidence));
            console.log(JSON.stringify({ stage: 'public_backup_restore_A_to_B', ...evidence }));
            return Response.json(evidence);
          } catch (cause) {
            const code = (cause as { code?: string }).code ?? 'maintenance_failed';
            const evidence = {
              stage: 'public_backup_restore_failed',
              code,
              originalServicePid: pid,
              root,
            };
            writeFileSync(join(root, 'restore-failure.json'), JSON.stringify(evidence));
            console.error(JSON.stringify(evidence));
            return Response.json(evidence, { status: 500 });
          }
        }
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        const lastUser = body.messages.filter((row) => row.role === 'user').at(-1)?.content;
        const marker = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser);
        const tools = body.messages.filter((row) => row.role === 'tool').length;
        calls.push({ marker, tools });
        const frame = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        const userContents = body.messages
          .filter((row) => row.role === 'user')
          .map((row) =>
            typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
          );
        const isOriginal = userContents.some((content) => content.includes('ORIGINAL_PARENT'));
        const isNewer = userContents.some((content) => content.includes('NEWER_PARENT'));
        let delta: unknown,
          reason = 'stop';
        if ((isOriginal || isNewer) && tools === 0) {
          const children = isOriginal
            ? ['UNICODE_CHILD', 'STOP_CHILD', 'DETACHED_CHILD']
            : ['NEWER_CHILD'];
          delta = {
            tool_calls: children.map((content, index) => ({
              index,
              id: `${isOriginal ? 'original' : 'newer'}-${index}`,
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  key: `child-${index}`,
                  role: 'worker',
                  input: { content },
                  cancellation: 'detached',
                  resultDisposition:
                    content === 'UNICODE_CHILD' || content === 'STOP_CHILD'
                      ? 'required'
                      : 'background',
                }),
              },
            })),
          };
          reason = 'tool_calls';
        } else if (!isOriginal && !isNewer) {
          const child = ['UNICODE_CHILD', 'STOP_CHILD', 'DETACHED_CHILD', 'NEWER_CHILD'].find(
            (key) => marker.includes(key),
          );
          if (!child)
            return new Response(`unexpected_provider_input:${marker.slice(0, 200)}`, {
              status: 500,
            });
          await new Promise<void>((resolve) => releases.set(child, resolve));
          delta = { content: child === 'UNICODE_CHILD' ? unicode : `${child}_DONE` };
        } else delta = { content: `${isOriginal ? 'ORIGINAL' : 'NEWER'}_PARENT_DONE` };
        return new Response(frame(delta, null) + frame({}, reason) + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      out: Promise<string> | undefined,
      err: Promise<string> | undefined,
      completed = false,
      cleanupUnconfirmed = false,
      failure: unknown;
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [],
      candidatePaths: string[] = [],
      cleanupFailures: unknown[] = [];
    try {
      const { buildTerminalBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
      );
      // Production default process Service: no source, resolver, Runtime, credential,
      // model, OAuth, network-policy or processHostFixture injection.
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'source'),
      });
      renameSync(join(root, 'source'), moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(existsSync(join(root, 'source'))).toBe(false);
      expect(existsSync(terminal.root)).toBe(false);
      const candidate = verifyNativeRuntimeBundle(moved);
      expect(candidate.digest).toBe(built.digest);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
      );
      candidatePaths.push(moved, candidate.terminal.root);
      initializeSqliteEngine({
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      });
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Background',
          rootUri: pathToFileURL(workspace).href,
        });
        await store.createWorkspace({
          expectedStoreId: storeId,
          id: 'other-workspace',
          name: 'Retained workspace',
          rootUri: pathToFileURL(secondWorkspace).href,
        });
        for (const [sessionId, title] of [
          ['original-root', 'Original Background'],
          ['newer-root', 'Newer Background'],
        ])
          await store.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${sessionId}`,
            sessionId: sessionId!,
            workspaceId: 'w',
            title: title!,
          });
      } finally {
        await store.close();
      }
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
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
          tools: [{ id: 'task', definitionVersion: '1' }],
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(home, 'original-background.json'), JSON.stringify({ unicode }));
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-background-electron.fixture.ts'),
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
      writeFileSync(
        join(root, 'candidate-evidence.json'),
        JSON.stringify({
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          productionDefaultService: true,
          productionDefaultNetwork: true,
          credentials: false,
          home,
          storeId: storeId!,
          producer: 'default worker task via compatible SDKHTTP',
        }),
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          storeId!,
          provider.url.href.replace(/\/$/, ''),
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      out = new Response(driver.stdout).text();
      err = new Response(driver.stderr).text();
      // New qualification budget includes two real Native launches and full saved
      // Unicode output and multiple complete refreshes; existing job deadlines are unchanged.
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 190000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        writeFileSync(join(root, 'driver.stdout.log'), stdout);
        writeFileSync(join(root, 'driver.stderr.log'), stderr);
        console.log(stdout);
        if (code) console.error({ root, stderr: stderr.slice(0, 4000) });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'background-report.json'), 'utf8')) as {
        pids: number[];
        physical: { method: string; path: string }[];
        coldPhysical: { method: string }[];
        coldProviderCalls: number;
        callsBeforeCold: number;
        executionIds: string[];
        stoppedId: string;
        originalStoreId: string;
        restoredStoreId: string;
        childSessionId: string;
        childRunId: string;
      };
      expect(report.originalStoreId).toBe(storeId!);
      expect(report.restoredStoreId).toBe(restoredStoreId!);
      expect(report.restoredStoreId).not.toBe(report.originalStoreId);
      expect(report.pids).toHaveLength(3);
      for (const pid of report.pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(report.coldPhysical.every((row) => row.method === 'GET')).toBe(true);
      expect(report.coldProviderCalls).toBe(report.callsBeforeCold);
      expect(calls.length).toBe(report.callsBeforeCold);
      expect(report.executionIds).toHaveLength(4);
      expect(baseline).toBeDefined();
      const removal = JSON.parse(readFileSync(join(home, 'workspace-removal-report.json'), 'utf8'));
      expect(removal.beforeRemovalSnapshot).toEqual(baseline!);
      expect(await snapshot(profile)).toEqual({
        ...baseline!,
        cursor: String(BigInt(baseline!.cursor) + 2n),
        sessions: [],
      });
      expect(removal.applied.receipt).toMatchObject({
        workspaceId: 'w',
        deletedRoots: 2,
        deletedSessions: 6,
        originStoreId: report.restoredStoreId,
        stopConfirmed: false,
      });
      expect(removal.removePosts).toHaveLength(1);
      expect(removal.lookupPhysical.every((r: { method: string }) => r.method === 'GET')).toBe(
        true,
      );
      const removedStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        for (const original of baseline!.sessions) {
          expect((await removedStore.getSession(original.id))!.deletedAt).toBe(
            removal.applied.receipt.removedAt,
          );
          for (const execution of original.executions) {
            expect(
              (await removedStore.getExecution(execution.id))!.cancelRequestedAt,
            ).not.toBeNull();
            if (execution.childSessionId)
              expect((await removedStore.getSession(execution.childSessionId))!.deletedAt).toBe(
                removal.applied.receipt.removedAt,
              );
          }
        }
      } finally {
        await removedStore.close();
      }
      const currentBackup = await createProfileBackup({
        profile,
        destinationRoot: join(root, 'db8-backup'),
      });
      expect(currentBackup.manifest.version).toBe(17);
      expect(currentBackup.manifest.assets.desktopUi.format!.userVersion).toBe(8);
      const privatePath = join(profile.profilePath, 'desktop-private/data.sqlite'),
        privateBytes = readFileSync(privatePath),
        backupBytes = readFileSync(join(currentBackup.directory, 'core.db'));
      const originalNow = Date.now;
      let gc: Awaited<ReturnType<typeof collectProfileGarbage>>;
      try {
        // Only maintenance observes a future grace clock; real filesystem timestamps stay intact.
        Date.now = () => originalNow() + 8 * 86400000;
        gc = await collectProfileGarbage({ profile, expectedStoreId: report.restoredStoreId });
      } finally {
        Date.now = originalNow;
      }
      expect(gc).toMatchObject({
        purgedWorkspaces: 1,
        purgedSessions: 6,
        retainedUnsettledWorkspaces: 0,
      });
      expect(gc.removedFiles).toBeGreaterThan(0);
      expect(readFileSync(privatePath)).toEqual(privateBytes);
      expect(readFileSync(join(currentBackup.directory, 'core.db'))).toEqual(backupBytes);
      expect(calls.length).toBe(report.callsBeforeCold);
      const collectedStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect(
          await collectedStore.getWorkspaceRemoval({
            expectedStoreId: report.restoredStoreId,
            subjectId: 'local-user',
            workspaceId: 'w',
            commandId: removal.applied.receipt.commandId,
          }),
        ).toEqual(removal.applied.receipt);
        for (const id of [
          ...baseline!.sessions.map((s) => s.id),
          ...baseline!.sessions.flatMap((s) =>
            s.executions.flatMap((e) => (e.childSessionId ? [e.childSessionId] : [])),
          ),
        ]) {
          const view = await collectedStore.getView(id);
          expect(view.session.historyPurgedAt).toBeGreaterThan(0);
          expect(view.messages).toEqual([]);
        }
      } finally {
        await collectedStore.close();
      }
      expect((await snapshot(profile)).sessions).toEqual([]);
      const original = baseline!.sessions.find((row) => row.id === 'original-root')!;
      const task = original.executions.find((row) => row.id === report.stoppedId)!;
      expect(task.cancelRequestedAt).not.toBeNull();
      expect(task.sessionId).toBe('original-root');
      const newer = baseline!.sessions.find((row) => row.id === 'newer-root')!;
      expect(
        newer.executions
          .filter((row) => row.childSessionId !== null)
          .every((row) => row.cancelRequestedAt === null),
      ).toBe(true);
      console.log(
        JSON.stringify({
          stage: 'post_exit_cold_readonly_store',
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          productionDefaultService: true,
          productionDefaultOSVault: true,
          root,
          originalStoreId: storeId,
          restoredStoreId,
          childSessionId: report.childSessionId,
          childRunId: report.childRunId,
          originalCursor: baseline!.cursor,
          providerCalls: calls.length,
          executionIds: report.executionIds,
          stoppedId: report.stoppedId,
          pids: report.pids,
          gc,
        }),
      );
      completed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      if (out) writeFileSync(join(root, 'driver.stdout.log'), await out);
      if (err) writeFileSync(join(root, 'driver.stderr.log'), await err);
      if (driver) {
        const readRows = () =>
          String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
            .trim()
            .split('\n')
            .map((line) => {
              const parts = line.trim().split(/\s+/);
              return {
                pid: Number(parts[0]),
                parent: Number(parts[1]),
                command: parts.slice(2).join(' '),
              };
            });
        const rows = readRows();
        const originalIdentity = new Map(rows.map((row) => [row.pid, row.command]));
        const owned = new Set(
          rows.filter((row) => row.command.startsWith(`${moved}/`)).map((row) => row.pid),
        );
        for (let count = 0; count < rows.length; count++)
          for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
        for (const pid of owned)
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        const until = Date.now() + 2000;
        while (
          Date.now() < until &&
          [...owned].some((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
        )
          await Bun.sleep(20);
        const forced: number[] = [];
        for (const pid of owned)
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
            forced.push(pid);
          } catch {}
        const remainingOwned = () => {
          const current = readRows(),
            targets = new Set(
              current
                .filter(
                  (row) =>
                    row.command.startsWith(`${moved}/`) ||
                    (owned.has(row.pid) && originalIdentity.get(row.pid) === row.command),
                )
                .map((row) => row.pid),
            );
          for (let count = 0; count < current.length; count++)
            for (const row of current) if (targets.has(row.parent)) targets.add(row.pid);
          return [...targets];
        };
        const disappearanceDeadline = Date.now() + 5000;
        let remaining = remainingOwned();
        while (remaining.length && Date.now() < disappearanceDeadline) {
          await Bun.sleep(50);
          remaining = remainingOwned();
        }
        cleanupUnconfirmed = remaining.length > 0;
        const cleanup = { observed: [...owned], forced, remaining, confirmed: !cleanupUnconfirmed };
        writeFileSync(join(root, 'owned-cleanup.json'), JSON.stringify(cleanup));
        console.log(JSON.stringify({ stage: 'owned_process_tree_cleanup', root, ...cleanup }));
      }
      for (const release of releases.values()) release();
      provider.stop(true);
      // Release SH only after owned process disappearance has been checked.
      // A passing case must then prove both exact roots admit EX before removal.
      for (const lease of leases.splice(0)) lease.release();
      if (completed && !cleanupUnconfirmed) {
        for (const path of candidatePaths) {
          try {
            const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
            exclusive.release();
          } catch (cause) {
            cleanupFailures.push(cause);
          }
        }
        console.log(
          JSON.stringify({
            stage: 'candidate_exclusive_after_cleanup',
            root,
            roots: candidatePaths,
            confirmed: cleanupFailures.length === 0,
          }),
        );
      }
      if (completed && !cleanupUnconfirmed && !cleanupFailures.length)
        rmSync(root, { recursive: true, force: true });
      else console.error('background_failed_candidate_retained', root);
    }
    if (cleanupUnconfirmed || cleanupFailures.length)
      throw new AggregateError(
        [
          failure,
          ...cleanupFailures,
          ...(cleanupUnconfirmed ? [Error(`native_owned_cleanup_unconfirmed:${root}`)] : []),
        ].filter(Boolean),
        'Native background fixture cleanup failed',
      );
    if (failure) throw failure;
  },
  240000,
);

async function snapshot(profile: ReturnType<typeof selectProfile>) {
  const store = await openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: profile.profile,
    mode: 'readonly',
  });
  try {
    const rows = await store.listSessions({ limit: 100 });
    const sessions = [];
    for (const row of rows)
      sessions.push({
        id: row.id,
        runs: (await store.getView(row.id)).runs,
        executions: await store.listExecutions(row.id),
      });
    const metadata = await store.getMetadata();
    return { storeId: metadata.storeId, cursor: metadata.lastChangeCursor, sessions };
  } finally {
    await store.close();
  }
}
