import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { ptyDeadline, spawnTuiPTY, type TuiPTY } from '../../../../apps/cli/test/fixtures/tui-pty';
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import {
  reserveDaemonEndpoint,
  selectDaemonEndpoint,
} from '../../../../apps/service/src/daemon/endpoint';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

interface WindowOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
  evidenceRoot: string;
}
class WindowBoundary extends Error {
  readonly kind: 'branch_not_reached' | 'oracle_violation';
  readonly stage: string;
  constructor(kind: 'branch_not_reached' | 'oracle_violation', stage: string) {
    super('live_collaboration_tui_boundary');
    this.kind = kind;
    this.stage = stage;
  }
}
/** Ordinary source TUI, real PTY, formal native bootstrap and default persisted policy. */
export async function runLiveTuiWindow(options: WindowOptions) {
  if (!isAbsolute(options.evidenceRoot)) throw Error('live_collaboration_evidence_root_invalid');
  mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(options.evidenceRoot);
  const workspace = join(root, 'workspace');
  const checks: Record<string, boolean | number> = {};
  const screens: { stage: string; sha256: string }[] = [];
  const keys: string[] = [];
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let reservation: Awaited<ReturnType<typeof reserveDaemonEndpoint>> | undefined;
  let terminal: TuiPTY | undefined;
  let locksClose: Promise<void> | undefined;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
  let reason = 'execution_unavailable';
  let failureStage = 'setup';
  let canonicalEvidenceRetained = false;
  let u01Completed = false;
  let u03Completed = false;
  const requestStart = options.requests().length;
  const closeLocks = () => (locksClose ??= Promise.resolve().then(() => locks?.close()));
  const require = (condition: unknown, stage: string) => {
    if (!condition) throw new WindowBoundary('oracle_violation', stage);
    checks[stage] = true;
  };
  const until = async <T>(read: () => Promise<T | undefined>, stage: string, ms = 60_000) => {
    failureStage = stage;
    const deadline = Date.now() + ms;
    for (;;) {
      options.signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) {
        checks[stage] = true;
        return value;
      }
      if (terminal?.ended) throw new WindowBoundary('branch_not_reached', `${stage}_host_exited`);
      if (Date.now() >= deadline) throw new WindowBoundary('branch_not_reached', stage);
      await Bun.sleep(30);
    }
  };
  const screen = async (stage: string, match: (text: string) => boolean, ms = 30_000) => {
    const text = await until(
      async () => {
        await terminal!.drain();
        const current = terminal!.viewport();
        return match(current) ? current : undefined;
      },
      stage,
      ms,
    );
    screens.push({ stage, sha256: createHash('sha256').update(text).digest('hex') });
    checks[stage] = true;
    return text;
  };
  const key = async (value: string, kind: string) => {
    options.signal.throwIfAborted();
    keys.push(kind);
    await terminal!.key(value);
    await Bun.sleep(150);
  };
  const send = async (text: string, stage: string) => {
    await key(text, stage === 'business_input' ? 'synthetic_business_text' : 'slash_command');
    const suffix = text.slice(-32).replace(/\s+/g, '');
    await screen(`${stage}_composed`, (frame) => frame.replace(/\s+/g, '').includes(suffix));
    await key('\r', 'enter');
  };
  const normalExit = async () => {
    await key('\x02', 'ctrl_b');
    await screen('exit_card_chooser', (text) => text.includes('Pending cards'));
    await key('\x1b', 'escape');
    await screen('exit_parent_composer', (text) => /^❯(?: |$)/m.test(text));
    await send('/exit', 'exit');
    const code = await ptyDeadline(terminal!.host.exited, 15_000, 'normal_exit_timeout');
    await ptyDeadline(terminal!.eof, 5_000, 'normal_exit_eof_timeout');
    require(code === 0, 'normal_tui_exit');
    terminal!.close();
    terminal = undefined;
  };
  try {
    mkdirSync(workspace, { mode: 0o700 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const targets = [join(root, 'external-A.txt'), join(root, 'external-B.txt')];
    const bodies = targets.map(() => `owned-${crypto.randomUUID()}`);
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
        tools: [
          'task.spawn',
          'task.events',
          'task.list',
          'task.message',
          'task.follow_up',
          'task.interrupt',
          'files.write_path',
        ].map((id) => ({ id })),
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
    const inject = (binding: RunConfiguration): RunConfiguration => ({
      ...binding,
      model,
      permissions: {
        ...binding.permissions!,
        async authorize(request) {
          if (request.kind === 'tool' && request.definitionId === 'files.write_path') {
            const input = request.input;
            if (
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              !targets.includes(String(input.path))
            )
              return {
                allowed: false,
                revision: 'owned-tui-target-only-1',
                reason: 'live_target_out_of_scope',
              };
          }
          return binding.permissions!.authorize(request);
        },
      },
    });
    runtime = createRuntime({
      ...host,
      store: ownedStore,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store: ownedStore }),
      workspaceSerialLocks: locks,
      modelConcurrency: 4,
      resolveRunConfiguration: async (input) => inject(await host.resolveRunConfiguration!(input)),
      resolveChildRunConfiguration: async (input) =>
        inject(await host.resolveChildRunConfiguration!(input)),
      resolveRecoveryRunConfiguration: async (input) =>
        inject(await host.resolveRecoveryRunConfiguration!(input)),
    });
    const ownedRuntime = runtime;
    const controls = host.permissionManagement!(ownedRuntime);
    const expectedStoreId = (await ownedStore.getMetadata()).storeId;
    const identity = { expectedStoreId, subjectId: 'live-tui-owner' };
    await ownedRuntime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'synthetic',
      rootUri: pathToFileURL(workspace).href,
    });
    await ownedRuntime.createSession({
      ...identity,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      title: 'Live TUI approval session',
    });
    const instanceId = crypto.randomUUID();
    const buildId = 'live-source-tui-window';
    const daemonProfile = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    const endpoint = selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      explicitSocket: join(root, 's.sock'),
    });
    failureStage = 'native_endpoint_reservation';
    reservation = await reserveDaemonEndpoint(endpoint, {
      profile: daemonProfile,
      instanceId,
      buildId,
      workspace,
    });
    failureStage = 'formal_service_start';
    service = await startService({
      runtime: ownedRuntime,
      profile: daemonProfile,
      subjectId: identity.subjectId,
      buildId,
      instanceId,
      permissionManagement: controls,
      configurationManagement: host.configurationManagement!(ownedRuntime),
      beforeResourceClose: closeLocks,
    });
    failureStage = 'native_endpoint_listen';
    await reservation.listen({
      httpEndpoint: service.endpoint,
      token: service.bootstrap.token,
      webOrigin: service.endpoint,
    });
    const runner = join(root, 'tui-runner.ts');
    const hostPath = pathToFileURL(
      new URL('../../../../apps/cli/host/tui.tsx', import.meta.url).pathname,
    ).href;
    writeFileSync(
      runner,
      `import {runTUIHost} from ${JSON.stringify(hostPath)};try{process.exitCode=await runTUIHost(${JSON.stringify({ server: endpoint.socket, dataRoot: profile.dataRoot, profile: profile.profile, thread: 'root', cwd: workspace })})}catch{console.error('live_tui_host_failed');process.exitCode=1}`,
      { mode: 0o600 },
    );
    const launch = () =>
      spawnTuiPTY({
        cmd: [process.execPath, '--no-install', runner],
        cwd: workspace,
        env: {
          HOME: root,
          KITE_CODE_HOME: join(root, 'owned-home'),
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
        },
      });
    failureStage = 'ordinary_pty_launch';
    terminal = launch();
    await screen('ordinary_workspace_trust_prompt', (text) =>
      text.includes('Trust this workspace and continue'),
    );
    await key('\x1b[B', 'down');
    await key('\r', 'enter');
    await screen('ordinary_parent_composer', (text) => /^❯(?: |$)/m.test(text));
    require((await controls.readTrust({ ...identity, workspaceId: 'w' }))
      .trusted, 'trust_saved_through_tui');
    await send('/permissions', 'permissions');
    await screen(
      'ordinary_permissions_panel',
      (text) => text.includes('请求批准') && text.includes('自动审核'),
    );
    const current = await controls.readMode({ ...identity, sessionId: 'root' });
    if (current.mode === 'auto') await key('\x1b[A', 'up');
    if (current.mode === 'full') {
      await key('\x1b[A', 'up');
      await key('\x1b[A', 'up');
    }
    await key('\r', 'enter');
    await screen(
      'ordinary_mode_confirmation',
      (text) => text.includes('Confirm original') && text.includes('请求批准'),
    );
    await key('\r', 'enter');
    await until(
      async () =>
        (await controls.readMode({ ...identity, sessionId: 'root' })).mode === 'accept_edits'
          ? true
          : undefined,
      'mode_saved_through_tui',
    );
    await key('\x1b', 'escape');
    await screen('ordinary_ready_for_business', (text) => /^❯(?: |$)/m.test(text));
    const leaf = (index: number) =>
      `Use write_user_file exactly once with path ${JSON.stringify(targets[index])}, content ${JSON.stringify(bodies[index])}, base null. Respect a denied Tool and stop without retry or replacement. Report its actual outcome.`;
    const content = `New task: Create exactly two worker collaborators using spawn_agent with only prompt and no preset before waiting. Do not select any preset. A: ${leaf(0)} B: ${leaf(1)} Do not write files yourself. Keep your Run waiting with wait_agent_events until BOTH children actually finish; use returned event sequence for subsequent waits. Operator will decide each approval. Do not retry denied work. Synthetic test ${crypto.randomUUID()}`;
    await send(content, 'business_input');
    const allSessions = async () => {
      const rootSession = (await ownedStore.getSession('root'))!;
      const sessions = [rootSession];
      const seen = new Set(['root']);
      for (let i = 0; i < sessions.length; i++)
        for (const carrier of await ownedStore.listExecutions(sessions[i]!.id)) {
          if (!carrier.childSessionId) continue;
          const child = await ownedStore.getSession(carrier.childSessionId);
          require(child &&
            child.parentSessionId === sessions[i]!.id &&
            child.rootSessionId === 'root' &&
            child.workspaceId === 'w' &&
            carrier.originStoreId === expectedStoreId, 'exact_child_scope');
          if (!seen.has(child!.id)) {
            if (sessions.length >= 16)
              throw new WindowBoundary('branch_not_reached', 'too_many_children');
            seen.add(child!.id);
            sessions.push(child!);
          }
        }
      return sessions;
    };
    const pending = async () =>
      (
        await Promise.all(
          (
            await allSessions()
          ).map((session) =>
            ownedRuntime.listInteractions({ expectedStoreId, sessionId: session.id }),
          ),
        )
      )
        .flatMap((page) => page.interactions)
        .filter(
          (card, index, values) =>
            card.kind === 'approval' &&
            card.state === 'pending' &&
            values.findIndex((other) => other.id === card.id) === index,
        );
    const cards = await until(async () => {
      const found = await pending();
      return found.length === 2 && found[0]!.sessionId !== found[1]!.sessionId ? found : undefined;
    }, 'two_real_children_pending');
    await until(
      async () =>
        (await ownedStore.listExecutions('root')).some(
          (execution) =>
            execution.kind === 'tool' &&
            execution.definitionId === 'task.events' &&
            ['dispatching', 'running'].includes(execution.status) &&
            execution.authorization?.dispatched === true &&
            execution.result === null,
        )
          ? true
          : undefined,
      'parent_real_event_wait_active',
    );
    require((await allSessions()).length === 3, 'exactly_two_real_children');
    const parentBefore = await ownedStore.getView('root');
    require(parentBefore.runs.some((run) => run.isActive), 'parent_still_waiting_for_children');
    require(targets.every((target) => !existsSync(target)), 'zero_effects_before_ui_approval');
    await key('\x02', 'ctrl_b');
    await screen(
      'ordinary_two_card_chooser',
      (text) => text.includes('Pending cards') && text.includes('2'),
    );
    await key('\r', 'enter');
    const approvalScreen = await screen(
      'ordinary_exact_approval_panel',
      (text) => text.includes('files.write_path') && text.includes('Allow once'),
    );
    const panel = approvalScreen
      .slice(approvalScreen.lastIndexOf('files.write_path'))
      .replace(/\s+/g, '');
    const chosenIndex = targets.findIndex(
      (target) =>
        panel.includes(target.replace(/\s+/g, '')) || panel.includes(target.split('/').at(-1)!),
    );
    require(chosenIndex >= 0, 'visible_original_target');
    const chosen = cards.find((card) => {
      const input =
        card.request && typeof card.request === 'object' && !Array.isArray(card.request)
          ? card.request.input
          : null;
      return (
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        input.path === targets[chosenIndex]
      );
    });
    require(chosen, 'visible_card_matches_durable_exact_target');
    const other = cards.find((card) => card.id !== chosen!.id)!;
    await key('\r', 'enter_allow_once');
    await until(
      async () =>
        (await ownedStore.getExecution(chosen!.executionId))?.status === 'succeeded'
          ? true
          : undefined,
      'chosen_execution_succeeded',
    );
    require(existsSync(targets[chosenIndex]!) &&
      readFileSync(targets[chosenIndex]!, 'utf8') ===
        bodies[chosenIndex], 'chosen_exact_file_effect');
    const approved = await ownedRuntime.getInteraction({
      expectedStoreId,
      sessionId: chosen!.presentationSessionId,
      interactionId: chosen!.id,
    });
    require(approved?.state === 'answered' &&
      approved.answer?.kind === 'approval' &&
      approved.answer.decision === 'approve' &&
      approved.answer.grant === 'approve_once' &&
      approved.acceptedDecisionRevision !== null &&
      approved.acceptedDecisionRevision !== chosen!.revision, 'exact_chosen_card_once_saved');
    const untouched = await ownedRuntime.getInteraction({
      expectedStoreId,
      sessionId: other.presentationSessionId,
      interactionId: other.id,
    });
    require(untouched?.state === 'pending' &&
      (await ownedStore.getExecution(other.executionId))?.authorization?.dispatched !== true &&
      !existsSync(targets[1 - chosenIndex]!), 'unselected_child_still_pending_zero_effect');
    await key('\x02', 'ctrl_b');
    await screen('ordinary_remaining_card_chooser', (text) => text.includes('Pending cards'));
    await key('\r', 'enter');
    await screen(
      'ordinary_second_approval_panel',
      (text) =>
        text.includes('files.write_path') &&
        text.includes(targets[1 - chosenIndex]!.split('/').at(-1)!),
    );
    await key('\x1b', 'escape_deny');
    await until(async () => {
      const card = await ownedRuntime.getInteraction({
        expectedStoreId,
        sessionId: other.presentationSessionId,
        interactionId: other.id,
      });
      if (
        card?.state === 'cancelled' &&
        !(card.answer?.kind === 'approval' && card.answer.decision === 'deny')
      )
        throw new WindowBoundary('oracle_violation', 'exact_other_card_cancelled_without_refusal');
      return card &&
        ['answered', 'cancelled'].includes(card.state) &&
        card.revision !== other.revision &&
        card.answer?.kind === 'approval' &&
        card.answer.decision === 'deny'
        ? true
        : undefined;
    }, 'exact_other_card_denied');
    await until(async () => {
      const sessions = await allSessions();
      const views = await Promise.all(sessions.map((session) => ownedStore.getView(session.id)));
      return views.every((view) => view.runs.every((run) => !run.isActive)) ? true : undefined;
    }, 'all_runs_settled');
    const finalViews = await Promise.all(
      (await allSessions()).map((session) => ownedStore.getView(session.id)),
    );
    require(finalViews.every((view) =>
      view.runs.every(
        (run) => run.status === (view.session.id === other.sessionId ? 'cancelled' : 'completed'),
      ),
    ), 'parent_and_approved_completed_only_declined_child_cancelled');
    const deniedExecution = await ownedStore.getExecution(other.executionId);
    const refusal = await ownedStore.getCommand(`decline-${other.id}`);
    const refusedRequest = refusal?.request;
    require(refusal?.sessionId === other.sessionId &&
      refusal.originStoreId === expectedStoreId &&
      refusal.kind === 'command.cancel' &&
      refusedRequest &&
      typeof refusedRequest === 'object' &&
      !Array.isArray(refusedRequest) &&
      refusedRequest.targetCommandId ===
        deniedExecution?.originCommandId, 'refusal_cancels_only_original_child_command');
    const deniedResult = deniedExecution?.result;
    require(deniedExecution?.status === 'failed' &&
      deniedResult &&
      typeof deniedResult === 'object' &&
      !Array.isArray(deniedResult) &&
      deniedResult.content === 'approval_denied' &&
      deniedExecution.authorization?.dispatched !== true, 'original_denied_tool_never_dispatched');
    require(!existsSync(targets[1 - chosenIndex]!), 'denied_effect_absent');
    const actual = (
      await Promise.all(
        (await allSessions()).map((session) => ownedStore.listExecutions(session.id)),
      )
    ).flat();
    require(actual.filter(
      (execution) =>
        execution.kind === 'tool' &&
        execution.definitionId === 'files.write_path' &&
        execution.authorization?.dispatched,
    ).length === 1, 'one_exact_file_dispatch');
    const original = (await ownedStore.getChanges({ after: '0', limit: 200 })).events;
    require(original.length > 0, 'durable_ui_events');
    checks.providerModelsObserved = options.requests().length - requestStart;
    await normalExit();
    u01Completed = true;
    const beforeCold = {
      cursor: (await ownedStore.getMetadata()).lastChangeCursor,
      requests: options.requests().length,
      executions: actual.length,
    };
    failureStage = 'ordinary_pty_launch';
    terminal = launch();
    await screen('cold_ordinary_tui_composer', (text) => /^❯(?: |$)/m.test(text));
    const savedTail = content.slice(-32).replace(/\s+/g, '');
    await until(async () => {
      const frame = await terminal!.projection();
      return frame.text.replace(/\s+/g, '').includes(savedTail) ? true : undefined;
    }, 'cold_original_saved_input_rendered');
    await key('\x0c', 'ctrl_l_refresh');
    await screen('cold_tui_history_visible', (text) => /^❯(?: |$)/m.test(text));
    require(options.requests().length === beforeCold.requests &&
      (await ownedStore.getMetadata()).lastChangeCursor ===
        beforeCold.cursor, 'cold_client_zero_model_and_store_mutation');
    require(existsSync(targets[chosenIndex]!) &&
      readFileSync(targets[chosenIndex]!, 'utf8') === bodies[chosenIndex] &&
      !existsSync(targets[1 - chosenIndex]!), 'cold_client_preserves_exact_effects');
    await normalExit();
    u03Completed = true;
    status = 'passed';
    reason = '';
  } catch (error) {
    if (terminal) {
      await terminal.drain();
      const viewport = terminal.viewport();
      screens.push({
        stage: 'failure_viewport',
        sha256: createHash('sha256').update(viewport).digest('hex'),
      });
    }
    if (error instanceof Error && /^(daemon|service|profile)_[a-z_]+$/.test(error.message))
      reason = error.message;
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && ['EPERM', 'EACCES', 'EADDRINUSE', 'ENOENT'].includes(code))
      reason = `host_${code}`;
    if (error instanceof WindowBoundary) {
      status = error.kind === 'oracle_violation' ? 'failed' : 'inconclusive';
      reason = error.kind;
      failureStage = error.stage;
    }
  } finally {
    let cleanupFailed = false;
    if (terminal) {
      try {
        terminal.host.kill('SIGTERM');
        try {
          await ptyDeadline(terminal.host.exited, 5_000, 'cleanup_term_timeout');
        } catch {
          terminal.host.kill('SIGKILL');
          await ptyDeadline(terminal.host.exited, 5_000, 'cleanup_kill_timeout');
        }
        await ptyDeadline(terminal.eof, 5_000, 'cleanup_eof_timeout');
      } catch {
        cleanupFailed = true;
      } finally {
        terminal.close();
      }
    }
    try {
      if (service) await service.close();
      else if (runtime) await runtime.close();
      else await store?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      await closeLocks();
    } catch {
      cleanupFailed = true;
    }
    try {
      await reservation?.close();
    } catch {
      cleanupFailed = true;
    }
    checks.resourcesClosed = !cleanupFailed;
    if (cleanupFailed) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    canonicalEvidenceRetained = status !== 'passed';
    if (!canonicalEvidenceRetained) rmSync(root, { recursive: true, force: true });
  }
  return {
    status,
    checks,
    screens,
    keyClasses: keys,
    canonicalEvidenceRetained,
    ...(reason ? { reason, failureStage } : {}),
    cases: [
      {
        id: 'U01',
        status: checks.resourcesClosed === false ? 'failed' : u01Completed ? 'passed' : status,
      },
      {
        id: 'U03',
        status:
          checks.resourcesClosed === false ? 'failed' : u03Completed ? 'passed' : 'inconclusive',
      },
    ],
    intendedCoverage: [
      'U01_real_source_pty_default_policy',
      'U03_same_store_cold_tui_client',
      'normal_composer_and_approval_keys',
      'seeded_named_session_no_title_qualification',
      'no_installed_or_other_platform_qualification',
    ],
  };
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_TUI_WINDOW !== '1')
    throw Error('live_collaboration_tui_opt_in_required');
  const args = process.argv.slice(2);
  const output = args[0]?.startsWith('--output=') ? args[0].slice(9) : undefined;
  if (args.length !== 1 || !output || !isAbsolute(output) || existsSync(output))
    throw Error('live_collaboration_arguments_invalid');
  const started = performance.now();
  const report: Record<string, unknown> = {
    version: 1,
    date: new Date().toISOString(),
    platform: process.platform,
    bunVersion: Bun.version,
    requestLimit: 40,
    timeoutMs: 600_000,
    code: liveCodeEvidence(),
    status: 'inconclusive',
  };
  let fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  try {
    fixture = await createLiveModelFixture({ requestLimit: 40, timeoutMs: 600_000 });
    Object.assign(report, fixture.metadata);
    const result = await runLiveTuiWindow({
      model: fixture.model,
      modelId: fixture.modelId,
      signal: fixture.signal,
      requests: () => fixture!.requests,
      evidenceRoot: `${output}.workspace`,
    });
    Object.assign(report, result);
  } catch {
    report.status = 'failed';
    report.reason = 'live_collaboration_tui_unexpected_failure';
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
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
  }
}
