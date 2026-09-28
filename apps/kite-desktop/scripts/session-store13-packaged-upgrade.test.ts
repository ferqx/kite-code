import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import { pairedDesktopManifestDigest } from '@kite-ai/kite-local-runtime/desktop-manifest';
import { parseServiceStartupDiagnostic } from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';
import { chromium } from 'playwright';
import { verifyPairedDesktopServiceArtifact } from '../../../packages/kite-local-runtime/src/service/paired-desktop-admission';
import {
  assertKiteSessionStore13Schema,
  assertKiteSessionStoreSchema,
  KITE_SESSION_STORE13_DDL,
} from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import { validateKiteSessionStoreContinuity } from '../../../packages/runtime-storage-sqlite/src/kite-session-continuity-validation';
import {
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_SCHEMA_VERSION,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-store-format';
import { convertKiteSessionStore13CandidateTo14 } from '../../../packages/runtime-storage-sqlite/src/kite-session-store13-to14';
import {
  checksum,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../../../packages/runtime-storage-sqlite/src/preflight';

const packagedExecutable = resolve(
  process.env.KITE_PACKAGED_DESKTOP ??
    join(import.meta.dir, `../out/kite-darwin-${process.arch}/kite.app/Contents/MacOS/kite`),
);
const retiredSourceSchemaVersion = 13;
const retiredSourceEpoch = 'kite-session-cross-followup-2026-09-25';

test('packaged upgrade fixture qualifies the current Store release', () => {
  // A new schema or epoch needs a new previous-release fixture and packaged upgrade proof.
  expect(KITE_SESSION_STORE_SCHEMA_VERSION).toBe(14);
  expect(KITE_SESSION_STORE_SCHEMA_VERSION).toBe(retiredSourceSchemaVersion + 1);
  expect(KITE_SESSION_STORE_FORMAT_EPOCH).toBe('kite-session-history-generation-2026-09-28');
});

function createRetiredStore(home: string, workspace: string): string {
  const config = join(home, '.kite-code');
  mkdirSync(config, { mode: 0o700 });
  const path = join(config, 'kite-session.sqlite');
  const sourcePath = join(home, 'fixture-source.sqlite');
  const database = new Database(sourcePath, { strict: true });
  chmodSync(sourcePath, 0o600);
  try {
    database.run('PRAGMA foreign_keys = ON');
    database.run('PRAGMA journal_mode = WAL');
    database.run('PRAGMA wal_autocheckpoint = 0');
    for (const statement of KITE_SESSION_STORE13_DDL) database.run(statement);
    database
      .query('INSERT INTO kite_meta VALUES (?, ?)')
      .run('schema_version', String(retiredSourceSchemaVersion));
    database.query('INSERT INTO kite_meta VALUES (?, ?)').run('format_epoch', retiredSourceEpoch);
    database.run(`PRAGMA user_version = ${retiredSourceSchemaVersion}`);
    const hex = createHash('sha256').update(workspace).digest('hex');
    const projectId = `project_${hex}`;
    const workspaceDigest = `sha256:${hex}`;
    const identityDigest = `sha256:${createHash('sha256')
      .update(
        `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath: workspace, projectId, workspaceDigest })}`,
      )
      .digest('hex')}`;
    const workspaceId = `workspace_${identityDigest.slice(7)}`;
    database
      .query(`INSERT INTO workspaces
      (workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,
       display_name,created_at,updated_at) VALUES (?,?,?,?,?,'Workspace',1,1)`)
      .run(workspaceId, workspace, identityDigest, projectId, workspaceDigest);
    for (const [sessionId, parentSessionId] of [
      ['retired-parent', null],
      ['retired-child', 'retired-parent'],
    ] as const) {
      const initial = createInitialAgentState({
        threadId: sessionId,
        userId: 'packaged-upgrade-user',
        workspace,
        turnId: `${sessionId}-turn`,
        recoveryIdentityKey: 'a'.repeat(64),
      });
      const stateJson = createRuntimeHostStateStorageBinding().codec.encodeState({
        ...initial,
        revision: 1,
        session: { ...initial.session, projectId, canonicalWorkspaceDigest: workspaceDigest },
      });
      database
        .query(`INSERT INTO runtime_sessions
        (session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,
         revision,name,updated_at,run_index_from_revision,parent_session_id)
        VALUES (?,?,?,?,27,?,1,?,1,0,?)`)
        .run(
          sessionId,
          workspaceId,
          projectId,
          workspaceDigest,
          SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
          sessionId,
          parentSessionId,
        );
      database
        .query(`INSERT INTO runtime_snapshots
        (session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
        VALUES (?,27,?,1,?,1,?,1)`)
        .run(sessionId, SQLITE_RUNTIME_RUN_FORMAT_EPOCH, stateJson, checksum(stateJson));
      database
        .query(`INSERT INTO runtime_events
        (session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES (?,?,1,27,?,1)`)
        .run(
          sessionId,
          `${sessionId}-event`,
          JSON.stringify({
            type: 'user.message_appended',
            messageId: `${sessionId}-message`,
            content: `Persisted ${sessionId} history`,
          }),
        );
      database.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(
        `session_execution/${sessionId}`,
        JSON.stringify({
          schema: 'kite.session-execution-authority.v1',
          sessionId,
          status: parentSessionId === null ? 'active' : 'recovery_required',
          controllerGeneration: 3,
          hostInstanceId: parentSessionId === null ? 'retired-host' : null,
          clientId: parentSessionId === null ? 'retired-client' : null,
          connectionGeneration: parentSessionId === null ? 2 : 0,
          interactionGeneration: 4,
          leaseUntilMs: parentSessionId === null ? 1 : null,
          cleanupConfirmed: parentSessionId !== null,
          updatedAt: 1,
          revision: 5,
        }),
      );
    }
    assertKiteSessionStore13Schema(database);
    const candidatePath = join(home, 'fixture-candidate.sqlite');
    database.query('VACUUM INTO ?').run(candidatePath);
    const candidate = new Database(candidatePath, { strict: true });
    try {
      convertKiteSessionStore13CandidateTo14({ database: candidate });
      validateKiteSessionStoreContinuity({
        database: candidate,
        codec: createRuntimeHostStateStorageBinding().codec,
      });
    } finally {
      candidate.close(false);
      rmSync(candidatePath, { force: true });
    }
    // Copy a consistent idle WAL image to the target before closing the fixture writer.
    // The target has no open SQLite handle when the packaged Service starts.
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${sourcePath}${suffix}`;
      if (existsSync(source)) {
        cpSync(source, `${path}${suffix}`);
        chmodSync(`${path}${suffix}`, 0o600);
      }
    }
  } catch (error) {
    database.close(false);
    throw error;
  }
  database.close(false);
  return path;
}

function storeFileHashes(path: string): { main: string; wal: string | null } {
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  return { main: hash(path), wal: existsSync(`${path}-wal`) ? hash(`${path}-wal`) : null };
}

function packagedServiceIdentity(application: string) {
  const serviceDirectory = join(application, 'Contents/Resources/service');
  const executablePath = join(serviceDirectory, 'kite-service');
  const manifest = JSON.parse(readFileSync(join(serviceDirectory, 'desktop.json'), 'utf8'));
  const digest = pairedDesktopManifestDigest(manifest);
  return verifyPairedDesktopServiceArtifact({
    executablePath,
    expectedManifestDigest: digest,
    expectedBuildId: manifest.buildId,
  });
}

function persistedHistory(path: string): unknown {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return {
      sessions: database
        .query(`SELECT session_id,parent_session_id,name,revision
        FROM runtime_sessions ORDER BY session_id`)
        .all(),
      snapshots: database
        .query(`SELECT session_id,state_json,state_checksum
        FROM runtime_snapshots ORDER BY session_id`)
        .all(),
      events: database
        .query(`SELECT session_id,event_id,sequence,event_json
        FROM runtime_events ORDER BY session_id,sequence`)
        .all(),
    };
  } finally {
    database.close();
  }
}

function executionAuthority(path: string, sessionId: string): Record<string, unknown> {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const row = database
      .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
      .get(`session_execution/${sessionId}`);
    if (!row) throw new Error(`Missing execution authority for ${sessionId}.`);
    return JSON.parse(row.value);
  } finally {
    database.close();
  }
}

function recoveryAssets(home: string): {
  entries: string[];
  migrationEntries: string[];
  backupPath: string;
  manifest: {
    source: { mainSha256: string; walSha256: string | null };
    backupSha256: string;
  };
} {
  const root = join(home, '.kite-code', 'session-store-recovery');
  const entries = readdirSync(root).sort();
  const migrations = entries.filter((entry) => entry.startsWith('migration-'));
  expect(migrations).toHaveLength(1);
  const migration = join(root, migrations[0]!);
  const migrationEntries = readdirSync(migration).sort();
  const backups = migrationEntries.filter((entry) => entry.startsWith('backup-'));
  expect(backups).toHaveLength(1);
  const directory = join(migration, backups[0]!);
  return {
    entries,
    migrationEntries,
    backupPath: join(directory, 'kite-session.sqlite'),
    manifest: JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')),
  };
}

async function launchPackagedDesktop(application: string, home: string) {
  const child = spawn(
    join(application, 'Contents/MacOS/kite'),
    ['--inspect-brk=0', '--remote-debugging-port=0'],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: '/private/tmp',
        LANG: 'en_US.UTF-8',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((done) => {
    child.once('exit', done);
    child.once('error', (error) => {
      spawnError = error;
      done(null);
    });
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-65_536);
    });
  const endpoint = async (pattern: RegExp): Promise<string> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const match = logs.match(pattern);
      if (match?.[1]) return match[1];
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Desktop exited: ${logs}`);
      await Bun.sleep(25);
    }
    throw new Error(`Desktop debugger timed out: ${logs}`);
  };
  let inspector: WebSocket | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
    await new Promise<void>((done, fail) => {
      inspector!.addEventListener('open', () => done(), { once: true });
      inspector!.addEventListener('error', () => fail(new Error('Inspector failed.')), {
        once: true,
      });
    });
    let nextId = 0;
    type InspectorResult = { result?: { value?: unknown }; exceptionDetails?: unknown };
    const pending = new Map<
      number,
      { done(value: InspectorResult): void; fail(error: Error): void }
    >();
    let onPause: (callFrameId: string) => void = () => {};
    inspector.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Debugger.paused') onPause(message.params.callFrames[0].callFrameId);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
        else waiter.done(message.result);
      }
    });
    const command = (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<InspectorResult> => {
      const id = ++nextId;
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`Inspector timed out: ${method}`));
        }, 30_000);
        pending.set(id, {
          done: (value) => {
            clearTimeout(timer);
            done(value);
          },
          fail: (error) => {
            clearTimeout(timer);
            fail(error);
          },
        });
        inspector!.send(JSON.stringify({ id, method, params }));
      });
    };
    await command('Runtime.enable');
    await command('Debugger.enable');
    const paused = new Promise<string>((done) => {
      onPause = done;
    });
    await command('Runtime.runIfWaitingForDebugger');
    const callFrameId = await paused;
    const isolation = await command('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: `globalThis.__kiteStoreUpgrade = require('electron');
__kiteStoreUpgrade.app.setPath('home', ${JSON.stringify(home)});
__kiteStoreUpgrade.app.setPath('appData', ${JSON.stringify(join(home, 'app-data'))});
__kiteStoreUpgrade.app.setPath('userData', ${JSON.stringify(join(home, 'app-data/dev.kite-code.desktop'))});
__kiteStoreUpgrade.app.getPath('home')`,
      returnByValue: true,
    });
    expect(isolation.result?.value).toBe(home);
    await command('Debugger.resume');
    browser = await chromium.connectOverCDP(
      await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u),
    );
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByRole('button', { name: '新对话', exact: true }).waitFor({ timeout: 45_000 });
    return {
      page,
      async close() {
        try {
          await command('Runtime.evaluate', {
            expression:
              '__kiteStoreUpgrade.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); __kiteStoreUpgrade.app.quit();',
            awaitPromise: true,
          });
          const code = await Promise.race([exited, Bun.sleep(25_000).then(() => null)]);
          if (code === null && child.exitCode === null) child.kill('SIGKILL');
        } finally {
          inspector?.close();
          await browser?.close();
          if (child.exitCode === null) child.kill('SIGKILL');
          await exited;
        }
      },
    };
  } catch (error) {
    const diagnostic = parseServiceStartupDiagnostic(logs);
    const storePath = join(home, '.kite-code', 'kite-session.sqlite');
    const sourceHashes = existsSync(storePath) ? storeFileHashes(storePath) : null;
    inspector?.close();
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    throw new Error(
      `Packaged Desktop startup failed: ${String(error)}; evidence=${JSON.stringify({
        diagnostic,
        sourceHashes,
        spawnError: spawnError?.name,
        exitCode: child.exitCode,
        stderrTail: logs.slice(-2048),
      })}`,
    );
  }
}

test('Store 13 fixture converts and passes the production continuity codec', () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-store13-fixture-')));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const store = createRetiredStore(home, workspace);
  try {
    expect(existsSync(`${store}-wal`)).toBe(true);
    const database = new Database(store, { readonly: true });
    try {
      assertKiteSessionStore13Schema(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'packaged Service rejects a non-Desktop parent before touching Store 13 WAL',
  async () => {
    expect(existsSync(packagedExecutable)).toBe(true);
    const application = resolve(dirname(packagedExecutable), '../..');
    const paired = packagedServiceIdentity(application);
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-store13-parent-')));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    try {
      const storePath = createRetiredStore(home, workspace);
      const before = storeFileHashes(storePath);
      expect(before.wal).not.toBeNull();
      const config = join(home, '.kite-code');
      const child = Bun.spawn(
        [join(application, 'Contents/Resources/service/kite-service'), 'app-server', 'run-stdio'],
        {
          cwd: home,
          env: {
            HOME: home,
            USERPROFILE: home,
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            NODE_ENV: 'production',
            KITE_CODE_HOME: config,
            KITE_CODE_CONFIG_HOME: config,
            KITE_APP_SERVER_BUILD_ID: paired.manifest.buildId,
            KITE_STANDALONE_EXECUTABLE: '1',
            KITE_DESKTOP_PAIRED_MANIFEST_SHA256: pairedDesktopManifestDigest(paired.manifest),
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      try {
        const code = await Promise.race([
          child.exited,
          Bun.sleep(15_000).then(() => {
            throw new Error('Packaged Service admission timed out.');
          }),
        ]);
        const stderr = await new Response(child.stderr).text();
        expect(code).not.toBe(0);
        expect(parseServiceStartupDiagnostic(stderr)).toEqual({
          code: 'store_admission_failed',
          actualSchema: null,
          expectedSchema: null,
          stage: 'acquiring_maintenance',
          admissionReason: 'desktop_parent_unverified',
        });
        expect(storeFileHashes(storePath)).toEqual(before);
        expect(existsSync(join(config, 'session-store-recovery'))).toBe(false);
        expect(existsSync(join(config, 'kite-session-publication.json'))).toBe(false);
      } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.platform !== 'darwin')(
  'packaged Desktop upgrades exact Store 13 once and preserves parent and child history',
  async () => {
    expect(existsSync(packagedExecutable)).toBe(true);
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-store13-packaged-')));
    const application = join(home, 'kite.app');
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(join(home, 'app-data'), { mode: 0o700 });
    try {
      cpSync(resolve(dirname(packagedExecutable), '../..'), application, {
        recursive: true,
        verbatimSymlinks: true,
      });
      expect(packagedServiceIdentity(application).serviceSha256).toMatch(/^[a-f0-9]{64}$/u);
      const storePath = createRetiredStore(home, workspace);
      expect(existsSync(`${storePath}-wal`)).toBe(true);
      const before = persistedHistory(storePath);
      const beforeHashes = storeFileHashes(storePath);
      expect(beforeHashes.wal).not.toBeNull();
      const originalParent = executionAuthority(storePath, 'retired-parent');
      const originalChild = executionAuthority(storePath, 'retired-child');
      expect(originalParent).toMatchObject({ status: 'active', cleanupConfirmed: false });
      expect(originalChild).toMatchObject({ status: 'recovery_required', cleanupConfirmed: true });
      const first = await launchPackagedDesktop(application, home);
      let firstAssets: ReturnType<typeof recoveryAssets>;
      try {
        await first.page
          .locator('.session-row')
          .filter({ hasText: 'retired-parent' })
          .waitFor({ timeout: 45_000 });
        const database = new Database(storePath, { readonly: true });
        try {
          assertKiteSessionStoreSchema(database);
        } finally {
          database.close();
        }
        expect(persistedHistory(storePath)).toEqual(before);
        expect(executionAuthority(storePath, 'retired-parent')).toMatchObject({
          status: 'recovery_required',
          controllerGeneration: 4,
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          interactionGeneration: 4,
          leaseUntilMs: null,
          cleanupConfirmed: false,
          revision: 6,
        });
        expect(executionAuthority(storePath, 'retired-child')).toEqual(originalChild);
        firstAssets = recoveryAssets(home);
        expect(firstAssets.manifest.source).toMatchObject({
          mainSha256: beforeHashes.main,
          walSha256: beforeHashes.wal,
        });
        expect(
          createHash('sha256').update(readFileSync(firstAssets.backupPath)).digest('hex'),
        ).toBe(firstAssets.manifest.backupSha256);
        expect(persistedHistory(firstAssets.backupPath)).toEqual(before);
        expect(executionAuthority(firstAssets.backupPath, 'retired-parent')).toEqual(
          originalParent,
        );
        expect(executionAuthority(firstAssets.backupPath, 'retired-child')).toEqual(originalChild);
      } finally {
        await first.close();
      }
      const publishedBytes = readFileSync(storePath);
      const publishedParent = executionAuthority(storePath, 'retired-parent');
      const second = await launchPackagedDesktop(application, home);
      try {
        await second.page
          .locator('.session-row')
          .filter({ hasText: 'retired-parent' })
          .waitFor({ timeout: 45_000 });
        expect(readFileSync(storePath)).toEqual(publishedBytes);
        expect(persistedHistory(storePath)).toEqual(before);
        expect(executionAuthority(storePath, 'retired-parent')).toEqual(publishedParent);
        expect(executionAuthority(storePath, 'retired-child')).toEqual(originalChild);
        expect(recoveryAssets(home)).toEqual(firstAssets!);
        expect(existsSync(join(home, '.kite-code', 'kite-session-publication.json'))).toBe(false);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  180_000,
);
