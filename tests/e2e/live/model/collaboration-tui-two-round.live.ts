import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { mcpCanonical } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord, RunRecord } from '@kite-ai/agent/storage';
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

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function approvalPanelHasExactTarget(text: string, target: string) {
  const start = text.lastIndexOf('files.write_path');
  if (start < 0) return false;
  const panel = text.slice(start);
  return (
    panel.includes('Allow once') && panel.replace(/\s+/g, '').includes(target.replace(/\s+/g, ''))
  );
}

function mcpSnapshot(manifest: unknown): Record<string, unknown> {
  const snapshot = object(object(manifest).snapshot);
  const configuration = Object.hasOwn(snapshot, 'roleId')
    ? object(snapshot.configuration)
    : snapshot;
  return object(object(configuration.mcp).sources);
}
const mcpHash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
function stableChildConfiguration(configuration: unknown) {
  const stable = structuredClone(configuration);
  const proof = object(mcpSnapshot(object(stable).snapshot).inheritance);
  // Only invocation identity changes; all role, tool, policy and source fields remain comparable.
  delete proof.parentExecutionId;
  delete proof.parentExecutionDigest;
  delete proof.parentRunId;
  return stable;
}
function exactChildMcpBinding(
  carrier: ExecutionRecord,
  run: RunRecord,
  parent: ExecutionRecord | null,
  parentRun: RunRecord | null,
  definitionId: 'task.spawn' | 'task.follow_up',
) {
  const sources = mcpSnapshot(carrier.childConfiguration?.snapshot);
  const proof = object(sources.inheritance);
  return Boolean(
    carrier.childConfiguration &&
      parent &&
      parentRun &&
      proof.version === 1 &&
      parent.kind === 'tool' &&
      parent.definitionId === definitionId &&
      proof.parentExecutionId === parent.id &&
      carrier.parentExecutionId === parent.id &&
      proof.parentExecutionDigest === mcpHash(parent.input) &&
      proof.parentRunId === parentRun.id &&
      parent.runId === parentRun.id &&
      proof.parentSessionId === 'root' &&
      parent.sessionId === 'root' &&
      carrier.sessionId === 'root' &&
      parentRun.sessionId === 'root' &&
      proof.rootSessionId === 'root' &&
      parent.originStoreId === carrier.originStoreId &&
      parentRun.originStoreId === carrier.originStoreId &&
      run.originStoreId === carrier.originStoreId &&
      run.sessionId === carrier.childSessionId &&
      run.originCommandId === `child-start-${carrier.id}` &&
      [run, parent, parentRun].every(
        (fact) =>
          fact.rootWorkCommandId === carrier.rootWorkCommandId &&
          fact.rootWorkSeq === carrier.rootWorkSeq,
      ) &&
      proof.rootWorkCommandId === carrier.rootWorkCommandId &&
      proof.rootWorkSeq === carrier.rootWorkSeq &&
      proof.parentSnapshotDigest === mcpHash(proof.parentSnapshot) &&
      mcpHash(proof.parentSnapshot) === mcpHash(mcpSnapshot(parentRun.configuration)) &&
      mcpHash(carrier.childConfiguration.snapshot) === mcpHash(run.configuration) &&
      Array.isArray(sources.servers) &&
      sources.servers.length === 0 &&
      Array.isArray(object(sources.selection).serverIds) &&
      (object(sources.selection).serverIds as unknown[]).length === 0 &&
      sources.readSet === null,
  );
}

export type LiveTuiTwoRoundCaseId = 'U02-TUI-two-round-history-controls-subset';

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
export async function runLiveTuiTwoRoundWindow(options: WindowOptions) {
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
  let u02Completed = false;
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
    await key(text, stage.includes('business_input') ? 'synthetic_business_text' : 'slash_command');
    const suffix = text.slice(-32).replace(/\s+/g, '');
    await screen(`${stage}_composed`, (frame) => frame.replace(/\s+/g, '').includes(suffix));
    await key('\r', 'enter');
  };
  // Ctrl+B captures the UI's current pending-card directory. Canonical Store
  // readiness can precede that read; an empty captured chooser intentionally
  // ignores Enter. Reopen only the navigation overlay until its exact directory
  // and one highlighted ordinary Approval row are actually visible.
  const openExactApprovalChooser = async (count: number, stage: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      await key('\x02', 'ctrl_b');
      const text = await screen(
        `${stage}_directory`,
        (text) => /Pending cards\s*·\s*\d+/.test(text),
        Math.max(1, deadline - Date.now()),
      );
      const actual = /Pending cards\s*·\s*(\d+)/.exec(text);
      const focused = (text.match(/›\s*Approval\s*·/g) ?? []).length;
      if (Number(actual?.[1]) === count && focused === 1) {
        checks[stage] = true;
        return;
      }
      if (Date.now() >= deadline) throw new WindowBoundary('branch_not_reached', stage);
      await key('\x1b', 'escape_stale_card_directory');
      await screen(
        `${stage}_closed_before_refresh`,
        (text) => !text.includes('Pending cards'),
        Math.max(1, deadline - Date.now()),
      );
      // This is the ordinary original-intent lookup/Session read, never an
      // approval, submit, retry of the business invocation or extra Provider.
      await key('\x0c', 'ctrl_l_refresh_card_directory');
    }
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
    const targets = [
      join(root, 'external-A.txt'),
      join(root, 'external-B.txt'),
      join(root, 'external-C-second-round.txt'),
    ];
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
    await ownedRuntime.createSession({
      ...identity,
      commandId: 'create-inspection',
      sessionId: 'inspection',
      workspaceId: 'w',
      title: 'U02 inspection session',
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
      `import {runTUIHost} from ${JSON.stringify(hostPath)};try{process.exitCode=await runTUIHost(${JSON.stringify({ server: endpoint.socket, dataRoot: profile.dataRoot, profile: profile.profile, thread: 'root', cwd: workspace, testDiagnostics: false })})}catch{console.error('live_tui_host_failed');process.exitCode=1}`,
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
    await openExactApprovalChooser(2, 'ordinary_two_card_chooser');
    await key('\r', 'enter');
    const approvalScreen = await screen(
      'ordinary_exact_approval_panel',
      (text) => text.includes('files.write_path') && text.includes('Allow once'),
    );
    const chosenIndex = targets.findIndex((target) =>
      approvalPanelHasExactTarget(approvalScreen, target),
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
    await screen('ordinary_remaining_card_chooser', (text) => /Pending cards\s*·\s*1/.test(text));
    await key('\r', 'enter');
    await screen('ordinary_second_approval_panel', (text) =>
      approvalPanelHasExactTarget(text, targets[1 - chosenIndex]!),
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
    // U02 adds a second real child round after the complete ordinary U01 setup.
    // All business and approval mutation still originates from actual TUI input.
    const oldCarrier = (await ownedStore.listExecutions('root')).find(
      (execution) =>
        execution.childSessionId === chosen!.sessionId &&
        object(execution.reference).runId === chosen!.runId,
    );
    require(oldCarrier?.status === 'succeeded', 'first_round_exact_carrier_complete');
    const oldRun = await ownedStore.getRun(chosen!.runId!);
    require(oldRun?.status === 'completed' &&
      !oldRun.isActive, 'first_round_exact_child_run_complete');
    const immutableCarrier = (execution: NonNullable<typeof oldCarrier>) => ({
      id: execution.id,
      sessionId: execution.sessionId,
      childSessionId: execution.childSessionId,
      parentExecutionId: execution.parentExecutionId,
      originCommandId: execution.originCommandId,
      originStoreId: execution.originStoreId,
      rootWorkCommandId: execution.rootWorkCommandId,
      rootWorkSeq: execution.rootWorkSeq,
      definitionId: execution.definitionId,
      definitionVersion: execution.definitionVersion,
      input: execution.input,
      reference: execution.reference,
      childConfiguration: execution.childConfiguration,
      result: execution.result,
      resultRevision: execution.resultRevision,
      status: execution.status,
    });
    const oldCarrierMetadata = structuredClone(immutableCarrier(oldCarrier!));
    const oldInteractionMetadata = structuredClone(approved);
    const oldRunMetadata = structuredClone(oldRun);
    const immutableMetadataUnchanged = async (stage: string) => {
      const carrier = await ownedStore.getExecution(oldCarrier!.id);
      const interaction = await ownedRuntime.getInteraction({
        expectedStoreId,
        sessionId: chosen!.presentationSessionId,
        interactionId: chosen!.id,
      });
      require(carrier &&
        isDeepStrictEqual(immutableCarrier(carrier), oldCarrierMetadata) &&
        isDeepStrictEqual(interaction, oldInteractionMetadata) &&
        isDeepStrictEqual(await ownedStore.getRun(oldRun!.id), oldRunMetadata), stage);
    };
    await key('\x02', 'ctrl_b');
    await screen('two_round_return_parent_chooser', (text) => text.includes('Pending cards'));
    await key('\x1b', 'escape');
    await screen('two_round_parent_composer', (text) => /^❯(?: |$)/m.test(text));
    const instructionC = `New assignment in the same collaborator: use write_user_file exactly once with path ${JSON.stringify(targets[2])}, content ${JSON.stringify(bodies[2])}, base null. This fresh target needs its own human approval. Report the complete exact content marker only after the real successful write. Respect denial, without retry, replacement or delegation.`;
    const continuation = `Continue ${oldCarrier!.rootWorkCommandId}. Continue the same original work and use follow_up_agent exactly once on the SAME original agent_id ${chosen!.sessionId}, content ${JSON.stringify(instructionC)}. Keep its saved history and original configuration. Wait for that new child round's actual result with finite wait_agent_events and report its complete actual content marker. Do not spawn, write yourself, replay prior writes, retry denials, or control other collaborators.`;
    await send(continuation, 'second_round_business_input');
    let parentFollowupApproved = false;
    const fresh = await until(async () => {
      const currentCards = await pending();
      const newChild = currentCards.find(
        (card) => card.sessionId === chosen!.sessionId && card.id !== chosen!.id,
      );
      if (newChild) return { kind: 'child' as const, card: newChild };
      const parent = currentCards.find(
        (card) => card.sessionId === 'root' && card.definitionId === 'task.follow_up',
      );
      return parent ? { kind: 'parent' as const, card: parent } : undefined;
    }, 'real_second_round_or_default_parent_followup_approval');
    if (fresh.kind === 'parent') {
      const input = object(object(fresh.card.request).input);
      require(input.agentId === chosen!.sessionId &&
        typeof input.content === 'string' &&
        input.content.includes(targets[2]!) &&
        input.content.includes(
          bodies[2]!,
        ), 'default_parent_followup_card_exact_same_child_and_new_assignment');
      await screen(
        'ordinary_parent_followup_approval',
        (text) => text.includes('task.follow_up') && text.includes('Allow once'),
      );
      await key('\r', 'enter_parent_followup_allow_once');
      await until(async () => {
        const card = await ownedRuntime.getInteraction({
          expectedStoreId,
          sessionId: fresh.card.presentationSessionId,
          interactionId: fresh.card.id,
        });
        return card?.answer?.kind === 'approval' &&
          card.answer.decision === 'approve' &&
          card.acceptedDecisionRevision !== null
          ? true
          : undefined;
      }, 'default_parent_followup_original_approval_saved');
      parentFollowupApproved = true;
    }
    const next =
      fresh.kind === 'child'
        ? fresh.card
        : await until(
            async () =>
              (await pending()).find(
                (card) => card.sessionId === chosen!.sessionId && card.id !== chosen!.id,
              ),
            'same_child_real_second_round_approval',
          );
    checks.parentFollowupApprovalThroughOrdinaryTui = parentFollowupApproved;
    require(next.sessionId === chosen!.sessionId &&
      next.id !== chosen!.id &&
      next.runId !== chosen!.runId &&
      next.executionId !== chosen!.executionId &&
      next.presentationSessionId === 'root' &&
      next.originStoreId === expectedStoreId &&
      object(object(next.request).input).path === targets[2] &&
      !existsSync(targets[2]!), 'fresh_second_round_exact_run_tool_card_and_zero_effect');
    const nextTool = await ownedStore.getExecution(next.executionId);
    const nextRun = await ownedStore.getRun(next.runId!);
    const nextCarrier = (await ownedStore.listExecutions('root')).find(
      (execution) =>
        execution.childSessionId === chosen!.sessionId &&
        object(execution.reference).runId === next.runId,
    );
    const exactLineage = async (
      carrier: ExecutionRecord | undefined,
      run: RunRecord | null,
      definitionId: 'task.spawn' | 'task.follow_up',
    ) => {
      if (!carrier || !run) return false;
      const proof = object(mcpSnapshot(carrier.childConfiguration?.snapshot).inheritance);
      const parent =
        typeof proof.parentExecutionId === 'string'
          ? await ownedStore.getExecution(proof.parentExecutionId)
          : null;
      const parentRun =
        typeof proof.parentRunId === 'string' ? await ownedStore.getRun(proof.parentRunId) : null;
      return exactChildMcpBinding(carrier, run, parent, parentRun, definitionId);
    };
    require((await exactLineage(oldCarrier, oldRun, 'task.spawn')) &&
      (await exactLineage(
        nextCarrier,
        nextRun,
        'task.follow_up',
      )), 'both_child_rounds_have_exact_fresh_MCP_parent_invocation_proofs');
    require(nextCarrier &&
      nextCarrier.id !== oldCarrier!.id &&
      nextCarrier.rootWorkCommandId === oldCarrier!.rootWorkCommandId &&
      nextCarrier.rootWorkSeq === oldCarrier!.rootWorkSeq &&
      nextRun?.rootWorkCommandId === oldRun!.rootWorkCommandId &&
      nextTool?.runId === nextRun?.id &&
      nextTool.authorization?.dispatched !== true &&
      isDeepStrictEqual(
        stableChildConfiguration(nextCarrier.childConfiguration),
        stableChildConfiguration(oldCarrier!.childConfiguration),
      ) &&
      (await ownedStore.getView(chosen!.sessionId)).runs.length === 2 &&
      (await ownedStore.listExecutions('root')).filter((execution) => execution.childSessionId)
        .length === 3, 'same_session_one_new_carrier_original_work_and_configuration');
    await immutableMetadataUnchanged('old_first_round_metadata_unchanged_at_new_approval');
    require((await pending()).length === 1 &&
      (await pending())[0]?.id ===
        next.id, 'pending_projection_contains_only_exact_new_card_no_historical_controls');
    // Ordinary chooser has no diagnostic IDs. Its one visible entry is tied to the
    // exact current target by opening the real panel and reading its target below.
    await key('\x02', 'ctrl_b');
    await screen('ordinary_only_new_pending_chooser', (text) => /Pending cards\s*·\s*1/.test(text));
    await key('\r', 'enter_new_card');
    await screen('ordinary_new_target_approval_before_switch', (text) =>
      approvalPanelHasExactTarget(text, targets[2]!),
    );
    await key('\x02', 'ctrl_b');
    await screen('ordinary_leave_new_approval_chooser', (text) => text.includes('Pending cards'));
    await key('\x1b', 'escape');
    await screen('ordinary_parent_before_session_switch', (text) => /^❯(?: |$)/m.test(text));
    const pendingBeforeSwitch = structuredClone(
      await ownedRuntime.getInteraction({
        expectedStoreId,
        sessionId: next.presentationSessionId,
        interactionId: next.id,
      }),
    );
    const rootTitle = (await ownedStore.getSession('root'))!.title;
    const escapeSessionTitle = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactSessionRow = (text: string, title: string, current = false) =>
      text
        .split('\n')
        .some((line) =>
          new RegExp(
            `^\\s*❯\\s+${escapeSessionTitle(title)}${current ? '\\s+Current' : '(?:\\s+Current)?'}(?:\\s+\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})?\\s*$`,
          ).test(line),
        );
    const chooseSession = async (title: string, stage: string) => {
      await send('/resume', `${stage}_resume`);
      await screen(`${stage}_session_chooser`, (text) => text.includes('Search'));
      await key('\t', 'tab_to_session_search');
      await screen(`${stage}_search_focused`, (text) => /^\s*❯\s*Search:/m.test(text));
      await key(title, 'session_search_title');
      await screen(
        `${stage}_filtered_session`,
        (text) =>
          text
            .split('\n')
            .some(
              (line) => line.includes('❯') && line.includes('Search:') && line.includes(title),
            ) &&
          text.split('\n').filter((line) => line.includes(title) && !line.includes('Search:'))
            .length === 1,
      );
      await key('\x1b[B', 'down_to_exact_session');
      await screen(
        `${stage}_exact_highlighted_session`,
        (text) => /1\s*\/\s*1/.test(text) && exactSessionRow(text, title),
      );
      await key('\r', 'enter_session');
      await screen(
        `${stage}_selected_session`,
        (text) => !text.includes('Search') && /^❯(?: |$)/m.test(text),
      );
      await key('\x12', 'ctrl_r_verify_selected_session');
      await screen(`${stage}_current_session_identity`, (text) =>
        exactSessionRow(text, title, true),
      );
      await key('\x1b', 'escape_selection_verification');
      await screen(
        `${stage}_ordinary_composer_after_selection`,
        (text) => !text.includes('Search') && /^❯(?: |$)/m.test(text),
      );
    };
    await chooseSession('U02 inspection session', 'ordinary_switch_other');
    await key('\x02', 'ctrl_b');
    await screen('ordinary_other_session_has_zero_pending_cards', (text) =>
      /Pending cards\s*·\s*0/.test(text),
    );
    await key('\x1b', 'escape');
    await chooseSession(rootTitle, 'ordinary_switch_back_root');
    require(isDeepStrictEqual(
      await ownedRuntime.getInteraction({
        expectedStoreId,
        sessionId: next.presentationSessionId,
        interactionId: next.id,
      }),
      pendingBeforeSwitch,
    ) &&
      !existsSync(targets[2]!) &&
      (await ownedStore.getView('inspection')).runs.length ===
        0, 'session_switch_returns_exact_pending_card_without_effect_or_other_business');
    for (const request of options.requests().slice(requestStart))
      require((await ownedStore.getExecution(request.requestId))?.sessionId !==
        'inspection', 'ordinary_inspection_session_switch_starts_no_model');
    await immutableMetadataUnchanged('old_metadata_unchanged_after_normal_session_switch');
    await key('\x02', 'ctrl_b');
    await screen('ordinary_new_card_after_return', (text) => /Pending cards\s*·\s*1/.test(text));
    await key('\r', 'enter_exact_second_round_card');
    await screen('ordinary_exact_second_round_approval_after_return', (text) =>
      approvalPanelHasExactTarget(text, targets[2]!),
    );
    await key('\r', 'enter_second_round_allow_once');
    await until(
      async () =>
        (await ownedStore.getExecution(next.executionId))?.status === 'succeeded'
          ? true
          : undefined,
      'second_round_original_tool_completed',
    );
    await until(async () => {
      const carrier = await ownedStore.getExecution(nextCarrier!.id);
      const views = await Promise.all(
        (await allSessions()).map((session) => ownedStore.getView(session.id)),
      );
      return carrier?.status === 'succeeded' &&
        carrier.resultAcceptance &&
        views.every((view) => view.runs.every((run) => !run.isActive))
        ? true
        : undefined;
    }, 'second_round_result_accepted_and_all_runs_terminal');
    const newApproved = await ownedRuntime.getInteraction({
      expectedStoreId,
      sessionId: next.presentationSessionId,
      interactionId: next.id,
    });
    require(newApproved?.state === 'answered' &&
      newApproved.answer?.kind === 'approval' &&
      newApproved.answer.decision === 'approve' &&
      newApproved.answer.grant === 'approve_once' &&
      newApproved.acceptedDecisionRevision !== null &&
      existsSync(targets[2]!) &&
      readFileSync(targets[2]!, 'utf8') === bodies[2] &&
      readFileSync(targets[chosenIndex]!, 'utf8') === bodies[chosenIndex] &&
      !existsSync(targets[1 - chosenIndex]!), 'second_round_only_new_exact_once_physical_effect');
    const completedCarrier = (await ownedStore.getExecution(nextCarrier!.id))!;
    const acceptance = completedCarrier.resultAcceptance!;
    const acceptedParentRun = acceptance.runId ? await ownedStore.getRun(acceptance.runId) : null;
    require(acceptedParentRun?.rootWorkCommandId === oldCarrier!.rootWorkCommandId &&
      acceptedParentRun.contextSelectionId === acceptance.selectionId &&
      acceptance.resultRevision === completedCarrier.resultRevision &&
      String(object(completedCarrier.result).content ?? '').includes(
        bodies[2]!,
      ), 'second_round_exact_result_revision_original_work_and_actual_fact');
    let exactPreparedSource = false;
    for (const request of options.requests().slice(requestStart)) {
      const execution = await ownedStore.getExecution(request.requestId);
      if (execution?.sessionId !== 'root' || execution.runId !== acceptance.runId) continue;
      const sourceMessages = request.messages.filter((message) =>
        message.sourceIds?.includes(acceptance.sourceId),
      );
      if (!sourceMessages.length) continue;
      require(sourceMessages.reduce(
        (count, message) =>
          count +
          (message.sourceIds?.filter((sourceId) => sourceId === acceptance.sourceId).length ?? 0),
        0,
      ) === 1, 'second_round_original_source_once_per_actual_parent_input');
      exactPreparedSource ||= sourceMessages.some((message) =>
        message.content.includes(bodies[2]!),
      );
    }
    require(exactPreparedSource, 'second_round_complete_actual_fact_in_exact_parent_model_source');
    await immutableMetadataUnchanged('old_first_round_metadata_and_identity_still_unchanged');
    const finalSameChild = await ownedStore.getView(chosen!.sessionId);
    require(finalSameChild.runs.length === 2 &&
      finalSameChild.runs.every((run) => run.status === 'completed') &&
      finalSameChild.executions.filter(
        (execution) =>
          execution.definitionId === 'files.write_path' && execution.authorization?.dispatched,
      ).length === 2 &&
      (await ownedStore.listExecutions('root')).filter((execution) => execution.childSessionId)
        .length === 3, 'two_real_child_rounds_exact_two_dispatches_no_replacement');

    const original = (await ownedStore.getChanges({ after: '0', limit: 200 })).events;
    require(original.length > 0, 'durable_ui_events');
    checks.providerModelsObserved = options.requests().length - requestStart;
    await normalExit();
    u02Completed = true;
    const beforeCold = {
      cursor: (await ownedStore.getMetadata()).lastChangeCursor,
      requests: options.requests().length,
    };
    failureStage = 'ordinary_pty_launch';
    terminal = launch();
    await screen('cold_ordinary_tui_composer', (text) => /^❯(?: |$)/m.test(text));
    const savedTail = continuation.slice(-32).replace(/\s+/g, '');
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
      !existsSync(targets[1 - chosenIndex]!) &&
      existsSync(targets[2]!) &&
      readFileSync(targets[2]!, 'utf8') === bodies[2], 'cold_client_preserves_exact_effects');
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
    canonicalEvidenceRetained = true;
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
        id: 'U02-TUI-two-round-history-controls-subset',
        status: checks.resourcesClosed === false ? 'failed' : u02Completed ? 'passed' : status,
      },
      {
        id: 'U03',
        status:
          checks.resourcesClosed === false ? 'failed' : u03Completed ? 'passed' : 'inconclusive',
      },
    ],
    intendedCoverage: [
      'U02_two_round_same_child_real_source_pty_default_policy',
      'old_history_controls_detached_not_late_server_answer_or_stop',
      'ordinary_resume_switch_and_return_exact_current_approval',
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
    group: 'tui-two-round-window',
    caseId: 'U02-TUI-two-round-history-controls-subset',
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
    const result = await runLiveTuiTwoRoundWindow({
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
