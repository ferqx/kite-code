import {
  type AgentClient,
  ClientError,
  type Command,
  type Execution,
  type SelectContextRequest,
  type SelectedContextPage,
} from '@kite-ai/client';
import type { ContextSubmission } from '../src/controller';
import { NativeCompression } from './compression';
export type ContextViewScope = {
  generation: number;
  selection: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
export type NativeContextFacts = { observationId: number; page: SelectedContextPage };
export type IncludeScope = {
  storeId: string;
  sessionId: string;
  contextSelectionId: string;
  targetRunId?: string;
};
/** A public-page view and frozen caller intents; it does not select or reconstruct Model input. */
export class NativeContext {
  private readonly client: AgentClient;
  private readonly current: () => ContextViewScope | undefined;
  private readonly notify: () => void;
  private observed:
    | {
        scope: ContextViewScope;
        facts: NativeContextFacts;
        lastSourceId?: string;
        boundaries: Map<string, string>;
        readId?: string;
      }
    | undefined;
  private reading: { abort: AbortController; readId?: string } | undefined;
  private sequence = 0;
  private readonly compression: NativeCompression;
  private readonly intents = new Map<
    string,
    { state: ContextSubmission; promise?: Promise<Command> }
  >();
  constructor(
    client: AgentClient,
    current: () => ContextViewScope | undefined,
    notify: () => void,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.compression = new NativeCompression(client, notify);
  }
  get submissions() {
    return [...this.intents.values()].map((entry) => structuredClone(entry.state));
  }
  get compressionSubmissions() {
    return this.compression.submissions;
  }
  maintainCompression(observationId: number, kind: 'compress' | 'reset', focus?: string) {
    const observed = this.observe(observationId),
      compressionId = observed.facts.page.compression?.id ?? null;
    return this.compression.submit(
      {
        sessionId: observed.scope.sessionId,
        rootSessionId: observed.scope.sessionId,
        storeId: observed.scope.storeId,
        selectionId: observed.facts.page.selection.id,
        compressionId,
        kind,
        focus,
      },
      async () => {
        const view = await this.verified(observed);
        if (
          view.session.parentSessionId !== null ||
          (view.session.rootSessionId ?? view.session.id) !== observed.scope.sessionId
        )
          throw new ClientError('child_session_readonly');
        const page = await this.client.getContext(observed.scope.sessionId, {
          storeId: observed.scope.storeId,
          contextSelectionId: observed.facts.page.selection.id,
          messageLimit: 1,
          sourceLimit: 1,
        });
        if (!this.same(observed.scope) || (page.compression?.id ?? null) !== compressionId)
          throw new ClientError('compression_selection_changed');
      },
    );
  }
  lookupCompression(commandId: string) {
    return this.compression.lookup(commandId);
  }
  release() {
    this.reading?.abort.abort();
    this.reading = undefined;
    this.observed = undefined;
  }
  close(readId: string) {
    if (this.reading?.readId === readId) {
      this.reading.abort.abort();
      this.reading = undefined;
    }
    if (this.observed?.readId === readId) this.observed = undefined;
  }
  private same(scope: ContextViewScope) {
    const now = this.current();
    return (
      !!now &&
      Object.keys(scope).every(
        (key) => now[key as keyof ContextViewScope] === scope[key as keyof ContextViewScope],
      )
    );
  }
  async read(sessionId: string, next = false, readId?: string): Promise<NativeContextFacts> {
    const scope = this.current();
    if (!scope || scope.sessionId !== sessionId) throw new ClientError('native_selection_changed');
    const previous = next ? this.observed : undefined;
    if (next && (!previous || !this.same(previous.scope)))
      throw new ClientError('context_observation_changed');
    const page = previous?.facts.page;
    if (page && page.nextAfterSeq === null && page.nextAfterSourceId === null)
      throw new ClientError('context_page_end');
    this.release();
    if (!this.client.serverInfo?.capabilities.includes('context'))
      throw new ClientError('capability_unavailable');
    const abort = new AbortController();
    const reading = { abort, readId };
    this.reading = reading;
    try {
      const query = {
        storeId: scope.storeId,
        byteLimit: 8 * 1048576,
        ...(page
          ? {
              contextSelectionId: page.selection.id,
              upperSeq: page.highWaterSeq,
              afterSeq: page.nextAfterSeq ?? page.highWaterSeq,
              ...((page.nextAfterSourceId ?? previous?.lastSourceId) === undefined
                ? {}
                : { afterSourceId: page.nextAfterSourceId ?? previous?.lastSourceId }),
            }
          : {}),
      };
      let messageLimit = 200,
        sourceLimit = 100;
      let value = await this.client.getContext(
        scope.sessionId,
        {
          storeId: scope.storeId,
          byteLimit: 8 * 1048576,
          messageLimit: 200,
          sourceLimit: 100,
          ...(page
            ? {
                contextSelectionId: page.selection.id,
                upperSeq: page.highWaterSeq,
                afterSeq: page.nextAfterSeq ?? page.highWaterSeq,
                ...((page.nextAfterSourceId ?? previous?.lastSourceId) === undefined
                  ? {}
                  : { afterSourceId: page.nextAfterSourceId ?? previous?.lastSourceId }),
              }
            : {}),
        },
        { signal: abort.signal },
      );
      const selectedId = value.selection.id,
        highWaterSeq = value.highWaterSeq;
      while (
        Buffer.byteLength(JSON.stringify({ observationId: this.sequence + 1, page: value })) >
        4 * 1048576 - 1024
      ) {
        abort.signal.throwIfAborted();
        if (!this.same(scope)) throw new ClientError('native_selection_changed');
        if (messageLimit === 1 && sourceLimit === 1)
          throw new ClientError('context_page_too_large');
        messageLimit = Math.max(1, Math.floor(messageLimit / 2));
        sourceLimit = Math.max(1, Math.floor(sourceLimit / 2));
        value = await this.client.getContext(
          scope.sessionId,
          {
            ...query,
            contextSelectionId: selectedId,
            upperSeq: highWaterSeq,
            messageLimit,
            sourceLimit,
          },
          { signal: abort.signal },
        );
      }
      abort.signal.throwIfAborted();
      if (!this.same(scope)) throw new ClientError('native_selection_changed');
      if (value.selection.id !== selectedId || value.highWaterSeq !== highWaterSeq)
        throw new ClientError('context_selection_changed');
      if (
        value.selection.sessionId !== scope.sessionId ||
        (page &&
          (value.selection.id !== page.selection.id || value.highWaterSeq !== page.highWaterSeq))
      )
        throw new ClientError('context_selection_changed');
      const boundaries = previous?.boundaries ?? new Map<string, string>();
      for (const message of value.messages)
        if (message.status === 'complete') boundaries.set(message.id, message.seq);
      const facts = { observationId: ++this.sequence, page: structuredClone(value) };
      this.observed = {
        scope: { ...scope },
        facts,
        boundaries,
        lastSourceId: value.resultSources.at(-1)?.id ?? previous?.lastSourceId,
        readId,
      };
      return facts;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
  }
  private observe(observationId: number) {
    const value = this.observed;
    if (!value || value.facts.observationId !== observationId || !this.same(value.scope))
      throw new ClientError('context_observation_changed');
    return value;
  }
  private async verified(
    observation: NonNullable<NativeContext['observed']>,
    scope?: IncludeScope,
  ) {
    const view = await this.client.getView(observation.scope.sessionId);
    if (!this.same(observation.scope)) throw new ClientError('native_selection_changed');
    if (
      view.storeId !== observation.scope.storeId ||
      view.session.id !== observation.scope.sessionId ||
      view.session.workspaceId !== observation.scope.workspaceId ||
      view.session.contextSelectionId !== observation.facts.page.selection.id ||
      view.session.deletedAt !== null
    )
      throw new ClientError('context_selection_changed');
    if (
      scope &&
      (scope.storeId !== view.storeId ||
        scope.sessionId !== view.session.id ||
        scope.contextSelectionId !== view.session.contextSelectionId)
    )
      throw new ClientError('context_selection_changed');
    const active = view.runs.filter((run) => run.isActive);
    if (scope?.targetRunId) {
      if (
        active.length !== 1 ||
        active[0]!.id !== scope.targetRunId ||
        active[0]!.sessionId !== scope.sessionId
      )
        throw new ClientError('input_target_changed');
    } else if (
      active.length ||
      view.executions.some((execution) =>
        ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(execution.status),
      )
    )
      throw new ClientError('input_busy');
    return view;
  }
  rewind(observationId: number, boundary: SelectContextRequest['boundary']) {
    const observed = this.observe(observationId);
    if (boundary && observed.boundaries.get(boundary.messageId) !== boundary.seq)
      throw new ClientError('context_boundary_unavailable');
    return this.save(
      {
        sessionId: observed.scope.sessionId,
        kind: 'rewind',
        phase: 'saved',
        intent: {
          expectedStoreId: observed.scope.storeId,
          commandId: crypto.randomUUID(),
          expectedContextSelectionId: observed.facts.page.selection.id,
          boundary: structuredClone(boundary),
        },
      },
      async () => {
        await this.verified(observed);
      },
    );
  }
  include(observationId: number, executionId: string, resultRevision: string, scope: IncludeScope) {
    const observed = this.observe(observationId),
      frozen = structuredClone(scope);
    if (
      frozen.storeId !== observed.scope.storeId ||
      frozen.sessionId !== observed.scope.sessionId ||
      frozen.contextSelectionId !== observed.facts.page.selection.id
    )
      throw new ClientError('context_selection_changed');
    return this.save(
      {
        sessionId: frozen.sessionId,
        kind: 'include',
        executionId,
        phase: 'saved',
        intent: {
          expectedStoreId: frozen.storeId,
          commandId: crypto.randomUUID(),
          expectedContextSelectionId: frozen.contextSelectionId,
          resultRevision,
          ...(frozen.targetRunId ? { targetRunId: frozen.targetRunId } : {}),
        },
      },
      async () => {
        const view = await this.verified(observed, frozen),
          execution: Execution | undefined = view.executions.find(
            (value) => value.id === executionId && value.resultRevision === resultRevision,
          );
        if (
          execution?.kind !== 'job' ||
          !execution.originStoreId ||
          execution.delivery !== 'suppressed' ||
          !['succeeded', 'failed', 'cancelled'].includes(execution.status)
        )
          throw new ClientError('historical_result_unavailable');
      },
    );
  }
  private save(state: ContextSubmission, verify: () => Promise<void>): Promise<Command> {
    const key = JSON.stringify([
      state.sessionId,
      state.kind,
      state.executionId,
      state.intent.expectedStoreId,
      state.intent.expectedContextSelectionId,
      'boundary' in state.intent ? state.intent.boundary : state.intent.resultRevision,
      'targetRunId' in state.intent ? state.intent.targetRunId : null,
    ]);
    const old = this.intents.get(key);
    if (old?.promise) return old.promise;
    if (old) throw new ClientError('context_intent_already_saved');
    if (
      [...this.intents.values()].some((entry) =>
        ['saved', 'submitting', 'unknown', 'queued'].includes(entry.state.phase),
      )
    )
      throw new ClientError('context_intent_pending');
    if (this.intents.size >= 128) throw new ClientError('context_intent_limit');
    const entry: { state: ContextSubmission; promise?: Promise<Command> } = {
      state: structuredClone(state),
    };
    this.intents.set(key, entry);
    this.notify();
    entry.promise = (async () => {
      let dispatched = false;
      try {
        await verify();
        entry.state = { ...entry.state, phase: 'submitting' };
        this.notify();
        dispatched = true;
        const response =
          entry.state.kind === 'rewind'
            ? await this.client.rewind(
                entry.state.sessionId,
                entry.state.intent as SelectContextRequest,
              )
            : await this.client.includeResult(
                entry.state.sessionId,
                entry.state.executionId!,
                entry.state.intent as import('@kite-ai/client').IncludeResultRequest,
              );
        return this.apply(entry, response.command);
      } catch (error) {
        const known =
          error instanceof ClientError &&
          error.problem &&
          error.status !== undefined &&
          [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status);
        entry.state = {
          ...entry.state,
          phase: !dispatched || known ? 'failed' : 'unknown',
          error: error instanceof ClientError ? error.code : 'network_outcome_unknown',
        };
        throw error;
      } finally {
        entry.promise = undefined;
        this.notify();
      }
    })();
    return entry.promise;
  }
  private apply(entry: { state: ContextSubmission }, command: Command) {
    const state = entry.state;
    if (
      command.id !== state.intent.commandId ||
      command.originStoreId !== state.intent.expectedStoreId ||
      command.sessionId !== state.sessionId ||
      command.kind !== (state.kind === 'rewind' ? 'context.select' : 'result.include')
    )
      throw new ClientError('context_receipt_mismatch');
    const receipt = command.receipt as { outcome?: string; runId?: string } | null;
    const phase =
      command.status === 'applied'
        ? 'applied'
        : command.status === 'rejected'
          ? 'failed'
          : state.kind === 'include' &&
              command.status === 'accepted' &&
              'targetRunId' in state.intent &&
              state.intent.targetRunId &&
              receipt?.outcome === 'result_queued' &&
              receipt.runId === state.intent.targetRunId
            ? 'queued'
            : 'unknown';
    entry.state = { ...state, phase, receipt: structuredClone(command), error: undefined };
    return command;
  }
  lookup(commandId: string) {
    const entry = [...this.intents.values()].find(
      (value) => value.state.intent.commandId === commandId,
    );
    if (!entry) throw new ClientError('context_intent_not_saved');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getCommand(commandId)
      .then((command) => this.apply(entry, command))
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
}
