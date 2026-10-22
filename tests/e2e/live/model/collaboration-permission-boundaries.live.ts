import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
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
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

const ids = [
  'P10-mode-committed-response-loss-original-child',
  'P10-current-policy-read-failure-before-dispatch',
] as const;
export type LivePermissionBoundaryCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
class Boundary extends Error {
  readonly category: 'branch_not_hit' | 'oracle';
  readonly stage: string;
  constructor(category: 'branch_not_hit' | 'oracle', stage: string) {
    super('live_permission_boundary');
    this.category = category;
    this.stage = stage;
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Formal default persisted policy; owned transport loss or original policy-read error only. */
export async function runLivePermissionBoundaries(options: Options) {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    selected.length === 0 ||
    (options.evidenceRoot && (!isAbsolute(options.evidenceRoot) || selected.length !== 1))
  )
    throw Error('live_permission_boundary_case_invalid');
  const cases = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    const root =
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-permission-boundary-'));
    if (options.evidenceRoot) mkdirSync(root, { mode: 0o700 });
    const canonicalRoot = realpathSync(root);
    const workspace = join(canonicalRoot, 'workspace');
    const target = join(canonicalRoot, 'external-marker.txt');
    const body = `owned-P10-${crypto.randomUUID()}`;
    const checks: Record<string, boolean | number> = {};
    const observed: Record<string, string | boolean | number | null> = {};
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
    let proxy: Server | undefined;
    const cleanup = new AbortController();
    const authorizationContext = new AsyncLocalStorage<string>();
    const forward = new AbortController();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let held:
      | Parameters<Awaited<ReturnType<typeof openSqliteStore>>['markDispatching']>[0]
      | undefined;
    let heldExecutionId: string | undefined;
    let failPolicy = false;
    let actualPolicyReadFailures = 0;
    let rejectedOldDispatch = false;
    let closing = false;
    let modeDropArmed = false;
    let droppedResponses = 0;
    let modeMutationPosts = 0;
    let originalCommittedResponse: unknown;
    const dispatches: Parameters<
      Awaited<ReturnType<typeof openSqliteStore>>['markDispatching']
    >[0][] = [];
    let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
    let failureStage = 'setup';
    let failureCategory: string | null = null;
    const requestStart = options.requests().length;
    let locksClose: Promise<void> | undefined;
    const closeLocks = () => (locksClose ??= Promise.resolve().then(() => locks?.close()));
    const assert = (condition: unknown, stage: string) => {
      if (!condition) throw new Boundary('oracle', stage);
      checks[stage] = true;
    };
    const until = async <T>(
      load: () => Promise<T | undefined>,
      stage: string,
      ms = 90_000,
    ): Promise<T> => {
      failureStage = stage;
      const end = Date.now() + ms;
      for (;;) {
        options.signal.throwIfAborted();
        const value = await load();
        if (value !== undefined) {
          checks[stage] = true;
          return value;
        }
        if (Date.now() >= end) throw new Boundary('branch_not_hit', stage);
        await Bun.sleep(30);
      }
    };
    try {
      mkdirSync(workspace, { mode: 0o700 });
      const profile = selectProfile({ dataRoot: join(canonicalRoot, 'data'), profile: 'live' });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
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
            'files.write_path',
            'task.spawn',
            'task.events',
            'task.list',
            'task.message',
            'task.follow_up',
            'task.interrupt',
          ].map((id) => ({ id })),
        }),
        { mode: 0o600 },
      );
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: configPath,
        authorizationCheck: {
          id: 'live.review',
          version: '1',
          modelId: options.modelId,
          model: options.model,
        },
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const actualStore = store;
      const instrumentedStore = new Proxy(actualStore, {
        get(targetStore, key) {
          if (key === 'readHostControl')
            return async (input: Parameters<typeof targetStore.readHostControl>[0]) => {
              // Only an actual default-policy read for this precise original child Tool fails.
              // AsyncLocalStorage prevents a concurrent root Model/management read from borrowing it.
              if (
                failPolicy &&
                heldExecutionId &&
                authorizationContext.getStore() === heldExecutionId &&
                input.kind === 'permission.mode' &&
                input.scope === 'session:s'
              ) {
                actualPolicyReadFailures++;
                throw Error('owned_current_policy_read_failure');
              }
              return targetStore.readHostControl(input);
            };
          if (key === 'markDispatching')
            return async (input: Parameters<typeof targetStore.markDispatching>[0]) => {
              const execution = await targetStore.getExecution(input.executionId);
              if (
                !held &&
                execution?.kind === 'tool' &&
                execution.definitionId === 'files.write_path' &&
                execution.sessionId !== 's'
              ) {
                held = structuredClone(input);
                heldExecutionId = input.executionId;
                await dispatchGate;
                if (closing) throw Error('owned_fixture_cleanup');
              }
              try {
                const result = await targetStore.markDispatching(input);
                if (execution?.kind === 'tool' && execution.definitionId === 'files.write_path')
                  dispatches.push(structuredClone(input));
                return result;
              } catch (error) {
                if (
                  input.executionId === heldExecutionId &&
                  (error as { code?: string }).code === 'permission_control_changed'
                )
                  rejectedOldDispatch = true;
                throw error;
              }
            };
          const value = Reflect.get(targetStore, key);
          return typeof value === 'function' ? value.bind(targetStore) : value;
        },
      });
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        stream(request, context) {
          return options.model.stream(request, {
            signal: AbortSignal.any([context.signal, options.signal, cleanup.signal]),
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
              const input = record(request.input);
              if (
                request.sessionId === 's' ||
                input.path !== target ||
                input.content !== body ||
                input.base !== null
              )
                return {
                  allowed: false,
                  revision: 'owned-P10-target-only',
                  reason: 'live_target_out_of_scope',
                };
            }
            return authorizationContext.run(request.executionId, () =>
              binding.permissions!.authorize(request),
            );
          },
        },
      });
      locks = createWorkspaceSerialLocks(profile);
      runtime = createRuntime({
        ...host,
        store: instrumentedStore,
        artifacts: createArtifactStore({ profile, store: actualStore }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        resolveRunConfiguration: async (input) =>
          inject(await host.resolveRunConfiguration!(input)),
        resolveChildRunConfiguration: async (input) =>
          inject(await host.resolveChildRunConfiguration!(input)),
        resolveRecoveryRunConfiguration: async (input) =>
          inject(await host.resolveRecoveryRunConfiguration!(input)),
      });
      const controls = host.permissionManagement!(runtime);
      const expectedStoreId = (await actualStore.getMetadata()).storeId;
      const scope = { expectedStoreId, subjectId: 'live-P10-owner' };
      service = await startService({
        runtime,
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        subjectId: scope.subjectId,
        buildId: 'live-permission-boundaries',
        permissionManagement: controls,
        beforeResourceClose: closeLocks,
      });
      const ownedService = service;
      // Actual local HTTP response loss: upstream Service commits and returns its own
      // complete response, then this private transport closes just that client socket.
      proxy = createServer(async (incoming, outgoing) => {
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of incoming) {
            const bytes = Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > 1024 * 1024) throw Error('owned_proxy_body_limit');
            chunks.push(bytes);
          }
          const payload = Buffer.concat(chunks);
          const path = incoming.url ?? '/';
          const method = incoming.method ?? 'GET';
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined && !['host', 'connection', 'content-length'].includes(key))
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const upstream = await fetch(`${ownedService.endpoint}${path}`, {
            method,
            headers,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: payload }),
            signal: forward.signal,
            redirect: 'error',
          });
          const bytes = new Uint8Array(await upstream.arrayBuffer());
          if (method === 'POST' && path === '/v1/sessions/s/permission-mode') {
            modeMutationPosts++;
            if (
              modeDropArmed &&
              record(JSON.parse(payload.toString('utf8'))).commandId === 'mode-change'
            ) {
              if (!upstream.ok) throw Error('owned_mode_commit_not_successful');
              originalCommittedResponse = JSON.parse(new TextDecoder().decode(bytes));
              observed.originalCommittedResponseSha256 = digest(bytes);
              observed.originalCommittedResponseBytes = bytes.byteLength;
              modeDropArmed = false;
              droppedResponses++;
              outgoing.destroy();
              return;
            }
          }
          outgoing.statusCode = upstream.status;
          upstream.headers.forEach((value, name) => {
            outgoing.setHeader(name, value);
          });
          outgoing.end(bytes);
        } catch {
          if (!outgoing.destroyed) outgoing.destroy();
        }
      });
      const proxyServer = proxy;
      await new Promise<void>((resolve, reject) => {
        proxyServer.once('error', reject);
        proxyServer.listen(0, '127.0.0.1', () => {
          proxyServer.off('error', reject);
          resolve();
        });
      });
      const proxyEndpoint = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
      client = createClient({
        endpoint: proxyEndpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: {
          profile: service.bootstrap.profile,
          apiMajor: 1,
          requiredCapabilities: ['commands', 'sessions', 'interactions', 'permission_controls'],
        },
      });
      const ownedClient = client;
      await ownedClient.connect();
      await ownedClient.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'synthetic',
        rootUri: pathToFileURL(workspace).href,
      });
      await ownedClient.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Live P10 formal policy boundary',
      });
      const setMode = async (mode: 'accept_edits' | 'full', commandId: string) => {
        const previous = await ownedClient.getPermissionMode('s', {
          storeId: expectedStoreId,
          signal: options.signal,
        });
        return {
          previous,
          intent: {
            expectedStoreId,
            commandId,
            mode,
            makeDefault: false,
            ifRevision: previous.revision,
            ifDefaultRevision: previous.defaultRevision,
          },
        };
      };
      const initialMode = await setMode(id === ids[0] ? 'accept_edits' : 'full', 'mode-initial');
      assert(
        (await ownedClient.setPermissionMode('s', initialMode.intent, { signal: options.signal }))
          .state === 'applied',
        'formal_initial_mode_applied',
      );
      const trust = await ownedClient.getWorkspaceTrust('w', {
        storeId: expectedStoreId,
        signal: options.signal,
      });
      assert(
        (
          await ownedClient.setWorkspaceTrust(
            'w',
            {
              expectedStoreId,
              commandId: 'trust',
              trusted: true,
              ifRevision: trust.revision,
              canonicalIdentity: trust.canonicalIdentity,
              externalReadScopeDigest: trust.externalReadScopeDigest,
            },
            { signal: options.signal },
          )
        ).state === 'applied',
        'formal_trust_applied',
      );
      await ownedClient.startRun(
        's',
        {
          expectedStoreId,
          commandId: 'work',
          kind: 'run.start',
          content: `New task: Use spawn_agent exactly once, prompt only and no preset, to delegate this complete child instruction as content: ${JSON.stringify(`Use write_user_file exactly once to create ${target} with content ${JSON.stringify(body)} and base null. Report the actual result and finish. If denied, failed or unknown do not retry, replace the action or delegate.`)}. Do not write yourself. Wait for the actual child result with wait_agent_events and report its truthful result; never repeat the task or follow up. Synthetic ${crypto.randomUUID()}.`,
        },
        { signal: options.signal },
      );
      const carrier = await until(async () => {
        const children = (await actualStore.listExecutions('s')).filter(
          (execution) => execution.childSessionId,
        );
        assert(children.length <= 1, 'one_original_child_only');
        return children[0]?.childSessionId ? children[0] : undefined;
      }, 'real_original_child_created');
      const leaf = carrier.childSessionId!;
      const child = await actualStore.getSession(leaf);
      assert(
        child?.parentSessionId === 's' && child.rootSessionId === 's',
        'exact_real_child_ancestry',
      );
      let oldCard: Awaited<ReturnType<typeof ownedClient.getInteraction>> | undefined;
      if (id === ids[0]) {
        oldCard = await until(
          async () =>
            (
              await ownedClient.listInteractions(leaf, {
                storeId: expectedStoreId,
                state: 'pending',
              })
            ).interactions.find(
              (card) => card.kind === 'approval' && card.definitionId === 'files.write_path',
            ),
          'real_child_original_pending_approval',
        );
        assert(
          oldCard.answer === null && !existsSync(target),
          'original_pending_has_no_answer_or_effect',
        );
      } else {
        await until(
          async () => (held ? true : undefined),
          'real_child_full_proof_held_before_dispatch',
        );
        const originalFull = await actualStore.readHostControl({
          ...scope,
          kind: 'permission.mode',
          scope: 'session:s',
        });
        assert(
          held?.authorization?.controlReads?.some(
            (read) =>
              read.kind === 'permission.mode' &&
              read.scope === 'session:s' &&
              read.revision === originalFull.revision,
          ) === true,
          'held_original_proof_reads_actual_full_revision',
        );
        assert(
          !existsSync(target) &&
            (await actualStore.getExecution(heldExecutionId!))?.authorization?.dispatched !== true,
          'held_old_full_has_zero_effect',
        );
      }
      const originalChildRunId =
        oldCard?.runId ?? (await actualStore.getExecution(heldExecutionId!))?.runId;
      if (!originalChildRunId)
        throw new Boundary('branch_not_hit', 'original_child_run_binding_missing');
      const originalChildRun = await actualStore.getRun(originalChildRunId);
      if (!originalChildRun?.isActive)
        throw new Boundary('branch_not_hit', 'original_child_run_not_active_at_boundary');
      const originalChildConfiguration = structuredClone(carrier.childConfiguration);
      const change = await setMode('full', 'mode-change');
      if (id === ids[0]) modeDropArmed = true;
      else failPolicy = true;
      let callerUnknown = false;
      try {
        const applied = await ownedClient.setPermissionMode('s', change.intent, {
          signal: options.signal,
        });
        if (id === ids[0]) throw new Boundary('oracle', 'dropped_response_was_received');
        assert(applied.state === 'applied', 'new_formal_full_revision_applied');
      } catch (error) {
        if (id !== ids[0] || (error as { code?: string }).code !== 'network_outcome_unknown')
          throw error;
        callerUnknown = true;
      }
      if (id === ids[0])
        assert(
          callerUnknown && droppedResponses === 1,
          'actual_transport_loss_stays_unknown_until_lookup',
        );
      const recovered = await ownedClient.getPermissionMutation('mode-change', {
        storeId: expectedStoreId,
        signal: options.signal,
      });
      const recoveredAgain = await ownedClient.getPermissionMutation('mode-change', {
        storeId: expectedStoreId,
        signal: options.signal,
      });
      assert(
        recovered.state === 'applied' &&
          recovered.commandId === 'mode-change' &&
          recovered.kind === 'permission.mode' &&
          record(recovered.receipt).mode === 'full',
        'exact_original_applied_mutation_found',
      );
      const revision = String(record(recovered.receipt).revision);
      assert(
        BigInt(revision) > BigInt(change.previous.revision) &&
          isDeepStrictEqual(recoveredAgain, recovered),
        'same_applied_revision_repeated_get_only',
      );
      if (id === ids[0])
        assert(
          isDeepStrictEqual(originalCommittedResponse, recovered),
          'lookup_equals_complete_original_committed_response',
        );
      assert(modeMutationPosts === 2, 'exactly_initial_and_change_posts_no_replay');
      if (id === ids[0]) {
        await until(
          async () => (held ? true : undefined),
          'original_waiter_woke_to_current_full_dispatch',
        );
        assert(
          held!.executionId === oldCard!.executionId &&
            held!.authorization?.controlReads?.some(
              (read) =>
                read.kind === 'permission.mode' &&
                read.scope === 'session:s' &&
                read.revision === revision,
            ),
          'original_exact_tool_new_current_revision_proof',
        );
        const savedCard = await ownedClient.getInteraction(
          oldCard!.presentationSessionId,
          oldCard!.id,
          { storeId: expectedStoreId },
        );
        assert(
          savedCard.answer === null && savedCard.state !== 'pending',
          'mode_invalidates_wait_without_fabricated_human_answer',
        );
        assert(!existsSync(target), 'effect_absent_before_original_current_dispatch');
      }
      releaseDispatch();
      await until(async () => {
        const own = await actualStore.getExecution(carrier.id);
        const views = await Promise.all(['s', leaf].map((session) => actualStore.getView(session)));
        return own &&
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(own.status) &&
          views.every((view) => view.runs.every((run) => !run.isActive))
          ? true
          : undefined;
      }, 'original_child_and_parent_settled');
      const writes = (await actualStore.listExecutions(leaf)).filter(
        (execution) => execution.kind === 'tool' && execution.definitionId === 'files.write_path',
      );
      assert(
        writes.length === 1 && writes[0]?.id === heldExecutionId,
        'one_original_write_invocation_no_retry',
      );
      assert(
        (await actualStore.listExecutions('s')).filter((execution) => execution.childSessionId)
          .length === 1 &&
          !(await actualStore.listExecutions('s')).some(
            (execution) => execution.definitionId === 'files.write_path',
          ),
        'no_replacement_child_or_parent_write',
      );
      const finalChildRuns = (await actualStore.getView(leaf)).runs;
      assert(
        finalChildRuns.length === 1 &&
          finalChildRuns[0]?.id === originalChildRunId &&
          writes[0]?.runId === originalChildRunId &&
          isDeepStrictEqual(finalChildRuns[0]?.configuration, originalChildRun.configuration),
        'mode_change_keeps_original_child_run_and_configuration',
      );
      assert(
        isDeepStrictEqual(
          (await actualStore.getExecution(carrier.id))?.childConfiguration,
          originalChildConfiguration,
        ),
        'mode_change_keeps_original_carrier_configuration',
      );
      const interactions = (
        await actualStore.listInteractions({ expectedStoreId, sessionId: leaf, limit: 100 })
      ).interactions;
      assert(
        interactions.every((card) => card.answer === null),
        'no_human_answer_was_fabricated',
      );
      if (id === ids[0]) {
        assert(
          writes[0]!.status === 'succeeded' &&
            writes[0]!.authorization?.dispatched === true &&
            existsSync(target) &&
            readFileSync(target, 'utf8') === body,
          'exact_once_current_mode_real_file_effect',
        );
        assert(
          dispatches.filter((dispatch) => dispatch.executionId === heldExecutionId).length === 1,
          'one_committed_original_tool_dispatch',
        );
        const finalCarrier = await actualStore.getExecution(carrier.id);
        assert(
          finalCarrier?.status === 'succeeded' &&
            JSON.stringify(finalCarrier.result).includes(body),
          'real_child_final_report_has_actual_effect_fact',
        );
      } else {
        assert(
          rejectedOldDispatch && actualPolicyReadFailures > 0,
          'old_full_rejected_then_actual_current_policy_read_threw',
        );
        assert(
          !existsSync(target) &&
            dispatches.length === 0 &&
            writes[0]!.authorization?.dispatched !== true,
          'policy_read_failure_never_falls_back_to_old_full_effect',
        );
        assert(
          ['failed', 'outcome_unknown'].includes(writes[0]!.status),
          'original_read_failure_terminal_truth_retained',
        );
        observed.actualWriteTerminal = writes[0]!.status;
      }
      // Read-only replay assertions start only after the original report and all
      // root/leaf work have actually settled; inactive Run snapshots alone can race drain.
      await until(async () => {
        const original = await actualStore.getExecution(carrier.id);
        const views = await Promise.all(['s', leaf].map((session) => actualStore.getView(session)));
        const lifecycle = runtime!.getLifecycleState();
        return original &&
          ['consumed', 'suppressed'].includes(original.delivery ?? '') &&
          views.every(
            (view) =>
              view.runs.every((run) => !run.isActive) &&
              view.executions.every((execution) =>
                ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status),
              ),
          ) &&
          !lifecycle.busy
          ? true
          : undefined;
      }, 'original_report_and_all_root_leaf_work_settled_before_readback');
      // Formal readback must preserve original uncertainty and cannot replay unknown work.
      const beforeRead = {
        metadata: await actualStore.getMetadata(),
        view: await actualStore.getView(leaf),
        root: await actualStore.getView('s'),
        requests: options.requests().length,
      };
      await ownedClient.getPermissionMutation('mode-change', {
        storeId: expectedStoreId,
        signal: options.signal,
      });
      await ownedClient.getView(leaf, { signal: options.signal });
      await ownedClient.getView('s', { signal: options.signal });
      const afterRead = {
        metadata: await actualStore.getMetadata(),
        view: await actualStore.getView(leaf),
        root: await actualStore.getView('s'),
        requests: options.requests().length,
      };
      const changedFields = (['metadata', 'view', 'root', 'requests'] as const).filter(
        (field) => !isDeepStrictEqual(beforeRead[field], afterRead[field]),
      );
      // Full canonical bodies stay in the private evidence root, never the public report.
      writeFileSync(
        join(canonicalRoot, 'permission-readback-canonical-snapshots.json'),
        JSON.stringify({ beforeRead, afterRead }, null, 2),
        { mode: 0o600 },
      );
      observed.readbackBeforeSha256 = digest(Buffer.from(JSON.stringify(beforeRead)));
      observed.readbackAfterSha256 = digest(Buffer.from(JSON.stringify(afterRead)));
      observed.readbackChangedFields = changedFields.join(',');
      assert(changedFields.length === 0, 'formal_readback_zero_provider_or_canonical_replay');
      checks.actualPolicyReadFailures = actualPolicyReadFailures;
      checks.transportDrops = droppedResponses;
      checks.modePosts = modeMutationPosts;
      checks.actualModelRequests = options.requests().length - requestStart;
      status = 'passed';
      failureStage = '';
    } catch (error) {
      status =
        error instanceof Boundary && error.category === 'branch_not_hit'
          ? 'inconclusive'
          : 'failed';
      failureCategory =
        error instanceof Boundary
          ? error.category
          : options.signal.aborted
            ? 'aborted'
            : 'execution';
      if (error instanceof Boundary) failureStage = error.stage;
    } finally {
      closing = true;
      cleanup.abort();
      releaseDispatch();
      let failedClose = false;
      const close = async (fn: () => unknown | Promise<unknown>) => {
        try {
          await fn();
        } catch {
          failedClose = true;
        }
      };
      await close(() => client?.disposeNetwork());
      forward.abort();
      if (proxy)
        await close(async () => {
          await new Promise<void>((resolve, reject) => {
            proxy!.close((error) => (error ? reject(error) : resolve()));
            proxy!.closeAllConnections();
          });
        });
      let runtimeClosed = false;
      if (service)
        await close(async () => {
          await service!.close();
          runtimeClosed = true;
        });
      if (!runtimeClosed && runtime)
        await close(async () => {
          await runtime!.close();
          runtimeClosed = true;
        });
      if (!runtimeClosed) await close(() => store?.close());
      await close(closeLocks);
      checks.resourcesClosed = !failedClose;
      if (failedClose) {
        status = 'failed';
        failureCategory = 'cleanup';
      }
      if (status === 'passed' && !options.evidenceRoot)
        rmSync(canonicalRoot, { recursive: true, force: true });
    }
    cases.push({
      id,
      status,
      checks,
      observed,
      failureStage,
      failureCategory,
      canonicalEvidenceRetained: !!options.evidenceRoot || status !== 'passed',
      coverage: [
        'formal persisted default policy and exact management command/CAS',
        id === ids[0]
          ? 'one real committed HTTP mode response dropped; exact GET receipt/revision; original child waiter wakes once without answer'
          : 'old full final-dispatch proof rejected; actual current formal policy Store read throws for exact child Tool; zero new effects',
        'no on* disabled or cold process crash recovery qualification',
        'no complete P10 or contract80 qualification',
      ],
    });
  }
  return { cases };
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_PERMISSION_BOUNDARIES !== '1')
    throw Error('live_permission_boundary_opt_in_required');
  const args = process.argv.slice(2);
  const caseId = args.find((arg) => arg.startsWith('--case='))?.slice(7);
  const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
  if (
    args.length !== 2 ||
    !caseId ||
    !ids.includes(caseId as LivePermissionBoundaryCaseId) ||
    !output ||
    !isAbsolute(output) ||
    existsSync(output) ||
    existsSync(`${output}.workspace`)
  )
    throw Error('live_permission_boundary_arguments_invalid');
  const report: Record<string, unknown> = {
    version: 1,
    group: 'permission-boundaries',
    caseId,
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
    Object.assign(report, fixture.metadata);
    const result = await runLivePermissionBoundaries({
      model: fixture.model,
      modelId: fixture.modelId,
      signal: fixture.signal,
      requests: () => fixture!.requests,
      caseIds: [caseId],
      evidenceRoot: `${output}.workspace`,
    });
    report.cases = result.cases;
    report.status = result.cases[0]?.status ?? 'inconclusive';
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
