import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  createProfileBackup,
  type ProfileBackup,
  type ProfileGarbageCollection,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free default Native background overview retains original tasks, full child logs and exact stop across actual backup restore cold reopen plus original PC Workspace removal and installed offline maintenance',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-background-bundle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated');
    const runtimeRoots = [
      moved,
      join(root, 'installed-native/releases'),
      join(root, 'installed-terminal/releases'),
    ];
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
      const { buildTerminalBundle, installTerminalBundle, uninstallTerminalBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
      );
      const { installNativeBundle, uninstallNativeBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/native-install.ts')
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
      let originalBeforeMaintenance: Awaited<ReturnType<typeof removedStore.getView>> | undefined,
        executionsBeforeMaintenance:
          | Awaited<ReturnType<typeof removedStore.listExecutions>>
          | undefined;
      const commandsBeforeMaintenance: NonNullable<
        Awaited<ReturnType<typeof removedStore.getCommand>>
      >[] = [];
      try {
        originalBeforeMaintenance = await removedStore.getView('original-root');
        executionsBeforeMaintenance = await removedStore.listExecutions('original-root');
        for (const run of originalBeforeMaintenance.runs) {
          const command = await removedStore.getCommand(run.originCommandId);
          expect(command).not.toBeNull();
          commandsBeforeMaintenance.push(command!);
        }
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
      const terminalInstallation = installTerminalBundle({
          bundleRoot: join(moved, 'terminal'),
          prefix: join(root, 'installed-terminal'),
        }),
        nativeInstallation = installNativeBundle({
          bundleRoot: moved,
          prefix: join(root, 'installed-native'),
          cliPrefix: terminalInstallation.root,
        }),
        nativeCLI = join(nativeInstallation.root, 'bin/kite'),
        registeredCLI = join(terminalInstallation.root, 'bin/kite'),
        profileArguments = ['--data-root', profile.dataRoot, '--profile', profile.profile],
        privatePath = join(profile.profilePath, 'desktop-private/data.sqlite'),
        privateBytes = readFileSync(privatePath),
        privateInode = lstatSync(privatePath).ino,
        originalCoreBytes = readFileSync(profile.databasePath);
      const maintenance = async (launcher: string, args: string[]) => {
        const result = JSON.parse(await execute([launcher, 'maintenance', ...args], home));
        expect(result.kind).toBe('offline_maintenance');
        expect(result.coverage.profileComplete).toBe(false);
        return result;
      };
      const backupResult = await maintenance(nativeCLI, [
        'backup',
        ...profileArguments,
        '--destination',
        join(root, 'db8-backup'),
      ]);
      expect(backupResult.status).toBe('verified');
      const currentBackup = backupResult.backup as ProfileBackup;
      expect(currentBackup.manifest.version).toBe(17);
      expect(currentBackup.manifest.assets.desktopUi.format!.userVersion).toBe(8);
      expect(
        (await maintenance(registeredCLI, ['inspect', currentBackup.directory])).backup,
      ).toEqual(currentBackup);
      expect(readFileSync(profile.databasePath)).toEqual(originalCoreBytes);
      expect(readFileSync(privatePath)).toEqual(privateBytes);
      const recent = await maintenance(registeredCLI, [
        'gc',
        ...profileArguments,
        '--expected-store',
        report.restoredStoreId,
      ]);
      expect(recent.gc).toMatchObject({
        purgedWorkspaces: 0,
        purgedSessions: 0,
        retainedRecentWorkspaces: 1,
      });
      expect(readFileSync(profile.databasePath)).toEqual(originalCoreBytes);
      const backupBytes = readFileSync(join(currentBackup.directory, 'core.db')),
        backupPrivateBytes = readFileSync(
          join(currentBackup.directory, 'desktop-private/data.sqlite'),
        );
      const probeDirectory = join(root, 'maintenance-probe');
      mkdirSync(probeDirectory, { mode: 0o700 });
      symlinkSync(
        join(nativeInstallation.releaseRoot, 'terminal/node_modules'),
        join(probeDirectory, 'node_modules'),
        'dir',
      );
      writeFileSync(
        join(probeDirectory, 'grace.js'),
        `
import { runNativeTerminalCLI } from '@kite-ai/cli/host';
// This external harness changes only its clock. It uses the installed, verified
// host selector; no production clock option, stored timestamp or receipt changes.
const now = Date.now;
Date.now = () => now() + 8 * 86400000;
process.exitCode = await runNativeTerminalCLI(process.argv.slice(3), process.argv[2]);
`,
        { mode: 0o600 },
      );
      const agedResult = JSON.parse(
        await execute(
          [
            join(nativeInstallation.releaseRoot, 'terminal/runtime/bun'),
            join(probeDirectory, 'grace.js'),
            nativeInstallation.releaseRoot,
            'maintenance',
            'gc',
            ...profileArguments,
            '--expected-store',
            report.restoredStoreId,
          ],
          home,
        ),
      );
      expect(agedResult.kind).toBe('offline_maintenance');
      expect(agedResult.coverage.profileComplete).toBe(false);
      const gc = agedResult.gc as ProfileGarbageCollection;
      expect(gc).toMatchObject({
        purgedWorkspaces: 1,
        purgedSessions: 6,
        retainedUnsettledWorkspaces: 0,
      });
      expect(gc.removedFiles).toBeGreaterThan(0);
      expect(readFileSync(privatePath)).toEqual(privateBytes);
      expect(lstatSync(privatePath).ino).toBe(privateInode);
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
      const beforeRestoreBytes = readFileSync(profile.databasePath),
        beforeRestoreInode = lstatSync(profile.databasePath).ino;
      const restored = await maintenance(registeredCLI, [
        'restore',
        currentBackup.directory,
        ...profileArguments,
        '--expected-store',
        report.restoredStoreId,
        '--confirm-data-loss',
      ]);
      expect(restored.status).toBe('restored');
      expect(restored.storeId).not.toBe(report.restoredStoreId);
      expect(restored.previousDirectoryPreserved).toBe(true);
      expect(readFileSync(join(restored.preservedDirectory, 'core.db'))).toEqual(
        beforeRestoreBytes,
      );
      expect(lstatSync(join(restored.preservedDirectory, 'core.db')).ino).toBe(beforeRestoreInode);
      expect(
        readFileSync(join(restored.preservedDirectory, 'desktop-private/data.sqlite')),
      ).toEqual(privateBytes);
      expect(lstatSync(join(restored.preservedDirectory, 'desktop-private/data.sqlite')).ino).toBe(
        privateInode,
      );
      expect(readFileSync(privatePath)).toEqual(backupPrivateBytes);
      const status = await maintenance(nativeCLI, ['status', ...profileArguments]);
      expect(status.restore).toBeNull();
      const restoredStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await restoredStore.getMetadata()).storeId).toBe(restored.storeId);
        const original = await restoredStore.getView('original-root');
        expect(original.session.deletedAt).toBe(removal.applied.receipt.removedAt);
        expect(original.session.historyPurgedAt).toBe(
          originalBeforeMaintenance!.session.historyPurgedAt,
        );
        expect(original.messages).toEqual(originalBeforeMaintenance!.messages);
        expect(original.runs).toEqual(originalBeforeMaintenance!.runs);
        for (const command of commandsBeforeMaintenance)
          expect(await restoredStore.getCommand(command.id)).toEqual(command);
        expect(await restoredStore.listExecutions('original-root')).toEqual(
          executionsBeforeMaintenance!,
        );
        let foreignCode: string | undefined;
        try {
          await restoredStore.getWorkspaceRemoval({
            expectedStoreId: report.restoredStoreId,
            subjectId: 'local-user',
            workspaceId: 'w',
            commandId: removal.applied.receipt.commandId,
          });
        } catch (cause) {
          foreignCode = (cause as { code?: string }).code;
        }
        expect(foreignCode).toBe('store_identity_mismatch');
      } finally {
        await restoredStore.close();
      }
      const restoredCoreBytes = readFileSync(profile.databasePath),
        restoredCoreInode = lstatSync(profile.databasePath).ino,
        configurationPath = join(profile.profilePath, 'config.jsonc'),
        configurationBytes = readFileSync(configurationPath);
      uninstallNativeBundle(nativeInstallation.root);
      uninstallTerminalBundle(terminalInstallation.root);
      expect(existsSync(nativeInstallation.root)).toBe(false);
      expect(existsSync(terminalInstallation.root)).toBe(false);
      expect(readFileSync(profile.databasePath)).toEqual(restoredCoreBytes);
      expect(lstatSync(profile.databasePath).ino).toBe(restoredCoreInode);
      expect(readFileSync(privatePath)).toEqual(backupPrivateBytes);
      expect(readFileSync(configurationPath)).toEqual(configurationBytes);
      expect(readFileSync(join(currentBackup.directory, 'core.db'))).toEqual(backupBytes);
      expect(readFileSync(join(workspace, 'retained-project-file'), 'utf8')).toBe(
        'original project bytes',
      );
      expect(calls.length).toBe(report.callsBeforeCold);
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
          installedMaintenance: {
            nativeCandidateId: nativeInstallation.candidateId,
            terminalCandidateId: terminalInstallation.candidateId,
            realBinActions: ['backup', 'inspect', 'gc_with_real_grace', 'restore', 'status'],
            expiredGC: 'installed_host_selector_with_external_harness_clock',
            manifestVersion: currentBackup.manifest.version,
            desktopUserVersion: currentBackup.manifest.assets.desktopUi.format!.userVersion,
            restoredStoreId: restored.storeId,
            preservedPreviousProfile: true,
            uninstalled: true,
            providerReplay: false,
          },
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
          rows
            .filter((row) => runtimeRoots.some((path) => row.command.startsWith(`${path}/`)))
            .map((row) => row.pid),
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
                    runtimeRoots.some((path) => row.command.startsWith(`${path}/`)) ||
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

async function execute(argv: string[], home: string) {
  const child = Bun.spawn(argv, {
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw Error(`installed_maintenance_failed:${argv[0]}:${code}:${stderr.slice(-4000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

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
