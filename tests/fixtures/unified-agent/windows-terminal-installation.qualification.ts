import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
        `import {openSqliteStore} from ${JSON.stringify(pathToFileURL(join(selectedB.releaseRoot, 'node_modules/@kite-ai/agent/sqlite.js')).href)};const s=await openSqliteStore({dataRoot:${JSON.stringify(dataRoot)},profile:'default',mode:'readonly'});try{console.log(JSON.stringify({session:await s.getSession('windows-installed'),messages:await s.listMessages('windows-installed'),executions:await s.listExecutions('windows-installed')}));}finally{await s.close();}`,
      ),
    );
    const cold = await execute('installed_cold_history', [runtime, reader], {
      frontdoor: false,
      cwd: home,
    });
    assert.equal(cold.code, 0);
    const history = JSON.parse(cold.stdout) as {
      session: { id: string };
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
      daemon: false,
      daemonPlatformQualification: 'pending',
      candidateA: built.candidateId,
      candidateB: b.candidateId,
      providerCalls,
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
