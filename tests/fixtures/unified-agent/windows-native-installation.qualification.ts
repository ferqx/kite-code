import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProfileBackup } from '../../../packages/agent/src/maintenance';
import { readModelOutput } from '../../../packages/agent/src/model-output';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
  type WindowsOwnedJobMember,
} from '../../../packages/agent/src/platform/process/windows-owned-child';
import { createWindowsNativeUIA, type WindowsNativeUIAElement } from './windows-native-uia';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const samePath = (left: string, right: string) =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

/** Explicit native caller. A manifest-only B proves version selection, not cross-code compatibility.
 * The original 120s basic and 180s maintenance budgets remain separate; no availability skip.
 */
export async function qualifyWindowsNativeInstallation(candidateInput: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_native_qualification_platform_required');
  assert(isAbsolute(candidateInput), 'candidate_absolute_required');
  const startedAt = Date.now(),
    basicDeadline = startedAt + 120000;
  let deadline = basicDeadline;
  const candidate = realpathSync(candidateInput);
  const { verifyNativeRuntimeBundle } = await import(
    '../../../apps/service/src/native-runtime-assets'
  );
  const { verifyTerminalRuntimeBundle } = await import('../../../apps/service/src/runtime-assets');
  const { installNativeBundle, rollbackNativeBundle, uninstallNativeBundle } = await import(
    '../../../scripts/release/native-install'
  );
  const { packNativeBundle, unpackNativeBundle } = await import(
    '../../../scripts/release/native-archive'
  );
  const { acquireArtifactAccess } = await import('../../../packages/agent/src/artifact-access');
  const { selectProfile } = await import('../../../packages/agent/src/profile');
  const { defaultWindowsPathSecurity, privateDirectory } = await import(
    '../../../packages/agent/src/platform/windows-path-security'
  );
  const security = defaultWindowsPathSecurity()!;
  const originalCandidate = verifyNativeRuntimeBundle(candidate);
  const root = join(realpathSync(tmpdir()), `kite-windows-native-${randomUUID()}`);
  assert(!existsSync(root), 'qualification_root_must_be_new');
  privateDirectory(root);
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    prefix = join(root, 'installed');
  privateDirectory(home);
  privateDirectory(workspace);
  const dataRoot = join(home, '.kite-code', 'unified-agent');
  const profile = selectProfile({ dataRoot, profile: 'default' });
  privateDirectory(profile.profilePath);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key.toUpperCase()] = value;
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'BUN_BE_BUN',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete env[key];
  const roaming = join(home, 'AppData', 'Roaming'),
    local = join(home, 'AppData', 'Local');
  privateDirectory(roaming);
  privateDirectory(local);
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    LANG: 'C.UTF-8',
  });
  const poison = join(workspace, 'poison.mjs'),
    poisonMarker = join(root, 'preload-ran');
  security.writePrivateFile(
    poison,
    Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(poisonMarker)},'preload');throw Error('WINDOWS_NATIVE_FRONTDOOR_PRELOAD_EXECUTED');`,
    ),
  );
  security.writePrivateFile(
    join(workspace, 'bunfig.toml'),
    Buffer.from(`preload = [${JSON.stringify(poison)}]\n`),
  );
  const poisoned = {
    ...env,
    NODE_PATH: workspace,
    NODE_OPTIONS: `--require ${JSON.stringify(poison)}`,
    BUN_OPTIONS: `--preload ${JSON.stringify(poison)}`,
    BUN_BE_BUN: '1',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const owners = new Set<WindowsOwnedChild>();
  const records: Record<string, unknown>[] = [];
  let uia: Awaited<ReturnType<typeof createWindowsNativeUIA>> | undefined;
  const remaining = () => {
    const ms = deadline - Date.now();
    assert(ms > 0, 'windows_native_qualification_deadline');
    return ms;
  };
  const record = (phase: string, facts: Record<string, unknown> = {}) => {
    const row = { phase, elapsedMs: Date.now() - startedAt, ...facts };
    records.push(row);
    console.log(JSON.stringify({ qualification: 'windows-native-installation', ...row }));
  };
  const bounded = async <T>(operation: Promise<T>, ms: number, phase: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`windows_native_timeout:${phase}`)),
            Math.max(1, ms),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stage = async <T>(phase: string, run: () => T | Promise<T>): Promise<T> => {
    remaining();
    record(`${phase}_begin`);
    try {
      const result = await run();
      remaining();
      return result;
    } finally {
      record(`${phase}_end`);
    }
  };
  const start = async (executable: string, argv: string[]) => {
    try {
      const child = startWindowsOwnedChild({
        executable,
        argv,
        cwd: workspace,
        env: poisoned,
        stdin: 'ignore',
      });
      owners.add(child);
      return child;
    } catch (error) {
      if (error instanceof WindowsOwnedChildStartError) {
        try {
          await error.cleanup;
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'windows_native_start_cleanup_unknown');
        }
      }
      throw error;
    }
  };
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert(bytes <= 4 * 1024 * 1024, 'windows_native_process_output_limit');
      chunks.push(Buffer.from(chunk));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  };
  const consume = (child: WindowsOwnedChild) => {
    const completion = Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
    void completion.catch(() => {});
    return completion;
  };
  const confirmedClose = async (child: WindowsOwnedChild) => {
    await child.close();
    const proof = child.readEvidence();
    assert(
      proof.closed && !proof.closeUnknown && proof.root.waitConfirmed && proof.job.treeStopped,
    );
    assert.equal(proof.job.activeProcesses, 0);
    assert.equal(
      proof.job.terminationRequested,
      false,
      'natural_exit_must_not_be_fixture_job_termination',
    );
    assert.equal(proof.root.exitCode, 0);
    owners.delete(child);
    assert(!existsSync(poisonMarker), 'frontdoor_preload_must_not_execute');
    return proof;
  };
  const execute = async (phase: string, argv: string[]) => {
    const child = await start(argv[0]!, argv.slice(1));
    const [code, stdout, stderr] = await bounded(
      consume(child),
      Math.min(30000, remaining()),
      phase,
    );
    const proof = await confirmedClose(child);
    record(phase, { code, stdoutEOF: true, stderrEOF: true, proof });
    assert.equal(code, 0, `${phase}: ${stderr}`);
    assert.equal(stderr, '');
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  let providerCalls = 0;
  const input = 'real installed Native task',
    body = 'Native installed complete',
    sessionId = 'windows-native-installed-session',
    sessionTitle = 'Windows Native installed history';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
      const value = (await request.json()) as { messages: { role: string; content: string }[] };
      assert.equal(
        value.messages.filter((message) => message.role === 'user').at(-1)?.content,
        input,
      );
      assert.equal(++providerCalls, 1, 'cold_reads_must_not_replay_model');
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'windows-native-installed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(`${frame({ content: body }, null)}${frame({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  let result: Record<string, unknown> | undefined, firstError: unknown;
  try {
    const clone = join(root, 'clone-a');
    cpSync(candidate, clone, { recursive: true, dereference: false, verbatimSymlinks: true });
    const packed = await stage('archive_pack', () =>
      packNativeBundle({ bundleRoot: clone, archivePath: join(root, 'native.tar.gz') }),
    );
    const sourceA = join(root, 'relocated-a');
    const unpacked = await stage('archive_unpack', () =>
      unpackNativeBundle({ ...packed, destination: sourceA }),
    );
    assert.equal(unpacked.digest, originalCandidate.digest);
    rmSync(clone, { recursive: true });
    assert(existsSync(candidate), 'input_candidate_preserved');
    const sourceB = join(root, 'samebaseline-b');
    cpSync(sourceA, sourceB, { recursive: true, dereference: false, verbatimSymlinks: true });
    // Only private, unpublished witness manifests change. Runtime/app files stay byte-identical.
    const terminalManifestPath = join(sourceB, 'terminal', 'terminal-manifest.json');
    const terminalManifest = JSON.parse(readFileSync(terminalManifestPath, 'utf8'));
    terminalManifest.productVersion =
      terminalManifest.productVersion === '0.1.1' ? '0.1.2' : '0.1.1';
    rmSync(terminalManifestPath);
    security.writePrivateArtifactFile(
      terminalManifestPath,
      Buffer.from(`${JSON.stringify(terminalManifest, null, 2)}\n`),
    );
    const terminalB = verifyTerminalRuntimeBundle(join(sourceB, 'terminal'));
    const nativeManifestPath = join(sourceB, 'native-manifest.json');
    const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8'));
    nativeManifest.terminalManifestSha256 = terminalB.digest;
    rmSync(nativeManifestPath);
    security.writePrivateArtifactFile(
      nativeManifestPath,
      Buffer.from(`${JSON.stringify(nativeManifest, null, 2)}\n`),
    );
    const witnessB = verifyNativeRuntimeBundle(sourceB);
    assert.notEqual(witnessB.digest, originalCandidate.digest);
    assert.deepEqual(witnessB.manifest.files, originalCandidate.manifest.files);
    assert.deepEqual(witnessB.terminal.manifest.files, originalCandidate.terminal.manifest.files);
    const installedA = await stage('install_a', () =>
      installNativeBundle({ bundleRoot: sourceA, prefix }),
    );
    assert.equal(installedA.candidateId, originalCandidate.digest);
    const a = installedA.releaseRoot;
    const load = (leaf: string) =>
      pathToFileURL(join(a, 'terminal', 'node_modules', '@kite-ai', 'agent', leaf)).href;
    // Core evidence is read using the actual selected candidate, with no source-module fallback.
    const sqlite = (await import(
      load('sqlite.js')
    )) as typeof import('../../../packages/agent/src/sqlite');
    const usingStore = async <T>(
      store: Awaited<ReturnType<typeof sqlite.openSqliteStore>>,
      read: (store: Awaited<ReturnType<typeof sqlite.openSqliteStore>>) => Promise<T>,
    ): Promise<T> => {
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await read(store) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        await store.close();
      } catch (cleanup) {
        if (!outcome.ok)
          throw new AggregateError([outcome.error, cleanup], 'windows_native_store_cleanup_failed');
        throw cleanup;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    };
    const originalStoreId = await usingStore(
      await sqlite.openSqliteStore({ dataRoot, profile: 'default' }),
      async (seeded) => {
        const storeId = (await seeded.getMetadata()).storeId;
        await seeded.createWorkspace({
          expectedStoreId: storeId,
          id: 'windows-native-workspace',
          name: 'Windows Native installed workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        await seeded.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'windows-native-create',
          sessionId,
          workspaceId: 'windows-native-workspace',
          title: sessionTitle,
        });
        return storeId;
      },
    );
    const configPath = join(profile.profilePath, 'config.jsonc');
    security.writePrivateFile(
      configPath,
      Buffer.from(
        JSON.stringify({
          modelId: 'fixed',
          tools: [],
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
    const readHistory = async () =>
      await usingStore(
        await sqlite.openSqliteStore({
          dataRoot,
          profile: 'default',
          mode: 'readonly',
        }),
        async (store) => {
          const metadata = await store.getMetadata(),
            view = await store.getView(sessionId);
          const messages = await store.listMessages(sessionId),
            executions = await store.listExecutions(sessionId);
          const commands = await Promise.all(
            view.runs.map((run) => store.getCommand(run.originCommandId)),
          );
          const outputs = await Promise.all(
            executions
              .filter((execution) => execution.kind === 'model')
              .map(async (execution) => {
                const saved = await store.getModelOutputSnapshot({
                  expectedStoreId: metadata.storeId,
                  sessionId,
                  subjectId: 'local-user',
                  executionId: execution.id,
                });
                assert(saved.complete && saved.output, 'original_complete_output_required');
                const full = await readModelOutput(
                  saved.output,
                  {
                    storeId: saved.originStoreId,
                    sessionId,
                    subjectId: 'local-user',
                    executionId: execution.id,
                  },
                  async (reference) =>
                    readFileSync(
                      join(
                        profile.profilePath,
                        'blobs',
                        reference.hash.slice(0, 2),
                        reference.hash,
                      ),
                    ),
                );
                assert.equal(full.content, body);
                assert.equal(saved.output.contentBytes, String(Buffer.byteLength(body)));
                assert.equal(saved.output.head.storeId, originalStoreId);
                return { saved, full };
              }),
          );
          assert.deepEqual(
            await store.getMetadata(),
            metadata,
            'readonly_snapshot_must_not_mutate',
          );
          assert.equal(view.session.id, sessionId);
          assert.equal(view.runs.length, 1);
          assert.equal(view.runs[0]!.status, 'completed');
          assert.equal(executions.length, 1);
          assert.equal(executions[0]!.status, 'succeeded');
          assert.equal(executions[0]!.originStoreId, originalStoreId);
          assert.equal(commands[0]!.id, view.runs[0]!.originCommandId);
          assert.equal(commands[0]!.status, 'applied');
          assert.equal(commands[0]!.originStoreId, originalStoreId);
          assert.equal(
            messages.filter((message) => message.role === 'user').at(-1)?.content,
            input,
          );
          for (const output of outputs) {
            assert.equal(output.saved.originStoreId, originalStoreId);
            assert.equal(output.saved.identity.executionId, executions[0]!.id);
            assert.equal(output.saved.identity.runId, view.runs[0]!.id);
            assert.equal(output.full.complete, true);
          }
          assert.equal(providerCalls, 1);
          return { metadata, runs: view.runs, messages, executions, commands, outputs };
        },
      );
    type History = Awaited<ReturnType<typeof readHistory>>;
    const sameHistory = (actual: History, expected: History, storeId: string) => {
      assert.equal(actual.metadata.storeId, storeId);
      for (const output of actual.outputs) assert.equal(output.saved.storeId, storeId);
      for (const name of ['runs', 'messages', 'executions', 'commands'] as const)
        assert.deepEqual(actual[name], expected[name]);
      assert.deepEqual(
        actual.outputs.map(({ saved, full }) => ({
          saved: { ...saved, storeId: originalStoreId, snapshotCursor: 'independent-read-cursor' },
          full,
        })),
        expected.outputs.map(({ saved, full }) => ({
          saved: { ...saved, storeId: originalStoreId, snapshotCursor: 'independent-read-cursor' },
          full,
        })),
      );
      assert.equal(providerCalls, 1);
    };
    const leases = (releaseRoot: string, busy: boolean) => {
      for (const path of [releaseRoot, join(releaseRoot, 'terminal')]) {
        let acquired: ReturnType<typeof acquireArtifactAccess> | undefined;
        try {
          if (busy)
            assert.throws(() => {
              acquired = acquireArtifactAccess({ root: path, mode: 'exclusive' });
            }, /busy|in.use/i);
          else acquired = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        } finally {
          acquired?.release();
        }
      }
    };
    const busyUninstall = () => {
      assert.throws(() => uninstallNativeBundle(prefix), /busy|in.use/i);
      assert(existsSync(prefix));
    };
    const launcher = join(prefix, 'bin', 'kite-desktop.exe');
    const findMembers = async (child: WindowsOwnedChild, releaseRoot: string) => {
      const target = Date.now() + Math.min(10000, remaining());
      while (Date.now() < target) {
        const members = child.retainMembers();
        const verifiers = members.filter((member) =>
          samePath(member.executablePath, join(prefix, 'bin', 'native-verifier.exe')),
        );
        const mains = members.filter(
          (member) =>
            samePath(
              member.executablePath,
              join(releaseRoot, originalCandidate.manifest.entries.electron),
            ) &&
            verifiers.some(
              (verifier) =>
                member.parentPid === verifier.pid &&
                BigInt(member.creationTime) >= BigInt(verifier.creationTime),
            ),
        );
        const services = members.filter(
          (member) =>
            samePath(member.executablePath, join(releaseRoot, 'terminal', 'runtime', 'bun.exe')) &&
            mains.some(
              (main) =>
                member.parentPid === main.pid &&
                BigInt(member.creationTime) >= BigInt(main.creationTime),
            ),
        );
        if (mains.length === 1 && services.length === 1) {
          for (const member of members)
            if (member !== mains[0] && member !== services[0]) member.close();
          assert.equal(mains[0]!.inspect(), 'alive');
          assert.equal(services[0]!.inspect(), 'alive');
          return { main: mains[0]!, service: services[0]! };
        }
        for (const member of members) member.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error('windows_native_original_main_service_required');
    };
    const evidenceForUIA = (member: WindowsOwnedJobMember) => {
      assert.equal(member.inspect(), 'alive', 'original_main_must_still_be_alive');
      return {
        pid: member.pid,
        creationTime: member.creationTime,
        executablePath: member.executablePath,
      };
    };
    const ui = async (
      main: WindowsOwnedJobMember,
      action: Parameters<NonNullable<typeof uia>['perform']>[0],
    ) => {
      assert(uia);
      assert.equal(main.inspect(), 'alive');
      return await uia.perform(action, Math.min(10000, remaining()));
    };
    const snapshot = async (main: WindowsOwnedJobMember) => {
      const value = await ui(main, { ...evidenceForUIA(main), action: 'snapshot' });
      assert(Array.isArray(value.elements));
      return value.elements;
    };
    const waitText = async (main: WindowsOwnedJobMember, text: string, bodyText = false) => {
      const target = Date.now() + Math.min(10000, remaining());
      while (Date.now() < target) {
        const elements = await snapshot(main);
        const found = elements.find((element) =>
          bodyText
            ? element.text?.includes(text) || element.value?.includes(text)
            : element.name === text ||
              element.text?.includes(text) ||
              element.value?.includes(text),
        );
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error(`windows_native_visible_text_required:${text}`);
    };
    const windows: {
      child: WindowsOwnedChild;
      main: WindowsOwnedJobMember;
      service: WindowsOwnedJobMember;
      completion: ReturnType<typeof consume>;
      candidateId: string;
    }[] = [];
    const openWindow = async (releaseRoot: string, candidateId: string) => {
      const child = await start(launcher, []);
      const completion = consume(child);
      const members = await findMembers(child, releaseRoot);
      const window = { child, ...members, completion, candidateId };
      windows.push(window);
      await waitText(window.main, sessionTitle);
      await ui(window.main, {
        ...evidenceForUIA(window.main),
        action: 'clickByName',
        name: sessionTitle,
      });
      await waitText(window.main, '当前会话私有草稿');
      leases(releaseRoot, true);
      busyUninstall();
      record('window_opened', {
        candidateId,
        root: child.readEvidence().root,
        main: evidenceForUIA(window.main),
        service: evidenceForUIA(window.service),
      });
      return window;
    };
    const closeWindow = async (window: (typeof windows)[number], releaseRoot: string) => {
      const response = await ui(window.main, { ...evidenceForUIA(window.main), action: 'quit' });
      assert.equal(response.quitRequested, true);
      const [code, _stdout, stderr] = await bounded(
        window.completion,
        Math.min(10000, remaining()),
        'native_normal_exit',
      );
      assert.equal(code, 0, stderr);
      assert.equal(window.main.inspect(), 'dead');
      assert.equal(window.service.inspect(), 'dead');
      const proof = await confirmedClose(window.child);
      window.main.close();
      window.service.close();
      leases(releaseRoot, false);
      record('window_natural_exit', {
        candidateId: window.candidateId,
        proof,
        mainExited: true,
        serviceExited: true,
        doubleExclusive: true,
      });
    };
    const driverDeadline = Math.min(basicDeadline, Date.now() + 45000);
    uia = await createWindowsNativeUIA({ home, env, deadline: driverDeadline });
    const first = await openWindow(a, installedA.candidateId);
    const draft = await ui(first.main, {
      ...evidenceForUIA(first.main),
      action: 'fillByName',
      name: '当前会话私有草稿',
      text: input,
    });
    assert.equal(draft.filled, input);
    await ui(first.main, {
      ...evidenceForUIA(first.main),
      action: 'clickByName',
      name: '发送明确的新轮次',
    });
    await waitText(first.main, '轮次：completed');
    const visibleA: WindowsNativeUIAElement = await waitText(first.main, body, true);
    const originalHistory = await readHistory();
    const installedB = await stage('select_b_while_a_alive', () =>
      installNativeBundle({ bundleRoot: sourceB, prefix }),
    );
    const b = installedB.releaseRoot;
    assert.equal(installedB.candidateId, witnessB.digest);
    assert.equal(first.main.inspect(), 'alive');
    assert.equal(first.service.inspect(), 'alive');
    leases(a, true);
    busyUninstall();
    assert.equal(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0], witnessB.digest);
    await waitText(first.main, body, true);
    sameHistory(await readHistory(), originalHistory, originalStoreId);
    await closeWindow(first, a);
    const second = await openWindow(b, installedB.candidateId);
    await waitText(second.main, body, true);
    sameHistory(await readHistory(), originalHistory, originalStoreId);
    await closeWindow(second, b);
    const rollback = await stage('rollback_a', () => rollbackNativeBundle(prefix));
    assert.equal(rollback.candidateId, installedA.candidateId);
    const third = await openWindow(a, installedA.candidateId);
    await waitText(third.main, body, true);
    sameHistory(await readHistory(), originalHistory, originalStoreId);
    await closeWindow(third, a);
    assert(Date.now() <= driverDeadline, 'original_basic_driver_45s');
    await uia.close();
    uia = undefined;
    remaining();
    const basicElapsedMs = Date.now() - startedAt;
    record('basic_complete', { basicElapsedMs, originalBudgetMs: 120000, providerCalls });

    // Maintenance has its original independent whole budget; no reset within either leg.
    const maintenanceStarted = Date.now();
    deadline = maintenanceStarted + 180000;
    leases(a, false);
    leases(b, false);
    const cli = join(prefix, 'bin', 'kite.exe');
    const scope = ['--data-root', dataRoot, '--profile', 'default'];
    const maintenance = async (action: string, args: string[]) => {
      const value = await execute(`maintenance_${action}`, [cli, 'maintenance', action, ...args]);
      assert.equal(value.kind, 'offline_maintenance');
      assert.equal(value.action, action);
      assert.equal(providerCalls, 1);
      return value;
    };
    const beforeBackup = {
      core: sha(readFileSync(profile.databasePath)),
      native: sha(readFileSync(join(profile.profilePath, 'desktop-private', 'data.sqlite'))),
      config: sha(readFileSync(configPath)),
    };
    const backupResult = await maintenance('backup', [
      ...scope,
      '--destination',
      join(root, 'backups'),
    ]);
    assert.equal(backupResult.status, 'verified');
    const backup = backupResult.backup as ProfileBackup;
    assert.equal(backup.manifest.source.storeId, originalStoreId);
    assert.equal(backup.manifest.assets.configuration.proof?.sha256, beforeBackup.config);
    assert.equal(backup.manifest.version, 18);
    assert.equal(backup.manifest.assets.desktopUi.format?.userVersion, 9);
    assert.equal(backup.manifest.assets.desktopUi.proof?.sha256, beforeBackup.native);
    assert.equal(sha(readFileSync(profile.databasePath)), beforeBackup.core);
    assert.equal(
      sha(readFileSync(join(profile.profilePath, 'desktop-private', 'data.sqlite'))),
      beforeBackup.native,
    );
    const inspect = await maintenance('inspect', [backup.directory]);
    assert.equal(inspect.status, 'verified');
    assert.deepEqual(inspect.backup, backup);
    const restored = await maintenance('restore', [
      backup.directory,
      ...scope,
      '--expected-store',
      originalStoreId,
      '--confirm-data-loss',
    ]);
    assert.equal(restored.status, 'restored');
    assert.equal(typeof restored.storeId, 'string');
    assert.notEqual(restored.storeId, originalStoreId);
    assert.equal(restored.previousDirectoryPreserved, true);
    assert.equal((await maintenance('status', scope)).restore, null);
    assert.equal(sha(readFileSync(configPath)), beforeBackup.config);
    sameHistory(await readHistory(), originalHistory, restored.storeId as string);
    const restoreDriverDeadline = Math.min(deadline, Date.now() + 45000);
    uia = await createWindowsNativeUIA({ home, env, deadline: restoreDriverDeadline });
    const restoredWindow = await openWindow(a, installedA.candidateId);
    await waitText(restoredWindow.main, body, true);
    sameHistory(await readHistory(), originalHistory, restored.storeId as string);
    await closeWindow(restoredWindow, a);
    assert(Date.now() <= restoreDriverDeadline, 'original_restore_driver_45s');
    await uia.close();
    uia = undefined;
    leases(a, false);
    leases(b, false);
    const preserved = {
      core: sha(readFileSync(profile.databasePath)),
      native: sha(readFileSync(join(profile.profilePath, 'desktop-private', 'data.sqlite'))),
      config: sha(readFileSync(configPath)),
    };
    await stage('single_uninstall', () => uninstallNativeBundle(prefix));
    assert(!existsSync(prefix));
    assert.equal(sha(readFileSync(profile.databasePath)), preserved.core);
    assert.equal(
      sha(readFileSync(join(profile.profilePath, 'desktop-private', 'data.sqlite'))),
      preserved.native,
    );
    assert.equal(sha(readFileSync(configPath)), preserved.config);
    // The exact Core bytes retain the independently checked new Store and original
    // full history. The installed worker itself has now been genuinely removed.
    assert.equal(sha(readFileSync(packed.archivePath)), packed.sha256);
    assert.equal(verifyNativeRuntimeBundle(candidate).digest, originalCandidate.digest);
    assert.equal(providerCalls, 1);
    result = {
      qualification: 'windows-native-installed-complete-chain',
      root,
      candidateA: installedA.candidateId,
      candidateB: installedB.candidateId,
      selectionOnly: true,
      crossCodeQualified: false,
      originalStoreId,
      restoredStoreId: restored.storeId,
      originalCommandId: originalHistory.commands[0]!.id,
      originalRunId: originalHistory.runs[0]!.id,
      originalExecutionId: originalHistory.executions[0]!.id,
      completeOutputSHA256: sha(Buffer.from(body)),
      completeOutputBytes: Buffer.byteLength(body),
      visibleA,
      providerCalls,
      singleUninstall: true,
      preserved,
      basicElapsedMs,
      maintenanceElapsedMs: Date.now() - maintenanceStarted,
      basicBudgetMs: 120000,
      maintenanceBudgetMs: 180000,
      records,
    };
  } catch (error) {
    firstError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await uia?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const owner of owners) {
    try {
      await owner.close();
      owners.delete(owner);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  provider.stop(true);
  if (firstError !== undefined || cleanupErrors.length)
    throw new AggregateError(
      [...(firstError === undefined ? [] : [firstError]), ...cleanupErrors],
      'windows_native_qualification_failed',
    );
  assert(result, 'windows_native_evidence_required');
  remaining();
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 1, 'exact_candidate_argument_required');
  assert(args[0]!.startsWith('--candidate='), 'exact_candidate_argument_required');
  console.log(
    JSON.stringify(await qualifyWindowsNativeInstallation(args[0]!.slice('--candidate='.length))),
  );
}
