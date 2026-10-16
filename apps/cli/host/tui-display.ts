import { estimateModelContext } from '@kite-ai/agent/context-estimate';
import type { AgentClient, Message, Run, SessionView } from '@kite-ai/client';
import type { TuiPendingInput, TuiSnapshot } from '@kite-ai/ui/tui';
import { readTuiTimings, type TuiExecutionTiming } from './tui-timing';

type Environment = NonNullable<TuiSnapshot['environment']>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Only accepted public-directory records are pending; an unknown local POST is not. */
export async function readTuiPendingInputs(
  client: Pick<AgentClient, 'listPendingInputs'>,
  storeId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<readonly TuiPendingInput[]> {
  const commands: TuiPendingInput[] = [];
  const ids = new Set<string>();
  let afterSeq = '0',
    snapshotCursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await client.listPendingInputs(
      sessionId,
      { storeId, afterSeq, limit: 200 },
      { signal },
    );
    signal.throwIfAborted();
    // This directory has no frozen-upper query. A changed page observation is
    // unavailable, rather than a manufactured complete queue.
    snapshotCursor ??= page.snapshotCursor;
    if (page.snapshotCursor !== snapshotCursor || page.commands.length > 200)
      throw Error('tui_pending_input_observation_changed');
    for (const input of page.commands) {
      if (
        input.sessionId !== sessionId ||
        input.originStoreId !== storeId ||
        input.status !== 'accepted' ||
        input.cancelRequestedAt !== null ||
        !['input.steer', 'input.follow_up', 'result.include'].includes(input.kind) ||
        input.kind !== input.request.kind ||
        !/^(0|[1-9][0-9]*)$/.test(input.seq) ||
        BigInt(input.seq) <= BigInt(afterSeq) ||
        ids.has(input.id)
      )
        throw Error('tui_pending_input_identity_mismatch');
      ids.add(input.id);
      afterSeq = input.seq;
      // Result inclusion belongs to Context, not a fabricated text prompt.
      // Still consume its exact sequence so a mixed page remains complete.
      if (input.request.kind !== 'result.include')
        commands.push({ ...input, request: input.request });
    }
    if (page.nextAfterSeq === null) return commands;
    if (!page.commands.length || page.nextAfterSeq !== afterSeq)
      throw Error('tui_pending_input_cursor_invalid');
  }
}

function frozenModelConfiguration(run: Run, id: string): Record<string, unknown> | undefined {
  const configuration = object(object(run.configuration)?.configuration);
  const models = Array.isArray(configuration?.models) ? configuration.models.map(object) : [];
  const matches = models.filter((entry) => entry?.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
function frozenModelName(run: Run, id: string): string {
  const model = frozenModelConfiguration(run, id);
  return typeof model?.model === 'string' && model.model.length > 0 ? model.model : id;
}
function frozenModel(run: Run): Environment['runtimeModel'] {
  const configuration = object(object(run.configuration)?.configuration);
  const id = typeof configuration?.modelId === 'string' ? configuration.modelId : undefined;
  const model = id ? frozenModelConfiguration(run, id) : undefined;
  const options = object(model?.options);
  return {
    runId: run.id,
    active: run.isActive,
    ...(id ? { modelName: frozenModelName(run, id) } : {}),
    ...(typeof options?.reasoningEffort === 'string' ? { effort: options.reasoningEffort } : {}),
    source: id ? 'run_configuration' : 'unavailable',
  };
}

/** Observed usage snapshots, counted once per original Model, including failed/cancelled attempts. */
export function tuiRecordedUsage(
  view: SessionView,
  messages: readonly Message[],
): Environment['usage'] {
  const seen = new Set<string>();
  let inputTokens = 0,
    outputTokens = 0,
    cachedInputTokens = 0,
    hasOutput = true,
    hasCache = true;
  const add = (id: string, result: unknown) => {
    if (seen.has(id)) return;
    const usage = object(object(result)?.usage);
    if (!count(usage?.inputTokens)) return;
    if (
      usage.cachedInputTokens !== undefined &&
      (!count(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens)
    )
      return;
    const nextInput = inputTokens + usage.inputTokens;
    if (!Number.isSafeInteger(nextInput)) return;
    seen.add(id);
    inputTokens = nextInput;
    if (count(usage.outputTokens) && Number.isSafeInteger(outputTokens + usage.outputTokens))
      outputTokens += usage.outputTokens;
    else hasOutput = false;
    if (
      count(usage.cachedInputTokens) &&
      Number.isSafeInteger(cachedInputTokens + usage.cachedInputTokens)
    )
      cachedInputTokens += usage.cachedInputTokens;
    else hasCache = false;
  };
  for (const execution of view.executions) {
    const run = view.runs.find((entry) => entry.id === execution.runId);
    if (
      execution.kind === 'model' &&
      ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status) &&
      execution.sessionId === view.session.id &&
      execution.originStoreId === view.storeId &&
      run?.sessionId === execution.sessionId &&
      run.originStoreId === execution.originStoreId
    )
      add(execution.id, execution.result);
  }
  for (const message of messages) {
    const id =
      message.outputBody?.executionId ??
      (message.sourceIds?.length === 1 ? message.sourceIds[0] : undefined);
    if (message.role !== 'assistant' || message.status !== 'complete' || !id || seen.has(id))
      continue;
    const sourceSession = message.originMessage?.sessionId ?? message.sessionId;
    const sourceRun = message.originMessage ? message.originMessage.runId : message.runId;
    const execution = view.executions.find((entry) => entry.id === id);
    const run = view.runs.find((entry) => entry.id === sourceRun);
    if (
      !execution ||
      !run ||
      execution.kind !== 'model' ||
      execution.status !== 'succeeded' ||
      execution.sessionId !== sourceSession ||
      execution.runId !== sourceRun ||
      run.sessionId !== sourceSession ||
      !execution.originStoreId ||
      execution.originStoreId !== run.originStoreId ||
      execution.originStoreId !== (message.originMessage?.storeId ?? view.storeId)
    )
      continue;
    const result = object(execution.result);
    // A preview is not the saved complete content. outputBody identifies that
    // saved Model; without it, the exact content must also agree.
    if (!message.outputBody && result?.content !== message.content) continue;
    add(id, result);
  }
  return seen.size
    ? {
        inputTokens,
        executionCount: seen.size,
        ...(hasOutput ? { outputTokens } : {}),
        ...(hasCache ? { cachedInputTokens } : {}),
      }
    : undefined;
}

/** The display cache retains only facts for the current finite view, never request bodies. */
export function createTuiDisplayReader(
  client: Pick<AgentClient, 'getModelInput' | 'listSessionLogs'> &
    Partial<Pick<AgentClient, 'getContextEstimate'>>,
  storeId: string,
) {
  let lastModel:
    | {
        key: string;
        value: NonNullable<Environment['runtimeModel']>;
        context?: Environment['context'];
      }
    | undefined;
  let timing: { key: string; value: Readonly<Record<string, TuiExecutionTiming>> } | undefined;
  let forecast:
    | { key: string; value: Awaited<ReturnType<AgentClient['getContextEstimate']>> }
    | undefined;
  return async (view: SessionView, messages: readonly Message[], signal: AbortSignal) => {
    const runs =
      view.storeId === storeId
        ? view.runs.filter(
            (entry) => entry.originStoreId === storeId && entry.sessionId === view.session.id,
          )
        : [];
    const run = runs.find((entry) => entry.isActive) ?? runs.at(-1);
    let runtimeModel = run ? frozenModel(run) : undefined;
    let context: Environment['context'];
    const model =
      run &&
      view.executions
        .filter(
          (entry) =>
            entry.kind === 'model' &&
            entry.runId === run.id &&
            entry.sessionId === view.session.id &&
            entry.originStoreId === run.originStoreId,
        )
        .at(-1);
    const key =
      model &&
      JSON.stringify([
        storeId,
        view.session.id,
        view.session.rootSessionId,
        model.id,
        model.runId,
        model.originStoreId,
        model.rootWorkCommandId,
        model.rootWorkSeq,
        model.definitionId,
        model.definitionVersion,
        run?.originCommandId,
      ]);
    if (run && model && key) {
      if (lastModel?.key === key) {
        runtimeModel = { ...lastModel.value, active: run.isActive };
        context = lastModel.context;
      } else {
        try {
          const input = await client.getModelInput(view.session.id, model.id, {
            expectedStoreId: storeId,
            signal,
          });
          signal.throwIfAborted();
          if (
            input.storeId !== storeId ||
            input.sessionId !== view.session.id ||
            input.rootSessionId !== view.session.rootSessionId ||
            input.executionId !== model.id ||
            input.runId !== run.id ||
            input.originCommandId !== run.originCommandId
          )
            throw Error('tui_model_display_identity_mismatch');
          const adapter = input.metadata.adapter;
          const provider = adapter.availability === 'available' ? adapter.provider : undefined;
          runtimeModel = {
            runId: run.id,
            active: run.isActive,
            modelName:
              provider?.availability === 'available' && provider.modelId.length > 0
                ? provider.modelId
                : frozenModelName(run, input.request.modelId),
            source: 'model_input',
            ...(adapter.availability === 'available' &&
            adapter.settings.reasoningEffort !== undefined
              ? { effort: adapter.settings.reasoningEffort }
              : {}),
          };
          if (
            Array.isArray(input.request.messages) &&
            Array.isArray(input.request.tools) &&
            /^[a-f0-9]{64}$/.test(input.bodyHash)
          ) {
            const capabilities = object(
              frozenModelConfiguration(run, input.request.modelId)?.modelCapabilities,
            );
            context = {
              source: 'model_input',
              storeId,
              sessionId: view.session.id,
              runId: run.id,
              executionId: model.id,
              modelId: input.request.modelId,
              bodyHash: input.bodyHash,
              ...estimateModelContext(
                input.request,
                capabilities,
                adapter.availability === 'available' ? adapter.settings.maxOutputTokens : undefined,
              ),
            };
          }
          lastModel = { key, value: runtimeModel, context };
        } catch {
          /* Frozen Run selection remains separately labelled; no default substitution. */
        }
      }
    }
    // The saved input is immutable, but a running attempt can acquire usage later.
    // Overlay the current exact result on every observation instead of caching it
    // with the input body, or a first read during streaming would stay estimated.
    const reportedInputTokens = object(object(model?.result)?.usage)?.inputTokens;
    if (context && count(reportedInputTokens)) {
      context = {
        ...context,
        reportedInputTokens,
        ...(context.usableInputTokens && context.usableInputTokens > 0
          ? { utilization: reportedInputTokens / context.usableInputTokens }
          : {}),
      };
    }
    const timingKey = JSON.stringify([
      storeId,
      view.session.id,
      view.executions.map((entry) => [
        entry.id,
        entry.originStoreId,
        entry.status,
        entry.resultRevision,
      ]),
    ]);
    const executionTimings =
      timing?.key === timingKey
        ? timing.value
        : await readTuiTimings(client, storeId, view, signal);
    if (
      !signal.aborted &&
      Object.values(executionTimings).some((entry) => entry.availability === 'recorded_dispatch')
    )
      timing = { key: timingKey, value: executionTimings };
    let nextContext: Environment['nextContext'];
    const observedUsage = tuiRecordedUsage(view, messages);
    let usage: Environment['usage'] = observedUsage
      ? { ...observedUsage, scope: 'observed' }
      : undefined;
    if (context && client.getContextEstimate) {
      try {
        const forecastKey = JSON.stringify([
          storeId,
          view.session.id,
          view.snapshotCursor,
          context.executionId,
          model?.status,
          model?.resultRevision,
        ]);
        const projection =
          forecast?.key === forecastKey
            ? forecast.value
            : await client.getContextEstimate(
                view.session.id,
                { storeId, executionId: context.executionId },
                { signal },
              );
        signal.throwIfAborted();
        if (
          projection.storeId === storeId &&
          projection.sessionId === view.session.id &&
          projection.runId === context.runId &&
          projection.modelId === context.modelId &&
          projection.modelInputExecutionId === context.executionId &&
          BigInt(projection.snapshotCursor) >= BigInt(view.snapshotCursor)
        ) {
          nextContext = projection;
          usage = { ...projection.cumulativeUsage, scope: 'session' };
          // Cache only numeric facts at the exact observed cursor; streaming/new history invalidates them.
          if (projection.snapshotCursor === view.snapshotCursor)
            forecast = { key: forecastKey, value: projection };
        }
      } catch {
        /* A projection is unavailable rather than substituted with old measurements. */
      }
    }
    return { runtimeModel, context, nextContext, usage, executionTimings };
  };
}
