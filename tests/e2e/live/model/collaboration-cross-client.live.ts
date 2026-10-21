import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import {
  ptyDeadline,
  spawnTuiPTY,
  type TuiPTY,
  terminateTuiTree,
} from '../../../../apps/cli/test/fixtures/tui-pty';
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import {
  reserveDaemonEndpoint,
  selectDaemonEndpoint,
} from '../../../../apps/service/src/daemon/endpoint';
import { startDevelopmentWeb } from '../../../../apps/service/src/development-web';
import { createTrustedAssets } from '../../../../apps/web/src/assets';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

interface CrossClientOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  evidenceRoot: string;
}
// A small structural boundary to the real installed Playwright package, never a page fake.
interface BrowserPage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForResponse(
    predicate: (response: { url(): string; status(): number }) => boolean,
    options: { timeout: number },
  ): Promise<unknown>;
  locator(selector: string): { innerText(): Promise<string>; count(): Promise<number> };
  getByRole(role: string, options: { name: string; exact?: boolean }): { click(): Promise<void> };
  on(
    event: 'request',
    listener: (request: {
      method(): string;
      url(): string;
      headers(): Record<string, string>;
    }) => void,
  ): void;
  context(): { cookies(): Promise<{ name: string; httpOnly: boolean; sameSite: string }[]> };
  close(): Promise<void>;
}
interface BrowserHandle {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface BrowserAPI {
  chromium: {
    launch(options: {
      executablePath: string;
      headless: boolean;
      args: string[];
    }): Promise<BrowserHandle>;
  };
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
class Boundary extends Error {
  readonly category: 'oracle' | 'branch_not_hit';
  readonly stage: string;
  constructor(category: 'oracle' | 'branch_not_hit', stage: string) {
    super('live_cross_client_boundary');
    this.category = category;
    this.stage = stage;
  }
}
/** Isolated ordinary CLI -> PTY composer -> actual compiled Web in real Chrome. */
export async function runLiveCrossClient(options: CrossClientOptions) {
  if (!isAbsolute(options.evidenceRoot)) throw Error('live_cross_client_root_invalid');
  mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(options.evidenceRoot);
  const home = join(root, 'home');
  const workspace = join(home, 'workspace');
  const repository = new URL('../../../../', import.meta.url).pathname;
  const checks: Record<string, boolean> = {};
  const observations: { stage: string; sha256: string }[] = [];
  const processResults: {
    stage: string;
    exitCode: number;
    stdoutSha256: string;
    stderrSha256: string;
  }[] = [];
  const browserReads: { method: string; route: string; authorizationPresent: boolean }[] = [];
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let reservation: Awaited<ReturnType<typeof reserveDaemonEndpoint>> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let web: ReturnType<typeof startDevelopmentWeb> | undefined;
  let browser: BrowserHandle | undefined;
  let page: BrowserPage | undefined;
  let terminal: TuiPTY | undefined;
  let cli: ReturnType<typeof Bun.spawn> | undefined;
  let closeLocksTask: Promise<void> | undefined;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
  let failureStage = 'setup';
  let failureCategory: string | null = null;
  const requestStart = options.requests().length;
  const closeLocks = () => (closeLocksTask ??= Promise.resolve().then(() => locks?.close()));
  const assert = (condition: unknown, stage: string) => {
    if (!condition) throw new Boundary('oracle', stage);
    checks[stage] = true;
  };
  const until = async <T>(
    load: () => Promise<T | undefined>,
    stage: string,
    timeout = 60_000,
  ): Promise<T> => {
    failureStage = stage;
    const end = Date.now() + timeout;
    for (;;) {
      options.signal.throwIfAborted();
      const result = await load();
      if (result !== undefined) {
        checks[stage] = true;
        return result;
      }
      if (Date.now() >= end) throw new Boundary('branch_not_hit', stage);
      await Bun.sleep(30);
    }
  };
  const frame = async (stage: string, predicate: (text: string) => boolean) => {
    const text = await until(
      async () => {
        await terminal!.drain();
        if (terminal!.ended) throw new Boundary('branch_not_hit', `${stage}_host_exited`);
        const text = terminal!.viewport();
        return predicate(text) ? text : undefined;
      },
      stage,
      30_000,
    );
    observations.push({ stage, sha256: sha(text) });
    return text;
  };
  const send = async (text: string, stage: string) => {
    await terminal!.key(text);
    const tail = text.slice(-32).replace(/\s+/g, '');
    await frame(`${stage}_composed`, (text) => text.replace(/\s+/g, '').includes(tail));
    await terminal!.key('\r');
  };
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const nonce = `owned-U04-${crypto.randomUUID()}`;
    writeFileSync(join(workspace, 'material.txt'), nonce, { mode: 0o600 });
    const configPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        modelId: options.modelId,
        models: [
          {
            id: options.modelId,
            provider: 'compatible',
            model: 'injected-live',
            baseURL: 'http://127.0.0.1:1/v1',
          },
        ],
        tools: [{ id: 'files.read' }],
      }),
      { mode: 0o600 },
    );
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configPath,
      authorizationReview: {
        id: 'live.review',
        version: '1',
        modelId: options.modelId,
        model: options.model,
      },
    });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const ownedStore = store;
    locks = createWorkspaceSerialLocks(profile);
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      stream(request, context) {
        return options.model.stream(request, {
          signal: AbortSignal.any([context.signal, options.signal]),
        });
      },
    };
    // Root, child and recovery use the real counted adapter with the original default policy.
    const inject = (binding: RunConfiguration): RunConfiguration => ({ ...binding, model });
    runtime = createRuntime({
      ...host,
      store: ownedStore,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store: ownedStore }),
      workspaceSerialLocks: locks,
      resolveRunConfiguration: async (input) => inject(await host.resolveRunConfiguration!(input)),
      resolveChildRunConfiguration: async (input) =>
        inject(await host.resolveChildRunConfiguration!(input)),
      resolveRecoveryRunConfiguration: async (input) =>
        inject(await host.resolveRecoveryRunConfiguration!(input)),
    });
    const ownedRuntime = runtime;
    const expectedStoreId = (await ownedStore.getMetadata()).storeId;
    const scope = { expectedStoreId, subjectId: 'live-cross-client-owner', sessionId: 'root' };
    await ownedRuntime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'synthetic',
      rootUri: pathToFileURL(workspace).href,
    });
    await ownedRuntime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Live cross-client clarification',
    });
    const instanceId = crypto.randomUUID();
    const buildId = 'live-source-cross-client';
    const daemonProfile = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    const endpoint = selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      explicitSocket: join(root, 's.sock'),
    });
    reservation = await reserveDaemonEndpoint(endpoint, {
      profile: daemonProfile,
      instanceId,
      buildId,
      workspace,
    });
    service = await startService({
      runtime: ownedRuntime,
      profile: daemonProfile,
      subjectId: scope.subjectId,
      buildId,
      instanceId,
      permissionManagement: host.permissionManagement!(ownedRuntime),
      configurationManagement: host.configurationManagement!(ownedRuntime),
      beforeResourceClose: closeLocks,
    });
    await reservation.listen({
      httpEndpoint: service.endpoint,
      token: service.bootstrap.token,
      webOrigin: service.endpoint,
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile: daemonProfile, apiMajor: 1, requiredCapabilities: ['commands'] },
    });
    await client.connect();
    assert(client.serverInfo?.storeId === expectedStoreId, 'formal_admission_same_store');
    const idle = () =>
      until(async () => {
        const view = await ownedStore.getView('root');
        return view.runs.every((run) => !run.isActive) ? view : undefined;
      }, 'all_root_runs_terminal');
    const decision = (commandId: string) =>
      until(async () => {
        const command = await ownedStore.getCommand(commandId);
        const rawId = record(command?.receipt).humanInputCommandId;
        if (typeof rawId !== 'string') return undefined;
        const raw = await ownedStore.getCommand(rawId);
        const decidedId = record(raw?.receipt).decisionCommandId;
        if (typeof decidedId !== 'string') return undefined;
        const decided = await ownedStore.getCommand(decidedId);
        return decided?.receipt
          ? {
              command: command!,
              raw: raw!,
              decided,
              proposal: record(record(decided.request).proposal),
            }
          : undefined;
      }, 'exact_input_decision');
    const runCLI = async (task: string, stage: string, trust = false) => {
      failureStage = stage;
      cli = Bun.spawn({
        cmd: [
          process.execPath,
          '--no-install',
          join(repository, 'apps/cli/host/main.ts'),
          'run',
          '--data-root',
          profile.dataRoot,
          '--server',
          endpoint.socket,
          '--thread',
          'root',
          ...(trust ? ['--trust-workspace'] : []),
          '--task',
          task,
        ],
        cwd: workspace,
        env: { ...process.env, HOME: home },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const active = cli;
      if (
        !active.stdout ||
        typeof active.stdout === 'number' ||
        !active.stderr ||
        typeof active.stderr === 'number'
      )
        throw Error('cli_stdio_unavailable');
      const abort = () => active.kill('SIGTERM');
      options.signal.addEventListener('abort', abort, { once: true });
      try {
        const [exitCode, stdout, stderr] = await ptyDeadline(
          Promise.all([
            active.exited,
            new Response(active.stdout).text(),
            new Response(active.stderr).text(),
          ]),
          90_000,
          'cli_exit_deadline',
        );
        processResults.push({
          stage,
          exitCode,
          stdoutSha256: sha(stdout),
          stderrSha256: sha(stderr),
        });
        const match = /^terminal ([A-Za-z0-9._:-]+) (\w+)$/m.exec(stdout);
        if (!match) throw new Boundary('branch_not_hit', `${stage}_formal_terminal_missing`);
        cli = undefined;
        return { exitCode, commandId: match[1]!, outcome: match[2]!, stdout };
      } finally {
        options.signal.removeEventListener('abort', abort);
      }
    };
    const initial = await runCLI(
      'New task: Use read_file to read material.txt once, report the complete actual content verbatim, then finish normally. Do not edit any file or delegate.',
      'first_cli',
      true,
    );
    assert(
      initial.exitCode === 0 && initial.outcome === 'succeeded',
      'cli_first_business_succeeded',
    );
    const firstView = await idle();
    const originalA = firstView.runs.find((run) => run.rootWorkCommandId === initial.commandId);
    if (!originalA) throw new Boundary('branch_not_hit', 'original_A_business_missing');
    assert(
      (await ownedStore.listExecutions('root')).some(
        (e) =>
          e.runId === originalA.id && e.definitionId === 'files.read' && e.status === 'succeeded',
      ),
      'first_actual_default_file_read',
    );
    assert(
      firstView.messages.some(
        (message) => message.role === 'assistant' && message.content.includes(nonce),
      ),
      'first_model_report_has_complete_nonce',
    );
    const requestBeforeAmbiguous = options.requests().length;
    const ambiguousText = '先别做这个';
    const ambiguous = await runCLI(ambiguousText, 'ambiguous_cli');
    assert(
      ambiguous.exitCode === 3 &&
        ambiguous.outcome === 'needs_clarification' &&
        ambiguous.stdout.includes(`clarification ${ambiguous.commandId} `),
      'ordinary_cli_ambiguity_exit3',
    );
    const pending = await decision(ambiguous.commandId);
    await idle();
    assert(
      record(pending.raw.request).content === ambiguousText &&
        record(pending.command.request).content === ambiguousText,
      'original_public_and_raw_bytes_retained',
    );
    assert(
      pending.proposal.relation === 'unresolved' && pending.proposal.purpose === 'clarify',
      'original_input_unresolved',
    );
    assert(
      record(pending.command.receipt).runId === null &&
        record(pending.command.receipt).businessCommandId === null,
      'public_observation_business_run_is_null',
    );
    const interpretationRequests = options
      .requests()
      .slice(requestBeforeAmbiguous)
      .filter((request) =>
        request.messages.some((message) => message.content.includes('Original input identity:')),
      );
    if (interpretationRequests.length === 0)
      throw new Boundary('branch_not_hit', 'real_interpretation_model_not_reached');
    assert(
      interpretationRequests.every((request) => request.tools.length === 0),
      'readonly_processing_models_tools_empty',
    );
    assert(
      (await ownedStore.readHumanWorkState(scope)).pendingInputIds.includes(pending.raw.id),
      'exact_raw_pending_before_tui',
    );
    const processingCommandId = record(pending.raw.receipt).processingCommandId;
    if (typeof processingCommandId !== 'string')
      throw new Boundary('branch_not_hit', 'actual_processing_command_missing');
    const processingCommand = await ownedStore.getCommand(processingCommandId);
    assert(
      record(pending.decided.request).inputCommandId === pending.raw.id &&
        record(pending.decided.request).inputDigest === pending.raw.requestDigest &&
        record(processingCommand?.request).content === ambiguousText,
      'readonly_processing_exact_raw_digest',
    );
    const processingRuns = (await ownedStore.getView('root')).runs.filter(
      (run) => run.rootWorkCommandId === processingCommandId,
    );
    assert(
      processingRuns.length === 1 && processingRuns[0]?.status === 'completed',
      'readonly_processing_run_normally_completed',
    );
    assert(
      (await ownedStore.listExecutions('root'))
        .filter((execution) => execution.runId === processingRuns[0]!.id)
        .every((execution) => execution.kind === 'model'),
      'processing_has_no_ordinary_business_action',
    );
    assert(
      isDeepStrictEqual(await ownedStore.getRun(originalA.id), originalA),
      'ambiguous_cli_preserves_original_A_run',
    );
    const rawRequest = structuredClone(pending.raw.request);
    const originalDecision = structuredClone(pending.decided);
    const originalRun = structuredClone(await ownedStore.getRun(originalA.id));
    const beforeTuiModels = options.requests().length;
    const launcher = join(root, 'ordinary-tui.ts');
    writeFileSync(
      launcher,
      `import {runTUIProcess} from ${JSON.stringify(pathToFileURL(join(repository, 'apps/cli/host/tui-main.ts')).href)}; process.exitCode=await runTUIProcess({profile:'default',testDiagnostics:false});`,
      { mode: 0o600 },
    );
    terminal = spawnTuiPTY({
      cmd: [
        process.execPath,
        '--no-install',
        launcher,
        '--data-root',
        profile.dataRoot,
        '--server',
        endpoint.socket,
        '--thread',
        'root',
      ],
      cwd: workspace,
      env: { HOME: home, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    });
    await frame('ordinary_tui_composer', (text) => /^❯(?: |$)/m.test(text));
    await frame('ordinary_tui_original_ambiguous_history', (text) => text.includes(ambiguousText));
    assert(options.requests().length === beforeTuiModels, 'ordinary_tui_history_zero_model');
    // CLI and TUI share the private caller journal. A previously accepted CLI
    // input restores as unknown until the ordinary original-ID GET verifies it;
    // the unknown guard must remain fail-closed. Observe that explicit public
    // acknowledgement in the normal recovery panel before one new submission.
    const beforeCallerRead = {
      cursor: (await ownedStore.getMetadata()).lastChangeCursor,
      requests: options.requests().length,
    };
    const callerRow = (text: string, phase: 'unknown' | 'accepted' | 'applied', selected = false) =>
      text
        .split('\n')
        .some(
          (line) =>
            (!selected || line.trimStart().startsWith('›')) &&
            line.includes(`run.start · ${phase} · ${ambiguous.commandId}`),
        );
    const knownCaller = (text: string, selected = false) =>
      callerRow(text, 'accepted', selected) || callerRow(text, 'applied', selected);
    await send('/recovery', 'ordinary_tui_original_caller_status');
    const originalCallerPanel = await frame(
      'ordinary_tui_exact_prior_caller_visible',
      (text) => callerRow(text, 'unknown') || knownCaller(text),
    );
    if (
      !callerRow(originalCallerPanel, 'unknown', true) &&
      !knownCaller(originalCallerPanel, true)
    ) {
      // These are the two original CLI records in insertion order; select the
      // second only after observing its exact public ID in the ordinary panel.
      await terminal!.key('\x1b[B');
    }
    const selectedOriginalCaller = await frame(
      'ordinary_tui_exact_prior_caller_selected',
      (text) => callerRow(text, 'unknown', true) || knownCaller(text, true),
    );
    if (callerRow(selectedOriginalCaller, 'unknown', true)) {
      // In this ordinary panel Ctrl+L reads exactly the highlighted frozen ID;
      // it does not close/refresh the Session or race a new composer draft.
      await terminal!.key('\x0c');
      await frame('ordinary_tui_exact_original_caller_verified', (text) => knownCaller(text, true));
    } else checks.ordinary_tui_exact_original_caller_verified = true;
    await terminal!.key('\x1b');
    await frame(
      'ordinary_tui_composer_after_original_get',
      (text) => !text.includes('Explicit recovery') && /^❯(?: |$)/m.test(text),
    );
    assert(
      (await ownedStore.getMetadata()).lastChangeCursor === beforeCallerRead.cursor &&
        options.requests().length === beforeCallerRead.requests,
      'ordinary_original_caller_get_zero_model_and_canonical_write',
    );
    assert(
      isDeepStrictEqual(await ownedStore.getCommand(pending.decided.id), originalDecision) &&
        record((await ownedStore.getCommand(ambiguous.commandId))?.receipt).runId === null,
      'original_get_preserves_unresolved_decision_and_null_business',
    );
    const clarification = `我指的是 ${initial.commandId}。现在继续 ${initial.commandId}，用 read_file 重新读取 material.txt，逐字报告完整实际内容，然后正常结束。`;
    await send(clarification, 'ordinary_tui_clarification');
    const newRaw = await until(async () => {
      const state = await ownedStore.readHumanWorkState(scope);
      if (!state.latestInputCommandId || state.latestInputCommandId === pending.raw.id)
        return undefined;
      const raw = await ownedStore.getCommand(state.latestInputCommandId);
      return raw && record(raw.request).content === clarification ? raw : undefined;
    }, 'tui_new_raw_from_ordinary_composer');
    const publicId = record(newRaw.request).publicCommandId;
    if (typeof publicId !== 'string')
      throw new Boundary('branch_not_hit', 'clarification_public_link_missing');
    const clarified = await decision(publicId);
    assert(
      record(clarified.raw.request).clarifiesInputId === pending.raw.id,
      'exact_prior_raw_clarification_link',
    );
    assert(
      clarified.proposal.relation === 'same_work' &&
        clarified.proposal.purpose === 'continue' &&
        clarified.proposal.targetRootWorkCommandId === initial.commandId,
      'clarification_targets_original_A',
    );
    const finalView = await idle();
    const applied = await ownedStore.getCommand(publicId);
    const secondRunId = record(applied?.receipt).runId;
    if (typeof secondRunId !== 'string')
      throw new Boundary('branch_not_hit', 'clarification_business_not_reached');
    const secondRun = await ownedStore.getRun(secondRunId);
    assert(
      secondRun?.status === 'completed' &&
        secondRun.id !== originalA.id &&
        secondRun.rootWorkCommandId === initial.commandId,
      'new_business_run_exact_original_A',
    );
    assert(
      isDeepStrictEqual(secondRun?.configuration, originalA.configuration),
      'original_A_configuration_preserved',
    );
    assert(
      isDeepStrictEqual(await ownedStore.getRun(originalA.id), originalRun) &&
        isDeepStrictEqual(await ownedStore.getCommand(originalDecision.id), originalDecision) &&
        isDeepStrictEqual((await ownedStore.getCommand(pending.raw.id))?.request, rawRequest),
      'original_run_raw_request_decision_unchanged',
    );
    assert(
      !(await ownedStore.readHumanWorkState(scope)).pendingInputIds.includes(pending.raw.id),
      'prior_raw_no_longer_pending',
    );
    assert(
      (await ownedStore.listExecutions('root')).some(
        (e) =>
          e.runId === secondRunId && e.definitionId === 'files.read' && e.status === 'succeeded',
      ),
      'clarified_actual_default_file_reread',
    );
    assert(
      finalView.messages.some(
        (message) =>
          message.runId === secondRunId &&
          message.role === 'assistant' &&
          message.content.includes(nonce),
      ),
      'clarified_model_complete_actual_nonce',
    );
    assert(
      finalView.runs
        .filter(
          (run) => record(record(run.configuration).snapshot).kind !== 'human_input_processing',
        )
        .every((run) => run.rootWorkCommandId === initial.commandId),
      'no_independent_B_work',
    );
    await frame('ordinary_tui_final_nonce_visible', (text) =>
      text.replace(/\s+/g, '').includes(nonce),
    );
    await send('/exit', 'ordinary_tui_exit');
    const tuiExit = await ptyDeadline(terminal.host.exited, 15_000, 'ordinary_tui_exit_deadline');
    await ptyDeadline(terminal.eof, 5_000, 'ordinary_tui_eof_deadline');
    assert(tuiExit === 0, 'ordinary_tui_normal_exit');
    terminal.close();
    terminal = undefined;
    // Compile the production browser entry in memory; no synthetic DOM or controller substitutes.
    failureStage = 'actual_web_build';
    const built = await Bun.build({
      entrypoints: [join(repository, 'apps/web/src/browser.tsx')],
      target: 'browser',
      format: 'esm',
      splitting: false,
      minify: true,
    });
    const output = built.outputs.find((item) => item.kind === 'entry-point');
    if (!built.success || built.outputs.length !== 1 || !output)
      throw new Boundary('branch_not_hit', 'actual_web_bundle_unavailable');
    const assets = await createTrustedAssets(await output.text());
    web = startDevelopmentWeb({ admittedClient: client, assets: assets.assets });
    const require = createRequire(join(repository, 'apps/desktop/package.json'));
    const { chromium } = require('playwright') as BrowserAPI;
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (!existsSync(chrome)) throw new Boundary('branch_not_hit', 'ordinary_chrome_unavailable');
    browser = await chromium.launch({ executablePath: chrome, headless: false, args: [] });
    page = await browser.newPage();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === web!.endpoint)
        browserReads.push({
          method: request.method(),
          route: url.pathname.replace(/\/sessions\/[^/]+/g, '/sessions/<owned>'),
          authorizationPresent: 'authorization' in request.headers(),
        });
    });
    const footprint = async () => ({
      metadata: await ownedStore.getMetadata(),
      view: await ownedStore.getView('root'),
      work: await ownedStore.readHumanWorkState(scope),
      requests: options.requests().length,
    });
    const beforeWeb = await footprint();
    await page.goto(`${web.endpoint}/sessions/root`);
    const readPage = async (stage: string) => {
      const text = await until(
        async () => {
          const text = await page!.locator('main').innerText();
          return text.includes(nonce) && text.includes(ambiguousText) ? text : undefined;
        },
        stage,
        30_000,
      );
      observations.push({ stage, sha256: sha(text) });
    };
    await readPage('ordinary_real_web_same_history_and_result');
    const cookies = await page.context().cookies();
    assert(
      cookies.some(
        (cookie) =>
          cookie.name.startsWith('kite_web_') && cookie.httpOnly && cookie.sameSite === 'Strict',
      ),
      'actual_browser_http_only_strict_cookie',
    );
    assert(
      (await page.locator('textarea,input:not([type=hidden]),[contenteditable=true]').count()) ===
        0,
      'web_no_business_composer',
    );
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/browser/v1/sessions/root/messages' &&
        response.status() === 200,
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await refreshed;
    await readPage('ordinary_real_web_history_refresh');
    await page.reload();
    await readPage('ordinary_real_web_cold_document_history');
    assert(
      browserReads.some((read) => read.route.startsWith('/browser/v1/')) &&
        browserReads.every(
          (read) =>
            !read.authorizationPresent &&
            (read.method === 'GET' ||
              (read.method === 'POST' && read.route === '/browser/session')),
        ),
      'real_browser_finite_read_cookie_routes_no_native_bearer',
    );
    assert(
      isDeepStrictEqual(await footprint(), beforeWeb),
      'web_reads_zero_canonical_or_provider_delta',
    );
    status = 'passed';
    failureStage = '';
  } catch (error) {
    status =
      error instanceof Boundary && error.category === 'branch_not_hit' ? 'inconclusive' : 'failed';
    failureCategory =
      error instanceof Boundary ? error.category : options.signal.aborted ? 'aborted' : 'execution';
    if (error instanceof Boundary) failureStage = error.stage;
  } finally {
    let cleanupFailed = false;
    const close = async (fn: () => unknown | Promise<unknown>) => {
      try {
        await fn();
      } catch {
        cleanupFailed = true;
      }
    };
    if (cli)
      await close(async () => {
        if (cli!.exitCode === null) cli!.kill('SIGTERM');
        await ptyDeadline(cli!.exited, 10_000, 'cli_cleanup_timeout');
      });
    if (terminal)
      await close(async () => {
        if (!terminal!.ended) await terminateTuiTree(terminal!, { exitTimeoutMs: 10_000 });
        terminal!.close();
      });
    await close(() => page?.close());
    await close(() => browser?.close());
    await close(() => web?.close());
    await close(() => client?.disposeNetwork());
    if (service) await close(() => service!.close());
    else if (runtime) await close(() => runtime!.close());
    else await close(() => store?.close());
    await close(closeLocks);
    await close(() => reservation?.close());
    checks.resourcesClosed = !cleanupFailed;
    if (cleanupFailed) {
      status = 'failed';
      failureCategory = 'cleanup';
    }
  }
  return {
    status,
    caseId: 'U04-CLI-TUI-clarification-Web-readonly',
    checks,
    observations,
    processResults,
    browserReads,
    providerRequests: options.requests().length - requestStart,
    failureStage,
    failureCategory,
    canonicalEvidenceRetained: true,
    semanticReview:
      'Inspect original processing Model output and decision interpretation; unresolved fallback is not valid-model-reasoning qualification',
    coverage: [
      'ordinary CLI actual exit3 with null business Run',
      'same exact unresolved raw clarified through ordinary PTY composer',
      'actual production Web assets in real Chrome with Cookie readonly routes',
      'Native sequential cold transfer not tested',
      'no complete U04 or contracts47-48-50 qualification',
    ],
  };
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_CROSS_CLIENT !== '1')
    throw Error('live_cross_client_opt_in_required');
  const args = process.argv.slice(2);
  const output = args[0]?.startsWith('--output=') ? args[0].slice(9) : undefined;
  if (
    args.length !== 1 ||
    !output ||
    !isAbsolute(output) ||
    existsSync(output) ||
    existsSync(`${output}.workspace`)
  )
    throw Error('live_cross_client_arguments_invalid');
  const report: Record<string, unknown> = {
    version: 1,
    date: new Date().toISOString(),
    platform: process.platform,
    bunVersion: Bun.version,
    code: liveCodeEvidence(),
    requestLimit: 40,
    timeoutMs: 600_000,
    status: 'inconclusive',
  };
  const started = performance.now();
  let fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  try {
    fixture = await createLiveModelFixture({ requestLimit: 40, timeoutMs: 600_000 });
    Object.assign(
      report,
      fixture.metadata,
      await runLiveCrossClient({
        model: fixture.model,
        modelId: fixture.modelId,
        signal: fixture.signal,
        requests: () => fixture!.requests,
        evidenceRoot: `${output}.workspace`,
      }),
    );
  } catch {
    report.status = 'failed';
    report.failureCategory = 'execution';
  } finally {
    report.monotonicDurationMs = performance.now() - started;
    report.finishedAt = new Date().toISOString();
    if (fixture) {
      report.providerRequests = fixture.wire.length;
      report.modelRequests = fixture.requests.length;
      report.httpStatuses = fixture.wire.map((entry) => entry.status);
      report.toolCalls = summarizeLiveToolCalls(fixture.requests, fixture.calls);
      report.usage = fixture.usage;
    }
    writeFileSync(output!, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
  }
}
