import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { probeFiniteAgentMailbox } from './live-agent-events-pagination';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

export const agentEventsCases = [
  'A03-snapshot',
  'A03-timeout',
  'A03-input',
  'A03-root-stop',
  'A03-finite-mailbox',
] as const;
type CaseId = (typeof agentEventsCases)[number];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function wait(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let aborted!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(Error('live_agent_events_aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
  signal.throwIfAborted();
}
class Boundary extends Error {
  readonly kind: 'branch_not_reached' | 'oracle_violation';
  constructor(kind: 'branch_not_reached' | 'oracle_violation') {
    super(kind);
    this.kind = kind;
  }
}

/** Explicit isolated test artifact; no import-time model/configuration/network access. */
export async function runLiveAgentEvents(options: {
  caseId: CaseId;
  output: string;
  requestLimit?: number;
}) {
  if (
    !agentEventsCases.includes(options.caseId) ||
    !isAbsolute(options.output) ||
    existsSync(options.output) ||
    existsSync(`${options.output}.workspace`)
  )
    throw Error('live_agent_events_arguments_invalid');
  const requestLimit = options.requestLimit ?? 40;
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 40)
    throw Error('live_agent_events_budget_invalid');
  const startedAt = new Date().toISOString(),
    started = performance.now();
  const code = liveCodeEvidence();
  const scriptSha256 = createHash('sha256')
    .update(readFileSync(import.meta.path))
    .digest('hex');
  const root = `${options.output}.workspace`;
  mkdirSync(root, { mode: 0o700 });
  const checks: Record<string, boolean | number> = {};
  const stages: Record<string, unknown> = {};
  let fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
  let failurePoint = 'setup',
    reason: string | null = null;
  const localAbort = new AbortController();
  const childGate = gate(),
    childReady = gate(),
    snapshotGate = gate(),
    finalGate = gate();
  const streamOutcomes: { finished: boolean; aborted: boolean; eof: boolean }[] = [];
  let childEntry: { sessionId: string; runId: string | null; executionId: string } | undefined;
  let readDelivered = 0,
    snapshotDeliveryHeld = false,
    finalDeliveryHeld = false;
  let emptyScans = 0;
  const actualWaits: { at: number; timeoutMs: number; emptyScans: number; hostCaller: boolean }[] =
    [];
  function assert(value: unknown, name: string): asserts value {
    checks[name] = !!value;
    if (!value) throw new Boundary('oracle_violation');
  }
  let signal = localAbort.signal;
  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    const end = Date.now() + 90_000;
    for (;;) {
      signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= end) throw new Boundary('branch_not_reached');
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 15)), signal);
    }
  }
  try {
    fixture = await createLiveModelFixture({ requestLimit, timeoutMs: 600_000 });
    const live = fixture;
    signal = AbortSignal.any([localAbort.signal, live.signal]);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const fact = `owned finite mailbox fact ${randomUUID()}`;
    const materialPath = join(workspace, 'material.txt');
    writeFileSync(materialPath, fact, { mode: 0o600 });
    const profile = { dataRoot: join(root, 'data'), profile: 'live' };
    store = await openSqliteStore(profile);
    const ownedStore = store;
    const expectedStoreId = (await store.getMetadata()).storeId;
    const originalEvents = store.listAgentEvents.bind(store);
    store.listAgentEvents = async (input) => {
      const page = await originalEvents(input);
      if (input.sessionId === 'root' && page.events.length === 0) emptyScans++;
      return page;
    };
    const model: ModelAdapter = {
      ...(live.model.describeRequest
        ? { describeRequest: live.model.describeRequest.bind(live.model) }
        : {}),
      async *stream(request, context) {
        const combined = AbortSignal.any([signal, context.signal]);
        const execution = await ownedStore.getExecution(request.requestId);
        if (execution?.sessionId === 'root') {
          const completed = (await ownedStore.listExecutions('root')).filter(
            (item) => item.definitionId === 'task.events' && item.status === 'succeeded',
          );
          if (completed.length === 1) {
            snapshotDeliveryHeld = true;
            await wait(snapshotGate.promise, combined);
          } else if (completed.length >= 2) {
            finalDeliveryHeld = true;
            await wait(finalGate.promise, combined);
          }
        }
        const observation = { finished: false, aborted: false, eof: false };
        streamOutcomes.push(observation);
        try {
          for await (const event of live.model.stream(request, { signal: combined })) {
            if (event.type === 'finish') observation.finished = true;
            yield event;
          }
          observation.eof = true;
        } finally {
          observation.aborted = combined.aborted;
        }
      },
    };
    const reader: ToolDefinition = {
      id: 'live.agent-events-read',
      version: '1',
      model: { name: 'read_agent_events_material' },
      description:
        'Actual finite owned read. child_material waits for external release; root_ready waits until the delegated child read has entered. Do not poll or cancel either read.',
      inputSchema: {
        type: 'object',
        properties: { material: { type: 'string', enum: ['child_material', 'root_ready'] } },
        required: ['material'],
        additionalProperties: false,
      },
      async execute(input, context) {
        const combined = AbortSignal.any([signal, context.signal]);
        const material = record(input).material;
        if (material === 'root_ready' && context.sessionId === 'root') {
          await wait(childReady.promise, combined);
          return {
            outcome: 'succeeded',
            content:
              'The original child read is actually held. Execute the requested mailbox observation now.',
          };
        }
        if (material !== 'child_material' || context.sessionId === 'root')
          return { outcome: 'failed', content: 'invalid_owned_read_scope' };
        childEntry = {
          sessionId: context.sessionId,
          runId: context.runId,
          executionId: context.executionId,
        };
        childReady.release();
        try {
          await wait(childGate.promise, combined);
        } catch (error) {
          if (combined.aborted)
            return { outcome: 'cancelled', content: 'owned_read_cancelled_before_bytes' };
          throw error;
        }
        const content = readFileSync(materialPath, 'utf8');
        readDelivered++;
        return { outcome: 'succeeded', content };
      },
    };
    const toolIds = [
      reader.id,
      'task.spawn',
      'task.message',
      'task.follow_up',
      'task.events',
      'task.list',
      'task.interrupt',
    ];
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: live.modelId,
      modelConcurrency: 4,
      extensions: [
        { id: 'live.agent-events-fixture', version: '1', apiMajor: 1, tools: [reader] },
        createTaskExtension({
          roles: [
            {
              id: 'worker',
              configurationId: 'worker',
              description: 'Finite owned material reader.',
            },
          ],
        }),
      ],
      permissions: {
        authorize: async () => ({ allowed: true, revision: 'owned-agent-events-only' }),
      },
      afterTurn: {
        authorize: async () => ({ allowed: true, revision: 'owned-agent-events-only' }),
      },
      childConfigurations: [
        { id: 'worker', version: '1', model, modelId: live.modelId, toolIds, snapshot: {} },
      ],
    });
    // Test-only observation. Preserve exact this, arguments, signal, promise and return.
    const waits = (
      runtime as unknown as {
        changeWaits: {
          wait(cursor: string, signal: AbortSignal, timeoutMs: number): Promise<unknown>;
        };
      }
    ).changeWaits;
    const originalWait = waits.wait;
    waits.wait = function (cursor, waitSignal, timeoutMs) {
      const promise = originalWait.call(this, cursor, waitSignal, timeoutMs);
      actualWaits.push({
        at: performance.now(),
        timeoutMs,
        emptyScans,
        hostCaller: (new Error().stack ?? '').includes('/extensions/host.ts:'),
      });
      return promise;
    };
    const selection = {
      dataRoot: realpathSync(profile.dataRoot),
      name: profile.profile,
      accessKey: resolveProfile(profile).profileAccessKey,
    };
    service = await startService({
      runtime,
      profile: selection,
      subjectId: 'live-owner',
      buildId: 'live-agent-events',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: { profile: selection, apiMajor: 1, requiredCapabilities: ['commands', 'sessions'] },
    });
    const ownedClient = client;
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned mailbox boundaries',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      commandId: 'create',
      title: 'Live mailbox boundaries',
    });
    const second =
      options.caseId === 'A03-snapshot' || options.caseId === 'A03-finite-mailbox'
        ? 'After the zero snapshot, keep waiting for the actual child result and finish only after reporting its complete actual material.'
        : `After the zero snapshot, call wait_agent_events exactly once with after_seq equal to that exact next_seq and wait_ms ${options.caseId === 'A03-timeout' ? '1200' : 'null'}. This is an explicit observation test; do not send, interrupt, follow up or spawn again. After it returns, keep receiving the real child result and report its complete actual material. A human may add a supplemental input or stop this root normally.`;
    const assignment =
      options.caseId === 'A03-finite-mailbox'
        ? 'Call read_agent_events_material once with material child_material. Wait for the actual held read. After receiving the actual content, send_agent_message to target parent exactly once containing that complete actual content, then finish with the same complete actual content. Do not spawn, follow up or interrupt anyone.'
        : 'Call read_agent_events_material once with material child_material. Wait for the actual held read, then return its complete actual content. Do not spawn or send messages or interrupt anyone.';
    const content =
      `New task: Spawn exactly one child named material-reader with this exact assignment: ${assignment} After spawning, call read_agent_events_material with material root_ready once. When root_ready returns, call wait_agent_events exactly once with after_seq "0" and wait_ms 0. It must be a zero snapshot even though the child is still reading. ` +
      second;
    await client.startRun(
      'root',
      { expectedStoreId, commandId: 'work', kind: 'run.start', content },
      { signal },
    );
    failurePoint = 'snapshot';
    const first = await until(async () => {
      const events = (await ownedStore.listExecutions('root')).filter(
        (item) => item.definitionId === 'task.events',
      );
      return events.length === 1 && events[0]!.status === 'succeeded' && snapshotDeliveryHeld
        ? events[0]
        : undefined;
    });
    const firstArgs = record(first.input),
      firstBody = record(JSON.parse(String(record(first.result).content)));
    assert(
      firstArgs.waitMs === 0 && (firstArgs.afterSeq ?? '0') === '0',
      'actual_model_zero_snapshot_arguments',
    );
    assert(
      firstBody.reason === 'timeout' &&
        Array.isArray(firstBody.events) &&
        firstBody.events.length === 0 &&
        firstBody.next_seq === '0',
      'zero_snapshot_empty_and_no_cursor_jump',
    );
    assert(childEntry?.runId, 'real_child_read_entered');
    const child = childEntry;
    const childSession = await store.getSession(child.sessionId);
    const carriers = (await store.listExecutions('root')).filter((item) => item.childSessionId);
    assert(
      carriers.length === 1 &&
        carriers[0]!.childSessionId === child.sessionId &&
        childSession?.parentSessionId === 'root' &&
        childSession.rootSessionId === 'root' &&
        carriers[0]!.originStoreId === expectedStoreId,
      'accurate_single_child_carrier_and_ancestry',
    );
    const carrier = carriers[0]!;
    async function childActive() {
      const run = await ownedStore.getRun(child.runId!);
      const execution = await ownedStore.getExecution(child.executionId);
      const current = await ownedStore.getExecution(carrier.id);
      return (
        !!run?.isActive &&
        execution?.cancelRequestedAt === null &&
        ['running', 'dispatching'].includes(execution.status) &&
        current?.cancelRequestedAt === null &&
        current.resultAcceptance === null
      );
    }
    assert(await childActive(), 'snapshot_child_active_unconsumed_uncancelled');
    assert(
      (await store.getView(child.sessionId)).runs.length === 1 &&
        carriers.length === 1 &&
        readDelivered === 0,
      'snapshot_zero_activation_or_read_effect',
    );
    if (options.caseId !== 'A03-snapshot' && options.caseId !== 'A03-finite-mailbox') {
      failurePoint = 'real_empty_wait';
      const scanBaseline = emptyScans,
        waitBaseline = actualWaits.length;
      snapshotGate.release();
      const secondWait = await until(async () => {
        const events = (await ownedStore.listExecutions('root')).filter(
          (item) => item.definitionId === 'task.events' && item.id !== first.id,
        );
        const observed = actualWaits
          .slice(waitBaseline)
          .find((item) => item.hostCaller && item.emptyScans > scanBaseline);
        return events.length === 1 &&
          ['dispatching', 'running'].includes(events[0]!.status) &&
          observed
          ? { execution: events[0]!, observed }
          : undefined;
      });
      const args = record(secondWait.execution.input);
      assert(
        args.afterSeq === firstBody.next_seq &&
          args.waitMs === (options.caseId === 'A03-timeout' ? 1200 : null),
        'actual_second_wait_exact_cursor_and_duration',
      );
      assert(
        secondWait.observed.emptyScans > scanBaseline && secondWait.observed.hostCaller,
        'empty_sql_page_then_real_host_wait_registered',
      );
      assert(await childActive(), 'child_still_held_during_real_wait');
      if (options.caseId === 'A03-root-stop') {
        failurePoint = 'root_stop';
        const receipt = await ownedClient.cancelSession(
          'root',
          {
            expectedStoreId,
            commandId: 'root-stop',
            kind: 'session.cancel',
            includeBackground: true,
          },
          { signal },
        );
        assert(receipt.status === 'applied', 'formal_root_stop_applied');
        await until(async () => {
          const views = await Promise.all(
            ['root', child.sessionId].map((id) => ownedStore.getView(id)),
          );
          return views.every(
            (view) =>
              view.runs.every((run) => !run.isActive) &&
              view.executions.every((item) =>
                ['succeeded', 'failed', 'cancelled'].includes(item.status),
              ),
          )
            ? true
            : undefined;
        });
        const stopped = await ownedStore.getExecution(secondWait.execution.id);
        const stoppedResult = record(stopped?.result);
        const publicBody =
          stopped?.status === 'failed' ? record(JSON.parse(String(stoppedResult.content))) : {};
        const details = record(stoppedResult.details);
        const publicError = record(publicBody.error),
          detailError = record(details.error);
        const explicitReadCancellation =
          stopped?.status === 'failed' &&
          stoppedResult.outcome === 'failed' &&
          publicError.code === 'operation_cancelled' &&
          publicError.next_action === 'none' &&
          detailError.code === 'operation_cancelled' &&
          detailError.next_action === 'none' &&
          !Object.hasOwn(publicBody, 'accepted') &&
          !Object.hasOwn(details, 'accepted');
        assert(
          stopped?.status === 'cancelled' || explicitReadCancellation,
          'stop_wakes_exact_wait_as_cancelled_or_explicit_read_cancellation',
        );
        assert(
          (await ownedStore.getExecution(carrier.id))?.status === 'cancelled',
          'stop_cancels_accurate_attached_carrier',
        );
        const rootBefore = await ownedStore.getView('root'),
          childBefore = await ownedStore.getView(child.sessionId);
        assert(
          rootBefore.runs.length === 1 &&
            rootBefore.runs[0]?.id === secondWait.execution.runId &&
            rootBefore.runs[0].status === 'cancelled' &&
            !rootBefore.runs[0].isActive &&
            childBefore.runs.length === 1 &&
            childBefore.runs[0]?.id === child.runId &&
            childBefore.runs[0].status === 'cancelled' &&
            !childBefore.runs[0].isActive,
          'formal_stop_cancels_exact_original_root_and_child_runs',
        );
        const requestsBeforeRelease = live.requests.length;
        const modelCountBeforeRelease = [
          ...rootBefore.executions,
          ...childBefore.executions,
        ].filter((item) => item.kind === 'model').length;
        childGate.release();
        snapshotGate.release();
        finalGate.release();
        const rootAfter = await ownedStore.getView('root'),
          childAfter = await ownedStore.getView(child.sessionId);
        assert(
          rootAfter.runs.length === rootBefore.runs.length &&
            childAfter.runs.length === childBefore.runs.length &&
            rootAfter.executions.length === rootBefore.executions.length &&
            childAfter.executions.length === childBefore.executions.length &&
            [...rootAfter.executions, ...childAfter.executions].filter(
              (item) => item.kind === 'model',
            ).length === modelCountBeforeRelease &&
            live.requests.length === requestsBeforeRelease &&
            [...rootAfter.runs, ...childAfter.runs].every(
              (run) => run.status === 'cancelled' && !run.isActive,
            ) &&
            readDelivered === 0,
          'late_read_release_zero_revival_or_bytes',
        );
      } else {
        if (options.caseId === 'A03-input') {
          failurePoint = 'public_input';
          const rootRun = (await ownedStore.getRun(secondWait.execution.runId!))!;
          const receipt = await ownedClient.steer(
            'root',
            {
              expectedStoreId,
              commandId: 'supplement',
              kind: 'input.steer',
              targetRunId: rootRun.id,
              contextSelectionId: rootRun.contextSelectionId,
              content:
                '补充：等待并报告原 child 的完整实际资料。保持同一工作，不创建任何新 child。',
            },
            { signal },
          );
          const rawId = record(receipt.receipt).humanInputCommandId;
          assert(typeof rawId === 'string', 'formal_input_has_exact_raw_command');
          const raw = await ownedStore.getCommand(rawId);
          assert(
            raw?.kind === 'human.input' &&
              raw.sessionId === 'root' &&
              raw.originStoreId === expectedStoreId &&
              raw.subjectId === 'live-owner',
            'durable_raw_input_exact_scope',
          );
        }
        failurePoint = 'wait_result';
        const settled = await until(async () => {
          const item = await ownedStore.getExecution(secondWait.execution.id);
          return item?.status === 'succeeded' && finalDeliveryHeld ? item : undefined;
        });
        const body = record(JSON.parse(String(record(settled.result).content)));
        assert(
          body.reason === (options.caseId === 'A03-input' ? 'input' : 'timeout') &&
            Array.isArray(body.events) &&
            body.events.length === 0 &&
            body.next_seq === firstBody.next_seq,
          'exact_wait_reason_empty_events_and_unchanged_watermark',
        );
        if (options.caseId === 'A03-timeout')
          assert(
            performance.now() - secondWait.observed.at >= 1100,
            'finite_timeout_really_waited',
          );
        assert(await childActive(), 'wait_return_does_not_cancel_or_consume_child');
      }
    }
    if (options.caseId !== 'A03-root-stop') {
      failurePoint = 'real_completion';
      childGate.release();
      snapshotGate.release();
      finalGate.release();
      const finalCarrier = await until(async () => {
        const item = await ownedStore.getExecution(carrier.id);
        return item?.status === 'succeeded' && item.resultAcceptance ? item : undefined;
      });
      assert(
        JSON.stringify(finalCarrier.result).includes(fact) && Number(readDelivered) === 1,
        'original_child_completes_with_actual_random_fact_once',
      );
      const acceptance = finalCarrier.resultAcceptance!;
      await until(async () => {
        const rootView = await ownedStore.getView('root');
        const prepared = rootView.executions.some(
          (item) =>
            item.kind === 'model' &&
            item.runId === acceptance.runId &&
            live.requests.some(
              (request) =>
                request.requestId === item.id &&
                request.messages.some(
                  (message) =>
                    message.sourceIds?.includes(acceptance.sourceId) &&
                    message.content.includes(fact),
                ),
            ),
        );
        return prepared &&
          rootView.runs.every((run) => !run.isActive) &&
          rootView.executions.every((item) =>
            ['succeeded', 'failed', 'cancelled'].includes(item.status),
          )
          ? true
          : undefined;
      });
      assert(
        (await ownedStore.getRun(acceptance.runId!))?.status === 'completed',
        'root_prepared_exact_result_source_and_completed',
      );
      assert(
        (await ownedStore.listExecutions('root')).filter((item) => item.childSessionId).length ===
          1 && (await ownedStore.getView(child.sessionId)).runs.length === 1,
        'no_replacement_child_or_successor',
      );
    }
    if (options.caseId === 'A03-finite-mailbox') {
      failurePoint = 'finite_mailbox_host_observation';
      await until(async () => {
        const view = await ownedStore.getView('root');
        return !runtime!.getLifecycleState().busy && view.runs.every((run) => !run.isActive)
          ? true
          : undefined;
      });
      const genuine = await ownedStore.listAgentEvents({
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'live-owner',
        extensionId: 'builtin.task',
        limit: 200,
      });
      if (genuine.events.length < 2) throw new Boundary('branch_not_reached');
      stages.finiteMailbox = await probeFiniteAgentMailbox({
        store: ownedStore,
        databasePath: join(root, 'data', 'live', 'core.db'),
        expectedStoreId,
        sessionId: 'root',
        subjectId: 'live-owner',
        childSessionId: child.sessionId,
        counts: () => ({
          physicalHTTP: live.wire.length,
          modelRequests: live.requests.length,
          actualToolCalls: live.calls.length,
        }),
      });
      assert(true, 'finite_host_pages_repeat_and_explicit_retention_control_zero_effect');
      writeFileSync(
        join(root, 'finite-mailbox-private-evidence.json'),
        `${JSON.stringify(stages.finiteMailbox, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    assert(
      live.wire.length > 0 &&
        live.wire.length <= requestLimit &&
        live.wire.every((item) => item.status === 200),
      'physical_real_provider_requests_within_budget',
    );
    status = 'passed';
  } catch (error) {
    reason =
      error instanceof Boundary
        ? error.kind
        : error instanceof Error && /^live_(?:model|agent_events)_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : 'execution_unavailable';
    status = reason === 'branch_not_reached' ? 'inconclusive' : 'failed';
  } finally {
    if (options.caseId === 'A03-finite-mailbox' && runtime && store && fixture) {
      try {
        const actual = `${JSON.stringify({ requests: fixture.requests, calls: fixture.calls, wire: fixture.wire, usage: fixture.usage, metadata: fixture.metadata, streams: streamOutcomes }, null, 2)}\n`;
        writeFileSync(join(root, 'actual-model-evidence.json'), actual, { mode: 0o600 });
        stages.actualModels = {
          file: 'actual-model-evidence.json',
          sha256: createHash('sha256').update(actual).digest('hex'),
        };
        stages.canonicalModels = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: fixture.requests,
          root,
          subjectId: 'live-owner',
        });
        if (status === 'passed' && record(stages.canonicalModels).complete !== true) {
          status = 'failed';
          reason = 'canonical_evidence_incomplete';
        }
      } catch {
        status = 'failed';
        reason = 'canonical_evidence_unavailable';
      }
    }
    localAbort.abort();
    childGate.release();
    childReady.release();
    snapshotGate.release();
    finalGate.release();
    let closedRuntime = false,
      cleanupSucceeded = true;
    try {
      client?.disposeNetwork();
    } catch {
      cleanupSucceeded = false;
    }
    if (service) {
      try {
        await service.close();
        closedRuntime = true;
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (runtime && !closedRuntime) {
      try {
        await runtime.close();
        closedRuntime = true;
      } catch {
        cleanupSucceeded = false;
      }
    }
    // Service owns Runtime.close, which owns Store.close. Close Store only before Runtime construction.
    if (store && !runtime) {
      try {
        await store.close();
      } catch {
        cleanupSucceeded = false;
      }
    }
    checks.resourcesClosed = cleanupSucceeded;
    if (!cleanupSucceeded) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    const report = {
      version: 1,
      artifact: 'live-agent-events',
      startedAt,
      finishedAt: new Date().toISOString(),
      monotonicDurationMs: performance.now() - started,
      code,
      codeAtEnd: liveCodeEvidence(),
      scriptSha256,
      ...fixture?.metadata,
      entryLayer: 'service-client-runtime-sqlite',
      coverage: [
        'real_model_task_events',
        'finite_owned_read_and_model_delivery_gates',
        'owned_allow_policy_not_default_policy_qualification',
        ...(options.caseId === 'A03-finite-mailbox'
          ? [
              'host_Store_finite_pages_and_repeats',
              'explicit_SQL_retention_boundary_control_not_natural_compaction',
              'actual_Model_gap_call_not_run',
            ]
          : ['no_directory_pagination_or_replay_gap_coverage']),
      ],
      ...(options.caseId === 'A03-finite-mailbox'
        ? {
            privateEvidence: {
              finiteMailbox: 'finite-mailbox-private-evidence.json',
              canonicalModels: stages.canonicalModels,
              actualModels: stages.actualModels,
            },
            qualification: {
              naturalProductionRetention: 'not_run',
              actualModelGapCalls: 0,
              hostApiPagination: true,
            },
          }
        : {}),
      cases: [
        {
          id: options.caseId,
          status,
          failurePoint: status === 'passed' ? null : failurePoint,
          reason,
          checks,
        },
      ],
      budget: {
        requestLimit,
        timeoutMs: 600_000,
        physicalRequests: fixture?.wire.length ?? 0,
        modelRequests: fixture?.requests.length ?? 0,
      },
      physicalHttp:
        fixture?.wire.map((item) => ({
          status: item.status,
          usage: null,
          trustedToolCount: item.tools.length,
        })) ?? [],
      physicalUsageObservation: 'not_parsed; canonical_adapter_finish_usage_separately',
      usage:
        fixture?.usage.map(
          ({ inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens }) => ({
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            reasoningTokens,
          }),
        ) ?? [],
      modelStreams: {
        started: streamOutcomes.length,
        finishEvents: streamOutcomes.filter((item) => item.finished).length,
        eof: streamOutcomes.filter((item) => item.eof).length,
        aborted: streamOutcomes.filter((item) => item.aborted).length,
      },
      toolCalls: fixture ? summarizeLiveToolCalls(fixture.requests, fixture.calls) : [],
      waitObservations: {
        emptyScans,
        hostWaitRegistrations: actualWaits.filter((item) => item.hostCaller).length,
      },
      cleanup: { succeeded: cleanupSucceeded },
      retained: { root, canonicalStore: join(root, 'data', 'live', 'core.db') },
    };
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return status === 'passed';
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_COLLABORATION !== '1')
    throw Error('live_agent_events_opt_in_required');
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const match = /^--(case|output|limit)=(.+)$/.exec(arg);
      if (!match) throw Error('live_agent_events_arguments_invalid');
      return [match[1]!, match[2]!] as const;
    }),
  );
  const caseId = args.get('case') as CaseId,
    output = args.get('output');
  if (!output) throw Error('live_agent_events_arguments_invalid');
  process.exitCode = (await runLiveAgentEvents({
    caseId,
    output,
    ...(args.has('limit') ? { requestLimit: Number(args.get('limit')) } : {}),
  }))
    ? 0
    : 1;
}
