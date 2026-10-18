import { createHash } from 'node:crypto';
import { type ModelAdapter, ModelAttemptError } from '@kite-ai/ai';
import {
  type AuthorizationRequest,
  defineExtension,
  type Json,
  type RunBoundaryEvent,
} from '../../extensions';
import type {
  AgentRuntime,
  ChildAgentConfiguration,
  RunConfiguration,
  RuntimeOptions,
} from '../../runtime';
import { AgentError } from '../../storage/types';
import {
  fallbackSessionTitle,
  readableSessionTitle,
  sessionTitleInput,
  sessionTitleInstructions,
} from './title';

const extensionId = 'builtin.session-title';
const configurationId = 'session-title';
const recordKey = 'automatic-title';
const contentType = 'automatic-session-title';
const instructionsDigest = createHash('sha256').update(sessionTitleInstructions).digest('hex');
type ChildInput = Parameters<NonNullable<RuntimeOptions['resolveChildRunConfiguration']>>[0];
type Runtime = Pick<
  AgentRuntime,
  'getCommand' | 'getRun' | 'getSession' | 'getExecution' | 'renameSession' | 'listMessages'
>;

function fields(value: Json): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Business policy uses ordinary lifecycle Actions and an ordinary tool-free child. */
export function createSessionTitleExtension(options: {
  runtime(): Runtime;
  resolveModel(input: {
    command: Awaited<ReturnType<Runtime['getCommand']>> & {};
    session: Awaited<ReturnType<Runtime['getSession']>> & {};
    workspace: ChildInput['workspace'];
    modelId: string;
  }): Promise<RunConfiguration>;
}) {
  const schema = {
    type: 'object',
    required: ['commandId'],
    additionalProperties: false,
    properties: { commandId: { type: 'string' }, runId: { type: 'string' } },
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
      command.kind !== 'run.start' ||
      !session ||
      session.parentSessionId !== null ||
      session.deletedAt !== null ||
      typeof fields(command.request).content !== 'string'
    )
      return null;
    return { command, session, content: fields(command.request).content as string };
  };
  const lifecycleAction = (actionId: 'fallback' | 'generate', event: RunBoundaryEvent) => {
    if (event.command.kind !== 'run.start' || event.session.parentSessionId !== null) return null;
    if (
      actionId === 'fallback' &&
      (event.session.title !== '' || event.session.controlRevision !== '0')
    )
      return null;
    if (actionId === 'generate' && event.session.controlRevision !== '1') return null;
    return {
      actionId,
      definitionVersion: '1',
      input: { commandId: event.command.id, ...(event.run ? { runId: event.run.id } : {}) },
    };
  };
  const extension = defineExtension({
    id: extensionId,
    version: '1',
    apiMajor: 1,
    lifecycle: {
      async beforeRun(event) {
        return lifecycleAction('fallback', event);
      },
      async beforeRunComplete(event) {
        return lifecycleAction('generate', event);
      },
    },
    records: [
      {
        contentType,
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
    ],
    actions: [
      {
        id: 'fallback',
        version: '1',
        description: 'Preserve the first input as an automatic title fallback.',
        inputSchema: schema,
        async prepare(input, context) {
          const selected = await origin(context.sessionId, input);
          return selected?.session.title === '' &&
            selected.session.controlRevision === '0' &&
            !(await context.records.get(recordKey)) &&
            (await options.runtime().listMessages(context.sessionId, { limit: 1 })).length === 0
            ? input
            : null;
        },
        async execute(input, context) {
          const selected = await origin(context.sessionId, input);
          if (selected?.session.title !== '' || selected.session.controlRevision !== '0')
            return { outcome: 'succeeded', content: 'skipped' };
          try {
            const renamed = await options.runtime().renameSession({
              expectedStoreId: selected.command.originStoreId,
              commandId: `title-fallback-${context.executionId}`,
              sessionId: context.sessionId,
              subjectId: selected.command.subjectId,
              ifRevision: '0',
              title: fallbackSessionTitle(selected.content),
            });
            await context.records.write({
              key: recordKey,
              contentType,
              contentVersion: 1,
              expectedRevision: null,
              value: {
                commandId: selected.command.id,
                revision: renamed.session.controlRevision,
                attempted: false,
              },
            });
            return { outcome: 'succeeded', content: 'fallback_saved' };
          } catch (error) {
            if (
              error instanceof AgentError &&
              ['session_revision_changed', 'session_deleted'].includes(error.code)
            )
              return { outcome: 'succeeded', content: 'superseded' };
            throw error;
          }
        },
      },
      {
        id: 'generate',
        version: '1',
        description: 'Generate one readable automatic conversation title.',
        inputSchema: schema,
        async prepare(input, context) {
          const selected = await origin(context.sessionId, input);
          const record = await context.records.get(recordKey);
          const marker = fields(record?.value ?? null);
          const runId = fields(input).runId;
          const run = typeof runId === 'string' ? await options.runtime().getRun(runId) : null;
          return selected &&
            marker.commandId === selected.command.id &&
            marker.attempted === false &&
            marker.revision === selected.session.controlRevision &&
            run?.originCommandId === selected.command.id &&
            run.sessionId === context.sessionId
            ? input
            : null;
        },
        async execute(input, context) {
          if (input === null) return { outcome: 'succeeded', content: 'skipped' };
          const selected = await origin(context.sessionId, input);
          const record = await context.records.get(recordKey);
          const marker = fields(record?.value ?? null);
          if (
            !selected ||
            !record ||
            marker.attempted !== false ||
            marker.commandId !== selected.command.id ||
            marker.revision !== selected.session.controlRevision
          )
            return { outcome: 'succeeded', content: 'skipped' };
          await context.records.write({
            key: recordKey,
            contentType,
            contentVersion: 1,
            expectedRevision: record.revision,
            value: { ...marker, attempted: true },
          });
          const content = sessionTitleInput(selected.content);
          if (!content) return { outcome: 'succeeded', content: 'fallback_retained' };
          const ref = await context.operations.ensure({
            key: `title-${selected.command.id}`,
            resultDelivery: 'caller',
            request: {
              kind: 'agent',
              configurationId,
              input: { content },
            },
          });
          let cancellation: Promise<void> | undefined;
          const cancel = () =>
            (cancellation ??= context.operations.cancel!(ref, {
              commandId: `title-stop-${context.executionId}`,
            }));
          const timer = setTimeout(() => {
            void cancel().catch(() => {});
          }, 10000);
          timer.unref();
          try {
            const result = await context.operations.wait(ref, {
              signal: context.signal,
              timeoutMs: 30000,
            });
            if (result.status === 'outcome_unknown')
              return { outcome: 'outcome_unknown', content: 'title_stop_unconfirmed' };
            const title =
              result.status === 'succeeded'
                ? readableSessionTitle(String(fields(result.result).content ?? ''))
                : null;
            context.signal.throwIfAborted();
            if (title)
              await options.runtime().renameSession({
                expectedStoreId: selected.command.originStoreId,
                commandId: `title-generated-${context.executionId}`,
                sessionId: context.sessionId,
                subjectId: selected.command.subjectId,
                ifRevision: marker.revision as string,
                title,
              });
            return { outcome: 'succeeded', content: title ? 'title_saved' : 'fallback_retained' };
          } catch (error) {
            if (
              error instanceof AgentError &&
              ['session_revision_changed', 'session_deleted'].includes(error.code)
            )
              return { outcome: 'succeeded', content: 'superseded' };
            if (
              !context.signal.aborted &&
              !(error instanceof AgentError && error.code === 'wait_timeout')
            )
              throw error;
            await cancel().catch(() => {});
            // Scoped reads remain available after cancellation; wait() correctly uses
            // the aborted callback signal and cannot confirm its own cleanup.
            const deadline = Date.now() + 1000;
            for (;;) {
              const actual = await context.operations.get(ref);
              if (actual && ['succeeded', 'failed', 'cancelled'].includes(actual.status))
                return {
                  outcome: context.signal.aborted ? 'cancelled' : 'succeeded',
                  content: 'fallback_retained',
                };
              if (actual?.status === 'outcome_unknown' || Date.now() >= deadline)
                return { outcome: 'outcome_unknown', content: 'title_stop_unconfirmed' };
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          } finally {
            clearTimeout(timer);
          }
        },
      },
    ],
  });
  return {
    extension,
    childConfiguration: {
      id: configurationId,
      version: '1',
      modelId: 'unresolved',
      toolIds: [],
      snapshot: {},
      model: {
        stream() {
          throw new AgentError('child_configuration_unresolved');
        },
      },
    } satisfies ChildAgentConfiguration,
    async resolveChild(input: ChildInput): Promise<RunConfiguration> {
      if (input.parentExecution.definitionId !== `${extensionId}/generate`)
        throw new AgentError('session_title_scope_invalid');
      const selected = await origin(
        input.parentSession.id,
        fields(input.command.request).input ?? null,
      );
      const runId = fields(fields(input.command.request).input ?? null).runId;
      const run = typeof runId === 'string' ? await options.runtime().getRun(runId) : null;
      const modelId = fields(run?.configuration ?? null).modelId;
      if (
        !selected ||
        run?.originCommandId !== selected.command.id ||
        run.sessionId !== selected.session.id ||
        typeof modelId !== 'string'
      )
        throw new AgentError('session_title_scope_invalid');
      const configuration = await options.resolveModel({
        ...selected,
        workspace: input.workspace,
        modelId,
      });
      const originalModel = configuration.model!;
      const model: ModelAdapter = {
        ...(originalModel.describeRequest
          ? { describeRequest: originalModel.describeRequest.bind(originalModel) }
          : {}),
        async *stream(request, options) {
          let bytes = 0;
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
            if (ModelAttemptError.isInstance(error))
              throw new AgentError('session_title_model_failed');
            throw error;
          }
        },
      };
      return {
        ...configuration,
        model,
        toolIds: [],
        extensions: [],
        sources: {
          async capture(request) {
            return [
              {
                id: `${extensionId}:instructions`,
                kind: 'instruction',
                role: 'system',
                scope: request.sessionId,
                digest: instructionsDigest,
                content: sessionTitleInstructions,
              },
            ];
          },
        },
      };
    },
    ownsChild(id: string) {
      return id === configurationId;
    },
    async authorize(request: AuthorizationRequest) {
      if (request.definitionVersion !== '1') return null;
      if (
        request.kind === 'job' &&
        [`${extensionId}/fallback`, `${extensionId}/generate`, `agent/${configurationId}`].includes(
          request.definitionId,
        )
      )
        return { allowed: true, revision: 'session-title-1' };
      if (request.kind !== 'model') return null;
      const runtime = options.runtime();
      const execution = await runtime.getExecution(request.executionId);
      const carrier = execution?.parentExecutionId
        ? await runtime.getExecution(execution.parentExecutionId)
        : null;
      return carrier?.definitionId === `agent/${configurationId}` &&
        carrier.childSessionId === request.sessionId
        ? { allowed: true, revision: 'session-title-1' }
        : null;
    },
  };
}
