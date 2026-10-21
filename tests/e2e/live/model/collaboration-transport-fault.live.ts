import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { agentContractSource } from '@kite-ai/agent/sources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelUsage } from '@kite-ai/ai';
import { liveCodeEvidence } from './live-code-evidence';
import { createHeaderBodyCut } from './live-header-body-cut';
import { createLiveModelFixture } from './live-model-fixture';
export const C07_HEADER_CASE =
  'C07-injected-after-real-HTTP200-headers-before-SDK-body-once' as const;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function save(path: string, value: unknown) {
  const temp = `${path}.pending-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
class Boundary extends Error {
  readonly violation: boolean;
  constructor(point: string, violation = false) {
    super(point);
    this.violation = violation;
  }
}
export async function runC07HeaderCut(output: string) {
  if (!isAbsolute(output) || existsSync(output) || existsSync(`${output}.workspace`))
    throw Error('C07_new_absolute_output_required');
  mkdirSync(`${output}.workspace`, { mode: 0o700 });
  const root = realpathSync(`${output}.workspace`),
    profile = { dataRoot: join(root, 'data'), profile: 'live' };
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const code = liveCodeEvidence(),
    started = performance.now(),
    deadline = Date.now() + 600000;
  const cut = createHeaderBodyCut(undefined, () => deadline - Date.now());
  let runtime: ReturnType<typeof createRuntime> | undefined,
    store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
    failure: string | undefined,
    activeRequestId: string | null = null,
    closed = false;
  const providerTimeline: { at: number; event: string; wireCount: number; statuses: number[] }[] =
    [];
  const checks: Record<string, boolean> = {},
    stages: Record<string, unknown> = {};
  const traces: Record<
    string,
    {
      startedAt: number;
      closedAt: number | null;
      actualSignalAbortedAtClose: boolean;
      fixtureDeadlineAbortedAtClose: boolean;
      finish: boolean;
      eof: boolean;
      usage: ModelUsage[];
      error?: { name: string; message: string; reason: unknown };
    }
  > = {};
  function assert(value: unknown, point: string): asserts value {
    checks[point] = !!value;
    if (!value) throw new Boundary(point, true);
  }
  try {
    store = await openSqliteStore(profile);
    const owned = store;
    const expectedStoreId = (await store.getMetadata()).storeId,
      identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    fixture = await createLiveModelFixture({
      requestLimit: 40,
      timeoutMs: Math.max(1, deadline - Date.now()),
      preserveSdkAttemptErrors: true,
      observe(state) {
        providerTimeline.push({
          at: performance.now(),
          event: state.event,
          wireCount: state.wire.length,
          statuses: state.wire.map((item) => item.status),
        });
        save(join(root, 'provider-observations.json'), { ...state, timeline: providerTimeline });
      },
      async transportResponse(response, index) {
        if (
          !cut.evidence.fired &&
          response.status === 200 &&
          response.body &&
          response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          assert(activeRequestId, 'real_HTTP_has_actual_Model_binding');
          const execution = await owned.getExecution(activeRequestId);
          assert(
            execution?.kind === 'model' &&
              execution.status === 'dispatching' &&
              execution.sessionId === 'root' &&
              execution.rootWorkCommandId === 'A',
            'cut_exact_actual_dispatching_Model_and_work',
          );
          stages.cutIdentity = {
            physicalIndex: index,
            execution,
            headers: { status: response.status, contentType: response.headers.get('content-type') },
            at: performance.now(),
          };
          save(join(root, 'cut-before.json'), stages.cutIdentity);
          const result = await cut.apply(response);
          save(join(root, 'cut-evidence.json'), cut.evidence);
          return result;
        }
        return response;
      },
    });
    const live = fixture;
    assert(
      object(live.metadata.settings).maxOutputTokens === 4096 &&
        object(live.metadata.settings).reasoningEffort === 'medium',
      'original_4096_medium_no_configuration_override',
    );
    const model: ModelAdapter = {
      ...(live.model.describeRequest
        ? { describeRequest: live.model.describeRequest.bind(live.model) }
        : {}),
      async *stream(request, context) {
        if (cut.evidence.cancelFailure && !cut.evidence.upstreamCancelConfirmed) {
          stages.blockedAfterUnconfirmedCleanup = { requestId: request.requestId };
          throw Error('C07_fixture_close_unconfirmed_no_Provider_reissue');
        }
        assert(activeRequestId === null, 'single_actual_Model_stream_no_ambiguous_HTTP_binding');
        activeRequestId = request.requestId;
        const trace = {
          startedAt: performance.now(),
          closedAt: null as number | null,
          actualSignalAbortedAtClose: false,
          fixtureDeadlineAbortedAtClose: false,
          finish: false,
          eof: false,
          usage: [] as ModelUsage[],
          error: undefined as { name: string; message: string; reason: unknown } | undefined,
        };
        traces[request.requestId] = trace;
        try {
          for await (const event of live.model.stream(request, context)) {
            if (event.type === 'finish') {
              trace.finish = true;
              trace.usage.push(event.usage);
            }
            if (event.type === 'usage') trace.usage.push(event.usage);
            yield event;
          }
          trace.eof = true;
        } catch (error) {
          trace.error =
            error instanceof Error
              ? { name: error.name, message: error.message, reason: object(error).reason }
              : { name: 'unknown', message: 'unknown', reason: null };
          if (cut.evidence.cancelFailure && !cut.evidence.upstreamCancelConfirmed)
            throw Error('C07_fixture_original_transport_close_unconfirmed');
          throw error;
        } finally {
          trace.closedAt = performance.now();
          trace.actualSignalAbortedAtClose = context.signal.aborted;
          trace.fixtureDeadlineAbortedAtClose = live.signal.aborted;
          activeRequestId = null;
          save(join(root, 'adapter-streams.json'), traces);
          save(join(root, 'cut-evidence.json'), cut.evidence);
        }
      },
    };
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: live.modelId,
      modelConcurrency: 1,
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned-C07-Model-only' }) },
      sources: { capture: async () => [agentContractSource(workspace)] },
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned C07 finite transport fault',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: C07_HEADER_CASE,
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'A',
      request: {
        kind: 'run.start',
        content:
          'New task: In fewer than 200 words, explain binary search, including its sorted-input precondition. This is a text-only explanation. Do not call tools, delegate, read or write files, perform external actions, or claim any execution outside this explanation.',
      },
    });
    await runtime.waitForCommand('A', { timeoutMs: Math.max(1, deadline - Date.now()) });
    while (runtime.getLifecycleState().busy) {
      if (Date.now() >= deadline)
        throw new Boundary('global_deadline_before_Runtime_true_terminal');
      await Bun.sleep(10);
    }
    const view = await store.getView('root');
    stages.terminal = {
      metadata: await store.getMetadata(),
      view,
      command: await store.getCommand('A'),
    };
    save(join(root, 'terminal-native.json'), stages.terminal);
    if (!cut.evidence.fired)
      throw new Boundary('real_HTTP200_SSE_headers_fault_window_not_reached');
    if (!cut.evidence.upstreamCancelConfirmed)
      throw new Boundary('original_upstream_close_unconfirmed_no_safe_retry_qualification');
    assert(
      cut.evidence.upstreamCancelConfirmed &&
        cut.evidence.sdkFirstPullAt !== null &&
        cut.evidence.sdkDeliveredBytes === 0 &&
        !cut.evidence.sdkEOF &&
        cut.evidence.injectedCode === 'ECONNRESET',
      'actual_original_body_cancelled_before_any_SDK_byte_no_fabricated_EOF',
    );
    const cutId = String(object(object(stages.cutIdentity).execution).id),
      models = view.executions.filter((e) => e.kind === 'model'),
      original = models.find((e) => e.id === cutId)!;
    stages.nativeModelUsage = models.map((execution) => ({
      executionId: execution.id,
      status: execution.status,
      actualUsage: object(execution.result).usage ?? null,
    }));
    const firstTrace = traces[cutId]!;
    assert(
      original?.status === 'failed' &&
        !firstTrace.finish &&
        !firstTrace.eof &&
        firstTrace.closedAt !== null,
      'injected_attempt_actual_failed_closed_no_finish_or_EOF',
    );
    const literalCode = String(object(original.result).code ?? ''),
      reason = firstTrace.error?.reason;
    assert(
      typeof reason === 'string' && literalCode === `MODEL_ATTEMPT_RETRYABLE_FAILURE:${reason}`,
      'SDK_neutral_typed_retry_error_preserved_to_actual_Core_failure',
    );
    assert(
      object(original.result).content === '' &&
        (object(original.result).reasoning ?? '') === '' &&
        object(original.result).incomplete === true,
      'zero_received_text_reasoning_not_invented_or_marked_complete',
    );
    const next = models.find(
      (e) => object(object(e.decisionSource).retry).previousExecutionId === original.id,
    );
    if (!next)
      throw new Boundary('formal_Core_retry_not_reached_before_terminal_or_environment_failure');
    assert(
      next.runId === original.runId &&
        next.rootWorkCommandId === original.rootWorkCommandId &&
        object(object(next.decisionSource).retry).reason === reason,
      'formal_Core_same_Run_retry_exact_predecessor_and_reason',
    );
    stages.retry = {
      failed: original,
      next,
      retryGapMs:
        traces[next.id] && firstTrace.closedAt !== null
          ? traces[next.id]!.startedAt - firstTrace.closedAt
          : null,
      literalCode,
      reason,
    };
    assert(
      view.executions.every((e) => e.kind === 'model') && view.runs.length === 1,
      'zero_Tool_Job_child_or_external_effect_dispatch',
    );
    const inputs = [],
      outputs = [];
    for (const actual of live.requests) {
      const execution = await store.getExecution(actual.requestId);
      assert(execution?.kind === 'model', 'actual_Provider_request_has_native_Model');
      const scope = { ...identity, executionId: execution.id };
      const input = await runtime.readModelInput(scope),
        full = await runtime.readModelOutput(scope);
      const visible = structuredClone(actual);
      for (const message of visible.messages)
        delete (message as { continuation?: unknown }).continuation;
      assert(
        isDeepStrictEqual(input.request, visible) && input.request.tools.length === 0,
        'full_actual_saved_ModelInput_exact_and_tools_empty',
      );
      if (execution.id === cutId)
        assert(
          !full.output.complete &&
            full.output.content === '' &&
            full.output.reasoning === '' &&
            full.output.toolCalls.length === 0,
          'full_failed_Inspector_zero_seen_prefix_incomplete_no_tool_grant',
        );
      if (execution.status === 'succeeded')
        assert(
          full.output.complete && traces[execution.id]?.finish && traces[execution.id]?.eof,
          'actual_successful_full_Output_real_finish_EOF',
        );
      inputs.push(input);
      outputs.push(full);
    }
    stages.fullInspectors = { inputs, outputs };
    const final = outputs.find(
      (o) =>
        o.status === 'succeeded' &&
        o.output.complete &&
        o.output.content.length > 0 &&
        o.output.toolCalls.length === 0,
    );
    if (view.runs[0]?.status !== 'completed' || !final)
      throw new Boundary('natural_following_Provider_did_not_complete_visible_reply');
    assert(
      live.wire.length >= 2 && live.wire.length <= 40 && live.requests.length === models.length,
      'all_actual_attempts_counted_within_budget_no_outer_retry',
    );
    const beforeReplay = {
      metadata: await store.getMetadata(),
      view: await store.getView('root'),
      command: await store.getCommand('A'),
      wire: live.wire.length,
    };
    await runtime.getCommand('A');
    await runtime.getExecution(cutId);
    assert(
      isDeepStrictEqual(beforeReplay, {
        metadata: await store.getMetadata(),
        view: await store.getView('root'),
        command: await store.getCommand('A'),
        wire: live.wire.length,
      }),
      'original_failed_attempt_and_receipt_read_zero_replay_or_cursor_change',
    );
    status = 'passed';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    status = error instanceof Boundary && error.violation ? 'failed' : 'inconclusive';
    stages.failure = { failure, stack: error instanceof Error ? error.stack : null };
  } finally {
    if (runtime && store && fixture) {
      const inspectors = [];
      for (const actual of fixture.requests) {
        try {
          const execution = await store.getExecution(actual.requestId);
          if (!execution) {
            inspectors.push({ executionId: actual.requestId, inspectorUnavailable: true });
            continue;
          }
          const scope = {
            expectedStoreId: execution.originStoreId,
            sessionId: execution.sessionId,
            subjectId: 'owner',
            executionId: execution.id,
          };
          const input = await runtime.readModelInput(scope);
          let full: unknown;
          try {
            full = await runtime.readModelOutput(scope);
          } catch (error) {
            full = { outputUnavailableAtOriginalStatus: execution.status, error: String(error) };
          }
          inspectors.push({ execution, input, output: full });
        } catch (error) {
          inspectors.push({
            executionId: actual.requestId,
            inspectorUnavailable: true,
            error: String(error),
          });
        }
      }
      save(join(root, 'full-inspectors-at-close.json'), inspectors);
      stages.allOriginalNativeInspectorsAtClose = {
        file: 'full-inspectors-at-close.json',
        models: inspectors.length,
      };
    }
    try {
      if (runtime) await runtime.close();
      else await store?.close();
      closed = true;
    } catch (error) {
      status = 'failed';
      failure = 'cleanup_failed';
      stages.cleanupError = String(error);
    }
    if (closed && fixture && existsSync(join(root, 'data/live/core.db'))) {
      let coldStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
        cold: ReturnType<typeof createRuntime> | undefined;
      try {
        coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
        cold = createRuntime({
          store: coldStore,
          artifacts: createArtifactStore({ profile, store: coldStore }),
          permissions: {
            authorize: async () => ({
              allowed: false,
              revision: 'C07-cold-readonly-never-dispatch',
            }),
          },
        });
        const before = {
            metadata: await coldStore.getMetadata(),
            view: await cold.getView('root'),
          },
          wire = fixture.wire.length;
        await cold.getCommand('A');
        for (const execution of before.view.executions) await cold.getExecution(execution.id);
        const after = { metadata: await coldStore.getMetadata(), view: await cold.getView('root') };
        if (!isDeepStrictEqual(before, after) || fixture.wire.length !== wire) {
          status = 'failed';
          failure = 'cold_read_changed_original_facts';
        }
        stages.coldReadonly = {
          before,
          after,
          newConfiguredProviderFactories: 0,
          processScope: 'same process, fresh readonly Store and Runtime',
          ModelPorts: 0,
          ProviderDelta: 0,
        };
      } catch (error) {
        status = 'failed';
        failure = 'cold_readonly_failed';
        stages.coldError = String(error);
      } finally {
        try {
          if (cold) await cold.close();
          else await coldStore?.close();
        } catch {
          status = 'failed';
          closed = false;
          failure = 'cold_cleanup_failed';
        }
      }
    }
    const retainedTransportClosed = await cut.closeRetained();
    if (!retainedTransportClosed) {
      closed = false;
      status = 'failed';
      failure = 'original_retained_transport_cleanup_unconfirmed';
    }
    const privateEvidence = {
      stages,
      providerTimeline,
      checks,
      cut: cut.evidence,
      traces,
      requests: fixture?.requests,
      usage: fixture?.usage,
      wire: fixture?.wire,
      metadata: fixture?.metadata,
    };
    save(join(root, 'private-evidence.json'), privateEvidence);
    const endCode = liveCodeEvidence();
    if (!isDeepStrictEqual(code, endCode)) {
      status = 'failed';
      failure = 'source_drift';
    }
    save(output, {
      caseId: C07_HEADER_CASE,
      status,
      failure,
      code,
      endCode,
      checks,
      physicalHTTP: fixture?.wire.length ?? 0,
      modelRequests: fixture?.requests.length ?? 0,
      requestLimit: 40,
      timeoutMs: 600000,
      durationMs: performance.now() - started,
      cleanupConfirmed: closed,
      declaredFault:
        'explicit injected body ECONNRESET after real HTTP200 SSE headers and before SDK byte0; not a naturally occurring public-network error',
      privateEvidence: {
        file: 'private-evidence.json',
        sha256: hash(readFileSync(join(root, 'private-evidence.json'), 'utf8')),
      },
      unknownBilling:
        'Original cancelled HTTP may be billed despite no reported usage; missing usage is not zero and no monetary cost is inferred.',
      scope:
        'This one injected pre-body window only. Natural C06 errors, protocol corruption controls, partial text/tools, effect-confirmation return loss and natural public-network abnormalities remain not_run.',
      semanticReviewRequired: true,
    });
  }
  return { status, output, root };
}
if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_TRANSPORT_FAULT !== '1')
    throw Error('C07_explicit_test_artifact_opt_in_required');
  const [name, output] = process.argv.slice(2);
  if (name !== 'run' || !output) throw Error('C07_run_new_output_required');
  const result = await runC07HeaderCut(output);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}
