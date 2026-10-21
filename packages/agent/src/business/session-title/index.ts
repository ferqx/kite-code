import { createHash } from 'node:crypto';
import { type ModelAdapter, ModelAttemptError } from '@kite-ai/ai';
import {
  type AuthorizationRequest,
  defineExtension,
  type Json,
  type RunBoundaryEvent,
} from '../../extensions';
import { canonicalJson } from '../../json';
import type {
  AgentRuntime,
  ChildAgentConfiguration,
  RunConfiguration,
  RuntimeOptions,
} from '../../runtime';
import { AgentError, type CommandRecord } from '../../storage/types';
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
  | 'getCommand'
  | 'getRun'
  | 'getSession'
  | 'getExecution'
  | 'renameSession'
  | 'listMessages'
  | 'getChanges'
  | 'getMetadata'
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
      !['run.start', 'input.follow_up'].includes(command.kind) ||
      !session ||
      session.parentSessionId !== null ||
      session.deletedAt !== null ||
      typeof fields(command.request).content !== 'string'
    )
      return null;
    let originalCommand = command;
    const receipt = fields(command.receipt);
    const inputCommandId = receipt.humanInputCommandId ?? receipt.inputCommandId;
    if (typeof inputCommandId === 'string' && typeof receipt.decisionCommandId === 'string') {
      const raw = await runtime.getCommand(inputCommandId);
      const decision = await runtime.getCommand(receipt.decisionCommandId);
      const publicId = fields(raw?.request ?? null).publicCommandId;
      const original = typeof publicId === 'string' ? await runtime.getCommand(publicId) : null;
      if (
        raw?.kind !== 'human.input' ||
        decision?.kind !== 'human.input.decision' ||
        !original ||
        !['run.start', 'input.follow_up'].includes(original.kind) ||
        [raw, decision, original].some(
          (item) =>
            item.sessionId !== sessionId ||
            item.originStoreId !== command.originStoreId ||
            item.subjectId !== command.subjectId,
        ) ||
        fields(raw.receipt).decisionCommandId !== decision.id ||
        fields(raw.receipt).businessCommandId !== command.id ||
        fields(decision.receipt).businessCommandId !== command.id ||
        fields(original.receipt).humanInputCommandId !== raw.id ||
        fields(original.receipt).businessCommandId !== command.id ||
        canonicalJson(fields(raw.request).originalRequest ?? null) !==
          canonicalJson(original.request) ||
        fields(raw.request).content !== fields(command.request).content ||
        fields(original.request).content !== fields(command.request).content
      )
        return null;
      originalCommand = original;
      const clarificationId =
        fields(decision.request).clarifiesInputId ?? fields(raw.request).clarifiesInputId;
      if (typeof clarificationId === 'string') {
        const first = await runtime.getCommand(clarificationId);
        const firstRequest = fields(first?.request ?? null);
        const firstReceipt = fields(first?.receipt ?? null);
        const firstPublicId = firstRequest.publicCommandId;
        const firstPublic =
          typeof firstPublicId === 'string' ? await runtime.getCommand(firstPublicId) : null;
        const firstPublicReceipt = fields(firstPublic?.receipt ?? null);
        const proposal = fields(fields(decision.request).proposal ?? null);
        if (
          first?.kind !== 'human.input' ||
          !firstPublic ||
          !['run.start', 'input.follow_up'].includes(firstPublic.kind) ||
          [first, firstPublic].some(
            (item) =>
              item.sessionId !== sessionId ||
              item.originStoreId !== command.originStoreId ||
              item.subjectId !== command.subjectId,
          ) ||
          proposal.relation !== 'independent_work' ||
          proposal.purpose !== 'work' ||
          proposal.targetRootWorkCommandId !== null ||
          firstReceipt.state !== 'clarified' ||
          firstReceipt.clarifyingInputId !== raw.id ||
          firstReceipt.decisionCommandId !== decision.id ||
          firstReceipt.originalSelection !== null ||
          !Array.isArray(firstReceipt.candidateWorkCommandIds) ||
          firstReceipt.candidateWorkCommandIds.length !== 0 ||
          firstPublicReceipt.humanInputCommandId !== first.id ||
          firstPublicReceipt.reason !== 'clarified_by_input' ||
          firstPublicReceipt.clarifyingInputId !== raw.id ||
          canonicalJson(firstRequest.originalRequest ?? null) !==
            canonicalJson(firstPublic.request) ||
          firstRequest.content !== fields(firstPublic.request).content
        )
          return null;
        originalCommand = firstPublic;
      }
    }
    return {
      command,
      originalCommand,
      session,
      content: fields(originalCommand.request).content as string,
    };
  };
  const metadataId = (command: Readonly<CommandRecord>) =>
    `title-input-fallback-${createHash('sha256')
      .update(JSON.stringify([command.originStoreId, command.sessionId, command.id]))
      .digest('hex')}`;
  const noOtherRename = async (
    sessionId: string,
    inputCommandId: string,
    allowedRevision?: string,
  ) => {
    const metadata = await options.runtime().getMetadata();
    let after = metadata.replayFloor;
    const upper = BigInt(metadata.lastChangeCursor);
    let registered = false;
    for (;;) {
      const page = await options
        .runtime()
        .getChanges({ after, limit: 128, sessionIds: [sessionId] });
      if (BigInt(page.metadata.replayFloor) > BigInt(after)) return false;
      const events = page.events.filter((event) => BigInt(event.cursor) <= upper);
      registered ||= events.some(
        (event) => event.type === 'human.input_registered' && event.objectId === inputCommandId,
      );
      if (
        events.some(
          (event) =>
            event.type === 'session.renamed' &&
            fields(event.payload).controlRevision !== allowedRevision,
        )
      )
        return false;
      if (!events.length || BigInt(events.at(-1)!.cursor) >= upper || page.events.length < 128)
        return registered;
      after = events.at(-1)!.cursor;
    }
  };
  const metadataFallback = async (selected: NonNullable<Awaited<ReturnType<typeof origin>>>) => {
    const saved = await options.runtime().getCommand(metadataId(selected.originalCommand));
    const receipt = fields(saved?.receipt ?? null);
    const snapshot = fields(receipt.session ?? null);
    const title = fallbackSessionTitle(selected.content);
    const inputId = fields(selected.originalCommand.receipt).humanInputCommandId;
    const raw = typeof inputId === 'string' ? await options.runtime().getCommand(inputId) : null;
    if (
      saved?.kind !== 'session.rename' ||
      saved.status !== 'applied' ||
      saved.sessionId !== selected.session.id ||
      saved.originStoreId !== selected.command.originStoreId ||
      saved.subjectId !== selected.command.subjectId ||
      fields(saved.request).title !== title ||
      receipt.outcome !== 'renamed' ||
      snapshot.id !== selected.session.id ||
      snapshot.title !== title ||
      typeof snapshot.controlRevision !== 'string' ||
      selected.session.title !== title ||
      raw?.kind !== 'human.input' ||
      fields(raw.receipt).observedControlRevision !== '0' ||
      fields(raw.receipt).originalSelection !== null ||
      !(await noOtherRename(selected.session.id, raw.id, snapshot.controlRevision))
    )
      return null;
    return { revision: selected.session.controlRevision };
  };
  const lifecycleAction = async (actionId: 'fallback' | 'generate', event: RunBoundaryEvent) => {
    if (
      !['run.start', 'input.follow_up'].includes(event.command.kind) ||
      event.session.parentSessionId !== null
    )
      return null;
    const selected = await origin(event.session.id, { commandId: event.command.id });
    if (!selected) return null;
    const metadata = await metadataFallback(selected);
    if (
      actionId === 'fallback' &&
      !metadata &&
      (event.session.title !== '' || event.session.controlRevision !== '0')
    )
      return null;
    if (actionId === 'generate' && !metadata && event.session.controlRevision !== '1') return null;
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
          if (!selected || (await context.records.get(recordKey))) return null;
          if (await metadataFallback(selected)) return input;
          return selected.session.title === '' &&
            selected.session.controlRevision === '0' &&
            (await options.runtime().listMessages(context.sessionId, { limit: 1 })).length === 0
            ? input
            : null;
        },
        async execute(input, context) {
          const selected = await origin(context.sessionId, input);
          if (!selected) return { outcome: 'succeeded', content: 'skipped' };
          const metadata = await metadataFallback(selected);
          if (metadata) {
            await context.records.write({
              key: recordKey,
              contentType,
              contentVersion: 1,
              expectedRevision: null,
              value: {
                commandId: selected.originalCommand.id,
                revision: metadata.revision,
                attempted: false,
              },
            });
            return { outcome: 'succeeded', content: 'fallback_saved' };
          }
          if (selected.session.title !== '' || selected.session.controlRevision !== '0')
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
                commandId: selected.originalCommand.id,
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
            marker.commandId === selected.originalCommand.id &&
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
            marker.commandId !== selected.originalCommand.id ||
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
    /** Host-only metadata; no Action, Run, Tool, Model, or work selection is created. */
    async preserveInputFallback(input: Readonly<CommandRecord>): Promise<void> {
      const runtime = options.runtime();
      const command = await runtime.getCommand(input.id);
      if (
        !command ||
        command.requestDigest !== input.requestDigest ||
        command.originStoreId !== input.originStoreId ||
        command.sessionId !== input.sessionId ||
        command.subjectId !== input.subjectId ||
        !['run.start', 'input.follow_up'].includes(command.kind)
      )
        return;
      const rawId = fields(command.receipt).humanInputCommandId;
      const raw = typeof rawId === 'string' ? await runtime.getCommand(rawId) : null;
      const fact = fields(raw?.receipt ?? null);
      const rawRequest = fields(raw?.request ?? null);
      if (
        raw?.kind !== 'human.input' ||
        raw.sessionId !== command.sessionId ||
        raw.originStoreId !== command.originStoreId ||
        raw.subjectId !== command.subjectId ||
        rawRequest.publicCommandId !== command.id ||
        rawRequest.content !== fields(command.request).content ||
        fact.observedControlRevision !== '0' ||
        fact.originalSelection !== null
      )
        return;
      if (await runtime.getCommand(metadataId(command))) return;
      const session = await runtime.getSession(command.sessionId);
      if (
        !session ||
        session.parentSessionId !== null ||
        session.deletedAt !== null ||
        session.title !== '' ||
        (await runtime.listMessages(command.sessionId, { limit: 1 })).length !== 0 ||
        !(await noOtherRename(session.id, raw.id))
      )
        return;
      try {
        await runtime.renameSession({
          expectedStoreId: command.originStoreId,
          sessionId: session.id,
          commandId: metadataId(command),
          subjectId: command.subjectId,
          ifRevision: session.controlRevision,
          title: fallbackSessionTitle(rawRequest.content as string),
        });
      } catch (error) {
        if (
          error instanceof AgentError &&
          ['session_revision_changed', 'session_deleted'].includes(error.code)
        )
          return;
        throw error;
      }
    },
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
