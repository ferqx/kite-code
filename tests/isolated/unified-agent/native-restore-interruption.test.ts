import { expect, test } from 'bun:test';
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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import type { ProfileBackup, ProfileRestoreJournal } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import { acquireProfileAccess } from '../../../packages/agent/src/platform/profile';
import {
  installNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

const repositoryRoot = resolve(import.meta.dir, '../../..');
test.skipIf(process.platform !== 'darwin')(
  'installed PC refuses an absent profile before and after restore-holder SIGKILL, then reads the explicitly reconciled original session',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-restore-interruption-'))),
      home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      prefix = join(root, 'installed');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    let holder: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      holderOutput: Promise<string> | undefined,
      holderError: Promise<string> | undefined,
      installedCLI = '',
      originalStoreId = '',
      preservedDirectory = '',
      journal: { journal: ProfileRestoreJournal; digest: string } | undefined,
      providerCalls = 0,
      completed = false;
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    const identity = () => {
      const stat = lstatSync(join(profile.coordinationPath, 'profile-use.lock'));
      return { dev: stat.dev, ino: stat.ino };
    };
    let lockIdentity: ReturnType<typeof identity>;
    let preservedCore: Buffer<ArrayBuffer>, preservedConfig: Buffer<ArrayBuffer>;
    const maintenance = async (args: string[]) => {
      const child = Bun.spawn([installedCLI, 'maintenance', ...args], {
        cwd: home,
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = new Response(child.stdout).text(),
        err = new Response(child.stderr).text(),
        timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        expect(await child.exited).toBe(0);
        expect(await err).toBe('');
        const result = JSON.parse(await out);
        expect(result.kind).toBe('offline_maintenance');
        expect(result.coverage.profileComplete).toBe(false);
        return result;
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
        await Promise.all([out, err]);
      }
    };
    const profileArguments = ['--data-root', profile.dataRoot, '--profile', profile.profile];
    const control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/snapshot') {
          expect(identity()).toEqual(lockIdentity);
          expect(readFileSync(join(preservedDirectory, 'core.db'))).toEqual(preservedCore);
          expect(readFileSync(join(preservedDirectory, 'config.jsonc'))).toEqual(preservedConfig);
          return Response.json({
            profileExists: existsSync(profile.profilePath),
            coreExists: existsSync(profile.databasePath),
            lockIdentity: identity(),
          });
        }
        if (path === '/kill' && request.method === 'POST') {
          expect(holder?.exitCode).toBeNull();
          holder!.kill('SIGKILL');
          expect(await holder!.exited).not.toBe(0);
          expect(await holderError).toBe('');
          console.log(await holderOutput);
          const status = await maintenance(['status', ...profileArguments]);
          journal = status.restore;
          expect(journal!.journal.phase).toBe('prepared');
          expect(journal!.journal.expectedStoreId).toBe(originalStoreId);
          expect(existsSync(profile.profilePath)).toBe(false);
          return Response.json({ ...journal, lockIdentity: identity() });
        }
        if (path === '/reconcile' && request.method === 'POST') {
          const input = await request.json();
          expect(input).toEqual({
            restoreId: journal!.journal.restoreId,
            digest: journal!.digest,
            decision: 'complete',
          });
          const result = await maintenance([
            'reconcile',
            ...profileArguments,
            '--restore-id',
            input.restoreId,
            '--journal-digest',
            input.digest,
            '--decision',
            input.decision,
            '--confirm-data-loss',
          ]);
          expect(result.status).toBe('restored');
          expect(result.storeId).toBe(journal!.journal.newStoreId);
          expect(result.storeId).not.toBe(originalStoreId);
          expect((await maintenance(['status', ...profileArguments])).restore).toBeNull();
          expect(identity()).toEqual(lockIdentity);
          return Response.json({ storeId: result.storeId, lockIdentity: identity() });
        }
        providerCalls++;
        return new Response('unexpected_provider_request', { status: 500 });
      },
    });
    try {
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') }),
        req = createRequire(join(repositoryRoot, 'apps/desktop/package.json')),
        electronDist = resolve(dirname(dirname(req('electron') as string)), '../..'),
        built = await buildNativeCandidate({
          terminalRoot: terminal.root,
          electronDist,
          outdir: join(root, 'source'),
        });
      renameSync(built.root, join(root, 'relocated'));
      rmSync(terminal.root, { recursive: true, force: true });
      const installation = installNativeBundle({ bundleRoot: join(root, 'relocated'), prefix }),
        candidate = verifyNativeRuntimeBundle(installation.releaseRoot);
      expect(candidate.digest).toBe(built.digest);
      expect(existsSync(built.root)).toBe(false);
      expect(existsSync(terminal.root)).toBe(false);
      leases.push(
        acquireArtifactAccess({ root: candidate.root, mode: 'shared' }),
        acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
      );
      const engine = {
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      };
      initializeSqliteEngine(engine);
      installedCLI = join(prefix, 'bin/kite');
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      try {
        originalStoreId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: originalStoreId,
          id: 'w',
          name: 'Original restore workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        await store.createSession({
          expectedStoreId: originalStoreId,
          subjectId: 'local-user',
          commandId: 'create-original',
          sessionId: 's',
          workspaceId: 'w',
          title: 'Original backup session',
        });
      } finally {
        await store.close();
      }
      const config = JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: control.url.href },
        ],
      });
      writeFileSync(join(profile.profilePath, 'config.jsonc'), config, { mode: 0o600 });
      const backup: ProfileBackup = (
        await maintenance(['backup', ...profileArguments, '--destination', join(root, 'backups')])
      ).backup;
      const current = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
      });
      try {
        await current.renameSession({
          expectedStoreId: originalStoreId,
          subjectId: 'local-user',
          commandId: 'rename-after-backup',
          sessionId: 's',
          ifRevision: (await current.getSession('s'))!.controlRevision,
          title: 'Later current session',
        });
      } finally {
        await current.close();
      }
      writeFileSync(join(profile.profilePath, 'config.jsonc'), `${config}\n`, { mode: 0o600 });
      preservedCore = readFileSync(profile.databasePath);
      preservedConfig = readFileSync(join(profile.profilePath, 'config.jsonc'));
      lockIdentity = identity();

      // Only the fault publisher uses the existing internal source observation seam.
      // Actual Main/Service and installed backup/status/reconcile bytes are never patched.
      const holderEntry = join(root, 'restore-holder.ts');
      writeFileSync(
        holderEntry,
        `import { initializeSqliteEngine } from ${JSON.stringify(join(repositoryRoot, 'packages/agent/src/sqlite-engine.ts'))};\n` +
          `import { runProfileRestore } from ${JSON.stringify(join(repositoryRoot, 'packages/agent/src/maintenance/restore.ts'))};\n` +
          `initializeSqliteEngine(${JSON.stringify(engine)});\n` +
          `await runProfileRestore(${JSON.stringify({ profile: { dataRoot: profile.dataRoot, profile: profile.profile }, expectedStoreId: originalStoreId, backup, intent: 'replace_with_selected_backup' })}, async point => { if (point === 'old_directory_moved') { console.log(point); await new Promise(() => setInterval(() => {}, 1000)); } });\n`,
      );
      holder = Bun.spawn([join(candidate.terminal.root, 'runtime/bun'), holderEntry], {
        cwd: home,
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      holderError = new Response(holder.stderr).text();
      const reader = holder.stdout.getReader(),
        timer = setTimeout(() => holder!.kill('SIGKILL'), 15000);
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          'old_directory_moved',
        );
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
      holderOutput = (async () => {
        const remainder = holder!.stdout.getReader();
        try {
          while (!(await remainder.read()).done) {
            // The phase line was consumed above; drain the same owned pipe through EOF.
          }
          return 'old_directory_moved';
        } finally {
          remainder.releaseLock();
        }
      })();
      const status = await maintenance(['status', ...profileArguments]);
      journal = status.restore;
      preservedDirectory = join(profile.dataRoot, journal!.journal.preservedName);
      expect(existsSync(profile.profilePath)).toBe(false);
      const other = await openSqliteStore({ dataRoot: profile.dataRoot, profile: 'other' });
      await other.close();
      symlinkSync(join(candidate.terminal.root, 'node_modules'), join(root, 'node_modules'));
      const driverBuild = await Bun.build({
        entrypoints: [
          join(repositoryRoot, 'tests/fixtures/unified-agent/native-restore-electron.ts'),
        ],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: '[name].mjs',
      });
      expect(driverBuild.success).toBe(true);
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'native-restore-electron.mjs'),
          join(prefix, 'bin/kite-desktop'),
          home,
          control.url.href,
          originalStoreId,
          join(repositoryRoot, 'apps/desktop/package.json'),
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
        err = new Response(driver.stderr).text(),
        deadline = setTimeout(() => driver!.kill('SIGTERM'), 45000);
      try {
        const exit = await driver.exited;
        console.log(await out);
        console.error(await err);
        expect(exit).toBe(0);
      } finally {
        clearTimeout(deadline);
      }
      expect(providerCalls).toBe(0);
      expect(identity()).toEqual(lockIdentity);
      expect(readFileSync(join(preservedDirectory, 'core.db'))).toEqual(preservedCore);
      expect(readFileSync(join(profile.profilePath, 'config.jsonc'), 'utf8')).toBe(config);
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await cold.getMetadata()).storeId).toBe(journal!.journal.newStoreId);
        expect((await cold.getSession('s'))!.title).toBe('Original backup session');
        expect(await cold.getCommand('rename-after-backup')).toBeNull();
      } finally {
        await cold.close();
      }
      const use = acquireProfileAccess(
        { dataRoot: profile.dataRoot, profile: profile.profile },
        'exclusive',
      );
      use.lock.release();
      for (const lease of leases.splice(0).reverse()) lease.release();
      for (const path of [candidate.root, candidate.terminal.root]) {
        const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        lease.release();
      }
      const coreBytes = readFileSync(profile.databasePath);
      uninstallNativeBundle(prefix);
      expect(readFileSync(profile.databasePath)).toEqual(coreBytes);
      expect(identity()).toEqual(lockIdentity);
      completed = true;
    } finally {
      if (driver?.exitCode === null) {
        driver.kill('SIGTERM');
        await driver.exited;
      }
      if (holder?.exitCode === null) {
        holder.kill('SIGKILL');
        await holder.exited;
      }
      const [, holderDiagnostic] = await Promise.all([holderOutput, holderError]);
      if (holderDiagnostic) console.error(holderDiagnostic);
      for (const lease of leases.reverse()) lease.release();
      control.stop(true);
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.log(JSON.stringify({ retainedNativeRestoreFixture: root }));
    }
  },
  180000,
);
