import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Terminal } from '@xterm/headless';
import { parseCallerIntent } from '../../../apps/cli/host/caller-intents';
import { parseTuiDraftDocument } from '../../../apps/cli/host/tui-drafts';
import { readModelOutput } from '../../../packages/agent/src/model-output';
import type { WindowsOwnedJobMember } from '../../../packages/agent/src/platform/process/windows-owned-child';
import { startWindowsInstalledTuiPty } from './windows-installed-tui-pty';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string) =>
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const compact = (text: string) => text.replace(/\s/gu, '');

/** Two complete, independent installed consumers. Each has one absolute 120s budget;
 * each real 80x24 ConPTY driver has at most 30s. No source-service or availability fallback.
 * This caller qualifies current code, not two different releases or Windows Shell.
 */
export async function qualifyWindowsInstalledTui(input: { terminal: string; native: string }) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_installed_tui_platform_required');
  assert(isAbsolute(input.terminal) && isAbsolute(input.native), 'absolute_candidates_required');
  const terminalSource = realpathSync(input.terminal),
    nativeSource = realpathSync(input.native);
  const { verifyTerminalBundle } = await import('../../../apps/cli/host/terminal-artifact');
  const { verifyNativeRuntimeBundle } = await import(
    '../../../apps/service/src/native-runtime-assets'
  );
  const { installTerminalBundle, uninstallTerminalBundle } = await import(
    '../../../scripts/release/terminal-bundle'
  );
  const { installNativeBundle, uninstallNativeBundle } = await import(
    '../../../scripts/release/native-install'
  );
  const { registerNativeCLI } = await import('../../../scripts/release/cli-registration');
  const { readCLIRegistration, sameCLIRegistration } = await import(
    '../../../apps/cli/host/cli-registration'
  );
  const { acquireArtifactAccess } = await import('../../../packages/agent/src/artifact-access');
  const { selectProfile } = await import('../../../packages/agent/src/profile');
  const { defaultWindowsPathSecurity, privateDirectory } = await import(
    '../../../packages/agent/src/platform/windows-path-security'
  );
  const terminalCandidate = verifyTerminalBundle(terminalSource),
    nativeCandidate = verifyNativeRuntimeBundle(nativeSource),
    security = defaultWindowsPathSecurity()!;
  assert.deepEqual(terminalCandidate.manifest.sqlite, nativeCandidate.terminal.manifest.sqlite);
  const root = join(realpathSync(tmpdir()), `kite-windows-installed-tui-${randomUUID()}`);
  assert(!existsSync(root), 'new_private_root_required');
  privateDirectory(root);
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    terminalPrefix = join(root, 'terminal'),
    nativePrefix = join(root, 'native');
  privateDirectory(home);
  privateDirectory(workspace);
  const dataRoot = join(home, '.kite-code', 'unified-agent'),
    profile = selectProfile({ dataRoot, profile: 'default' });
  privateDirectory(profile.profilePath);
  privateDirectory(join(profile.profilePath, 'ui'));
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
  // Only the stable product frontdoor receives poisoned startup options. The trusted
  // candidate Bun driver receives the clean environment and fixed native config.
  const poison = join(workspace, 'poison.mjs'),
    poisonMarker = join(root, 'preload-ran');
  security.writePrivateFile(
    poison,
    Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(poisonMarker)},'preload');throw Error('INSTALLED_TUI_PRELOAD_EXECUTED');`,
    ),
  );
  security.writePrivateFile(
    join(workspace, 'bunfig.toml'),
    Buffer.from(`preload = [${JSON.stringify(poison)}]\n`),
  );
  const productEnv = {
    ...env,
    NODE_PATH: workspace,
    NODE_OPTIONS: `--require ${JSON.stringify(poison)}`,
    BUN_OPTIONS: `--preload ${JSON.stringify(poison)}`,
    BUN_BE_BUN: '1',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const preferencesPath = join(profile.profilePath, 'ui', 'preferences.jsonc');
  security.writePrivateFile(preferencesPath, Buffer.from('{"language":"en-US"}\n'));
  const phases = ['terminal', 'registered-native'] as const;
  const cases = phases.map((phase) => ({
    phase,
    sessionId: `installed-tui-${phase}`,
    work: `Complete original installed TUI ${phase} task`,
    cancel: `Cancel original installed TUI ${phase} task`,
    body: `${'完整正文🙂e\u0301 '.repeat(2048)}\nFULL_INSTALLED_TUI_${phase}_TAIL`,
    reasoning: `ORIGINAL_INSTALLED_TUI_${phase}_REASON`,
    partial: `PENDING_INSTALLED_TUI_${phase}`,
    draft: `UNSUBMITTED_${phase}_原完整🙂e\u0301_DRAFT_TAIL`,
  }));
  const calls = new Map<string, number>();
  const cancelledStreams = new Set<string>();
  let providerError: unknown;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      try {
        assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
        const value = (await request.json()) as {
          messages: { role: string; content: string }[];
        };
        const task = [...value.messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'user' &&
              cases.some(
                (item) => item.work === message.content || item.cancel === message.content,
              ),
          )?.content;
        const scenario = cases.find((item) => item.work === task || item.cancel === task);
        assert(scenario && task, 'provider_must_receive_exact_real_tui_work');
        calls.set(task, (calls.get(task) ?? 0) + 1);
        assert.equal(calls.get(task), 1, 'original_tui_work_must_not_replay');
        const frame = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: `tui-${scenario.phase}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (task === scenario.work)
          return new Response(
            `${frame({ content: scenario.body, reasoning_content: scenario.reasoning }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        // The second real Model is held open until Ctrl+C cancels its exact original
        // Command. Stream cancellation/HTTP abort and durable terminal state are separate facts.
        request.signal.addEventListener('abort', () => cancelledStreams.add(task), { once: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(frame({ content: scenario.partial }, null)));
            },
            cancel() {
              cancelledStreams.add(task);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      } catch (error) {
        providerError ??= error;
        return new Response('qualification_provider_failed', { status: 500 });
      }
    },
  });
  security.writePrivateFile(
    join(profile.profilePath, 'config.jsonc'),
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
  const originalConfig = readFileSync(join(profile.profilePath, 'config.jsonc')),
    originalPreferences = readFileSync(preferencesPath);
  const records: Record<string, unknown>[] = [];
  const owners = new Set<Awaited<ReturnType<typeof startWindowsInstalledTuiPty>>>();
  let deadline = 0,
    phaseStartedAt = 0,
    activePhase: (typeof phases)[number] = 'terminal';
  const remaining = () => {
    const ms = deadline - Date.now();
    assert(ms > 0, `installed_tui_absolute_deadline:${activePhase}`);
    return ms;
  };
  const record = (phase: string, facts: Record<string, unknown> = {}) => {
    const row = { consumer: activePhase, phase, elapsedMs: Date.now() - phaseStartedAt, ...facts };
    records.push(row);
    console.log(JSON.stringify({ qualification: 'windows-installed-tui', ...row }));
  };
  const poll = async <T>(
    label: string,
    operation: () => T | Promise<T>,
    accept: (value: T) => boolean,
  ) => {
    const until = Date.now() + Math.min(10000, remaining());
    let latest: T | undefined;
    while (Date.now() < until) {
      if (providerError !== undefined) throw providerError;
      latest = await operation();
      if (accept(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`installed_tui_wait_failed:${label}:${JSON.stringify(latest)}`);
  };
  const leases = (roots: readonly string[], busy: boolean) => {
    for (const selected of roots) {
      let lease: ReturnType<typeof acquireArtifactAccess> | undefined;
      try {
        if (busy)
          assert.throws(() => {
            lease = acquireArtifactAccess({ root: selected, mode: 'exclusive' });
          }, /busy|in.use/i);
        else lease = acquireArtifactAccess({ root: selected, mode: 'exclusive' });
      } finally {
        lease?.release();
      }
    }
  };
  let outcome: Record<string, unknown> | undefined, firstError: unknown;
  try {
    phaseStartedAt = Date.now();
    deadline = phaseStartedAt + 120000;
    record('install_begin');
    const installedTerminal = installTerminalBundle({
      bundleRoot: terminalSource,
      prefix: terminalPrefix,
    });
    remaining();
    assert.equal(installedTerminal.candidateId, terminalCandidate.candidateId);
    const terminalRoot = installedTerminal.releaseRoot,
      launcher = join(terminalPrefix, 'bin', 'kite-tui.exe'),
      driverRuntime = join(terminalRoot, terminalCandidate.manifest.entries.runtime);
    const load = (selected: string) =>
      pathToFileURL(join(selected, 'node_modules', '@kite-ai', 'agent', 'sqlite.js')).href;
    const sqlite = (await import(
      load(terminalRoot)
    )) as typeof import('../../../packages/agent/src/sqlite');
    type Store = Awaited<ReturnType<typeof sqlite.openSqliteStore>>;
    const usingStore = async <T>(store: Store, read: (selected: Store) => Promise<T>) => {
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        result = { ok: true, value: await read(store) };
      } catch (error) {
        result = { ok: false, error };
      }
      try {
        await store.close();
      } catch (cleanup) {
        throw new AggregateError(
          result.ok ? [cleanup] : [result.error, cleanup],
          'installed_tui_store_close_failed',
        );
      }
      if (!result.ok) throw result.error;
      return result.value;
    };
    const originalStoreId = await usingStore(
      await sqlite.openSqliteStore({ dataRoot, profile: 'default' }),
      async (store) => {
        const storeId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: storeId,
          id: 'installed-tui-workspace',
          name: 'Installed TUI original workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        for (const scenario of cases)
          await store.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `installed-tui-create-${scenario.phase}`,
            sessionId: scenario.sessionId,
            workspaceId: 'installed-tui-workspace',
            title: `Installed TUI ${scenario.phase}`,
          });
        return storeId;
      },
    );
    const history = async (selectedSqlite: typeof sqlite, sessionId: string) =>
      usingStore(
        await selectedSqlite.openSqliteStore({ dataRoot, profile: 'default', mode: 'readonly' }),
        async (store) => {
          const metadata = await store.getMetadata(),
            view = await store.getView(sessionId),
            messages = await store.listMessages(sessionId),
            executions = await store.listExecutions(sessionId),
            commands = await Promise.all(
              view.runs.map((run) => store.getCommand(run.originCommandId)),
            );
          assert.equal(metadata.storeId, originalStoreId);
          assert.equal(view.session.id, sessionId);
          assert.equal(view.session.workspaceId, 'installed-tui-workspace');
          assert.deepEqual(await store.getMetadata(), metadata, 'readonly_history_must_not_write');
          return {
            metadata,
            session: view.session,
            runs: view.runs,
            messages,
            executions,
            commands,
          };
        },
      );
    const fullOutput = async (selectedSqlite: typeof sqlite, scenario: (typeof cases)[number]) =>
      usingStore(
        await selectedSqlite.openSqliteStore({ dataRoot, profile: 'default', mode: 'readonly' }),
        async (store) => {
          const metadata = await store.getMetadata(),
            executions = await store.listExecutions(scenario.sessionId),
            original = executions.filter(
              (execution) => execution.kind === 'model' && execution.status === 'succeeded',
            );
          assert.equal(original.length, 1);
          const execution = original[0]!;
          const saved = await store.getModelOutputSnapshot({
            expectedStoreId: originalStoreId,
            sessionId: scenario.sessionId,
            subjectId: 'local-user',
            executionId: execution.id,
          });
          assert(saved.complete && saved.output);
          assert.equal(saved.storeId, originalStoreId);
          assert.equal(saved.originStoreId, originalStoreId);
          assert.equal(saved.identity.executionId, execution.id);
          assert.equal(saved.identity.runId, execution.runId);
          assert.equal(saved.output.contentBytes, String(Buffer.byteLength(scenario.body)));
          assert.equal(saved.output.reasoningBytes, String(Buffer.byteLength(scenario.reasoning)));
          assert.equal(saved.output.toolCallCount, 0);
          const full = await readModelOutput(
            saved.output,
            {
              storeId: originalStoreId,
              sessionId: scenario.sessionId,
              subjectId: 'local-user',
              executionId: execution.id,
            },
            async (reference) =>
              readFileSync(
                join(profile.profilePath, 'blobs', reference.hash.slice(0, 2), reference.hash),
              ),
          );
          assert.equal(full.content, scenario.body);
          assert.equal(full.reasoning, scenario.reasoning);
          assert.deepEqual(full.toolCalls, []);
          assert.equal(full.complete, true);
          assert.deepEqual(await store.getMetadata(), metadata, 'full_output_read_must_not_write');
          return { execution, saved, full };
        },
      );
    const journal = () => {
      const path = join(profile.profilePath, 'ui', 'caller-intents.json');
      security.verifyFile(path);
      const bytes = readFileSync(path),
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
          version: number;
          records: { intent: unknown; phase: string }[];
        };
      assert.deepEqual(Object.keys(value).sort(), ['records', 'version']);
      assert.equal(value.version, 1);
      assert(value.records.length <= 128);
      const records = value.records.map((row) => {
        assert.deepEqual(Object.keys(row).sort(), ['intent', 'phase']);
        assert.equal(row.phase, 'applied');
        const intent = parseCallerIntent(row.intent);
        assert.equal(intent.scope.storeId, originalStoreId);
        assert.equal(intent.scope.workspaceId, 'installed-tui-workspace');
        assert.equal(intent.request.expectedStoreId, originalStoreId);
        assert.equal(intent.subjectId, 'local-user');
        return { intent, phase: row.phase };
      });
      assert.equal(
        new Set(records.map((row) => row.intent.request.commandId)).size,
        records.length,
      );
      return { records, bytes };
    };
    const draft = (scenario: (typeof cases)[number]) => {
      const path = join(profile.profilePath, 'ui', 'tui.json');
      security.verifyFile(path);
      const bytes = readFileSync(path),
        doc = parseTuiDraftDocument(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
        matches = doc.drafts.filter(
          (row) =>
            row.storeId === originalStoreId &&
            row.sessionId === scenario.sessionId &&
            row.workspaceId === 'installed-tui-workspace',
        );
      assert.equal(matches.length, 1);
      assert.equal(matches[0]!.text, scenario.draft);
      assert(BigInt(matches[0]!.revision) > 0n);
      return { row: matches[0]!, bytes };
    };
    const start = async (
      scenario: (typeof cases)[number],
      runtimeRoot: string,
      nativeRoot?: string,
    ) => {
      const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      let revision = 0;
      const pty = await startWindowsInstalledTuiPty({
        runtimeExecutable: driverRuntime,
        launcher,
        argv: ['--test-ui-diagnostics', '--workspace', workspace, '--thread', scenario.sessionId],
        cwd: workspace,
        env,
        productEnv,
        deadline,
        onOutput: (bytes) =>
          new Promise<void>((resolve) =>
            screen.write(bytes, () => {
              revision++;
              resolve();
            }),
          ),
      });
      owners.add(pty);
      const frame = () => {
        const buffer = screen.buffer.active;
        return Array.from(
          { length: screen.rows },
          (_, offset) => buffer.getLine(buffer.viewportY + offset)?.translateToString(true) ?? '',
        ).join('\n');
      };
      const waitFrame = async (label: string, test: (frame: string) => boolean, after = -1) =>
        poll(
          label,
          () => ({ revision, frame: frame() }),
          (value) => value.revision > after && test(value.frame),
        );
      const idle = (value: string) =>
        compact(value).includes(compact(`Session ${scenario.sessionId} · Idle`)) &&
        !value.includes(' · Loading') &&
        !value.includes(' · Stale') &&
        !value.includes('Error:');
      await waitFrame(
        'current_session_idle',
        (value) => idle(value) && value.includes('New Run >'),
      );
      const members = await poll(
        'original_tui_and_service',
        () => {
          const all = pty.originalOwner.retainMembers();
          const verifierPath = nativeRoot
            ? join(nativePrefix, 'bin', 'native-verifier.exe')
            : join(terminalPrefix, 'bin', 'terminal-verifier.exe');
          const verifier = all.filter((member) => samePath(member.executablePath, verifierPath));
          const runtimePath = join(runtimeRoot, 'runtime', 'bun.exe');
          const tui = all.filter(
            (member) =>
              samePath(member.executablePath, runtimePath) &&
              verifier.some(
                (parent) =>
                  member.parentPid === parent.pid &&
                  BigInt(member.creationTime) >= BigInt(parent.creationTime),
              ),
          );
          const service = all.filter(
            (member) =>
              samePath(member.executablePath, runtimePath) &&
              tui.some(
                (parent) =>
                  member.parentPid === parent.pid &&
                  BigInt(member.creationTime) >= BigInt(parent.creationTime),
              ),
          );
          const product = all.find(
            (member) => member.pid === pty.productPid && samePath(member.executablePath, launcher),
          );
          const nativeFrontdoor = nativeRoot
            ? all.filter((member) =>
                samePath(member.executablePath, join(nativePrefix, 'bin', 'kite-tui.exe')),
              )
            : [];
          if (
            tui.length !== 1 ||
            service.length !== 1 ||
            !product ||
            (nativeRoot && nativeFrontdoor.length !== 1)
          ) {
            for (const member of all) member.close();
            return null;
          }
          const kept = [product, ...verifier, ...tui, ...service, ...nativeFrontdoor];
          for (const member of all) if (!kept.includes(member)) member.close();
          for (const member of kept) assert.equal(member.inspect(), 'alive');
          return kept;
        },
        (value): value is WindowsOwnedJobMember[] => value !== null,
      );
      assert(members);
      const selected = nativeRoot ? [terminalRoot, nativeRoot, runtimeRoot] : [terminalRoot];
      leases(selected, true);
      assert(!existsSync(poisonMarker));
      record('frontdoor_original_consumers', {
        sessionId: scenario.sessionId,
        terminalCandidateId: terminalCandidate.candidateId,
        nativeCandidateId: nativeRoot ? nativeCandidate.digest : null,
        members: members.map(({ pid, parentPid, creationTime, executablePath }) => ({
          pid,
          parentPid,
          creationTime,
          executablePath,
        })),
        frame: frame(),
      });
      return { pty, screen, frame, waitFrame, idle, revision: () => revision, selected };
    };
    type Window = Awaited<ReturnType<typeof start>>;
    // Read the latest rendering of the exact original Message from the parsed
    // terminal buffer. The completed Thought summary remains visible; complete
    // reasoning is qualified through the saved output and Markdown export.
    const originalOutputFrame = (window: Window, message: { id: string; status: string }) => {
      assert.equal(message.status, 'complete');
      const expectedHeader = compact(`assistant [${message.id}] ${message.status}`);
      const buffer = window.screen.buffer.active;
      let header = -1;
      for (let line = buffer.length - 1; line >= 0; line--) {
        const text = compact(buffer.getLine(line)?.translateToString(true) ?? '');
        if (text.includes(expectedHeader)) {
          header = line;
          break;
        }
      }
      assert(header >= 0, 'latest_original_output_header_required');
      window.screen.scrollToLine(header);
      const frame = window.frame();
      assert(compact(frame).includes(expectedHeader));
      window.screen.scrollToBottom();
      assert(window.idle(window.frame()), 'latest_main_area_must_remain_current');
      return frame;
    };
    const quit = async (window: Window, phase: string) => {
      await window.pty.write('\x11', Math.min(10000, remaining()));
      const exited = await window.pty.exited;
      assert.equal(exited.productExitCode, 0);
      assert.equal(exited.ptyExitCode, 0);
      const proof = window.pty.originalOwner.readEvidence();
      assert(
        proof.closed && !proof.closeUnknown && proof.job.treeStopped && proof.root.waitConfirmed,
      );
      assert.equal(proof.job.activeProcesses, 0);
      assert.equal(proof.job.terminationRequested, false);
      leases(window.selected, false);
      assert(!existsSync(poisonMarker));
      record(phase, { stdoutEOF: true, stderrEOF: true, outputBytes: exited.outputBytes, proof });
      owners.delete(window.pty);
      window.screen.dispose();
    };
    const exercise = async (
      scenario: (typeof cases)[number],
      selectedSqlite: typeof sqlite,
      runtimeRoot: string,
      nativeRoot?: string,
    ) => {
      const warm = await start(scenario, runtimeRoot, nativeRoot);
      const before = warm.revision();
      await warm.pty.write(scenario.work);
      await warm.waitFrame(
        'exact_editor_work',
        (value) => compact(value).includes(compact(`New Run > ${scenario.work}`)),
        before,
      );
      await warm.pty.write('\r');
      await warm.waitFrame(
        'original_work_completed_preview',
        (value) => warm.idle(value) && value.includes('Recorded Model output preview only;'),
      );
      const completed = await history(selectedSqlite, scenario.sessionId);
      assert.equal(completed.runs.length, 1);
      assert.equal(completed.runs[0]!.status, 'completed');
      assert.equal(completed.executions.length, 1);
      assert.equal(completed.executions[0]!.kind, 'model');
      assert.equal(completed.executions[0]!.status, 'succeeded');
      assert.equal(completed.commands[0]!.id, completed.runs[0]!.originCommandId);
      assert.equal(completed.commands[0]!.status, 'applied');
      assert.equal(completed.commands[0]!.originStoreId, originalStoreId);
      assert.equal(completed.executions[0]!.originCommandId, completed.commands[0]!.id);
      assert.equal(
        completed.messages.filter((message) => message.role === 'user').at(-1)?.content,
        scenario.work,
      );
      const complete = await fullOutput(selectedSqlite, scenario);
      const originalMessage = completed.messages.find((message) => message.role === 'assistant');
      assert(originalMessage);
      assert(
        !originalMessage.content.includes(`FULL_INSTALLED_TUI_${scenario.phase}_TAIL`),
        'full_tail_must_exceed_preview',
      );
      const previewRevision = warm.revision();
      await warm.pty.write('\x0f');
      await warm.waitFrame(
        'explicit_complete_body',
        (value) =>
          warm.idle(value) &&
          value.includes(`FULL_INSTALLED_TUI_${scenario.phase}_TAIL`) &&
          !value.includes('Recorded Model output preview only;'),
        previewRevision,
      );
      const completedFrame = originalOutputFrame(warm, originalMessage);
      assert(!completedFrame.includes(scenario.reasoning));
      assert(completedFrame.includes('Thought · Recorded phase:'));
      const exportsBefore = new Set(
        readdirSync(profile.profilePath).filter(
          (name) => name.startsWith('session-') && name.endsWith('.md'),
        ),
      );
      await warm.pty.write('/export');
      await warm.waitFrame('export_editor', (value) => value.includes('New Run > /export'));
      await warm.pty.write('\r');
      const filename = await poll(
        'complete_export_created',
        () =>
          readdirSync(profile.profilePath).filter(
            (name) =>
              name.startsWith('session-') && name.endsWith('.md') && !exportsBefore.has(name),
          ),
        (value) => value.length === 1,
      );
      const exportedPath = join(profile.profilePath, filename[0]!);
      await warm.waitFrame(
        'export_actual_receipt',
        (value) =>
          value.includes('Exported loaded conversation:') &&
          compact(value).includes(compact(filename[0]!)),
      );
      security.verifyFile(exportedPath);
      const exported = readFileSync(exportedPath, 'utf8');
      assert(exported.startsWith('# Kite Code Session Export\n'));
      assert(exported.includes(scenario.body));
      assert(exported.includes(`> ${scenario.reasoning}`));
      assert(exported.includes(`**You:** ${scenario.work}`));
      assert(
        !exported.includes('Loaded preview only;') &&
          !exported.includes('Loaded incomplete prefix'),
      );
      assert.equal(calls.get(scenario.work), 1);
      record('complete_work_body_reasoning_export', {
        commandId: completed.commands[0]!.id,
        runId: completed.runs[0]!.id,
        executionId: complete.execution.id,
        contentSha256: sha(Buffer.from(complete.full.content)),
        reasoningSha256: sha(Buffer.from(complete.full.reasoning)),
        exportSha256: sha(Buffer.from(exported)),
        originalMessageId: originalMessage.id,
        completedFrame,
      });
      await warm.pty.write(scenario.cancel);
      await warm.waitFrame('exact_cancel_editor', (value) =>
        compact(value).includes(compact(`New Run > ${scenario.cancel}`)),
      );
      await warm.pty.write('\r');
      await warm.waitFrame(
        'original_second_work_active',
        (value) =>
          compact(value).includes(compact(`Session ${scenario.sessionId} · Working`)) &&
          value.includes(scenario.partial),
      );
      const active = await poll(
        'original_active_model',
        () => history(selectedSqlite, scenario.sessionId),
        (value) =>
          value.runs.some((run) => run.isActive && run.status === 'running') &&
          value.executions.some(
            (execution) => execution.kind === 'model' && execution.status === 'running',
          ),
      );
      const activeRun = active.runs.find((run) => run.isActive)!;
      assert.notEqual(activeRun.originCommandId, completed.commands[0]!.id);
      assert.equal(calls.get(scenario.cancel), 1);
      await warm.pty.write('\x03');
      await warm.waitFrame('exact_work_cancelled_idle', warm.idle);
      await poll(
        'original_provider_cancelled',
        () => cancelledStreams.has(scenario.cancel),
        Boolean,
      );
      const cancelled = await history(selectedSqlite, scenario.sessionId);
      assert.equal(cancelled.runs.length, 2);
      assert.equal(cancelled.runs.find((run) => run.id === activeRun.id)?.status, 'cancelled');
      assert.equal(
        cancelled.commands.find((command) => command?.id === activeRun.originCommandId)?.status,
        'applied',
      );
      const originalCancelledCommand = cancelled.commands.find(
        (command) => command?.id === activeRun.originCommandId,
      );
      assert(originalCancelledCommand);
      assert(Number.isSafeInteger(originalCancelledCommand.cancelRequestedAt));
      assert(originalCancelledCommand.cancelRequestedAt! > 0);
      const originalExecution = cancelled.executions.find(
        (execution) => execution.runId === activeRun.id && execution.kind === 'model',
      );
      assert(originalExecution);
      assert.equal(originalExecution.status, 'cancelled');
      assert.equal(originalExecution.originCommandId, activeRun.originCommandId);
      assert(
        cancelled.executions.every((execution) => execution.kind === 'model'),
        'no_tool_or_shell_dispatch',
      );
      const saved = journal();
      const own = saved.records.filter((row) => row.intent.scope.sessionId === scenario.sessionId);
      assert.equal(own.length, 3);
      const startRows = own.filter((row) => row.intent.request.kind === 'run.start');
      assert.equal(startRows.length, 2);
      const cancelRows = own.filter((row) => row.intent.request.kind === 'command.cancel');
      assert.equal(cancelRows.length, 1);
      const cancelIntent = cancelRows[0]!.intent;
      assert.equal(cancelIntent.request.kind, 'command.cancel');
      if (cancelIntent.request.kind !== 'command.cancel')
        throw Error('original_cancel_intent_required');
      assert.equal(cancelIntent.request.targetCommandId, activeRun.originCommandId);
      assert.notEqual(cancelIntent.request.commandId, activeRun.originCommandId);
      const cancelCommand = await usingStore(
        await selectedSqlite.openSqliteStore({ dataRoot, profile: 'default', mode: 'readonly' }),
        (store) => store.getCommand(cancelIntent.request.commandId),
      );
      assert(cancelCommand);
      assert.equal(cancelCommand.status, 'applied');
      assert.equal(cancelCommand.originStoreId, originalStoreId);
      assert.equal(cancelCommand.requestDigest, cancelIntent.requestDigest);
      assert.deepEqual(cancelCommand.receipt, {
        kind: 'command.cancel',
        targetCommandId: activeRun.originCommandId,
        outcome: 'cancel_requested',
        affectedCount: 3,
      });
      leases(warm.selected, true);
      if (nativeRoot) assert.throws(() => uninstallNativeBundle(nativePrefix), /busy|in.use/i);
      else assert.throws(() => uninstallTerminalBundle(terminalPrefix), /busy|in.use/i);
      await warm.pty.write(scenario.draft);
      await warm.waitFrame('exact_unsent_draft', (value) =>
        compact(value).includes(compact(scenario.draft)),
      );
      await quit(warm, 'normal_quit_full_original_job');
      const originalHistory = await history(selectedSqlite, scenario.sessionId),
        originalOutput = await fullOutput(selectedSqlite, scenario),
        originalJournal = journal(),
        originalDraft = draft(scenario);
      const callsBeforeCold = [...calls];
      const cold = await start(scenario, runtimeRoot, nativeRoot);
      await cold.waitFrame(
        'cold_original_editor_and_history',
        (value) =>
          cold.idle(value) &&
          compact(value).includes(compact(scenario.draft)) &&
          value.includes('Recorded Model output preview only;'),
      );
      await cold.pty.write('\x0f');
      await cold.waitFrame(
        'cold_explicit_original_full_body',
        (value) => cold.idle(value) && value.includes(`FULL_INSTALLED_TUI_${scenario.phase}_TAIL`),
      );
      const coldCompletedFrame = originalOutputFrame(cold, originalMessage);
      assert(!coldCompletedFrame.includes('Recorded Model output preview only;'));
      assert(!coldCompletedFrame.includes(scenario.reasoning));
      assert(coldCompletedFrame.includes('Thought · Recorded phase:'));
      await quit(cold, 'cold_normal_quit_full_original_job');
      const afterCold = await history(selectedSqlite, scenario.sessionId);
      for (const field of ['runs', 'messages', 'executions', 'commands'] as const)
        assert.deepEqual(afterCold[field], originalHistory[field], `cold_original_${field}`);
      assert.equal(
        afterCold.metadata.lastChangeCursor,
        originalHistory.metadata.lastChangeCursor,
        'cold_read_zero_new_store_events',
      );
      assert.deepEqual(await fullOutput(selectedSqlite, scenario), originalOutput);
      assert.deepEqual(journal().bytes, originalJournal.bytes);
      assert.deepEqual(draft(scenario), originalDraft);
      assert.deepEqual([...calls], callsBeforeCold, 'cold_model_zero_replay');
      assert.deepEqual(readFileSync(join(profile.profilePath, 'config.jsonc')), originalConfig);
      assert.deepEqual(readFileSync(preferencesPath), originalPreferences);
      record('cold_original_history_draft_cancel_zero_replay', {
        originalStoreId,
        cancelledCommandId: activeRun.originCommandId,
        cancelCommandId: cancelCommand.id,
        originalLastChangeCursor: originalHistory.metadata.lastChangeCursor,
        modelCalls: [...calls],
        journalSha256: sha(originalJournal.bytes),
        draftSha256: sha(originalDraft.bytes),
      });
      remaining();
      return afterCold;
    };
    const terminalHistory = await exercise(cases[0]!, sqlite, terminalRoot);
    record('terminal_complete', { absoluteBudgetMs: 120000 });
    // The second consumer has its own predeclared absolute budget, never a reset
    // inside retries or a claim that both complete installation chains take 120s.
    activePhase = 'registered-native';
    phaseStartedAt = Date.now();
    deadline = phaseStartedAt + 120000;
    record('install_and_registration_begin');
    const installedNative = installNativeBundle({ bundleRoot: nativeSource, prefix: nativePrefix });
    remaining();
    assert.equal(installedNative.candidateId, nativeCandidate.digest);
    const registration = registerNativeCLI({ nativePrefix, terminalPrefix });
    assert(sameCLIRegistration(readCLIRegistration(terminalPrefix), registration));
    assert(sameCLIRegistration(readCLIRegistration(nativePrefix, true), registration));
    assert.equal(registration.candidateId, nativeCandidate.digest);
    const nativeTerminalRoot = join(installedNative.releaseRoot, 'terminal');
    const nativeSqlite = (await import(load(nativeTerminalRoot))) as typeof sqlite;
    await exercise(cases[1]!, nativeSqlite, nativeTerminalRoot, installedNative.releaseRoot);
    const migratedHistory = await history(nativeSqlite, cases[0]!.sessionId);
    for (const field of ['runs', 'messages', 'executions', 'commands'] as const)
      assert.deepEqual(
        migratedHistory[field],
        terminalHistory[field],
        `native_consumer_preserves_terminal_${field}`,
      );
    await fullOutput(nativeSqlite, cases[0]!);
    const beforeUninstall = {
      journal: journal().bytes,
      draft: readFileSync(join(profile.profilePath, 'ui', 'tui.json')),
      database: readFileSync(profile.databasePath),
    };
    leases([terminalRoot, installedNative.releaseRoot, nativeTerminalRoot], false);
    uninstallNativeBundle(nativePrefix);
    assert(!existsSync(nativePrefix));
    assert.equal(
      readCLIRegistration(terminalPrefix),
      undefined,
      'native_uninstall_removes_both_original_registration_records',
    );
    assert(existsSync(launcher), 'independent_terminal_survives_native_uninstall');
    uninstallTerminalBundle(terminalPrefix);
    assert(!existsSync(terminalPrefix));
    assert.deepEqual(readFileSync(profile.databasePath), beforeUninstall.database);
    assert.deepEqual(journal().bytes, beforeUninstall.journal);
    assert.deepEqual(
      readFileSync(join(profile.profilePath, 'ui', 'tui.json')),
      beforeUninstall.draft,
    );
    assert.deepEqual(readFileSync(join(profile.profilePath, 'config.jsonc')), originalConfig);
    assert.deepEqual(readFileSync(preferencesPath), originalPreferences);
    assert.equal(verifyTerminalBundle(terminalSource).candidateId, terminalCandidate.candidateId);
    assert.equal(verifyNativeRuntimeBundle(nativeSource).digest, nativeCandidate.digest);
    assert(!existsSync(poisonMarker));
    assert.equal(calls.size, 4);
    for (const count of calls.values()) assert.equal(count, 1);
    record('uninstall_preserves_original_media_and_inputs', {
      modelCalls: [...calls],
      originalStoreId,
      databaseSha256: sha(beforeUninstall.database),
      journalSha256: sha(beforeUninstall.journal),
      draftSha256: sha(beforeUninstall.draft),
    });
    remaining();
    outcome = {
      root,
      terminalCandidateId: terminalCandidate.candidateId,
      nativeCandidateId: nativeCandidate.digest,
      terminalBudgetMs: 120000,
      registeredNativeBudgetMs: 120000,
      driverBudgetMs: 30000,
      records,
    };
  } catch (error) {
    firstError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const owner of owners) {
    try {
      await owner.close();
      owners.delete(owner);
    } catch (cleanup) {
      cleanupErrors.push(cleanup);
    }
  }
  provider.stop(true);
  if (providerError !== undefined && providerError !== firstError)
    cleanupErrors.push(providerError);
  if (firstError !== undefined || cleanupErrors.length)
    throw new AggregateError(
      [...(firstError === undefined ? [] : [firstError]), ...cleanupErrors],
      'windows_installed_tui_qualification_failed',
    );
  assert(outcome, 'installed_tui_evidence_required');
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'exact_terminal_and_native_arguments_required');
  assert(args[0]!.startsWith('--terminal=') && args[1]!.startsWith('--native='));
  console.log(
    JSON.stringify(
      await qualifyWindowsInstalledTui({
        terminal: args[0]!.slice('--terminal='.length),
        native: args[1]!.slice('--native='.length),
      }),
    ),
  );
}
