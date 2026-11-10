import { type ModelAdapter, ModelAttemptError } from '@kite-ai/ai';
import {
  type AuthorizationRequest,
  defineExtension,
  type JobContext,
  type JobEvent,
  type JobHandle,
  type Json,
  type ToolResult,
} from '../../extensions';
import { canonicalJson } from '../../json';
import type { AgentRuntime, RunConfiguration } from '../../runtime';
import { AgentError, type CommandRecord, type RunRecord } from '../../storage/types';
import { originalTitleSource } from './source';
import { automaticTitleIdentity, automaticTitleRecord, readAutomaticTitleAttempt } from './state';
import { readableSessionTitle, sessionTitleInput, sessionTitleInstructions } from './title';

const extensionId = 'builtin.session-title';
type Runtime = Pick<
  AgentRuntime,
  | 'runInternalModel'
  | 'getCommand'
  | 'getSession'
  | 'getExecution'
  | 'claimAutomaticSessionTitle'
  | 'openAutomaticSessionTitle'
  | 'automaticSessionTitleResourcesStopped'
  | 'retainAutomaticSessionTitleCleanup'
  | 'disposeAutomaticSessionTitleConfiguration'
>;
function fields(value: Json): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** A short lifecycle Action registers one managed, detached metadata Job. */
export function createSessionTitleExtension(options: {
  runtime(): Runtime;
  resolveModel(input: {
    command: CommandRecord;
    session: NonNullable<Awaited<ReturnType<Runtime['getSession']>>>;
    workspace: NonNullable<Awaited<ReturnType<AgentRuntime['getWorkspace']>>>;
    run: RunRecord;
    modelId: string;
    signal: AbortSignal;
  }): Promise<RunConfiguration>;
}) {
  const schema = {
    type: 'object',
    required: ['commandId'],
    additionalProperties: false,
    properties: { commandId: { type: 'string' } },
  };
  const origin = async (sessionId: string, input: Json) => {
    const value = fields(input);
    const runtime = options.runtime();
    const command =
      typeof value.commandId === 'string' ? await runtime.getCommand(value.commandId) : null;
    const session = await runtime.getSession(sessionId);
    if (
      !command ||
      command.sessionId !== sessionId ||
      !['run.start', 'input.follow_up'].includes(command.kind) ||
      !session ||
      session.parentSessionId !== null ||
      session.deletedAt !== null ||
      typeof fields(command.request).content !== 'string'
    )
      return null;
    const lookup = originalTitleSource(command);
    let step = lookup.next();
    while (!step.done) step = lookup.next(await runtime.getCommand(step.value));
    if (!step.value) return null;
    return { command, originalCommand: step.value, session };
  };
  const claim = async (sessionId: string, input: Json) => {
    const selected = await origin(sessionId, input);
    if (!selected) return null;
    const saved = await options.runtime().claimAutomaticSessionTitle(selected.originalCommand);
    const attempt = saved && readAutomaticTitleAttempt(saved.record.value);
    return saved && attempt?.publication === 'pending' ? { ...selected, saved, attempt } : null;
  };
  type State = {
    context: JobContext;
    input: Json;
    controller: AbortController;
    task?: Promise<{ result: ToolResult; supervision: 'ended' | 'unknown' }>;
    supervision?: 'ended' | 'unknown';
    publicationSettled?: () => Promise<boolean>;
  };
  const handles = new WeakMap<JobHandle, State>();
  const state = (handle: JobHandle) => {
    const value = handles.get(handle);
    if (!value) throw new AgentError('session_title_handle_invalid');
    return value;
  };
  const stopped = async (value: State) =>
    value.supervision === 'ended' ||
    (value.supervision === 'unknown' &&
      (!value.publicationSettled || (await value.publicationSettled())) &&
      options.runtime().automaticSessionTitleResourcesStopped(value.context.executionId));
  const generate = async (state: State) => {
    const { context, controller } = state;
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const selected = await origin(context.sessionId, state.input);
    if (!selected) throw new AgentError('session_title_source_invalid');
    const runtime = options.runtime();
    const operation = await runtime.openAutomaticSessionTitle({
      jobExecutionId: context.executionId,
      sourceCommandId: selected.originalCommand.id,
      signal,
    });
    const retained = async (reason: string, unknown = false) => {
      await operation.close(reason);
      return {
        result: {
          outcome: unknown ? 'outcome_unknown' : 'succeeded',
          content: unknown ? reason : 'fallback_retained',
        } as ToolResult,
        supervision: unknown ? ('unknown' as const) : ('ended' as const),
      };
    };
    let activated: Awaited<ReturnType<typeof operation.activated>>;
    try {
      activated = await operation.activated();
    } catch (error) {
      if (signal.aborted) return retained('title_cancelled');
      throw error;
    }
    if (!activated) return retained('source_not_activated');
    const content = sessionTitleInput(fields(selected.originalCommand.request).content as string);
    if (!content) return retained('empty_title_input');
    const modelId = fields(activated.run.configuration).modelId;
    if (typeof modelId !== 'string') return retained('source_model_unavailable');
    // Only the original Run qualifies this attempt; failure cancels preparation/generation.
    const settled = operation.settled().then((run) => {
      if (run?.status !== 'completed')
        controller.abort(new AgentError('session_title_source_stopped'));
      return run;
    });
    void settled.catch(() => {});
    let configuration: RunConfiguration | undefined;
    let transferred = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attemptGeneration = async () => {
      try {
        try {
          configuration = await options.resolveModel({ ...activated, modelId, signal });
        } catch (error) {
          if (error instanceof AgentError && error.code === 'configuration_cleanup_unconfirmed') {
            runtime.retainAutomaticSessionTitleCleanup(context.executionId, error);
            return await retained('title_cleanup_unconfirmed', true);
          }
          return await retained('title_preparation_failed');
        }
        signal.throwIfAborted();
        const originalModel = configuration.model;
        if (!originalModel) throw new AgentError('session_title_model_unavailable');
        const model: ModelAdapter = {
          ...(originalModel.describeRequest
            ? { describeRequest: originalModel.describeRequest.bind(originalModel) }
            : {}),
          async *stream(request, options) {
            let bytes = 0;
            // Provider time starts after local model admission, independently of Run observation.
            timer = setTimeout(
              () => controller.abort(new AgentError('session_title_deadline')),
              10000,
            );
            timer.unref();
            try {
              for await (const event of originalModel.stream(request, options)) {
                if (
                  event.type === 'tool_call' ||
                  (event.type === 'finish' && event.reason !== 'stop')
                )
                  throw new AgentError('session_title_response_invalid');
                if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
                  bytes += Buffer.byteLength(event.text);
                  if (bytes > 32768) throw new AgentError('session_title_response_too_large');
                }
                yield event;
              }
            } catch (error) {
              if (ModelAttemptError.isInstance(error) || !(error instanceof AgentError))
                throw new AgentError('session_title_model_failed');
              throw error;
            } finally {
              clearTimeout(timer);
            }
          },
        };
        const call = runtime.runInternalModel({
          parentExecutionId: context.executionId,
          model,
          permissions: configuration.permissions,
          dispose: configuration.dispose,
          request: {
            requestId: `title-model-${context.executionId}`,
            modelId: configuration.modelId,
            messages: [
              { role: 'system', content: sessionTitleInstructions },
              { role: 'user', content },
            ],
            tools: [],
          },
          signal,
        });
        transferred = true;
        const result = await call;
        const title = readableSessionTitle(result.content);
        if (!title) return await retained('title_response_invalid');
        const run = await settled;
        if (run?.status !== 'completed') return await retained('source_run_not_successful');
        signal.throwIfAborted();
        const saved = await operation.publish(result.executionId, title);
        return {
          result: {
            outcome: 'succeeded',
            content: saved.command ? 'title_saved' : 'fallback_retained',
          } as ToolResult,
          supervision: 'ended' as const,
        };
      } catch (error) {
        if (error instanceof AgentError && error.code === 'session_title_publication_unconfirmed') {
          state.publicationSettled = operation.publicationSettled;
          return {
            result: { outcome: 'outcome_unknown', content: error.code } as ToolResult,
            supervision: 'unknown' as const,
          };
        }
        if (error instanceof AgentError && error.code === 'internal_model_stop_unconfirmed')
          return await retained('title_stop_unconfirmed', true);
        if (error instanceof AgentError && error.code === 'session_title_cleanup_unconfirmed')
          return await retained('title_cleanup_unconfirmed', true);
        if (
          error instanceof AgentError &&
          ['session_title_capacity_exceeded', 'session_title_queue_timeout'].includes(error.code)
        )
          return await retained(error.code);
        if (signal.aborted) return await retained('title_cancelled');
        if (
          error instanceof AgentError &&
          [
            'permission_denied',
            'permission_control_changed',
            'session_title_model_unavailable',
            'session_title_model_failed',
            'session_title_response_invalid',
            'session_title_response_too_large',
            'model_response_incomplete',
            'model_event_after_finish',
          ].includes(error.code)
        )
          return await retained('title_generation_failed');
        throw error;
      }
    };
    let result: Awaited<ReturnType<typeof attemptGeneration>> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      result = await attemptGeneration();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearTimeout(timer);
      controller.abort(new AgentError('session_title_observation_ended'));
    }
    if (!transferred && configuration?.dispose) {
      try {
        await runtime.disposeAutomaticSessionTitleConfiguration(
          context.executionId,
          configuration.dispose,
        );
      } catch (error) {
        if (
          !failed &&
          error instanceof AgentError &&
          error.code === 'session_title_cleanup_unconfirmed'
        )
          return await retained('title_cleanup_unconfirmed', true);
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
    return result!;
  };
  const extension = defineExtension({
    id: extensionId,
    version: '1',
    apiMajor: 1,
    lifecycle: {
      async beforeRun(event) {
        const selected = await claim(event.session.id, { commandId: event.command.id });
        return selected && selected.attempt.jobExecutionId === null
          ? {
              actionId: 'fallback',
              definitionVersion: '1',
              input: { commandId: event.command.id },
            }
          : null;
      },
    },
    // Existing legacy records remain readable; the new producer never adopts their marker.
    records: [
      {
        contentType: 'automatic-session-title',
        contentVersion: 1,
        schema: {
          type: 'object',
          required: ['commandId', 'revision', 'attempted'],
          additionalProperties: false,
          properties: {
            commandId: { type: 'string' },
            revision: { type: 'string' },
            attempted: { type: 'boolean' },
          },
        },
      },
      {
        contentType: automaticTitleRecord.contentType,
        contentVersion: automaticTitleRecord.contentVersion,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceCommandId',
            'fallbackDigest',
            'manualRenameCommandId',
            'jobExecutionId',
            'sourceRunId',
            'modelExecutionId',
            'publication',
            'publicationCommandId',
            'closedReason',
          ],
          properties: {
            sourceCommandId: { type: 'string' },
            fallbackDigest: { type: 'string' },
            manualRenameCommandId: { type: ['string', 'null'] },
            jobExecutionId: { type: ['string', 'null'] },
            sourceRunId: { type: ['string', 'null'] },
            modelExecutionId: { type: ['string', 'null'] },
            publication: { enum: ['pending', 'published', 'closed'] },
            publicationCommandId: { type: ['string', 'null'] },
            closedReason: { type: ['string', 'null'] },
          },
        },
      },
    ],
    actions: [
      {
        id: 'fallback',
        version: '1',
        description: 'Preserve first-input metadata and register one title Job.',
        inputSchema: schema,
        // No pre-write marker stamp is inherited by the operation's freshness checks.
        async prepare(input, context) {
          return (await origin(context.sessionId, input)) ? input : null;
        },
        async execute(input, context) {
          const selected = await claim(context.sessionId, input);
          if (!selected) return { outcome: 'succeeded', content: 'skipped' };
          await context.operations.ensure({
            key: automaticTitleIdentity(
              selected.originalCommand.originStoreId,
              context.sessionId,
              selected.originalCommand.id,
            ).operationKey,
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: `${extensionId}/generate`,
              definitionVersion: '1',
              input: { commandId: selected.command.id },
            },
          });
          return { outcome: 'succeeded', content: 'title_registered' };
        },
      },
    ],
    jobs: [
      {
        id: `${extensionId}/generate`,
        version: '1',
        description: 'Generate and publish the first automatic title.',
        inputSchema: schema,
        async start(input, context) {
          const handle = { reference: { commandId: fields(input).commandId! } };
          handles.set(handle, { input, context, controller: new AbortController() });
          return handle;
        },
        async *observe(handle): AsyncIterable<JobEvent> {
          const value = state(handle);
          value.task ??= generate(value).then((result) => {
            value.supervision = result.supervision;
            return result;
          });
          const result = await value.task;
          yield { type: 'terminal', ...result };
        },
        async cancel(handle) {
          const value = state(handle);
          value.controller.abort(new AgentError('session_title_cancel_requested'));
          return {
            status: (await stopped(value)) ? 'already_finished' : 'requested',
          };
        },
        async dispose(handle) {
          const value = state(handle);
          if (!(await stopped(value))) throw new AgentError('session_title_stop_unconfirmed');
          handles.delete(handle);
        },
      },
    ],
  });
  return {
    extension,
    async preserveInputFallback(input: Readonly<CommandRecord>): Promise<void> {
      const selected = await origin(input.sessionId, { commandId: input.id });
      if (
        !selected ||
        selected.command.requestDigest !== input.requestDigest ||
        selected.command.originStoreId !== input.originStoreId ||
        selected.command.subjectId !== input.subjectId
      )
        return;
      await options.runtime().claimAutomaticSessionTitle(selected.originalCommand);
    },
    async authorize(request: AuthorizationRequest) {
      if (request.definitionVersion !== '1') return null;
      if (
        request.kind === 'job' &&
        [`${extensionId}/fallback`, `${extensionId}/generate`].includes(request.definitionId)
      )
        return { allowed: true, revision: 'session-title-1' };
      if (request.kind !== 'model' || request.runId !== null) return null;
      request.signal.throwIfAborted();
      const runtime = options.runtime();
      const execution = await runtime.getExecution(request.executionId);
      if (
        execution?.kind !== 'model' ||
        execution.runId !== null ||
        execution.childSessionId !== null ||
        execution.sessionId !== request.sessionId ||
        execution.definitionId !== request.definitionId ||
        execution.definitionVersion !== request.definitionVersion ||
        canonicalJson(execution.input) !== canonicalJson(request.input) ||
        !execution.parentExecutionId
      )
        return null;
      const command = await runtime.getCommand(execution.originCommandId);
      const parent = await runtime.getExecution(execution.parentExecutionId);
      request.signal.throwIfAborted();
      return command?.kind === 'session.title' &&
        command.sessionId === execution.sessionId &&
        command.originStoreId === execution.originStoreId &&
        parent?.definitionId === `${extensionId}/generate` &&
        parent.definitionVersion === '1' &&
        parent.sessionId === execution.sessionId &&
        parent.originStoreId === execution.originStoreId &&
        parent.rootWorkCommandId === execution.rootWorkCommandId &&
        parent.rootWorkSeq === execution.rootWorkSeq &&
        ['dispatching', 'running'].includes(parent.status)
        ? { allowed: true, revision: 'session-title-model-1' }
        : null;
    },
  };
}
