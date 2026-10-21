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

export interface LiveTreePermissionOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
export interface LiveTreePermissionResult {
  id: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'blocked';
  checks: Record<string, boolean | number>;
  coverage: string[];
  canonicalEvidenceRetained: boolean;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
}
const ids = [
  'tree-two-child-exact-approval',
  'tree-descendant-mode-relax',
  'tree-descendant-mode-tighten',
  'tree-queued-mode-relax',
] as const;

/** Formal default policy and resolver injection: every actual root/child/review uses the caller's adapter. */
export async function runLiveTreePermissions(
  options: LiveTreePermissionOptions,
): Promise<{ cases: LiveTreePermissionResult[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (options.evidenceRoot && (!isAbsolute(options.evidenceRoot) || selected.length !== 1))
    throw Error('live_collaboration_evidence_root_invalid');
  const cases: LiveTreePermissionResult[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-tree-permission-')),
    );
    let status: LiveTreePermissionResult['status'] = 'inconclusive';
    let reason: LiveTreePermissionResult['reason'];
    let canonicalEvidenceRetained = false;
    const requestStart = options.requests().length;
    const tree = id === 'tree-descendant-mode-relax' || id === 'tree-descendant-mode-tighten';
    const coverage = tree
      ? [
          'real_root_child_grandchild',
          'original_waiting_leaf',
          'current_root_mode',
          'no_idle_reuse_coverage',
          'no_auto_review_coverage',
        ]
      : id === 'tree-queued-mode-relax'
        ? ['real_two_children', 'queued_activation_current_mode', 'no_idle_reuse_coverage']
        : [
            'real_two_children',
            'exact_single_approval',
            'sibling_remains_pending',
            'no_grandchild_grant_coverage',
          ];
    const checks: Record<string, boolean | number> = {};
    let ownedStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let ownedLocks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
    let ownedRuntime: ReturnType<typeof createRuntime> | undefined;
    let ownedService: Awaited<ReturnType<typeof startService>> | undefined;
    let ownedClient: ReturnType<typeof createClient> | undefined;
    let locksClose: Promise<void> | undefined;
    const closeLocks = () => {
      if (!ownedLocks) return Promise.resolve();
      locksClose ??= ownedLocks.close();
      return locksClose;
    };
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      const targets = [join(root, 'external-A.txt'), join(root, 'external-B.txt')];
      const bodies = targets.map(() => `live-${crypto.randomUUID()}`);
      const configurationPath = join(profile.profilePath, 'config.jsonc');
      writeFileSync(
        configurationPath,
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
          ].map((toolId) => ({ id: toolId })),
        }),
        { mode: 0o600 },
      );
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: configurationPath,
        authorizationReview: {
          id: 'live.review',
          version: '1',
          modelId: options.modelId,
          model: options.model,
        },
      });
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      ownedStore = store;
      const dispatches: Parameters<typeof store.markDispatching>[0][] = [];
      const observedStore = new Proxy(store, {
        get(target, key) {
          if (key === 'markDispatching')
            return async (input: Parameters<typeof store.markDispatching>[0]) => {
              const result = await target.markDispatching(input);
              dispatches.push(structuredClone(input));
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const locks = createWorkspaceSerialLocks(profile);
      ownedLocks = locks;
      let tighten: (() => Promise<void>) | undefined;
      let tightenedAtRealCall = false;
      const model: ModelAdapter = {
        async *stream(request, context) {
          options.signal.throwIfAborted();
          for await (const event of options.model.stream(request, context)) {
            options.signal.throwIfAborted();
            if (event.type === 'tool_call' && event.name === 'write_user_file' && tighten) {
              const apply = tighten;
              tighten = undefined;
              await apply();
              tightenedAtRealCall = true;
            }
            yield event;
          }
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
                typeof input.path !== 'string' ||
                !targets.includes(input.path)
              )
                return {
                  allowed: false,
                  revision: 'owned-tree-target-only-1',
                  reason: 'live_target_out_of_scope',
                };
            }
            return binding.permissions!.authorize(request);
          },
        },
      });
      const runtime = createRuntime({
        ...host,
        store: observedStore,
        artifacts: createArtifactStore({ profile, store }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        maxConcurrentSubagents: id === 'tree-queued-mode-relax' ? 1 : 3,
        resolveRunConfiguration: async (input) =>
          inject(await host.resolveRunConfiguration!(input)),
        resolveChildRunConfiguration: async (input) =>
          inject(await host.resolveChildRunConfiguration!(input)),
      });
      ownedRuntime = runtime;
      const controls = host.permissionManagement!(runtime);
      const expectedStoreId = (await store.getMetadata()).storeId;
      // The public Session directory contains roots only. Follow actual child carriers,
      // verifying every edge rather than guessing IDs or relying on card projections.
      async function treeSessions() {
        const rootSession = await store.getSession('s');
        if (
          !rootSession ||
          rootSession.parentSessionId !== null ||
          rootSession.rootSessionId !== 's'
        )
          throw Error('live_collaboration_root_relation_invalid');
        const sessions = [rootSession];
        const seen = new Set([rootSession.id]);
        for (let index = 0; index < sessions.length; index++) {
          const parent = sessions[index]!;
          for (const carrier of await store.listExecutions(parent.id)) {
            if (!carrier.childSessionId) continue;
            const child = await store.getSession(carrier.childSessionId);
            if (
              !child ||
              child.id === parent.id ||
              child.parentSessionId !== parent.id ||
              child.rootSessionId !== rootSession.id ||
              child.workspaceId !== rootSession.workspaceId ||
              carrier.sessionId !== parent.id ||
              carrier.originStoreId !== expectedStoreId
            )
              throw Error('live_collaboration_child_relation_invalid');
            if (seen.has(child.id)) continue;
            if (sessions.length >= 64) throw Error('live_collaboration_tree_observation_limit');
            seen.add(child.id);
            sessions.push(child);
          }
        }
        return sessions;
      }

      const service = await startService({
        runtime,
        subjectId: 'live-owner',
        buildId: 'live-tree-permissions',
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        beforeResourceClose: closeLocks,
      });
      ownedService = service;
      const client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile: service.bootstrap.profile,
          apiMajor: 1,
          requiredCapabilities: ['commands', 'sessions', 'interactions'],
        },
      });
      ownedClient = client;
      await client.connect();
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'synthetic',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Explicit live tree permission test',
      });
      const scope = { expectedStoreId, subjectId: 'live-owner' };
      let mutation = 0;
      const setMode = async (mode: 'full' | 'accept_edits') => {
        const state = await controls.readMode({ ...scope, sessionId: 's' });
        const result = await controls.setMode({
          ...scope,
          sessionId: 's',
          commandId: `mode-${++mutation}`,
          mode,
          makeDefault: false,
          ifRevision: state.revision,
          ifDefaultRevision: state.defaultRevision,
        });
        if (result.state !== 'applied') throw Error('mode_not_applied');
        return controls.readMode({ ...scope, sessionId: 's' });
      };
      await setMode(id === 'tree-descendant-mode-tighten' ? 'full' : 'accept_edits');
      const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
      const trustResult = await controls.setTrust({
        ...scope,
        workspaceId: 'w',
        commandId: 'trust',
        trusted: true,
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
      if (trustResult.state !== 'applied') throw Error('trust_not_applied');
      if (id === 'tree-descendant-mode-tighten')
        tighten = async () => {
          await setMode('accept_edits');
        };
      const leaf = (index: number) =>
        `Use write_user_file exactly once to create ${JSON.stringify(targets[index])} with content ${JSON.stringify(bodies[index])} and base null. Do not use other paths or tools. If denied, report denial and stop; do not retry or create replacement collaborators. Report actual Tool outcome, not assumed success.`;
      const prompt = tree
        ? `New task: Create exactly one collaborator using spawn_agent with only prompt and no preset. In its prompt instruct it to create exactly one further collaborator using spawn_agent with only prompt and no preset. Do not choose code, explore, or any other preset at either level. ONLY that final grandchild performs this task: ${leaf(0)} The intermediate child must NOT write files itself. Each parent should wait for its own collaborator through wait_agent_events and report actual outcomes. Do not create any other collaborators.`
        : `New task: Create exactly two independent collaborators using spawn_agent with only prompt and no preset, one for task A and one for task B. Do not choose code, explore, or any other preset. Task A: ${leaf(0)} Task B: ${leaf(1)} You must not write files yourself. Create both before waiting; use wait_agent_events to collect actual outcomes. Do not retry denied work or replace a collaborator.`;
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: prompt,
      });
      type Card = Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number];
      let chosen: Card | undefined;
      let sibling: Card | undefined;
      let controlled = false;
      let siblingDenied = false;
      let currentModeRevision: string | undefined;
      let originalLeafRun: string | null | undefined;
      const end = Date.now() + 150_000;
      for (;;) {
        options.signal.throwIfAborted();
        const sessions = await treeSessions();
        const allCards = (
          await Promise.all(
            sessions.map((session) =>
              client.listInteractions(session.id, { storeId: expectedStoreId, state: 'pending' }),
            ),
          )
        ).flatMap((page) => page.interactions);
        const cards = [
          ...new Map(
            allCards
              .filter(
                (card) => card.kind === 'approval' && card.definitionId === 'files.write_path',
              )
              .map((card) => [card.id, card]),
          ).values(),
        ];
        const durable = (
          await Promise.all(sessions.map((session) => store.listExecutions(session.id)))
        ).flat();
        if (!controlled) {
          if (
            id === 'tree-two-child-exact-approval' &&
            cards.length === 2 &&
            cards[0]!.sessionId !== cards[1]!.sessionId
          ) {
            chosen = cards[0];
            sibling = cards[1];
            checks.zeroEffectsBeforeApproval = targets.every((target) => !existsSync(target));
            await client.answerInteraction(chosen!.presentationSessionId, chosen!.id, {
              expectedStoreId,
              commandId: 'approve-one',
              expectedRevision: chosen!.revision,
              answer: { kind: 'approval', decision: 'approve' },
            });
            controlled = true;
          } else if (tree && cards.some((card) => card.ancestry.length >= 3)) {
            chosen = cards.find((card) => card.ancestry.length >= 3)!;
            originalLeafRun = chosen.runId;
            checks.zeroEffectsBeforeModeDecision = targets.every((target) => !existsSync(target));
            if (id === 'tree-descendant-mode-relax')
              currentModeRevision = (await setMode('full')).revision;
            else {
              currentModeRevision = (await controls.readMode({ ...scope, sessionId: 's' }))
                .revision;
              await client.answerInteraction(chosen.presentationSessionId, chosen.id, {
                expectedStoreId,
                commandId: 'approve-current-mode',
                expectedRevision: chosen.revision,
                answer: { kind: 'approval', decision: 'approve' },
              });
            }
            controlled = true;
          } else if (
            id === 'tree-queued-mode-relax' &&
            cards.length === 1 &&
            durable.some(
              (execution) =>
                execution.kind === 'job' &&
                !!execution.childSessionId &&
                execution.childSessionId !== cards[0]!.sessionId,
            )
          ) {
            chosen = cards[0];
            checks.queuedObserved = durable.some(
              (execution) =>
                execution.childSessionId &&
                execution.childSessionId !== chosen!.sessionId &&
                !durable.some(
                  (other) => other.sessionId === execution.childSessionId && other.kind === 'model',
                ),
            );
            if (checks.queuedObserved) {
              checks.zeroEffectsBeforeModeDecision = targets.every((target) => !existsSync(target));
              currentModeRevision = (await setMode('full')).revision;
              controlled = true;
            }
          }
        }
        if (id === 'tree-two-child-exact-approval' && chosen && sibling && !siblingDenied) {
          const exact = durable.find((execution) => execution.id === chosen!.executionId);
          if (exact?.status === 'succeeded') {
            const other = durable.find((execution) => execution.id === sibling!.executionId);
            const otherPath =
              other?.input && typeof other.input === 'object' && !Array.isArray(other.input)
                ? other.input.path
                : null;
            const currentCard = await client.getInteraction(
              sibling.presentationSessionId,
              sibling.id,
              { storeId: expectedStoreId },
            );
            checks.onlyChosenDispatched =
              exact.authorization?.dispatched === true && other?.authorization?.dispatched !== true;
            checks.siblingPendingWithoutEffect =
              currentCard.state === 'pending' &&
              typeof otherPath === 'string' &&
              !existsSync(otherPath);
            await client.answerInteraction(sibling.presentationSessionId, sibling.id, {
              expectedStoreId,
              commandId: 'deny-other',
              expectedRevision: sibling.revision,
              answer: { kind: 'approval', decision: 'deny' },
            });
            siblingDenied = true;
          }
        }
        const views = await Promise.all(sessions.map((session) => client.getView(session.id)));
        const settled =
          views.length > 0 &&
          views.every((view) =>
            view.runs.every((run) =>
              ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status),
            ),
          );
        const carriersSettled = durable
          .filter((execution) => execution.kind === 'job' && execution.childSessionId)
          .every((execution) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status),
          );
        if (controlled && settled && carriersSettled) break;
        if (Date.now() >= end) break;
        await Bun.sleep(30);
      }
      const sessions = await treeSessions();
      const executions = (
        await Promise.all(sessions.map((session) => store.listExecutions(session.id)))
      ).flat();
      const views = await Promise.all(sessions.map((session) => client.getView(session.id)));
      const writes = executions.filter(
        (execution) => execution.kind === 'tool' && execution.definitionId === 'files.write_path',
      );
      checks.actualRequests = options.requests().length - requestStart;
      checks.realModelSessions = new Set(
        executions
          .filter((execution) => execution.kind === 'model' && execution.status === 'succeeded')
          .map((execution) => execution.sessionId),
      ).size;
      checks.rootNeverWrote = writes.every((execution) => execution.sessionId !== 's');
      checks.exactWriteInputs = writes.every((execution) => {
        if (
          !execution.input ||
          typeof execution.input !== 'object' ||
          Array.isArray(execution.input)
        )
          return false;
        const index = targets.indexOf(String(execution.input.path));
        return (
          index >= 0 && execution.input.content === bodies[index] && execution.input.base === null
        );
      });
      checks.settled = views.every((view) =>
        view.runs.every((run) =>
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status),
        ),
      );
      checks.settled =
        checks.settled &&
        executions
          .filter((execution) => execution.kind === 'job' && execution.childSessionId)
          .every((execution) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status),
          );
      checks.noUnknownTool = writes.every((execution) => execution.status !== 'outcome_unknown');
      checks.childCount = sessions.length - 1;
      checks.finalDispatchCurrentModeProof = writes
        .filter((execution) => execution.authorization?.dispatched)
        .every((execution) =>
          dispatches.some(
            (dispatch) =>
              dispatch.executionId === execution.id &&
              dispatch.authorization?.controlReads?.some(
                (read) =>
                  read.kind === 'permission.mode' &&
                  read.scope === 'session:s' &&
                  read.revision === currentModeRevision,
              ),
          ),
        );
      checks.writeCount = writes.length;
      checks.physicalEffectsExact = targets.every(
        (target, index) => !existsSync(target) || readFileSync(target, 'utf8') === bodies[index],
      );
      checks.noUnknownCarrier = executions
        .filter((execution) => execution.kind === 'job' && execution.childSessionId)
        .every((execution) => execution.status !== 'outcome_unknown');
      if (tree) {
        const leafSession = sessions.find((session) => session.id === chosen?.sessionId);
        const middleSession = sessions.find(
          (session) => session.id === leafSession?.parentSessionId,
        );
        checks.exactThreeLevelTree =
          !!leafSession &&
          !!middleSession &&
          middleSession.parentSessionId === 's' &&
          sessions.length === 3;
        checks.originalLeafRun = writes.length === 1 && writes[0]?.runId === originalLeafRun;
        checks.oneDispatchedEffect =
          writes.length === 1 &&
          writes[0]?.status === 'succeeded' &&
          writes[0].authorization?.dispatched === true &&
          existsSync(targets[0]!) &&
          readFileSync(targets[0]!, 'utf8') === bodies[0];
        checks.allDescendantsCurrentMode = (
          await Promise.all(
            sessions.map((session) => controls.readMode({ ...scope, sessionId: session.id })),
          )
        ).every(
          (state) =>
            state.revision === currentModeRevision &&
            state.scopeSessionId === 's' &&
            state.mode === (id === 'tree-descendant-mode-relax' ? 'full' : 'accept_edits'),
        );
        checks.tightenedAtRealCall = tightenedAtRealCall;
      } else if (id === 'tree-queued-mode-relax') {
        checks.bothEffects =
          writes.length === 2 &&
          writes.every(
            (execution) =>
              execution.status === 'succeeded' && execution.authorization?.dispatched === true,
          ) &&
          targets.every(
            (target, index) => existsSync(target) && readFileSync(target, 'utf8') === bodies[index],
          );
        checks.allDescendantsCurrentMode = (
          await Promise.all(
            sessions.map((session) => controls.readMode({ ...scope, sessionId: session.id })),
          )
        ).every(
          (state) =>
            state.revision === currentModeRevision &&
            state.mode === 'full' &&
            state.scopeSessionId === 's',
        );
      } else
        checks.oneEffectOnly =
          writes.length === 2 &&
          writes.filter((execution) => execution.authorization?.dispatched).length === 1 &&
          targets.filter((target) => existsSync(target)).length === 1;
      if (!controlled || !checks.settled || !checks.actualRequests) reason = 'branch_not_reached';
      else {
        const common =
          checks.rootNeverWrote &&
          checks.childCount === 2 &&
          checks.physicalEffectsExact &&
          checks.noUnknownCarrier &&
          checks.exactWriteInputs &&
          checks.noUnknownTool &&
          checks.realModelSessions === 3;
        const specific = tree
          ? checks.exactThreeLevelTree &&
            checks.originalLeafRun &&
            checks.oneDispatchedEffect &&
            checks.finalDispatchCurrentModeProof &&
            checks.allDescendantsCurrentMode &&
            checks.zeroEffectsBeforeModeDecision &&
            (id !== 'tree-descendant-mode-tighten' || checks.tightenedAtRealCall)
          : id === 'tree-queued-mode-relax'
            ? checks.queuedObserved &&
              checks.bothEffects &&
              checks.finalDispatchCurrentModeProof &&
              checks.allDescendantsCurrentMode &&
              checks.zeroEffectsBeforeModeDecision
            : checks.zeroEffectsBeforeApproval &&
              checks.onlyChosenDispatched &&
              checks.siblingPendingWithoutEffect &&
              siblingDenied &&
              checks.oneEffectOnly;
        status = common && specific ? 'passed' : 'failed';
        if (status === 'failed') reason = 'oracle_violation';
      }
    } catch {
      reason = 'execution_unavailable';
    } finally {
      let cleanupFailed = false;
      let runtimeClosed = false;
      try {
        ownedClient?.disposeNetwork();
      } catch {
        cleanupFailed = true;
      }
      if (ownedService) {
        try {
          // Service owns Runtime shutdown, which closes its Store, and invokes closeLocks.
          await ownedService.close();
          runtimeClosed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (!runtimeClosed && ownedRuntime) {
        try {
          await ownedRuntime.close();
          runtimeClosed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (!runtimeClosed && ownedStore) {
        try {
          // Store.close shares its existing close promise if shutdown reached it already.
          await ownedStore.close();
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await closeLocks();
      } catch {
        cleanupFailed = true;
      }
      checks.resourcesClosed = !cleanupFailed;
      if (cleanupFailed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      canonicalEvidenceRetained = status !== 'passed' && (!!options.evidenceRoot || cleanupFailed);
      if (!canonicalEvidenceRetained) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          checks.resourcesClosed = false;
          status = 'failed';
          reason = 'cleanup_failed';
          canonicalEvidenceRetained = existsSync(root);
        }
      }
    }
    cases.push({
      id,
      status,
      checks,
      coverage,
      canonicalEvidenceRetained,
      ...(reason ? { reason } : {}),
    });
  }
  return { cases };
}
