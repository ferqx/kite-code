import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';

export interface LivePermissionResult {
  id: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'blocked';
  checks: Record<string, boolean | number>;
  canonicalEvidenceRetained: boolean;
  reason?:
    | 'branch_not_reached'
    | 'oracle_violation'
    | 'execution_unavailable'
    | 'child_adapter_injection_unavailable'
    | 'cleanup_failed';
}
export interface LivePermissionOptions {
  model: ModelAdapter;
  modelId: string;
  caseIds?: readonly string[];
  evidenceRoot?: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
}

/** Real-model root policy checks. No credentials, remote invocation, or fixed authorization here. */
export async function runLiveCollaborationPermissions(
  options: LivePermissionOptions,
): Promise<{ cases: LivePermissionResult[] }> {
  const cases: LivePermissionResult[] = [];
  const variants = ['approve', 'deny', 'relax', 'tighten', 'untrusted'] as const;
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) ||
      variants.filter(
        (variant) => !options.caseIds || options.caseIds.includes(`permissions-${variant}`),
      ).length !== 1)
  )
    throw Error('live_collaboration_evidence_root_invalid');
  for (const variant of variants) {
    if (options.caseIds && !options.caseIds.includes(`permissions-${variant}`)) continue;
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-permission-')),
    );
    const checks: Record<string, boolean | number> = {};
    const id = `permissions-${variant}`;
    let reason: LivePermissionResult['reason'];
    let status: LivePermissionResult['status'] = 'inconclusive';
    let canonicalEvidenceRetained = false;
    const requestStart = options.requests().length;
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
      const target = join(root, 'external-marker.txt');
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
          tools: [{ id: 'files.write_path' }],
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
      let tightenBeforeTool: (() => Promise<void>) | undefined;
      const liveModel: ModelAdapter = {
        async *stream(request, context) {
          options.signal.throwIfAborted();
          for await (const event of options.model.stream(request, context)) {
            options.signal.throwIfAborted();
            if (event.type === 'tool_call' && tightenBeforeTool) {
              const apply = tightenBeforeTool;
              tightenBeforeTool = undefined;
              await apply();
            }
            yield event;
          }
        },
      };
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      ownedStore = store;
      const locks = createWorkspaceSerialLocks(profile);
      ownedLocks = locks;
      const runtime = createRuntime({
        ...host,
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        resolveRunConfiguration: async (input) => {
          const binding = await host.resolveRunConfiguration!(input);
          return {
            ...binding,
            model: liveModel,
            permissions: {
              ...binding.permissions!,
              async authorize(request) {
                // A restrictive test-target ceiling, followed by the unchanged default policy.
                if (
                  request.kind === 'tool' &&
                  (request.definitionId !== 'files.write_path' ||
                    !request.input ||
                    typeof request.input !== 'object' ||
                    Array.isArray(request.input) ||
                    request.input.path !== target)
                )
                  return {
                    allowed: false,
                    revision: 'owned-target-only-1',
                    reason: 'live_target_out_of_scope',
                  };
                return binding.permissions!.authorize(request);
              },
            },
          };
        },
      });
      ownedRuntime = runtime;
      const controls = host.permissionManagement!(runtime);
      const expectedStoreId = (await store.getMetadata()).storeId;
      const service = await startService({
        runtime,
        subjectId: 'live-owner',
        buildId: 'live-permissions',
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
          requiredCapabilities: ['commands', 'interactions', 'sessions'],
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
        title: 'Explicit live permission test',
      });
      const scope = { expectedStoreId, subjectId: 'live-owner' };
      let mutations = 0;
      const setMode = async (mode: 'accept_edits' | 'full') => {
        const state = await controls.readMode({ ...scope, sessionId: 's' });
        const result = await controls.setMode({
          ...scope,
          sessionId: 's',
          commandId: `mode-${++mutations}`,
          mode,
          ifRevision: state.revision,
          ifDefaultRevision: state.defaultRevision,
          makeDefault: false,
        });
        if (result.state !== 'applied') throw Error('mode_not_applied');
      };
      await setMode(variant === 'tighten' || variant === 'untrusted' ? 'full' : 'accept_edits');
      const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
      const trustMutation = await controls.setTrust({
        ...scope,
        workspaceId: 'w',
        commandId: 'trust',
        trusted: variant !== 'untrusted',
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
      if (trustMutation.state !== 'applied') throw Error('trust_not_applied');
      if (variant === 'tighten') tightenBeforeTool = () => setMode('accept_edits');
      const content = `marker-${crypto.randomUUID()}`;
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: `New task: Use write_user_file to create exactly ${JSON.stringify(target)} with content ${JSON.stringify(content)} and base null. This is a synthetic permission test. Do not use other paths or tools. Do not claim success without a successful Tool result. If denied, report that fact and stop.`,
      });
      type Card = Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number];
      let firstCard: Card | undefined;
      let reached = false;
      let answered = false;
      const end = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const cards = (
          await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
        ).interactions;
        const card = cards.find((entry) => entry.kind === 'approval');
        if (card && !answered && variant !== 'untrusted') {
          reached = true;
          firstCard = card;
          checks.noEffectBeforeDecision = !existsSync(target);
          if (variant === 'relax') await setMode('full');
          else
            await client.answerInteraction('s', card.id, {
              expectedStoreId,
              commandId: 'answer',
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: variant === 'deny' ? 'deny' : 'approve' },
            });
          answered = true;
        }
        const view = await client.getView('s');
        const tools = view.executions.filter((entry) => entry.kind === 'tool');
        if (tools.some((entry) => entry.definitionId === 'files.write_path')) reached = true;
        if (
          view.runs.length &&
          view.runs.every((entry) =>
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.status),
          )
        )
          break;
        if (Date.now() >= end) break;
        await Bun.sleep(25);
      }
      const view = await client.getView('s');
      const writes = view.executions.filter(
        (entry) => entry.kind === 'tool' && entry.definitionId === 'files.write_path',
      );
      checks.actualRequests = options.requests().length - requestStart;
      checks.toolAttempts = writes.length;
      const durableWrites = (await store.listExecutions('s')).filter(
        (entry) => entry.kind === 'tool' && entry.definitionId === 'files.write_path',
      );
      checks.exactTarget =
        durableWrites.length === 1 &&
        !!durableWrites[0]?.input &&
        typeof durableWrites[0].input === 'object' &&
        !Array.isArray(durableWrites[0].input) &&
        durableWrites[0].input.path === target &&
        durableWrites[0].input.content === content &&
        durableWrites[0].input.base === null;
      checks.dispatchedExactlyOne =
        durableWrites.length === 1 && durableWrites[0]?.authorization?.dispatched === true;
      const deniedResult = durableWrites[0]?.result;
      const deniedDetails =
        deniedResult && typeof deniedResult === 'object' && !Array.isArray(deniedResult)
          ? deniedResult.details
          : null;
      checks.expectedHardDenial =
        durableWrites.length === 1 &&
        durableWrites[0]?.status === 'failed' &&
        !!deniedResult &&
        typeof deniedResult === 'object' &&
        !Array.isArray(deniedResult) &&
        deniedResult.outcome === 'failed' &&
        deniedResult.content === 'permission_denied' &&
        !!deniedDetails &&
        typeof deniedDetails === 'object' &&
        !Array.isArray(deniedDetails) &&
        deniedDetails.reason === 'workspace_untrusted' &&
        deniedDetails.adapterAttempted === false &&
        deniedDetails.dispatchCommitted === false;
      checks.cardBoundToTarget = !firstCard || firstCard.executionId === durableWrites[0]?.id;
      checks.zeroDispatch = durableWrites.every(
        (entry) => entry.authorization?.dispatched !== true,
      );
      checks.noUnknownTool = durableWrites.every((entry) => entry.status !== 'outcome_unknown');
      checks.exactlyOneInvocation = writes.length === 1;
      checks.settled =
        view.runs.length > 0 &&
        view.runs.every((entry) =>
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.status),
        );
      checks.noUnexpectedTool = view.executions
        .filter((entry) => entry.kind === 'tool')
        .every((entry) => entry.definitionId === 'files.write_path');
      checks.successfulTool = writes.length === 1 && writes[0]?.status === 'succeeded';
      checks.exactEffect = existsSync(target) && readFileSync(target, 'utf8') === content;
      checks.noEffect = !existsSync(target);
      checks.businessCompleted = view.runs.some((entry) => entry.status === 'completed');
      checks.modeRetained =
        (await controls.readMode({ ...scope, sessionId: 's' })).mode ===
        (variant === 'relax' || variant === 'untrusted' ? 'full' : 'accept_edits');
      if (variant === 'relax' && firstCard) {
        const before = existsSync(target) ? statSync(target) : null;
        try {
          await client.answerInteraction('s', firstCard.id, {
            expectedStoreId,
            commandId: 'old-answer',
            expectedRevision: firstCard.revision,
            answer: { kind: 'approval', decision: 'approve' },
          });
        } catch {
          /* Rejected stale answer is expected. Inspect actual effects below. */
        }
        const after = existsSync(target) ? statSync(target) : null;
        checks.oldAnswerPreservesPhysicalFile =
          !!before &&
          !!after &&
          before.ino === after.ino &&
          before.mtimeMs === after.mtimeMs &&
          before.size === after.size &&
          readFileSync(target, 'utf8') === content;
        checks.oldCardInactive =
          (await client.getInteraction('s', firstCard.id, { storeId: expectedStoreId })).state !==
          'pending';
        checks.oldAnswerNoExtraExecution =
          (await client.getView('s')).executions.filter(
            (entry) => entry.kind === 'tool' && entry.definitionId === 'files.write_path',
          ).length === writes.length;
      }
      if (
        !reached ||
        !checks.actualRequests ||
        !checks.settled ||
        ((variant === 'approve' ||
          variant === 'deny' ||
          variant === 'relax' ||
          variant === 'tighten') &&
          !firstCard)
      )
        reason = 'branch_not_reached';
      else {
        const expectedEffect = variant !== 'deny' && variant !== 'untrusted';
        const passed =
          checks.modeRetained &&
          checks.settled &&
          checks.exactlyOneInvocation &&
          checks.noUnexpectedTool &&
          checks.exactTarget &&
          checks.cardBoundToTarget &&
          (variant !== 'untrusted' || checks.expectedHardDenial) &&
          checks.noUnknownTool &&
          (expectedEffect
            ? checks.exactEffect &&
              checks.businessCompleted &&
              checks.successfulTool &&
              checks.dispatchedExactlyOne
            : checks.noEffect && checks.zeroDispatch) &&
          (variant === 'untrusted' || checks.noEffectBeforeDecision) &&
          (variant !== 'relax' ||
            (checks.oldAnswerNoExtraExecution &&
              checks.oldCardInactive &&
              checks.oldAnswerPreservesPhysicalFile));
        status = passed ? 'passed' : 'failed';
        if (!passed) reason = 'oracle_violation';
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
    cases.push({ id, status, checks, canonicalEvidenceRetained, ...(reason ? { reason } : {}) });
  }
  if (!options.caseIds || options.caseIds.includes('permissions-descendant-and-readonly-ceiling'))
    cases.push({
      id: 'permissions-descendant-and-readonly-ceiling',
      status: 'blocked',
      checks: {},
      reason: 'child_adapter_injection_unavailable',
      canonicalEvidenceRetained: false,
    });
  return { cases };
}
