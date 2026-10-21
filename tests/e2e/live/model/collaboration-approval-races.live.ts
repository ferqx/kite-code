import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

const ids = [
  'P04-cancel-first',
  'P04-dispatch-first',
  'P04-parent-cancel-first',
  'P04-parent-dispatch-first',
  'P04-root-cancel-first',
  'P04-root-dispatch-first',
] as const;
type CaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: CaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  canonicalEvidenceRetained: boolean;
}
/** Isolated public child-stop/approval races; the default resolver remains the policy authority. */
export async function runLiveApprovalRaces(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (options.evidenceRoot && (!isAbsolute(options.evidenceRoot) || selected.length !== 1))
    throw Error('live_collaboration_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-approval-race-')),
    );
    const checks: Result['checks'] = {};
    const dispatchFirst = id.endsWith('dispatch-first');
    const controlKind = id.includes('-parent-')
      ? 'parent'
      : id.includes('-root-')
        ? 'root'
        : 'child';
    let rootModelCalls = 0;
    let parentHeld = false;
    let status: Result['status'] = 'inconclusive';
    let reason: Result['reason'];
    let canonicalEvidenceRetained = false;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
    let lockClose: Promise<void> | undefined;
    const closeLocks = () => {
      if (!locks) return Promise.resolve();
      lockClose ??= locks.close();
      return lockClose;
    };
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let heldAfterEffect = false;
    const requestStart = options.requests().length;
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const target = join(root, 'external-marker.txt');
      const body = `approval-race-${crypto.randomUUID()}`;
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      const config = join(profile.profilePath, 'config.jsonc');
      writeFileSync(
        config,
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
            'files.write_path',
            'task.spawn',
            'task.message',
            'task.follow_up',
            'task.events',
            'task.list',
            'task.interrupt',
          ].map((id) => ({ id })),
        }),
        { mode: 0o600 },
      );
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: config,
        authorizationReview: {
          id: 'live.review',
          version: '1',
          modelId: options.modelId,
          model: options.model,
        },
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const inject = (binding: RunConfiguration, child: boolean): RunConfiguration => ({
        ...binding,
        model: {
          async *stream(request, context) {
            // Preserve the actual Tool and physical effect, holding only the next child Model.
            if (
              (!child && controlKind === 'parent' && ++rootModelCalls > 1) ||
              (child && dispatchFirst && existsSync(target))
            ) {
              if (child) heldAfterEffect = true;
              else parentHeld = true;
              await Promise.race([
                childGate,
                new Promise<void>((_, reject) => {
                  if (context.signal.aborted) reject(context.signal.reason);
                  else
                    context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                      once: true,
                    });
                }),
              ]);
            }
            options.signal.throwIfAborted();
            for await (const event of options.model.stream(request, context)) yield event;
          },
        },
        permissions: {
          ...binding.permissions!,
          async authorize(request) {
            if (request.kind === 'tool' && request.definitionId === 'files.write_path') {
              const input = request.input;
              if (
                !input ||
                typeof input !== 'object' ||
                Array.isArray(input) ||
                input.path !== target ||
                input.content !== body ||
                input.base !== null
              )
                return {
                  allowed: false,
                  revision: 'owned-race-target-only-1',
                  reason: 'live_target_out_of_scope',
                };
            }
            return binding.permissions!.authorize(request);
          },
        },
      });
      locks = createWorkspaceSerialLocks(profile);
      runtime = createRuntime({
        ...host,
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        resolveRunConfiguration: async (input) =>
          inject(await host.resolveRunConfiguration!(input), false),
        resolveChildRunConfiguration: async (input) =>
          inject(await host.resolveChildRunConfiguration!(input), true),
      });
      checks.runtimeCreated = true;
      const controls = host.permissionManagement!(runtime);
      const expectedStoreId = (await store.getMetadata()).storeId;
      service = await startService({
        runtime,
        subjectId: 'live-owner',
        buildId: 'live-approval-races',
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        beforeResourceClose: closeLocks,
      });
      checks.serviceStarted = true;
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile: service.bootstrap.profile,
          apiMajor: 1,
          requiredCapabilities: ['commands', 'sessions', 'interactions'],
        },
      });
      await client.connect();
      checks.clientConnected = true;
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'synthetic',
        rootUri: pathToFileURL(workspace).href,
      });
      checks.workspaceCreated = true;
      await client.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Explicit approval race',
      });
      checks.sessionCreated = true;
      const scope = { expectedStoreId, subjectId: 'live-owner' };
      const mode = await controls.readMode({ ...scope, sessionId: 's' });
      const applied = await controls.setMode({
        ...scope,
        sessionId: 's',
        commandId: 'mode',
        mode: 'accept_edits',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      if (applied.state !== 'applied') throw Error('mode_not_applied');
      const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
      if (
        (
          await controls.setTrust({
            ...scope,
            workspaceId: 'w',
            commandId: 'trust',
            trusted: true,
            ifRevision: trust.revision,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
          })
        ).state !== 'applied'
      )
        throw Error('trust_not_applied');
      await client.startRun(
        's',
        {
          expectedStoreId,
          commandId: 'work',
          kind: 'run.start',
          content: `New task: Delegate exactly one collaborator with spawn_agent, prompt only, no preset. Tell it to use write_user_file exactly once to create ${JSON.stringify(target)} with content ${JSON.stringify(body)} and base null. You must not write yourself. The collaborator must not delegate or retry. Wait for its actual result with wait_agent_events and honestly report cancellation or completion. Never replace or follow up a cancelled collaborator.`,
        },
        { signal: options.signal },
      );
      type Card = Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number];
      let card: Card | undefined;
      let carrier: Awaited<ReturnType<typeof store.listExecutions>>[number] | undefined;
      const end = Date.now() + 150_000;
      while (Date.now() < end && !card) {
        options.signal.throwIfAborted();
        const carriers = (await store.listExecutions('s')).filter((e) => e.childSessionId);
        if (carriers.length > 1) {
          checks.singleChild = false;
          throw Error('oracle_violation');
        }
        carrier = carriers[0];
        if (carrier?.childSessionId) {
          const child = await store.getSession(carrier.childSessionId);
          checks.exactChildAncestry =
            child?.parentSessionId === 's' &&
            child.rootSessionId === 's' &&
            carrier.originStoreId === expectedStoreId;
          card = (
            await client.listInteractions(carrier.childSessionId, {
              storeId: expectedStoreId,
              state: 'pending',
            })
          ).interactions.find(
            (c) => c.kind === 'approval' && c.definitionId === 'files.write_path',
          );
        }
        if (!card) await Bun.sleep(30);
      }
      if (!card || !carrier?.childSessionId) {
        reason = 'branch_not_reached';
      } else {
        const leaf = carrier.childSessionId;
        const write = await store.getExecution(card.executionId!);
        checks.realPendingChildWrite =
          card.sessionId === leaf &&
          write?.sessionId === leaf &&
          write.kind === 'tool' &&
          write.definitionId === 'files.write_path' &&
          write.input !== null;
        checks.zeroEffectBeforeDecision =
          !existsSync(target) && write?.authorization?.dispatched !== true;
        const approve = async () =>
          client!.answerInteraction(
            card!.presentationSessionId,
            card!.id,
            {
              expectedStoreId,
              commandId: 'approve',
              expectedRevision: card!.revision,
              answer: { kind: 'approval', decision: 'approve' },
            },
            { signal: options.signal },
          );
        if (dispatchFirst) {
          await approve();
          while (Date.now() < end && !(heldAfterEffect && existsSync(target))) {
            options.signal.throwIfAborted();
            await Bun.sleep(30);
          }
          const done = await store.getExecution(card.executionId!);
          checks.actualEffectBeforeStop =
            heldAfterEffect &&
            existsSync(target) &&
            readFileSync(target, 'utf8') === body &&
            done?.status === 'succeeded' &&
            done.authorization?.dispatched === true;
          checks.childStillActiveBeforeStop = (await store.getView(leaf)).runs.some(
            (r) => r.id === card!.runId && r.isActive,
          );
          if (!checks.actualEffectBeforeStop || !checks.childStillActiveBeforeStop)
            throw Error('branch_not_reached');
        }
        if (controlKind === 'parent') {
          while (!parentHeld && Date.now() < end) {
            options.signal.throwIfAborted();
            await Bun.sleep(30);
          }
        }
        const parent = (await store.getView('s')).runs.find((run) => run.isActive);
        const spawn = carrier.parentExecutionId
          ? await store.getExecution(carrier.parentExecutionId)
          : null;
        if (controlKind === 'parent') {
          checks.exactParentActiveBeforeCancel =
            parentHeld &&
            !!parent &&
            spawn?.definitionId === 'task.spawn' &&
            spawn.runId === parent.id;
          if (!checks.exactParentActiveBeforeCancel) throw Error('branch_not_reached');
        }
        const stop =
          controlKind === 'root'
            ? await client.cancelSession(
                's',
                {
                  expectedStoreId,
                  commandId: 'root-stop',
                  kind: 'session.cancel',
                  includeBackground: true,
                },
                { signal: options.signal },
              )
            : controlKind === 'parent'
              ? await client.cancelRun(
                  's',
                  {
                    expectedStoreId,
                    commandId: 'parent-cancel',
                    kind: 'run.cancel',
                    runId: parent!.id,
                  },
                  { signal: options.signal },
                )
              : await client.cancelExecution(
                  's',
                  {
                    expectedStoreId,
                    commandId: 'stop-child',
                    kind: 'execution.cancel',
                    executionId: carrier.id,
                  },
                  { signal: options.signal },
                );
        checks.formalControlKindMatches =
          stop.kind ===
          (controlKind === 'root'
            ? 'session.cancel'
            : controlKind === 'parent'
              ? 'run.cancel'
              : 'execution.cancel');
        const stoppedCarrier = await store.getExecution(carrier.id);
        checks.formalExactStopApplied =
          stop.status === 'applied' &&
          !!stoppedCarrier &&
          stoppedCarrier.cancelRequestedAt !== null;
        if (!dispatchFirst) {
          try {
            await approve();
          } catch {
            checks.lateApprovalRejected = true;
          }
        }
        releaseChild();
        let settled = false;
        while (Date.now() < end) {
          options.signal.throwIfAborted();
          const views = await Promise.all(['s', leaf].map((s) => client!.getView(s)));
          const c = await store.getExecution(carrier.id);
          settled =
            views.every((v) => v.runs.every((r) => !r.isActive)) &&
            !!c &&
            ['cancelled', 'failed', 'succeeded', 'outcome_unknown'].includes(c.status);
          if (settled) break;
          await Bun.sleep(30);
        }
        checks.settled = settled;
        const writes = (await store.listExecutions(leaf)).filter(
          (e) => e.kind === 'tool' && e.definitionId === 'files.write_path',
        );
        checks.oneExactInvocation = writes.length === 1 && writes[0]?.id === card.executionId;
        checks.noReplacementChild =
          (await store.listExecutions('s')).filter((e) => e.childSessionId).length === 1;
        checks.parentNeverWrote = !(await store.listExecutions('s')).some(
          (e) => e.definitionId === 'files.write_path',
        );
        checks.effectOracle = !dispatchFirst
          ? !existsSync(target) && writes.every((e) => !e.authorization?.dispatched)
          : existsSync(target) &&
            readFileSync(target, 'utf8') === body &&
            writes[0]?.status === 'succeeded' &&
            writes[0].authorization?.dispatched === true;
        const finalCard = await client.getInteraction(card.presentationSessionId, card.id, {
          storeId: expectedStoreId,
        });
        checks.noPendingOldApproval = finalCard.state !== 'pending';
        checks.actualRequests = options.requests().length - requestStart;
        checks.realRootAndChildModels =
          (await store.listExecutions('s')).some(
            (e) => e.kind === 'model' && e.status === 'succeeded',
          ) &&
          (await store.listExecutions(leaf)).some(
            (e) => e.kind === 'model' && e.status === 'succeeded',
          );
        status = Object.values(checks).every((v) => v !== false) && settled ? 'passed' : 'failed';
        if (status === 'failed') reason = 'oracle_violation';
      }
    } catch (error) {
      checks.errorIsTypeError = error instanceof TypeError;
      reason =
        error instanceof Error && error.message === 'branch_not_reached'
          ? 'branch_not_reached'
          : error instanceof Error && error.message === 'oracle_violation'
            ? 'oracle_violation'
            : 'execution_unavailable';
      if (reason === 'oracle_violation') status = 'failed';
    } finally {
      releaseChild();
      let closed = true;
      try {
        client?.disposeNetwork();
      } catch {
        closed = false;
      }
      let runtimeClosed = false;
      if (service) {
        try {
          await service.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      }
      if (!runtimeClosed && runtime) {
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch {
          closed = false;
        }
      }
      if (!runtimeClosed && store) {
        try {
          await store.close();
        } catch {
          closed = false;
        }
      }
      try {
        await closeLocks();
      } catch {
        closed = false;
      }
      checks.resourcesClosed = closed;
      if (!closed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      canonicalEvidenceRetained = status !== 'passed' && (!!options.evidenceRoot || !closed);
      if (!canonicalEvidenceRetained) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
          canonicalEvidenceRetained = existsSync(root);
        }
      }
    }
    cases.push({
      id,
      status,
      reason,
      checks,
      canonicalEvidenceRetained,
      coverage: [
        !dispatchFirst
          ? `${controlKind}_stop_durable_before_late_approval`
          : `real_effect_and_completed_tool_before_${controlKind}_stop`,
        'default_policy_real_root_child',
        controlKind === 'child'
          ? 'exact_child_carrier_control'
          : controlKind === 'parent'
            ? 'exact_active_parent_run_control'
            : 'formal_root_stop_including_background',
        'no_P08_grant_gate_coverage',
      ],
    });
  }
  return { cases };
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_APPROVAL_RACES !== '1')
    throw Error('live_collaboration_requires_KITE_RUN_LIVE_APPROVAL_RACES_1');
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--(case|output)=(.+)$/.exec(arg);
    if (!m || args.has(m[1]!)) throw Error('live_collaboration_arguments_invalid');
    args.set(m[1]!, m[2]!);
  }
  const id = args.get('case');
  const output = args.get('output');
  if (
    !ids.includes(id as CaseId) ||
    !output ||
    !isAbsolute(output) ||
    existsSync(output) ||
    existsSync(`${output}.workspace`)
  )
    throw Error('live_collaboration_arguments_invalid');
  const started = performance.now();
  const report: Record<string, unknown> = {
    version: 1,
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    group: 'approval-races',
    caseId: id,
    entryLayer: 'service-client-runtime-sqlite',
    requestLimit: 40,
    timeoutMs: 600_000,
    network: 'configured-provider-direct-no-fallback',
    code: liveCodeEvidence(),
    status: 'inconclusive',
  };
  let fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  try {
    fixture = await createLiveModelFixture({ requestLimit: 40, timeoutMs: 600_000 });
    Object.assign(report, fixture.metadata);
    const result = await runLiveApprovalRaces({
      model: fixture.model,
      modelId: fixture.modelId,
      signal: fixture.signal,
      requests: () => fixture!.requests,
      caseIds: [id!],
      evidenceRoot: `${output}.workspace`,
    });
    report.cases = result.cases;
    report.status = result.cases[0]?.status ?? 'inconclusive';
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
  } catch {
    report.status = 'failed';
    report.error = 'live_collaboration_approval_race_unavailable';
    process.exitCode = 1;
  } finally {
    report.monotonicDurationMs = performance.now() - started;
    report.finishedAt = new Date().toISOString();
    if (fixture) {
      report.providerRequests = fixture.wire.length;
      report.modelRequests = fixture.requests.length;
      report.httpStatuses = fixture.wire.map((w) => w.status);
      report.toolCalls = summarizeLiveToolCalls(fixture.requests, fixture.calls);
      report.usage = {
        knownInputTokens: fixture.usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
        knownOutputTokens: fixture.usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
        requestsWithUsage: fixture.usage.length,
        requestsWithInputTokens: fixture.usage.filter((u) => u.inputTokens !== null).length,
        requestsWithOutputTokens: fixture.usage.filter((u) => u.outputTokens !== null).length,
      };
    }
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
  }
}
