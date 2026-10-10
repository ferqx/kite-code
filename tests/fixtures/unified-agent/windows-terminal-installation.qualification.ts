import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ProfileBackup,
  ProfileGarbageCollection,
} from '../../../packages/agent/src/maintenance';
import type { SessionRecord } from '../../../packages/agent/src/storage/types';
import { qualifyInstalledWindowsDaemon } from './windows-daemon-qualification';

/** Explicit native Windows qualification, never a default availability-skipped test.
 * B differs only in manifest version: this proves selection, not cross-code compatibility.
 */
export async function qualifyWindowsTerminalInstallation(candidateInput: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_terminal_qualification_platform_required');
  const startedAt = performance.now(),
    deadline = startedAt + 120000,
    workDeadline = deadline - 10000;
  assert(isAbsolute(candidateInput), 'candidate_absolute_required');
  const candidate = realpathSync(candidateInput);
  const { verifyTerminalBundle } = await import('../../../apps/cli/host/terminal-artifact');
  const { installTerminalBundle, rollbackTerminalBundle, uninstallTerminalBundle } = await import(
    '../../../scripts/release/terminal-bundle'
  );
  const { packTerminalBundle, unpackTerminalBundle } = await import(
    '../../../scripts/release/terminal-archive'
  );
  const { acquireArtifactAccess } = await import('../../../packages/agent/src/artifact-access');
  const { selectProfile } = await import('../../../packages/agent/src/profile');
  const { defaultWindowsPathSecurity, privateDirectory } = await import(
    '../../../packages/agent/src/platform/windows-path-security'
  );
  const security = defaultWindowsPathSecurity()!;
  const built = verifyTerminalBundle(candidate);
  const root = join(realpathSync(tmpdir()), `kite-windows-terminal-${randomUUID()}`);
  assert(!existsSync(root), 'qualification_root_must_be_new');
  // The private API creates the protected SID DACL; mkdtemp's inherited ACL is not adopted.
  privateDirectory(root);
  assert.equal(realpathSync(root), root);
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    prefix = join(root, 'prefix');
  privateDirectory(home);
  privateDirectory(workspace);
  const dataRoot = join(home, '.kite-code', 'unified-agent');
  const profile = selectProfile({ dataRoot, profile: 'default' });
  privateDirectory(profile.profilePath);
  const poison = join(workspace, 'poison.mjs'),
    poisonMarker = join(root, 'preload-ran');
  security.writePrivateFile(
    poison,
    Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(poisonMarker)},'preload');throw Error('WINDOWS_FRONTDOOR_PRELOAD_EXECUTED');`,
    ),
  );
  security.writePrivateFile(
    join(workspace, 'bunfig.toml'),
    Buffer.from(`preload = [${JSON.stringify(poison)}]\n`),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LANG: 'C.UTF-8',
  };
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'BUN_BE_BUN',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete env[key];
  const poisoned = {
    ...env,
    NODE_OPTIONS: `--require ${JSON.stringify(poison)}`,
    BUN_OPTIONS: `--preload ${JSON.stringify(poison)}`,
    BUN_BE_BUN: '1',
    NODE_PATH: workspace,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const children = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>();
  const records: {
    phase: string;
    code: number;
    elapsedMs: number;
    stdoutEOF: true;
    stderrEOF: true;
  }[] = [];
  const remaining = (cleanup: boolean) =>
    Math.max(0, (cleanup ? deadline : workDeadline) - performance.now());
  const execute = async (
    phase: string,
    argv: string[],
    options: { frontdoor?: boolean; cleanup?: boolean; cwd?: string } = {},
  ) => {
    const budget = Math.min(30000, remaining(Boolean(options.cleanup)));
    assert(budget > 0, 'windows_terminal_qualification_deadline');
    const child = Bun.spawn(argv, {
      cwd: options.cwd ?? workspace,
      env: options.frontdoor === false ? env : poisoned,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.add(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(Error(`windows_terminal_command_timeout:${phase}`));
          }, budget);
        }),
      ]);
      const [code, stdout, stderr] = result;
      records.push({
        phase,
        code,
        elapsedMs: performance.now() - startedAt,
        stdoutEOF: true,
        stderrEOF: true,
      });
      children.delete(child);
      assert(!existsSync(poisonMarker), 'frontdoor_preload_must_not_execute');
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  };
  let providerCalls = 0;
  let releaseProvider!: () => void, announceProvider!: () => void;
  const providerHeld = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const providerReady = new Promise<void>((resolve) => {
    announceProvider = resolve;
  });
  const body = 'WINDOWS_INSTALLED_MODEL_COMPLETE';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { messages?: unknown[] };
      assert(JSON.stringify(input.messages).includes('windows installed task'));
      providerCalls++;
      announceProvider();
      await providerHeld;
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'windows-installed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(`${frame({ content: body }, null)}${frame({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const refuseCandidateEX = (releaseRoot: string) => {
    let unexpected: ReturnType<typeof acquireArtifactAccess> | undefined;
    try {
      assert.throws(
        () => {
          unexpected = acquireArtifactAccess({ root: releaseRoot, mode: 'exclusive' });
        },
        /busy|in.use/i,
        'actual_consumer_shared_lease_required',
      );
    } finally {
      unexpected?.release();
    }
  };
  const cli = join(prefix, 'bin', 'kite.exe'),
    tui = join(prefix, 'bin', 'kite-tui.exe');
  let completed = false,
    firstError: unknown;
  let runPromise: ReturnType<typeof execute> | undefined;
  let evidence: Record<string, unknown> | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    const clone = join(root, 'clone-a');
    cpSync(candidate, clone, { recursive: true, dereference: false, verbatimSymlinks: true });
    const archive = await packTerminalBundle({
      bundleRoot: clone,
      archivePath: join(root, 'terminal.tar.gz'),
    });
    const relocated = join(root, 'relocated');
    const unpacked = await unpackTerminalBundle({
      archivePath: archive.archivePath,
      sha256: archive.sha256,
      destination: relocated,
    });
    assert.equal(unpacked.candidateId, built.candidateId);
    rmSync(clone, { recursive: true });
    assert(existsSync(candidate), 'input_candidate_preserved');
    assert(remaining(false) > 0, 'qualification_build_deadline');
    const installed = await installTerminalBundle({ bundleRoot: relocated, prefix });
    assert.equal(installed.candidateId, built.candidateId);
    assert(existsSync(cli) && existsSync(tui));
    for (const executable of [cli, tui]) {
      const help = await execute(executable === cli ? 'cli_help' : 'tui_help', [
        executable,
        '--help',
      ]);
      assert.equal(help.code, 0);
      assert(help.stdout.includes('--workspace'));
      const version = await execute(executable === cli ? 'cli_version' : 'tui_version', [
        executable,
        '--version',
      ]);
      assert.equal(version.code, 0);
      assert(version.stdout.includes(built.manifest.productVersion));
    }
    const registration = join(prefix, '.kite-cli-registration.json');
    security.writePrivateFile(registration, Buffer.from('{}'));
    try {
      const denied = await execute('native_registration_guard', [cli, '--help']);
      assert.notEqual(denied.code, 0);
      assert(denied.stderr.includes('native_windows_bootstrap_unqualified'));
    } finally {
      rmSync(registration);
    }
    security.writePrivateFile(
      join(profile.profilePath, 'config.jsonc'),
      Buffer.from(
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
      ),
    );
    runPromise = execute('installed_run', [
      cli,
      'run',
      '--thread',
      'windows-installed',
      '--task',
      'windows installed task',
      '--workspace',
      workspace,
      '--trust-workspace',
      '--full',
    ]);
    // The actual installed paired consumer, not a synthetic holder, has admitted the Run.
    void runPromise.catch(() => {});
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        providerReady,
        runPromise.then(() => {
          throw Error('installed_run_finished_before_held_provider');
        }),
        new Promise<never>((_, reject) => {
          readyTimer = setTimeout(
            () => reject(Error('installed_provider_admission_timeout')),
            Math.min(30000, remaining(false)),
          );
        }),
      ]);
    } finally {
      clearTimeout(readyTimer);
    }
    assert.equal(providerCalls, 1);
    refuseCandidateEX(installed.releaseRoot);
    assert.throws(
      () => uninstallTerminalBundle(prefix),
      /busy|in.use/i,
      'actual_paired_shared_lease_blocks_uninstall',
    );
    const busyDatabase = readFileSync(profile.databasePath);
    const busyBackups = join(root, 'busy-backups');
    const busyBackup = await execute('maintenance_busy_backup', [
      cli,
      'maintenance',
      'backup',
      '--data-root',
      dataRoot,
      '--profile',
      'default',
      '--destination',
      busyBackups,
    ]);
    assert.notEqual(busyBackup.code, 0);
    assert(/owner_busy|store_busy|Lock is busy|in.use/i.test(busyBackup.stderr));
    assert(!existsSync(busyBackups), 'busy_backup_must_not_publish');
    assert.deepEqual(readFileSync(profile.databasePath), busyDatabase);
    assert.equal(providerCalls, 1);
    const upgrade = join(root, 'candidate-b');
    cpSync(relocated, upgrade, { recursive: true, dereference: false, verbatimSymlinks: true });
    const manifestPath = join(upgrade, 'terminal-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.productVersion = built.manifest.productVersion === '0.1.1' ? '0.1.2' : '0.1.1';
    // writePrivateFile creates a new private object; never reopen its existing file as a writer.
    rmSync(manifestPath);
    security.writePrivateFile(manifestPath, Buffer.from(JSON.stringify(manifest)));
    const b = verifyTerminalBundle(upgrade);
    assert.notEqual(b.candidateId, built.candidateId);
    const upgraded = await installTerminalBundle({ bundleRoot: upgrade, prefix });
    assert.equal(upgraded.previousCandidateId, built.candidateId);
    assert.equal(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0], b.candidateId);
    refuseCandidateEX(installed.releaseRoot);
    const inactiveB = acquireArtifactAccess({ root: upgraded.releaseRoot, mode: 'exclusive' });
    inactiveB.release();
    assert.throws(() => uninstallTerminalBundle(prefix), /busy|in.use/i);
    const rollback = rollbackTerminalBundle(prefix);
    assert.equal(rollback.candidateId, built.candidateId);
    assert.equal(rollback.previousCandidateId, b.candidateId);
    assert.equal(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0], built.candidateId);
    assert.throws(() => uninstallTerminalBundle(prefix), /busy|in.use/i);
    releaseProvider();
    const run = await runPromise;
    assert.equal(run.code, 0);
    assert(run.stdout.includes(body));
    assert.equal(providerCalls, 1);
    const selectedB = installTerminalBundle({ bundleRoot: upgrade, prefix });
    assert.equal(selectedB.candidateId, b.candidateId);
    const runtime = join(selectedB.releaseRoot, b.manifest.entries.runtime);
    const reader = join(home, 'read.mjs');
    security.writePrivateFile(
      reader,
      Buffer.from(
        `import {openSqliteStore} from ${JSON.stringify(pathToFileURL(join(selectedB.releaseRoot, 'node_modules/@kite-ai/agent/sqlite.js')).href)};const s=await openSqliteStore({dataRoot:${JSON.stringify(dataRoot)},profile:'default',mode:'readonly'});try{const executions=await s.listExecutions('windows-installed');console.log(JSON.stringify({metadata:await s.getMetadata(),session:await s.getSession('windows-installed'),messages:await s.listMessages('windows-installed'),executions,command:await s.getCommand(executions[0].originCommandId)}));}finally{await s.close();}`,
      ),
    );
    const cold = await execute('installed_cold_history', [runtime, reader], {
      frontdoor: false,
      cwd: home,
    });
    assert.equal(cold.code, 0);
    const history = JSON.parse(cold.stdout) as {
      metadata: { storeId: string; lastChangeCursor: string };
      command: Record<string, unknown>;
      session: SessionRecord;
      executions: {
        id: string;
        runId: string;
        sessionId: string;
        originStoreId: string;
        originCommandId: string;
        resultRevision: string;
        kind: string;
        status: string;
      }[];
      messages: unknown[];
    };
    assert.equal(history.session.id, 'windows-installed');
    assert.equal(history.executions.length, 1);
    assert.equal(history.executions[0]!.kind, 'model');
    assert.equal(history.executions[0]!.status, 'succeeded');
    const original = history.executions[0]!;
    assert.equal(original.sessionId, history.session.id);
    assert(
      original.id &&
        original.runId &&
        original.originStoreId &&
        original.originCommandId &&
        original.resultRevision,
    );
    assert(run.stdout.includes(original.originCommandId), 'actual_run_receipt_original_command');
    assert(JSON.stringify(history.messages).includes(body));
    assert.equal(providerCalls, 1);
    const scope = ['--data-root', dataRoot, '--profile', 'default'];
    const maintenance = async (action: string, args: string[]) => {
      const result = await execute(`maintenance_${action}`, [cli, 'maintenance', action, ...args]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(value.kind, 'offline_maintenance');
      assert.equal(value.action, action);
      assert.equal(providerCalls, 1);
      return value;
    };
    const configPath = join(profile.profilePath, 'config.jsonc');
    const originalConfig = readFileSync(configPath);
    privateDirectory(join(profile.profilePath, 'ui'));
    const preferencesPath = join(profile.profilePath, 'ui/preferences.jsonc');
    const preferences = Buffer.from(
      '// 原始 private UI bytes\r\n{"language":"system","colorPreset":"purple","unknown":"Café 🔐"}\r\n',
    );
    security.writePrivateFile(preferencesPath, preferences);
    const backed = await maintenance('backup', [...scope, '--destination', join(root, 'backups')]);
    assert.equal(backed.status, 'verified');
    const backup = backed.backup as ProfileBackup;
    assert.equal(backup.manifest.source.storeId, history.metadata.storeId);
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(backup.manifest.assets.configuration.proof?.sha256, sha(originalConfig));
    assert.equal(backup.manifest.assets.tuiPreferences.proof?.sha256, sha(preferences));
    assert.deepEqual(readFileSync(join(backup.directory, 'config.jsonc')), originalConfig);
    assert.deepEqual(readFileSync(join(backup.directory, 'ui/preferences.jsonc')), preferences);
    assert(
      BigInt(backup.manifest.media.referenceCount) > 0n,
      'original_model_referenced_media_required',
    );
    const inventory = readFileSync(join(backup.directory, 'media.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { hash: string; size: string });
    const verifyOriginalMedia = () => {
      assert.equal(String(inventory.length), backup.manifest.media.blobCount);
      for (const entry of inventory) {
        assert(/^[a-f0-9]{64}$/.test(entry.hash));
        const parts = ['blobs', entry.hash.slice(0, 2), entry.hash];
        const captured = readFileSync(join(backup.directory, ...parts));
        assert.equal(String(captured.length), entry.size);
        assert.equal(sha(captured), entry.hash);
        assert.deepEqual(readFileSync(join(profile.profilePath, ...parts)), captured);
      }
    };
    verifyOriginalMedia();
    const inspected = await maintenance('inspect', [backup.directory]);
    assert.equal(inspected.status, 'verified');
    assert.deepEqual(inspected.backup, backup);
    assert.equal((await maintenance('status', scope)).restore, null);
    const restore = await maintenance('restore', [
      backup.directory,
      ...scope,
      '--expected-store',
      history.metadata.storeId,
      '--confirm-data-loss',
    ]);
    assert.equal(restore.status, 'restored');
    assert.equal(typeof restore.storeId, 'string');
    assert.notEqual(restore.storeId, history.metadata.storeId);
    assert.equal(restore.previousDirectoryPreserved, true);
    assert.deepEqual(readFileSync(configPath), originalConfig);
    assert.deepEqual(readFileSync(preferencesPath), preferences);
    verifyOriginalMedia();
    assert.equal((await maintenance('status', scope)).restore, null);
    const restoredCold = await execute('installed_restored_cold_history', [runtime, reader], {
      frontdoor: false,
      cwd: home,
    });
    assert.equal(restoredCold.code, 0);
    const restoredHistory = JSON.parse(restoredCold.stdout) as typeof history;
    assert.equal(restoredHistory.metadata.storeId, restore.storeId);
    assert.deepEqual(restoredHistory.session, {
      ...history.session,
      ownerInstanceId: null,
      ownerGeneration: String(BigInt(history.session.ownerGeneration) + 1n),
    });
    assert.deepEqual(restoredHistory.messages, history.messages);
    assert.deepEqual(restoredHistory.executions, history.executions);
    assert.deepEqual(restoredHistory.command, history.command);
    assert(JSON.stringify(restoredHistory.messages).includes(body));
    assert.equal(providerCalls, 1);
    // The fixed native artifact publisher creates an actual unreferenced immutable blob.
    // It is recent: this frontdoor does not fake clock advancement or claim expired deletion.
    const { createWindowsArtifactTemporary } = await import(
      '../../../packages/agent/src/platform/windows-artifact-files'
    );
    const recent = Buffer.from('WINDOWS_INSTALLED_RECENT_UNREFERENCED_MEDIA');
    const recentHash = sha(recent);
    const recentPath = join(profile.profilePath, 'blobs', recentHash.slice(0, 2), recentHash);
    const temporary = createWindowsArtifactTemporary(profile.profilePath);
    try {
      temporary.write(recent);
      temporary.publish(recentHash, String(recent.length));
    } finally {
      temporary.close();
    }
    assert.deepEqual(readFileSync(recentPath), recent);
    const beforeGcDatabase = readFileSync(profile.databasePath);
    const beforeGcCursor = restoredHistory.metadata.lastChangeCursor;
    const oldStoreGc = await execute('maintenance_gc_old_store', [
      cli,
      'maintenance',
      'gc',
      ...scope,
      '--expected-store',
      history.metadata.storeId,
    ]);
    assert.notEqual(oldStoreGc.code, 0);
    assert(oldStoreGc.stderr.includes('store_identity_mismatch'));
    assert.deepEqual(readFileSync(profile.databasePath), beforeGcDatabase);
    assert.deepEqual(readFileSync(recentPath), recent);
    const collected = await maintenance('gc', [
      ...scope,
      '--expected-store',
      restore.storeId as string,
    ]);
    assert.equal(collected.status, 'collected');
    const gc = collected.gc as ProfileGarbageCollection;
    assert.equal(gc.storeId, restore.storeId);
    assert.equal(gc.outcome, 'collected');
    assert(gc.retainedReferenced > 0);
    assert(gc.retainedRecent > 0);
    assert.equal(gc.removedFiles, 0);
    assert.equal(gc.removedBytes, '0');
    verifyOriginalMedia();
    assert.deepEqual(readFileSync(recentPath), recent);
    assert.deepEqual(readFileSync(profile.databasePath), beforeGcDatabase);
    const gcCold = await execute('installed_gc_cold_history', [runtime, reader], {
      frontdoor: false,
      cwd: home,
    });
    assert.equal(gcCold.code, 0);
    const gcHistory = JSON.parse(gcCold.stdout) as typeof history;
    assert.equal(gcHistory.metadata.lastChangeCursor, beforeGcCursor);
    assert.deepEqual(gcHistory, restoredHistory);
    assert.equal(providerCalls, 1);
    const daemonEvidence = await qualifyInstalledWindowsDaemon({
      cli,
      prefix,
      dataRoot,
      workspace,
      candidateA: {
        releaseRoot: installed.releaseRoot,
        candidateId: built.candidateId,
        buildId: built.buildId,
      },
      candidateB: {
        releaseRoot: selectedB.releaseRoot,
        candidateId: b.candidateId,
        buildId: b.buildId,
      },
      execute,
      deadline: workDeadline,
      rollback: () => rollbackTerminalBundle(prefix),
      selectB: () => installTerminalBundle({ bundleRoot: upgrade, prefix }),
    });
    assert.equal(providerCalls, 1, 'original_paired_provider_count_preserved_after_daemon');
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    try {
      for (const id of [built.candidateId, b.candidateId])
        leases.push(
          acquireArtifactAccess({ root: join(prefix, 'releases', id), mode: 'exclusive' }),
        );
      assert.equal(leases.length, 2, 'all_candidate_ex_acquired_after_actual_consumer_exit');
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
    const database = readFileSync(profile.databasePath),
      config = readFileSync(join(profile.profilePath, 'config.jsonc'));
    uninstallTerminalBundle(prefix);
    assert(!existsSync(prefix));
    assert.deepEqual(readFileSync(profile.databasePath), database);
    assert.deepEqual(readFileSync(join(profile.profilePath, 'config.jsonc')), config);
    assert.equal(providerCalls, 1);
    assert(remaining(false) > 0);
    completed = true;
    evidence = {
      qualified: true,
      platform: 'win32-x64',
      scope: 'terminal-installed-pointer-lifecycle',
      crossCode: false,
      tuiPty: false,
      native: false,
      daemon: daemonEvidence,
      daemonPlatformQualification: 'qualified',
      candidateA: built.candidateId,
      candidateB: b.candidateId,
      providerCalls,
      maintenance: {
        frontdoor: 'kite.exe',
        actions: ['backup', 'inspect', 'status', 'restore', 'status', 'gc'],
        busyBackupRejected: true,
        newStoreId: restore.storeId,
        oldStoreGcRejected: true,
        referencedAndRecentRetained: true,
        expiredDeletion: false,
        rawConfigAndPreferences: true,
        desktopUi: false,
        coldNoReplay: true,
      },
      originalIdentity: {
        storeId: original.originStoreId,
        sessionId: original.sessionId,
        runId: original.runId,
        executionId: original.id,
        commandId: original.originCommandId,
        resultRevision: original.resultRevision,
      },
      elapsedMs: performance.now() - startedAt,
      records,
    };
  } catch (error) {
    firstError = error;
  } finally {
    releaseProvider();
    if (runPromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('original_paired_consumer_exit_unknown')),
              remaining(true),
            );
          }),
        ]);
      } catch (error) {
        if (error !== firstError) cleanupErrors.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    for (const child of children) {
      try {
        if (child.exitCode === null) child.kill();
        const budget = Math.min(2000, remaining(true));
        assert(budget > 0, 'cleanup_deadline');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            child.exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Error('owned_command_exit_unknown')), budget);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      provider.stop(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (completed && cleanupErrors.length === 0) {
      try {
        rmSync(root, { recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else
      console.error(
        `WINDOWS_TERMINAL_QUALIFICATION_FAILED ${JSON.stringify({ root, elapsedMs: performance.now() - startedAt, records })}`,
      );
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      firstError ? [firstError, ...cleanupErrors] : cleanupErrors,
      'windows_terminal_cleanup_unknown',
    );
  if (firstError) throw firstError;
  assert(performance.now() <= deadline, 'windows_terminal_whole_120s_deadline');
  assert(evidence, 'qualification_evidence_missing');
  evidence.elapsedMs = performance.now() - startedAt;
  return evidence;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]!.startsWith('--candidate=') || !args[0]!.slice(12))
    throw Error('usage: --candidate=<absolute-built-terminal>');
  console.log(JSON.stringify(await qualifyWindowsTerminalInstallation(args[0]!.slice(12))));
}
