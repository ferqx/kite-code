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

const ids = ['P08-grant-revision', 'P08-review-revision'] as const;
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
/** Private final-dispatch gate; all grants and reviews come from formal policy and real inputs. */
export async function runLiveGrantRaces(options: Options): Promise<{ cases: Result[] }> {
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
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let heldDispatch:
      | Parameters<Awaited<ReturnType<typeof openSqliteStore>>['markDispatching']>[0]
      | undefined;
    let dispatchGateEntered = false;
    let reviewGateEntered = false;
    let reviewArmed = false;
    let oldDispatchRejected = false;
    const successfulDispatches: Parameters<
      Awaited<ReturnType<typeof openSqliteStore>>['markDispatching']
    >[0][] = [];
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
        authorizationCheck: {
          id: 'live.review',
          version: '1',
          modelId: options.modelId,
          model: {
            async *stream(request, context) {
              for await (const event of options.model.stream(request, context)) {
                if (
                  id === 'P08-review-revision' &&
                  reviewArmed &&
                  !reviewGateEntered &&
                  event.type === 'text_delta'
                ) {
                  reviewGateEntered = true;
                  await reviewGate;
                }
                yield event;
              }
            },
          },
        },
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const observedStore = new Proxy(store, {
        get(target, key) {
          if (key === 'markDispatching')
            return async (input: Parameters<typeof target.markDispatching>[0]) => {
              const execution = await target.getExecution(input.executionId);
              if (
                !heldDispatch &&
                execution?.kind === 'tool' &&
                execution.definitionId === 'files.write_path' &&
                input.authorization?.interactionId
              ) {
                heldDispatch = structuredClone(input);
                dispatchGateEntered = true;
                await dispatchGate;
                try {
                  const result = await target.markDispatching(input);
                  successfulDispatches.push(structuredClone(input));
                  return result;
                } catch (error) {
                  if (error instanceof Error && error.message === 'permission_control_changed')
                    oldDispatchRejected = true;
                  throw error;
                }
              }
              const result = await target.markDispatching(input);
              successfulDispatches.push(structuredClone(input));
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const inject = (binding: RunConfiguration): RunConfiguration => ({
        ...binding,
        model: options.model,
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
        store: observedStore,
        artifacts: createArtifactStore({ profile, store }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        resolveRunConfiguration: async (input) =>
          inject(await host.resolveRunConfiguration!(input)),
        resolveChildRunConfiguration: async (input) =>
          inject(await host.resolveChildRunConfiguration!(input)),
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
        const answer = async (chosen: Card, commandId: string) =>
          client!.answerInteraction(
            chosen.presentationSessionId,
            chosen.id,
            {
              expectedStoreId,
              commandId,
              expectedRevision: chosen.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            },
            { signal: options.signal },
          );
        await answer(card, 'approve-original');
        while (!dispatchGateEntered && Date.now() < end) {
          options.signal.throwIfAborted();
          await Bun.sleep(30);
        }
        if (!heldDispatch || !dispatchGateEntered) throw Error('branch_not_reached');
        const approved = await client.getInteraction(card.presentationSessionId, card.id, {
          storeId: expectedStoreId,
        });
        const planned = await store.getExecution(card.executionId!);
        checks.durableExactHumanGrantBeforeFinalDispatch =
          approved.state === 'answered' &&
          approved.acceptedDecisionRevision !== null &&
          heldDispatch.executionId === card.executionId &&
          heldDispatch.authorization?.interactionId === card.id &&
          heldDispatch.authorization?.decisionRevision === approved.acceptedDecisionRevision;
        checks.originalExecutionPlannedNoEffect =
          planned?.status === 'planned' &&
          planned.authorization?.dispatched !== true &&
          !existsSync(target);
        if (
          !checks.durableExactHumanGrantBeforeFinalDispatch ||
          !checks.originalExecutionPlannedNoEffect
        )
          throw Error('oracle_violation');
        let mutations = 1;
        const setMode = async (mode: 'full' | 'auto' | 'accept_edits') => {
          const previous = await controls.readMode({ ...scope, sessionId: 's' });
          const result = await controls.setMode({
            ...scope,
            sessionId: 's',
            commandId: `mode-${++mutations}`,
            mode,
            makeDefault: false,
            ifRevision: previous.revision,
            ifDefaultRevision: previous.defaultRevision,
          });
          if (result.state !== 'applied') throw Error('branch_not_reached');
          return controls.readMode({ ...scope, sessionId: 's' });
        };
        let currentRevision: string;
        if (id === 'P08-grant-revision') {
          await setMode('full');
          currentRevision = (await setMode('accept_edits')).revision;
          releaseDispatch();
        } else {
          reviewArmed = true;
          await setMode('auto');
          releaseDispatch();
          while (!reviewGateEntered && Date.now() < end) {
            options.signal.throwIfAborted();
            await Bun.sleep(30);
          }
          if (!reviewGateEntered) throw Error('branch_not_reached');
          checks.realReviewOutputHeldBeforeCurrentModeChange =
            reviewGateEntered && !existsSync(target);
          currentRevision = (await setMode('accept_edits')).revision;
          releaseReview();
        }
        checks.revisionChangedAfterSavedGrant =
          heldDispatch.authorization?.controlReads?.some(
            (r) =>
              r.kind === 'permission.mode' &&
              r.scope === 'session:s' &&
              r.revision !== currentRevision,
          ) === true;
        let fresh: Card | undefined;
        while (Date.now() < end && !fresh) {
          options.signal.throwIfAborted();
          fresh = (
            await client.listInteractions(leaf, { storeId: expectedStoreId, state: 'pending' })
          ).interactions.find(
            (c) =>
              c.kind === 'approval' && c.executionId === card!.executionId && c.id !== card!.id,
          );
          if (existsSync(target)) throw Error('oracle_violation');
          if (!fresh) await Bun.sleep(30);
        }
        if (!fresh) throw Error('branch_not_reached');
        checks.oldDispatchProofRejected = oldDispatchRejected;
        checks.currentFreshCardExactSameExecution =
          fresh.sessionId === card.sessionId &&
          fresh.runId === card.runId &&
          fresh.executionId === card.executionId &&
          fresh.id !== card.id;
        try {
          await answer(card, 'late-original-answer');
        } catch {
          checks.lateAnswerRejected = true;
        }
        checks.zeroEffectAfterLateOldAnswer =
          !existsSync(target) &&
          (await store.getExecution(card.executionId!))?.authorization?.dispatched !== true;
        const currentCard = await client.getInteraction(fresh.presentationSessionId, fresh.id, {
          storeId: expectedStoreId,
        });
        checks.currentCardStillPendingAfterOldAnswer = currentCard.state === 'pending';
        await answer(fresh, 'approve-current');
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
        checks.effectOracle =
          existsSync(target) &&
          readFileSync(target, 'utf8') === body &&
          writes[0]?.status === 'succeeded' &&
          writes[0].authorization?.dispatched === true;
        checks.oneCurrentRevisionDispatch =
          successfulDispatches.filter((d) => d.executionId === card!.executionId).length === 1 &&
          successfulDispatches.some(
            (d) =>
              d.executionId === card!.executionId &&
              d.authorization?.interactionId === fresh!.id &&
              d.authorization?.controlReads?.some(
                (r) =>
                  r.kind === 'permission.mode' &&
                  r.scope === 'session:s' &&
                  r.revision === currentRevision,
              ),
          );
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
      releaseDispatch();
      releaseReview();
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
        id === 'P08-grant-revision'
          ? 'durable_once_grant_old_revision_rejected'
          : 'real_review_output_late_after_mode_change',
        'same_exact_execution_fresh_human_approval_once',
        'default_policy_real_root_child',
        'no_other_grant_or_review_race_coverage',
      ],
    });
  }
  return { cases };
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_GRANT_RACES !== '1')
    throw Error('live_collaboration_requires_KITE_RUN_LIVE_GRANT_RACES_1');
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
    group: 'grant-races',
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
    const result = await runLiveGrantRaces({
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
