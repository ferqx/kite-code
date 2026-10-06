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
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free relocated default Native Skills window reads complete byte-paged metadata, refreshes owned files, switches scopes and cold DB7 with zero execution',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-skills-bundle-')),
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
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        for (const [id, name, path, sessionId, title] of [
          ['w', 'Skills', workspace, 'skills-window', 'Skills Window'],
          ['w2', 'Second Skills', secondWorkspace, 'second-skills-window', 'Second Skills Window'],
        ] as const) {
          await seed.createWorkspace({
            expectedStoreId: storeId,
            id,
            name,
            rootUri: pathToFileURL(path).href,
          });
          await seed.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId,
            workspaceId: id,
            title,
          });
        }
      } finally {
        await seed.close();
      }
      const metadata = (path: string, name: string, description: string) => {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(path, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${description}\n---\nPRIVATE_SKILL_BODY\n`,
          { mode: 0o600 },
        );
      };
      const skills: { id: string; path: string; enabled?: boolean }[] = [];
      for (let i = 0; i < 301; i++) {
        const number = String(i).padStart(3, '0'),
          id = `skill-${number}`,
          path = `.agents/skills/${id}`;
        // Each description fits one bounded response, while the aggregate requires
        // many real byte-budget pages as well as exceeding the 256 item boundary.
        metadata(
          join(workspace, path),
          `Skill ${number}`,
          `${'完整Unicode目录摘要'.repeat(250)}LONG_DESCRIPTION_TAIL_${number}`,
        );
        skills.push({ id, path });
      }
      metadata(join(workspace, '.kite-code/skills/kite'), 'Kite metadata', 'KITE_SOURCE_TAIL');
      metadata(join(workspace, 'configured'), 'Configured metadata', 'CONFIGURED_SOURCE_TAIL');
      metadata(
        join(profile.profilePath, 'skills/profile'),
        'Profile metadata',
        'PROFILE_SOURCE_TAIL',
      );
      metadata(
        join(workspace, '.agents/skills/disabled'),
        'Disabled metadata must not be read',
        'DISABLED_METADATA_PRIVATE',
      );
      metadata(
        join(secondWorkspace, '.kite-code/skills/second'),
        'Second workspace',
        'SECOND_SCOPE_TAIL',
      );
      skills.push(
        { id: 'kite', path: '.kite-code/skills/kite' },
        { id: 'configured', path: 'configured' },
        { id: 'disabled', path: '.agents/skills/disabled', enabled: false },
        { id: 'missing', path: 'absent' },
      );
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          models: [],
          skills: [{ id: 'profile', path: join(profile.profilePath, 'skills/profile') }],
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(workspace, 'kite-agent.jsonc'), JSON.stringify({ models: [], skills }), {
        mode: 0o600,
      });
      writeFileSync(
        join(secondWorkspace, 'kite-agent.jsonc'),
        JSON.stringify({
          models: [],
          skills: [{ id: 'second', path: '.kite-code/skills/second' }],
        }),
        { mode: 0o600 },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-skills-electron.fixture.ts'),
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
          count: 306,
        }),
      );
      driver = Bun.spawn(
        [realpathSync(Bun.which('node')!), join(root, 'driver.js'), moved, home, storeId!],
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
      // New qualification budget includes two real Native launches, >1MiB of
      // metadata and multiple complete refreshes; existing job deadlines are unchanged.
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 150000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        writeFileSync(join(root, 'driver.stdout.log'), stdout);
        writeFileSync(join(root, 'driver.stderr.log'), stderr);
        console.log(stdout);
        if (code) console.error({ root, stderr });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'skills-report.json'), 'utf8')) as {
        pids: number[];
        physical: { method: string; path: string }[];
        coldPhysical: { method: string }[];
        persisted: {
          version: number;
          modelRoutes: number;
          configurationIntents: number;
          runs: number;
          executions: number;
        };
        count: number;
        bytePages: { entries: number; complete: boolean; revision: string }[];
      };
      expect(report.pids).toHaveLength(2);
      for (const pid of report.pids) expect(() => process.kill(pid, 0)).toThrow();
      // A separate cold public Store owner is admitted only after both ordinary
      // Native Service exits, independently of the live-window SQLite inspection.
      const coldStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        const before = await coldStore.getMetadata();
        expect(before.storeId).toBe(storeId!);
        for (const sessionId of ['skills-window', 'second-skills-window']) {
          const view = await coldStore.getView(sessionId);
          expect(view.storeId).toBe(storeId!);
          expect(view.session.id).toBe(sessionId);
          expect(view.runs).toHaveLength(0);
          expect(view.executions).toHaveLength(0);
          expect(await coldStore.listExecutions(sessionId)).toHaveLength(0);
        }
        const after = await coldStore.getMetadata();
        expect(after.storeId).toBe(before.storeId);
        expect(after.lastChangeCursor).toBe(before.lastChangeCursor);
        console.log(
          JSON.stringify({
            stage: 'post_exit_cold_readonly_store',
            root,
            storeId: before.storeId,
            lastChangeCursorBefore: before.lastChangeCursor,
            lastChangeCursorAfter: after.lastChangeCursor,
            runs: 0,
            executions: 0,
          }),
        );
      } finally {
        await coldStore.close();
      }
      expect(report.persisted).toEqual({
        version: 7,
        modelRoutes: 0,
        configurationIntents: 0,
        runs: 0,
        executions: 0,
      });
      expect(report.count).toBe(306);
      expect(report.bytePages.length).toBeGreaterThan(2);
      expect(report.bytePages.reduce((sum, page) => sum + page.entries, 0)).toBe(306);
      expect(new Set(report.bytePages.map((page) => page.revision)).size).toBe(1);
      expect(
        report.physical.filter(
          (row) => row.method !== 'GET' && !(row.method === 'POST' && /\/trust$/.test(row.path)),
        ),
      ).toHaveLength(0);
      expect(report.coldPhysical.filter((row) => row.method !== 'GET')).toHaveLength(0);
      console.log(
        JSON.stringify({
          root,
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          productionDefaultService: true,
          productionDefaultNetwork: true,
          ownedServicePids: report.pids,
          coldDatabase: report.persisted,
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
      else console.error('skills_failed_candidate_retained', root);
    }
    if (cleanupUnconfirmed || cleanupFailures.length)
      throw new AggregateError(
        [
          failure,
          ...cleanupFailures,
          ...(cleanupUnconfirmed ? [Error(`native_owned_cleanup_unconfirmed:${root}`)] : []),
        ].filter(Boolean),
        'Native Skills fixture cleanup failed',
      );
    if (failure) throw failure;
  },
  240000,
);
