import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
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
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelToolCall } from '@kite-ai/ai';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture } from './live-model-fixture';
import {
  currentToolNames,
  type NaturalCase,
  naturalCases,
  naturalPrompt,
  observeOriginalBody,
  parseOriginalToolBatches,
  targetError,
} from './live-natural-tool-evidence';
import { bounded } from './live-owned-process';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const hash = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
function save(path: string, value: unknown) {
  const temp = `${path}.pending-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
class Boundary extends Error {
  readonly violation: boolean;
  constructor(point: string, violation = false) {
    super(point);
    this.violation = violation;
  }
}
/** One selected natural probe only: no response rewriting, fake calls, outer retry or protocol control. */
export async function runNaturalToolProbe(caseId: NaturalCase, output: string) {
  if (
    !naturalCases.includes(caseId) ||
    !isAbsolute(output) ||
    existsSync(output) ||
    existsSync(`${output}.workspace`)
  )
    throw Error('C06_new_absolute_output_and_known_case_required');
  mkdirSync(`${output}.workspace`, { mode: 0o700 });
  const root = realpathSync(`${output}.workspace`),
    workspace = join(root, 'workspace'),
    profile = { dataRoot: join(root, 'data'), profile: 'live' };
  mkdirSync(workspace, { mode: 0o700 });
  const code = liveCodeEvidence(),
    started = performance.now(),
    deadline = Date.now() + 600000;
  const checks: Record<string, boolean> = {},
    stages: Record<string, unknown> = {};
  const streams: {
    physicalIndex: number;
    modelExecutionId: string;
    rawFile: string;
    state: ReturnType<typeof observeOriginalBody>['state'];
  }[] = [];
  const traces: Record<
    string,
    { calls: ModelToolCall[]; finish: boolean; eof: boolean; error: string | null }
  > = {};
  const toolBodiesEntered: {
    executionId: string;
    definitionId: string;
    input: unknown;
    method: string;
  }[] = [];
  let activeRequest: string | null = null;
  let runtime: ReturnType<typeof createRuntime> | undefined,
    store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    fixture: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
    reason = 'not_hit',
    cleanup = false,
    naturalTargetErrorHit = false;
  function assert(value: unknown, point: string): asserts value {
    checks[point] = !!value;
    if (!value) throw new Boundary(point, true);
  }
  try {
    store = await openSqliteStore(profile);
    const owned = store,
      expectedStoreId = (await owned.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    fixture = await createLiveModelFixture({
      requestLimit: 40,
      timeoutMs: Math.max(1, deadline - Date.now()),
      observe(state) {
        save(join(root, 'provider-observations.json'), state);
      },
      async transportResponse(response, index) {
        assert(activeRequest, 'original_HTTP_exact_actual_Model_binding');
        const rawFile = `raw-http-${index}.bin`,
          observed = observeOriginalBody(response, join(root, rawFile), (state) =>
            save(join(root, `raw-http-${index}-state.json`), state),
          );
        streams.push({
          physicalIndex: index,
          modelExecutionId: activeRequest,
          rawFile,
          state: observed.state,
        });
        return observed.response;
      },
    });
    const live = fixture;
    assert(
      object(live.metadata.settings).maxOutputTokens === 4096 &&
        object(live.metadata.settings).reasoningEffort === 'medium',
      'original_4096_medium_settings_no_override',
    );
    if (live.metadata.protocol !== 'chat-completions')
      throw new Boundary(
        'configured_protocol_not_supported_by_raw_batch_qualifier_no_Provider_called',
      );
    const model: ModelAdapter = {
      ...(live.model.describeRequest
        ? { describeRequest: live.model.describeRequest.bind(live.model) }
        : {}),
      async *stream(request, context) {
        assert(activeRequest === null, 'serial_Model_exact_HTTP_binding');
        activeRequest = request.requestId;
        const names = request.tools.map((tool) => tool.id).sort();
        assert(
          request.tools.length === 0 || isDeepStrictEqual(names, [...currentToolNames].sort()),
          'actual_root_six_original_tool_names_or_toolless_child',
        );
        const trace = {
          calls: [] as ModelToolCall[],
          finish: false,
          eof: false,
          error: null as string | null,
        };
        traces[request.requestId] = trace;
        try {
          for await (const event of live.model.stream(request, context)) {
            if (event.type === 'tool_call') trace.calls.push(structuredClone(event));
            if (event.type === 'finish') trace.finish = true;
            yield event;
          }
          trace.eof = true;
        } catch (error) {
          trace.error = String(error);
          throw error;
        } finally {
          activeRequest = null;
          save(join(root, 'adapter-original-events.json'), traces);
        }
      },
    };
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description: 'A finite isolated child; no tools or effects.',
        },
      ],
    });
    const tools = task.tools!.map((tool) => ({
      ...tool,
      async execute(
        input: Parameters<typeof tool.execute>[0],
        context: Parameters<typeof tool.execute>[1],
      ) {
        toolBodiesEntered.push({
          executionId: context.executionId,
          definitionId: tool.id,
          input: structuredClone(input),
          method: 'execute',
        });
        return tool.execute(input, context);
      },
      ...(tool.resume
        ? {
            async resume(
              input: Parameters<NonNullable<typeof tool.resume>>[0],
              context: Parameters<NonNullable<typeof tool.resume>>[1],
            ) {
              toolBodiesEntered.push({
                executionId: context.executionId,
                definitionId: tool.id,
                input: structuredClone(input),
                method: 'resume',
              });
              return tool.resume!(input, context);
            },
          }
        : {}),
    }));
    assert(
      tools.filter((tool) => !tool.model?.hidden).length === 6 &&
        tools.every(
          (tool, index) =>
            isDeepStrictEqual(tool.inputSchema, task.tools![index]!.inputSchema) &&
            isDeepStrictEqual(tool.model, task.tools![index]!.model),
        ),
      'all_original_Task_schemas_and_presentation_unchanged',
    );
    runtime = createRuntime({
      store: owned,
      artifacts: createArtifactStore({ profile, store: owned }),
      model,
      modelId: live.modelId,
      modelConcurrency: 1,
      maxConcurrentSubagents: 1,
      sources: { capture: async () => [agentContractSource(workspace)] },
      extensions: [{ ...task, tools }],
      permissions: {
        authorize: async () => ({
          allowed: true,
          revision: 'owned-C06-natural-Task-only-not-default-policy',
        }),
      },
      afterTurn: {
        authorize: async () => ({
          allowed: false,
          revision: 'owned-C06-no-automatic-parent-Model',
        }),
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: live.modelId,
          toolIds: [],
          snapshot: { kind: 'C06-finite-tool-free-child' },
        },
      ],
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned C06 natural migration probe',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: caseId,
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'A',
      request: { kind: 'run.start', content: naturalPrompt(caseId) },
    });
    await runtime.waitForCommand('A', { timeoutMs: Math.max(1, deadline - Date.now()) });
    while (runtime.getLifecycleState().busy) {
      if (Date.now() >= deadline) throw new Boundary('deadline_before_real_lifecycle_terminal');
      await Bun.sleep(10);
    }
    const view = await owned.getView('root');
    stages.terminal = {
      view,
      command: await owned.getCommand('A'),
      metadata: await owned.getMetadata(),
    };
    const batches = streams.map((stream) => {
      const raw = readFileSync(join(root, stream.rawFile));
      let batch: ReturnType<typeof parseOriginalToolBatches> | undefined,
        parseError: string | undefined;
      try {
        batch = parseOriginalToolBatches(raw, stream.state.eof);
      } catch (error) {
        parseError = String(error);
      }
      return { ...stream, rawBytes: raw.length, sha256: hash(raw), batch, parseError };
    });
    stages.originalBatches = batches;
    const hits = batches.flatMap((stream) =>
      stream.batch?.complete
        ? stream.batch.calls
            .filter((call) => targetError(caseId, call))
            .map((call) => ({ stream, call }))
        : [],
    );
    naturalTargetErrorHit = hits.length > 0;
    stages.targetHits = hits;
    assert(
      live.wire.length <= 40 && live.requests.length <= 40,
      'aggregate_40_HTTP_all_attempts_no_outer_retry',
    );
    if (!hits.length)
      throw new Boundary(
        batches.some((batch) => !batch.batch?.complete || batch.state.error)
          ? 'not_hit_complete_original_target_batch_not_observed'
          : 'not_hit_model_did_not_generate_target_error',
      );
    const models = view.executions.filter((execution) => execution.kind === 'model');
    for (const hit of hits) {
      const trace = traces[hit.stream.modelExecutionId];
      if (!trace?.finish || !trace.eof)
        throw new Boundary(
          'natural_raw_target_observed_but_SDK_batch_not_admitted_preserve_original_failure',
        );
      assert(
        trace.calls.length === hit.stream.batch!.calls.length &&
          hit.stream.batch!.calls.every((raw) =>
            trace.calls.some(
              (call) =>
                call.id === raw.id && call.name === raw.name && call.arguments === raw.arguments,
            ),
          ),
        'actual_SDK_complete_batch_exact_all_original_raw_calls',
      );
      const actual = trace.calls.find((call) => call.id === hit.call.id);
      assert(
        actual && actual.name === hit.call.name && actual.arguments === hit.call.arguments,
        'actual_SDK_complete_call_exact_original_raw_name_and_arguments',
      );
      const paired = view.executions.filter(
        (execution) =>
          execution.kind === 'tool' &&
          execution.callId === hit.call.id &&
          object(execution.decisionSource).modelExecutionId === hit.stream.modelExecutionId,
      );
      assert(paired.length === 1, 'one_real_native_tool_result_paired_exact_call_and_Model');
      const tool = paired[0]!,
        result = object(tool.result),
        details = object(result.details);
      const expectedCode =
        caseId === naturalCases[0]
          ? 'tool_not_available'
          : caseId === naturalCases[1]
            ? 'agent_unavailable'
            : 'invalid_tool_arguments';
      const actualCode = caseId === naturalCases[1] ? object(details.error).code : details.code;
      assert(
        tool.status === 'failed' && result.outcome === 'failed' && actualCode === expectedCode,
        'original_native_failure_exact_expected_code_no_forged_result',
      );
      if (caseId !== naturalCases[1])
        assert(
          !toolBodiesEntered.some((entry) => entry.executionId === tool.id),
          'invalid_name_or_schema_zero_original_execute_or_resume',
        );
      else
        assert(
          toolBodiesEntered.some(
            (entry) =>
              entry.executionId === tool.id &&
              entry.definitionId === 'task.message' &&
              entry.method === 'execute',
          ),
          'bad_ID_reaches_real_Task_resolution_not_fabricated_rejection',
        );
      const originatingRequestIndex = live.requests.findIndex(
        (request) => request.requestId === hit.stream.modelExecutionId,
      );
      assert(originatingRequestIndex >= 0, 'original_target_actual_request_exists');
      const feedback = live.requests
        .slice(originatingRequestIndex + 1)
        .flatMap((request) =>
          request.messages
            .filter((message) => message.role === 'tool' && message.toolCallId === hit.call.id)
            .map((message) => ({ requestId: request.requestId, message })),
        );
      assert(
        feedback.length > 0 && feedback.every((item) => item.message.content === result.content),
        'complete_real_paired_feedback_in_subsequent_actual_Model_input',
      );
      const explainingModel = models.find(
        (execution) =>
          execution.sessionId === tool.sessionId &&
          execution.runId === tool.runId &&
          execution.status === 'succeeded' &&
          object(execution.result).finishReason === 'stop' &&
          traces[execution.id]?.finish &&
          traces[execution.id]?.eof &&
          traces[execution.id]!.calls.length === 0 &&
          String(object(execution.result).content ?? '').length > 0 &&
          feedback.some((item) => item.requestId === execution.id),
      );
      if (!explainingModel)
        throw new Boundary('target_rejected_but_following_real_Model_did_not_complete_explanation');
      checks.complete_explanation_from_actual_Model_with_exact_paired_feedback = true;
    }
    assert(
      view.executions.every(
        (execution) => execution.kind === 'model' || execution.kind === 'tool',
      ) &&
        view.runs.length === 1 &&
        models.every((execution) => execution.sessionId === 'root'),
      'no_child_Run_Job_or_external_effect_and_only_original_root_Model',
    );
    const final = models.find(
      (execution) =>
        execution.status === 'succeeded' &&
        traces[execution.id]?.finish &&
        traces[execution.id]?.eof &&
        traces[execution.id]!.calls.length === 0 &&
        String(object(execution.result).content ?? '').length > 0,
    );
    if (!final || view.runs[0]?.status !== 'completed')
      throw new Boundary('target_rejected_but_following_real_Model_did_not_complete_explanation');
    const beforeReads = {
      metadata: await owned.getMetadata(),
      view: await owned.getView('root'),
      wire: live.wire.length,
    };
    await runtime.getCommand('A');
    for (const execution of view.executions) await runtime.getExecution(execution.id);
    assert(
      isDeepStrictEqual(beforeReads, {
        metadata: await owned.getMetadata(),
        view: await owned.getView('root'),
        wire: live.wire.length,
      }),
      'original_evidence_reads_zero_Provider_or_cursor_change',
    );
    status = 'passed';
    reason = 'natural_target_generated_and_exact_native_rejection_complete_feedback';
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    status = error instanceof Boundary && error.violation ? 'failed' : 'inconclusive';
    stages.failure = { reason, stack: error instanceof Error ? error.stack : null };
  } finally {
    const inspectors = [];
    if (runtime && store && fixture)
      for (const actual of fixture.requests) {
        try {
          const execution = await store.getExecution(actual.requestId);
          if (!execution) {
            inspectors.push({ executionId: actual.requestId, unavailable: true });
            if (status === 'passed') {
              status = 'failed';
              reason = 'actual_Model_native_execution_unavailable';
            }
            continue;
          }
          const scope = {
            expectedStoreId: execution.originStoreId,
            sessionId: execution.sessionId,
            subjectId: 'owner',
            executionId: execution.id,
          };
          const input = await runtime.readModelInput(scope);
          let output: unknown;
          try {
            output = await runtime.readModelOutput(scope);
            if (
              status === 'passed' &&
              execution.status === 'succeeded' &&
              object(object(output).output).complete !== true
            ) {
              status = 'failed';
              reason = 'successful_Model_full_output_not_complete';
            }
          } catch (error) {
            output = { unavailableAtOriginalStatus: execution.status, error: String(error) };
            if (status === 'passed') {
              status = 'failed';
              reason = 'required_full_output_inspector_unavailable';
            }
          }
          const visible = structuredClone(actual);
          for (const message of visible.messages)
            delete (message as { continuation?: unknown }).continuation;
          if (!isDeepStrictEqual(input.request, visible)) {
            status = 'failed';
            reason = 'actual_ModelInput_differs_from_saved_full_input';
          }
          inspectors.push({ execution, input, output });
        } catch (error) {
          inspectors.push({
            executionId: actual.requestId,
            inspectorUnavailable: true,
            error: String(error),
          });
          if (status === 'passed') {
            status = 'failed';
            reason = 'required_full_inspector_unavailable';
          }
        }
      }
    save(join(root, 'canonical-model-evidence.json'), inspectors);
    try {
      if (runtime) await bounded(runtime.close(), 10000);
      else if (store) await bounded(store.close(), 10000);
      cleanup = true;
      if (streams.some((stream) => !stream.state.closed)) {
        cleanup = false;
        status = 'failed';
        reason = 'original_response_body_close_unconfirmed';
      }
    } catch (error) {
      status = 'failed';
      reason = 'cleanup_failed';
      stages.cleanupError = String(error);
    }
    const evidence = {
      stages,
      toolBodiesEntered,
      traces,
      streams,
      actualRequests: fixture?.requests,
      actualCalls: fixture?.calls,
      wire: fixture?.wire,
      usage: fixture?.usage,
      metadata: fixture?.metadata,
    };
    save(join(root, 'private-evidence.json'), evidence);
    const endCode = liveCodeEvidence();
    if (!isDeepStrictEqual(code, endCode)) {
      status = 'failed';
      reason = 'source_drift';
    }
    save(output, {
      caseId,
      status,
      reason,
      naturalTargetErrorHit,
      naturalOutcome: naturalTargetErrorHit ? 'hit' : 'not_hit',
      code,
      endCode,
      checks,
      physicalHTTP: fixture?.wire.length ?? 0,
      modelRequests: fixture?.requests.length ?? 0,
      requestLimit: 40,
      timeoutMs: 600000,
      durationMs: performance.now() - started,
      cleanupConfirmed: cleanup,
      fullInspectorCount: inspectors.length,
      evidence: {
        privateEvidenceSha256: hash(readFileSync(join(root, 'private-evidence.json'))),
        fullInspectorSha256: hash(readFileSync(join(root, 'canonical-model-evidence.json'))),
      },
      scope:
        'One naturally generated old-name, nonexistent-owned-ID or unknown-parameter probe. No response/call edits or protocol corruption. Full prose requires independent semantic review. Bad ID means deliberately nonexistent, not a real foreign Store/child.',
      notRun: [
        'natural-invalid-JSON',
        'natural-incomplete-tool-batch',
        'explicit-protocol-corruption-control',
        ...naturalCases.filter((id) => id !== caseId),
      ],
      unknownBilling:
        'Usage retained exactly when reported; absent usage is not zero and monetary cost is unknown.',
      semanticReviewRequired: true,
    });
  }
  return { status, reason, output, root };
}
if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_NATURAL_TOOLS !== '1')
    throw Error('C06_explicit_isolated_test_opt_in_required');
  const [caseId, output] = process.argv.slice(2);
  if (!naturalCases.includes(caseId as NaturalCase) || !output)
    throw Error('C06_known_case_and_new_absolute_output_required');
  const result = await runNaturalToolProbe(caseId as NaturalCase, output);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}
