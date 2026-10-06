import {
  type AgentClient,
  type AnswerInteractionRequest,
  ClientError,
  type Command,
  type Execution,
  type ExtensionCommandRequest,
  type IncludeResultRequest,
  type Interaction,
  type InteractionAttachment,
  interactionAttachment,
  type Json,
  type PermissionModeState,
  type PermissionMutation,
  type PublicView,
  requiresInteractionAttachment,
  type SelectContextRequest,
  type SelectedContextPage,
  type SessionView,
  type SetPermissionModeRequest,
  type SetWorkspaceTrustRequest,
  type WorkspaceTrustState,
} from '@kite-ai/client';
import { serializePlanReviewAnswer } from '@kite-ai/ui';

export interface QuerySelection {
  readonly extensionId: string;
  readonly queryId: string;
  readonly input: Json;
}
export interface DesktopSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly view: SessionView;
  readonly publicViews: readonly PublicView[];
  readonly interactions: readonly Interaction[];
  readonly interactionsAfterId: string | null;
  readonly context?: SelectedContextPage;
  readonly activeCommand?: Command;
  readonly permissions?: DesktopPermissionFacts;
}
export interface DesktopOptions {
  readonly admittedClient: AgentClient;
  readonly onSnapshot: (snapshot: DesktopSnapshot) => void;
  readonly onPermissionSubmission?: (submission: PermissionSubmission) => void;
  readonly onContextSubmission?: (submission: ContextSubmission) => void;
  readonly onInteractionSubmission?: (submission: InteractionAnswerSubmission) => void;
  readonly onError?: (error: unknown) => void;
  readonly stopPairedService?: () => Promise<void>;
  readonly maxCachedObjects?: number;
  readonly maxCacheBytes?: number;
  /** Hosts with a separate explicit Context reader need not preload its body for history. */
  readonly readContextOnSelect?: boolean;
  /** Native input binds the original active command before choosing steer or follow-up. */
  readonly readActiveCommandOnSelect?: boolean;
  readonly interactionAnswerJournal?: {
    prepare(submission: InteractionAnswerSubmission, view: SessionView): Promise<void>;
    finish(submission: InteractionAnswerSubmission): void;
    lookup(submission: InteractionAnswerSubmission): Promise<Command>;
  };
}

/** A received Command is not evidence that this original answer was saved until its exact receipt agrees. */
export function verifyInteractionAnswerReceipt(
  interaction: Pick<Interaction, 'id' | 'presentationSessionId'>,
  intent: AnswerInteractionRequest,
  command: Command,
): 'accepted' | 'failed' {
  if (
    command.id !== intent.commandId ||
    command.originStoreId !== intent.expectedStoreId ||
    command.sessionId !== interaction.presentationSessionId ||
    command.kind !== 'interaction.answer'
  )
    throw new ClientError('answer_receipt_mismatch');
  if (command.status === 'rejected') return 'failed';
  const receipt = command.receipt;
  if (
    command.status !== 'applied' ||
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.outcome !== 'answer_saved' ||
    receipt.interactionId !== interaction.id ||
    receipt.decisionRevision !== (BigInt(intent.expectedRevision) + 1n).toString() ||
    typeof receipt.cancelled !== 'boolean'
  )
    throw new ClientError('answer_receipt_mismatch');
  return 'accepted';
}

export interface InteractionAnswerSubmission {
  readonly interaction: Interaction;
  readonly intent: AnswerInteractionRequest;
  readonly phase: 'saved' | 'submitting' | 'accepted' | 'unknown' | 'failed';
  readonly receipt?: Command;
  readonly error?: string;
}

export interface ContextSubmission {
  readonly sessionId: string;
  readonly kind: 'rewind' | 'include';
  readonly executionId?: string;
  readonly intent: SelectContextRequest | IncludeResultRequest;
  readonly phase: 'saved' | 'submitting' | 'queued' | 'applied' | 'unknown' | 'failed';
  readonly receipt?: Command;
  readonly error?: string;
}
export interface DesktopPermissionFacts {
  readonly observationId: number;
  readonly mode: PermissionModeState;
  readonly trust: WorkspaceTrustState;
}
export interface PermissionSubmission {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly workspaceId: string;
  readonly intent: SetPermissionModeRequest | SetWorkspaceTrustRequest;
  readonly kind: 'permission.mode' | 'workspace.trust';
  readonly phase: 'saved' | 'submitting' | 'applied' | 'unknown' | 'failed';
  readonly receipt?: PermissionMutation;
  readonly error?: string;
}
/** Portable main-adapter controller. Selecting a view never owns the Session execution. */
export class DesktopController {
  readonly client: AgentClient;
  private readonly options: DesktopOptions;
  private readonly cache = new Map<string, { snapshot: DesktopSnapshot; bytes: number }>();
  private readonly cacheLimit: number;
  private readonly byteLimit: number;
  private cacheBytes = 0;
  private generation = 0;
  private selected: { sessionId: string; queries: readonly QuerySelection[] } | undefined;
  private current: DesktopSnapshot | undefined;
  private stream: Promise<void> | undefined;
  private observing: AbortController | undefined;
  private disposed = false;
  private readonly attachmentReads = new Set<AbortController>();
  private readonly verifiedAttachments = new Set<string>();
  private interactionRead: AbortController | undefined;
  private interactionReadGeneration: number | undefined;
  private interactionPageStartId: string | undefined;
  private readonly answers = new Map<
    string,
    { state: InteractionAnswerSubmission; promise?: Promise<Command> }
  >();
  private readonly contextBoundaries = new Map<string, string>();
  private contextPaging:
    | {
        generation: number;
        sessionId: string;
        storeId: string;
        page: SelectedContextPage;
        lastSourceId?: string;
      }
    | undefined;
  private readonly contextIntents = new Map<
    string,
    { state: ContextSubmission; promise?: Promise<Command> }
  >();
  private permissionObservation = 0;
  private readonly permissionIntents = new Map<
    string,
    { state: PermissionSubmission; promise?: Promise<PermissionMutation> }
  >();
  private actionIntent: { sessionId: string; intent: ExtensionCommandRequest } | undefined;

  constructor(options: DesktopOptions) {
    this.client = options.admittedClient;
    this.options = options;
    this.cacheLimit = options.maxCachedObjects ?? 8;
    this.byteLimit = options.maxCacheBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.cacheLimit) ||
      this.cacheLimit < 0 ||
      !Number.isSafeInteger(this.byteLimit) ||
      this.byteLimit < 1
    )
      throw new Error('invalid_cache_bounds');
    if (!this.client.serverInfo) throw new ClientError('connection_not_admitted');
  }
  get lastActionIntent(): { sessionId: string; intent: ExtensionCommandRequest } | undefined {
    return this.actionIntent ? structuredClone(this.actionIntent) : undefined;
  }
  get viewGeneration(): number {
    return this.generation;
  }
  get snapshot(): DesktopSnapshot | undefined {
    return this.current;
  }
  get cachedObjectCount(): number {
    return this.cache.size;
  }
  get cachedBytes(): number {
    return this.cacheBytes;
  }

  async selectSession(
    sessionId: string,
    queries: readonly QuerySelection[] = [],
  ): Promise<DesktopSnapshot | undefined> {
    if (this.disposed) throw new Error('controller_disposed');
    this.cancelInteractionRead();
    this.clearAttachmentReads();
    const generation = ++this.generation;
    this.selected = { sessionId, queries: structuredClone(queries) };
    this.current = undefined;
    return this.readSelection(this.selected, generation);
  }

  /** Event refresh re-reads the visible bounded window using fresh observation facts. */
  async refreshSession(sessionId: string): Promise<DesktopSnapshot | undefined> {
    const original = this.current;
    if (
      !this.selected ||
      this.selected.sessionId !== sessionId ||
      (original && original.sessionId !== sessionId)
    )
      return this.selectSession(sessionId);
    const previous =
      this.interactionPageStartId && original
        ? { afterId: this.interactionPageStartId, scope: original.view }
        : undefined;
    this.cancelInteractionRead();
    this.clearAttachmentReads(true);
    const generation = ++this.generation;
    this.current = undefined;
    return this.readSelection(this.selected, generation, previous);
  }

  private async readSelection(
    selection: { sessionId: string; queries: readonly QuerySelection[] },
    generation: number,
    previous?: { afterId: string; scope: SessionView },
  ): Promise<DesktopSnapshot | undefined> {
    this.cancelInteractionRead();
    try {
      const view = await this.client.getView(selection.sessionId);
      const afterId =
        previous &&
        previous.scope.storeId === view.storeId &&
        previous.scope.session.id === view.session.id &&
        previous.scope.session.workspaceId === view.session.workspaceId &&
        previous.scope.session.contextSelectionId === view.session.contextSelectionId
          ? previous.afterId
          : undefined;
      const publicViews = (
        await Promise.all(
          selection.queries.map((query) =>
            this.client.queryExtension(
              selection.sessionId,
              query.extensionId,
              query.queryId,
              query.input,
            ),
          ),
        )
      ).flat();
      const page = this.client.serverInfo?.capabilities?.includes('interactions')
        ? await this.client.listInteractions(selection.sessionId, {
            storeId: view.storeId,
            state: 'pending',
            limit: 20,
            ...(afterId ? { afterId } : {}),
          })
        : { interactions: [], nextAfterId: null };
      this.validateInteractionPage(page, view, afterId);
      if (afterId && 'snapshotCursor' in page && page.snapshotCursor !== view.snapshotCursor)
        throw new ClientError('interaction_page_observation_changed');
      const context =
        this.options.readContextOnSelect !== false &&
        this.client.serverInfo?.capabilities?.includes('context')
          ? await this.client.getContext(selection.sessionId, {
              storeId: view.storeId,
              messageLimit: 200,
              sourceLimit: 100,
            })
          : undefined;
      const permissions = this.client.serverInfo?.capabilities?.includes('permission_controls')
        ? {
            observationId: ++this.permissionObservation,
            mode: await this.client.getPermissionMode(selection.sessionId, {
              storeId: view.storeId,
            }),
            trust: await this.client.getWorkspaceTrust(view.session.workspaceId, {
              storeId: view.storeId,
            }),
          }
        : undefined;
      if (permissions) {
        Object.freeze(permissions.mode);
        for (const scope of permissions.trust.readScopes) Object.freeze(scope);
        Object.freeze(permissions.trust.readScopes);
        Object.freeze(permissions.trust);
        Object.freeze(permissions);
      }
      const activeRun = view.runs.find((run) => run.isActive);
      const activeCommand =
        this.options.readActiveCommandOnSelect && activeRun
          ? await this.client.getCommand(activeRun.originCommandId)
          : undefined;
      if (
        activeCommand &&
        (activeCommand.id !== activeRun!.originCommandId ||
          activeCommand.sessionId !== view.session.id ||
          activeCommand.originStoreId !== view.storeId)
      )
        throw new ClientError('active_command_identity_unavailable');
      const snapshot: DesktopSnapshot = {
        sessionId: selection.sessionId,
        generation,
        view,
        publicViews,
        interactions: page.interactions,
        interactionsAfterId: page.nextAfterId,
        context,
        activeCommand,
        permissions,
      };
      // A late response may enter the bounded cache; its generation cannot select the visible page.
      this.remember(snapshot);
      if (
        this.disposed ||
        generation !== this.generation ||
        this.selected?.sessionId !== selection.sessionId
      )
        return undefined;
      this.current = snapshot;
      this.interactionPageStartId = afterId;
      const visibleAttachmentKeys = new Set<string>();
      for (const interaction of snapshot.interactions) {
        try {
          const attachment = interactionAttachment(interaction);
          if (attachment) visibleAttachmentKeys.add(attachment.key);
        } catch {
          // An invalid attachment can never retain a previous view's proof.
        }
      }
      for (const key of this.verifiedAttachments)
        if (!visibleAttachmentKeys.has(key)) this.verifiedAttachments.delete(key);
      this.contextBoundaries.clear();
      for (const message of context?.messages ?? [])
        if (message.status === 'complete') this.contextBoundaries.set(message.id, message.seq);
      this.contextPaging = context
        ? {
            generation,
            sessionId: selection.sessionId,
            storeId: view.storeId,
            page: context,
            lastSourceId: context.resultSources.at(-1)?.id,
          }
        : undefined;
      this.options.onSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.options.onError?.(error);
      if (generation === this.generation && !this.disposed) throw error;
      return undefined;
    }
  }

  cancelInteractionRead(generation?: number): void {
    if (generation !== undefined && generation !== this.interactionReadGeneration) return;
    this.interactionRead?.abort();
    this.interactionRead = undefined;
    this.interactionReadGeneration = undefined;
  }

  private validateInteractionPage(
    page: { interactions: readonly Interaction[]; nextAfterId: string | null },
    view: SessionView,
    afterId?: string,
  ): void {
    if (page.interactions.length > 20) throw new ClientError('interaction_page_budget_exceeded');
    const ids = new Set<string>();
    let previousId = afterId;
    for (const card of page.interactions) {
      if (
        card.originStoreId !== view.storeId ||
        card.presentationSessionId !== view.session.id ||
        card.state !== 'pending' ||
        ids.has(card.id) ||
        (previousId !== undefined && card.id <= previousId)
      )
        throw new ClientError('interaction_page_identity_mismatch');
      ids.add(card.id);
      previousId = card.id;
    }
    if (
      page.nextAfterId !== null &&
      (!page.interactions.length ||
        page.nextAfterId !== page.interactions.at(-1)!.id ||
        (afterId !== undefined && page.nextAfterId <= afterId))
    )
      throw new ClientError('interaction_page_cursor_invalid');
  }

  /** Explicitly replaces the visible bounded page; never accumulates all pending bodies. */
  async nextInteractionPage(
    generation: number,
    afterId: string,
  ): Promise<DesktopSnapshot | undefined> {
    const original = this.current;
    if (
      !original ||
      generation !== this.generation ||
      original.generation !== generation ||
      original.interactionsAfterId !== afterId
    )
      throw new ClientError('interaction_page_observation_changed');
    this.cancelInteractionRead();
    const abort = new AbortController();
    this.interactionRead = abort;
    this.interactionReadGeneration = generation;
    const scope = original.view;
    try {
      const page = await this.client.listInteractions(
        original.sessionId,
        { storeId: scope.storeId, state: 'pending', limit: 20, afterId },
        { signal: abort.signal },
      );
      this.validateInteractionPage(page, scope, afterId);
      if (page.snapshotCursor !== scope.snapshotCursor)
        throw new ClientError('interaction_page_observation_changed');
      const current = await this.client.getView(original.sessionId, { signal: abort.signal });
      abort.signal.throwIfAborted();
      if (
        this.disposed ||
        this.current !== original ||
        generation !== this.generation ||
        current.storeId !== scope.storeId ||
        current.session.id !== original.sessionId ||
        current.session.workspaceId !== scope.session.workspaceId ||
        current.session.contextSelectionId !== scope.session.contextSelectionId ||
        current.snapshotCursor !== scope.snapshotCursor
      )
        throw new ClientError('interaction_page_observation_changed');
      const next = {
        ...original,
        interactions: page.interactions,
        interactionsAfterId: page.nextAfterId,
      };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > this.byteLimit)
        throw new ClientError('interaction_page_budget_exceeded');
      this.clearAttachmentReads();
      this.current = next;
      this.interactionPageStartId = afterId;
      this.remember(next);
      this.options.onSnapshot(next);
      return next;
    } catch (error) {
      if (abort.signal.aborted) return undefined;
      if (
        error instanceof ClientError &&
        error.code === 'interaction_page_observation_changed' &&
        this.current === original &&
        this.selected?.sessionId === original.sessionId &&
        generation === this.generation &&
        !this.disposed
      )
        await this.readSelection(this.selected, generation);
      throw error;
    } finally {
      if (this.interactionRead === abort) this.interactionRead = undefined;
    }
  }

  private remember(snapshot: DesktopSnapshot): void {
    if (this.disposed || !this.cacheLimit) return;
    const key = `${snapshot.view.storeId}/${snapshot.sessionId}`;
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cacheBytes -= previous.bytes;
    }
    if (bytes > this.byteLimit) return;
    this.cache.set(key, { snapshot, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > this.cacheLimit || this.cacheBytes > this.byteLimit) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }

  /** Exactly one client stream, independent of the current page selection. */
  observe(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('controller_disposed'));
    if (this.stream) return this.stream;
    const controller = new AbortController();
    this.observing = controller;
    const stream = this.client.observe({
      signal: controller.signal,
      onChange: async (change) => {
        if (change.sessionId && this.selected?.sessionId === change.sessionId)
          await this.refreshSession(this.selected.sessionId);
      },
      onReset: async () => {
        this.cache.clear();
        this.cacheBytes = 0;
        if (this.selected) await this.readSelection(this.selected, this.generation);
      },
    });
    this.stream = stream.finally(() => {
      if (this.observing === controller) {
        this.observing = undefined;
        this.stream = undefined;
      }
    });
    return this.stream;
  }

  async invokeAction(
    action: PublicView['actions'][number],
    input: Json = action.input,
  ): Promise<Command> {
    const selection = this.selected;
    const snapshot = this.current;
    if (!selection || !snapshot || snapshot.generation !== this.generation)
      throw new ClientError('view_not_ready');
    // A user explicitly invoking an offered action creates one new stable intent.
    const intent: ExtensionCommandRequest = {
      expectedStoreId: snapshot.view.storeId,
      commandId: crypto.randomUUID(),
      kind: 'extension.invoke',
      extensionId:
        snapshot.publicViews.find((view) => view.actions.includes(action))?.extensionId ?? '',
      actionId: action.actionId,
      definitionVersion: action.definitionVersion,
      input: structuredClone(input),
    };
    if (!intent.extensionId) throw new ClientError('action_scope_mismatch');
    this.actionIntent = { sessionId: selection.sessionId, intent: structuredClone(intent) };
    const catalogue = await this.client.listExtensions();
    const definition = catalogue
      .find((extension) => extension.extensionId === intent.extensionId)
      ?.actions.find(
        (value) => value.id === intent.actionId && value.version === intent.definitionVersion,
      );
    if (!definition) throw new ClientError('action_definition_unavailable');
    // Admission/schema validation belongs to Client and Service; selection changes cannot retarget this intent.
    return this.client.invokeExtension(selection.sessionId, intent);
  }

  get interactionSubmissions(): readonly InteractionAnswerSubmission[] {
    return [...this.answers.values()].map((entry) => structuredClone(entry.state));
  }
  interactionSubmission(interaction: Interaction): InteractionAnswerSubmission | undefined {
    const state = this.answers.get(this.answerKey(interaction))?.state;
    return state ? structuredClone(state) : undefined;
  }
  private answerKey(interaction: Interaction): string {
    return `${interaction.originStoreId}/${interaction.presentationSessionId}/${interaction.id}/${interaction.revision}`;
  }
  private publishAnswer(state: InteractionAnswerSubmission): void {
    this.options.onInteractionSubmission?.(structuredClone(state));
  }
  private clearAttachmentReads(preserveVerified = false) {
    for (const read of this.attachmentReads) read.abort();
    this.attachmentReads.clear();
    if (!preserveVerified) this.verifiedAttachments.clear();
  }
  async readInteractionAttachment(
    attachment: InteractionAttachment,
    options: { signal: AbortSignal },
  ) {
    const generation = this.generation;
    const offered = this.current?.interactions.find((value) => {
      try {
        return interactionAttachment(value)?.key === attachment.key;
      } catch {
        return false;
      }
    });
    if (!offered || this.disposed) throw new ClientError('interaction_scope_mismatch');
    const frozen = structuredClone(offered);
    const controller = new AbortController();
    this.attachmentReads.add(controller);
    const signal = AbortSignal.any([controller.signal, options.signal]);
    try {
      const result = await this.client.readInteractionAttachment(frozen, { signal });
      signal.throwIfAborted();
      if (
        generation !== this.generation ||
        !this.current?.interactions.some((value) => {
          try {
            return interactionAttachment(value)?.key === attachment.key;
          } catch {
            return false;
          }
        })
      )
        throw new ClientError('interaction_scope_mismatch');
      this.verifiedAttachments.add(result.identity);
      return { reference: result.reference, content: result.content };
    } finally {
      this.attachmentReads.delete(controller);
    }
  }
  answerInteraction(
    interaction: Interaction,
    answer: NonNullable<Interaction['answer']>,
  ): Promise<Command> {
    const key = this.answerKey(interaction);
    const previous = this.answers.get(key);
    if (previous?.promise) return previous.promise;
    if (previous) return Promise.reject(new ClientError('interaction_answer_already_saved'));
    const snapshot = this.current;
    if (
      !snapshot ||
      snapshot.generation !== this.generation ||
      snapshot.view.storeId !== interaction.originStoreId ||
      snapshot.sessionId !== interaction.presentationSessionId ||
      !snapshot.interactions.some(
        (value) =>
          value.id === interaction.id &&
          value.revision === interaction.revision &&
          value.state === 'pending',
      )
    )
      return Promise.reject(new ClientError('interaction_scope_mismatch'));
    if (this.answers.size >= 128)
      return Promise.reject(new ClientError('interaction_intent_limit'));
    const offered = snapshot.interactions.find(
      (value) => value.id === interaction.id && value.revision === interaction.revision,
    )!;
    const frozen = structuredClone(offered);
    if (frozen.kind === 'plan_review') {
      if (answer.kind !== 'plan_review')
        return Promise.reject(new ClientError('interaction_answer_invalid'));
      try {
        answer = serializePlanReviewAnswer(
          frozen.request,
          answer.decision,
          answer.feedback,
          answer.mode,
        );
      } catch {
        return Promise.reject(new ClientError('interaction_answer_invalid'));
      }
    }
    if (requiresInteractionAttachment(frozen)) {
      let attachment: InteractionAttachment | null;
      try {
        attachment = interactionAttachment(frozen);
      } catch {
        return Promise.reject(new ClientError('attachment_invalid'));
      }
      if (!attachment || !this.verifiedAttachments.has(attachment.key))
        return Promise.reject(new ClientError('attachment_not_loaded'));
    }
    const intent: AnswerInteractionRequest = {
      expectedStoreId: frozen.originStoreId,
      commandId: crypto.randomUUID(),
      expectedRevision: frozen.revision,
      answer: structuredClone(answer),
    };
    const entry: { state: InteractionAnswerSubmission; promise?: Promise<Command> } = {
      state: { interaction: frozen, intent, phase: 'saved' },
    };
    this.answers.set(key, entry);
    this.publishAnswer(entry.state);
    // Defer transport until the stable entry and duplicate guard are both installed.
    entry.promise = Promise.resolve().then(async () => {
      entry.state = { ...entry.state, phase: 'submitting' };
      this.publishAnswer(entry.state);
      let prepared = false;
      try {
        await this.options.interactionAnswerJournal?.prepare(entry.state, snapshot.view);
        prepared = true;
        const receipt = await this.client.answerInteraction(
          frozen.presentationSessionId,
          frozen.id,
          intent,
        );
        const phase = verifyInteractionAnswerReceipt(frozen, intent, receipt);
        entry.state = {
          ...entry.state,
          phase,
          receipt,
        };
        this.options.interactionAnswerJournal?.finish(entry.state);
        this.publishAnswer(entry.state);
        return receipt;
      } catch (error) {
        entry.state = {
          ...entry.state,
          phase:
            !prepared ||
            (error instanceof ClientError &&
              !['network_outcome_unknown', 'answer_receipt_mismatch'].includes(error.code))
              ? 'failed'
              : 'unknown',
          error: error instanceof ClientError ? error.code : 'network_outcome_unknown',
        };
        if (prepared) {
          try {
            this.options.interactionAnswerJournal?.finish(entry.state);
          } catch {
            entry.state = { ...entry.state, phase: 'unknown', error: 'answer_storage_unavailable' };
          }
        }
        this.publishAnswer(entry.state);
        throw error;
      } finally {
        entry.promise = undefined;
      }
    });
    return entry.promise;
  }
  /** Reconcile only the saved command; a lost response never authorizes a new mutation. */
  async lookupInteractionAnswer(interaction: Interaction): Promise<Command> {
    const entry = this.answers.get(this.answerKey(interaction));
    if (!entry) throw new ClientError('interaction_answer_not_saved');
    try {
      const receipt = this.options.interactionAnswerJournal
        ? await this.options.interactionAnswerJournal.lookup(entry.state)
        : await this.client.getCommand(entry.state.intent.commandId);
      const phase = verifyInteractionAnswerReceipt(
        entry.state.interaction,
        entry.state.intent,
        receipt,
      );
      entry.state = {
        ...entry.state,
        phase,
        receipt,
        error: undefined,
      };
      this.publishAnswer(entry.state);
      return receipt;
    } catch (error) {
      entry.state = {
        ...entry.state,
        phase: 'unknown',
        error:
          error instanceof ClientError
            ? error.code
            : error instanceof Error
              ? error.message
              : 'unknown_error',
      };
      this.publishAnswer(entry.state);
      throw error;
    }
  }

  get contextSubmissions(): readonly ContextSubmission[] {
    return [...this.contextIntents.values()].map((value) => structuredClone(value.state));
  }
  async loadContextPage(): Promise<SelectedContextPage> {
    const pager = this.contextPaging;
    if (!pager || pager.generation !== this.generation) throw new ClientError('view_not_ready');
    const previous = pager.page;
    if (previous.nextAfterSeq === null && previous.nextAfterSourceId === null)
      throw new ClientError('context_page_end');
    const page = await this.client.getContext(pager.sessionId, {
      storeId: pager.storeId,
      contextSelectionId: previous.selection.id,
      upperSeq: previous.highWaterSeq,
      afterSeq: previous.nextAfterSeq ?? previous.highWaterSeq,
      afterSourceId: previous.nextAfterSourceId ?? pager.lastSourceId,
      messageLimit: 200,
      sourceLimit: 100,
    });
    if (this.contextPaging === pager && pager.generation === this.generation) {
      if (this.contextBoundaries.size + page.messages.length > 4096)
        throw new ClientError('context_boundary_limit');
      for (const message of page.messages)
        if (message.status === 'complete') this.contextBoundaries.set(message.id, message.seq);
      pager.page = page;
      pager.lastSourceId = page.resultSources.at(-1)?.id ?? pager.lastSourceId;
    }
    return page;
  }
  rewindContext(boundary: SelectContextRequest['boundary']): Promise<Command> {
    const snapshot = this.contextReady();
    if (boundary && this.contextBoundaries.get(boundary.messageId) !== boundary.seq)
      return Promise.reject(new ClientError('context_boundary_unavailable'));
    return this.saveContextIntent({
      sessionId: snapshot.sessionId,
      kind: 'rewind',
      phase: 'saved',
      intent: {
        expectedStoreId: snapshot.view.storeId,
        commandId: crypto.randomUUID(),
        expectedContextSelectionId: snapshot.context!.selection.id,
        boundary: structuredClone(boundary),
      },
    });
  }
  includeHistoricalResult(
    execution: Execution,
    scope?: {
      storeId: string;
      sessionId: string;
      contextSelectionId: string;
      targetRunId?: string;
    },
  ): Promise<Command> {
    const snapshot = this.contextReady(true);
    if (
      scope &&
      (scope.storeId !== snapshot.view.storeId ||
        scope.sessionId !== snapshot.sessionId ||
        scope.contextSelectionId !== snapshot.context!.selection.id)
    )
      throw new ClientError('context_selection_changed');
    const active = snapshot.view.runs.filter((value) => value.isActive);
    const targetRunId = scope?.targetRunId;
    if (
      active.length
        ? active.length !== 1 ||
          !targetRunId ||
          active[0]!.id !== targetRunId ||
          active[0]!.sessionId !== snapshot.sessionId
        : targetRunId !== undefined
    )
      throw new ClientError('input_target_changed');
    const actual = snapshot.view.executions.find(
      (value) => value.id === execution.id && value.resultRevision === execution.resultRevision,
    );
    if (
      actual?.kind !== 'job' ||
      !actual.originStoreId ||
      !actual.resultRevision ||
      actual.delivery !== 'suppressed' ||
      !['succeeded', 'failed', 'cancelled'].includes(actual.status)
    )
      return Promise.reject(new ClientError('historical_result_unavailable'));
    return this.saveContextIntent({
      sessionId: snapshot.sessionId,
      kind: 'include',
      executionId: actual.id,
      phase: 'saved',
      intent: {
        expectedStoreId: snapshot.view.storeId,
        commandId: crypto.randomUUID(),
        expectedContextSelectionId: snapshot.context!.selection.id,
        resultRevision: actual.resultRevision,
        ...(targetRunId ? { targetRunId } : {}),
      },
    });
  }
  private contextReady(allowActive = false): DesktopSnapshot {
    const snapshot = this.current;
    if (!snapshot?.context || snapshot.generation !== this.generation)
      throw new ClientError('view_not_ready');
    if (snapshot.context.selection.id !== snapshot.view.session.contextSelectionId)
      throw new ClientError('context_selection_changed');
    if (
      (!allowActive || !snapshot.view.runs.some((value) => value.isActive)) &&
      (snapshot.view.runs.some((value) => value.isActive) ||
        snapshot.view.executions.some((value) =>
          ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(value.status),
        ))
    )
      throw new ClientError('input_busy');
    return snapshot;
  }
  private saveContextIntent(state: ContextSubmission): Promise<Command> {
    const key = JSON.stringify([
      state.sessionId,
      state.kind,
      state.executionId,
      state.intent.expectedStoreId,
      state.intent.expectedContextSelectionId,
      'targetRunId' in state.intent ? state.intent.targetRunId : undefined,
      'boundary' in state.intent
        ? [state.intent.boundary?.messageId, state.intent.boundary?.seq]
        : state.intent.resultRevision,
    ]);
    const previous = this.contextIntents.get(key);
    if (previous?.promise) return previous.promise;
    if (previous) return Promise.reject(new ClientError('context_intent_already_saved'));
    if (this.contextIntents.size >= 128)
      return Promise.reject(new ClientError('context_intent_limit'));
    const entry: { state: ContextSubmission; promise?: Promise<Command> } = {
      state: structuredClone(state),
    };
    this.contextIntents.set(key, entry);
    this.options.onContextSubmission?.(structuredClone(entry.state));
    entry.promise = Promise.resolve().then(async () => {
      entry.state = { ...entry.state, phase: 'submitting' };
      this.options.onContextSubmission?.(structuredClone(entry.state));
      try {
        const response =
          entry.state.kind === 'rewind'
            ? await this.client.rewind(
                entry.state.sessionId,
                entry.state.intent as SelectContextRequest,
              )
            : await this.client.includeResult(
                entry.state.sessionId,
                entry.state.executionId!,
                entry.state.intent as IncludeResultRequest,
              );
        const command = response.command;
        this.verifyContextReceipt(entry.state, command);
        entry.state = {
          ...entry.state,
          phase: this.contextPhase(entry.state, command),
          receipt: command,
        };
        this.options.onContextSubmission?.(structuredClone(entry.state));
        return command;
      } catch (error) {
        entry.state = {
          ...entry.state,
          phase:
            error instanceof ClientError &&
            ([
              'invalid_request',
              'connection_not_admitted',
              'data_unavailable',
              'capability_unavailable',
            ].includes(error.code) ||
              (error.problem !== undefined &&
                error.status !== undefined &&
                [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)))
              ? 'failed'
              : 'unknown',
          error: error instanceof ClientError ? error.code : 'network_outcome_unknown',
        };
        this.options.onContextSubmission?.(structuredClone(entry.state));
        throw error;
      } finally {
        entry.promise = undefined;
      }
    });
    return entry.promise;
  }
  private verifyContextReceipt(state: ContextSubmission, command: Command): void {
    if (
      command.id !== state.intent.commandId ||
      command.originStoreId !== state.intent.expectedStoreId ||
      command.sessionId !== state.sessionId ||
      command.kind !== (state.kind === 'include' ? 'result.include' : 'context.select')
    )
      throw new ClientError('context_receipt_mismatch');
  }
  async lookupContextIntent(commandId: string): Promise<Command> {
    const entry = [...this.contextIntents.values()].find(
      (value) => value.state.intent.commandId === commandId,
    );
    if (!entry) throw new ClientError('context_intent_not_saved');
    const command = await this.client.getCommand(commandId);
    this.verifyContextReceipt(entry.state, command);
    entry.state = {
      ...entry.state,
      phase: this.contextPhase(entry.state, command),
      receipt: command,
    };
    this.options.onContextSubmission?.(structuredClone(entry.state));
    return command;
  }

  private contextPhase(state: ContextSubmission, command: Command): ContextSubmission['phase'] {
    if (command.status === 'applied') return 'applied';
    if (command.status === 'rejected') return 'failed';
    const receipt = command.receipt as { outcome?: string; runId?: string } | null;
    return command.status === 'accepted' &&
      state.kind === 'include' &&
      'targetRunId' in state.intent &&
      state.intent.targetRunId &&
      receipt?.outcome === 'result_queued' &&
      receipt.runId === state.intent.targetRunId
      ? 'queued'
      : 'unknown';
  }

  get permissionSubmissions(): readonly PermissionSubmission[] {
    return [...this.permissionIntents.values()].map((entry) => structuredClone(entry.state));
  }
  async refreshPermissions(): Promise<DesktopSnapshot | undefined> {
    if (this.disposed || !this.selected) throw new ClientError('session_not_selected');
    if (
      [...this.permissionIntents.values()].some((entry) =>
        ['saved', 'submitting', 'unknown'].includes(entry.state.phase),
      )
    )
      throw new ClientError('permission_intent_pending');
    return this.readSelection(this.selected, this.generation);
  }
  setPermissionMode(
    mode: PermissionModeState['mode'],
    makeDefault: boolean,
    observationId: number,
  ): Promise<PermissionMutation> {
    return this.submitPermission('permission.mode', { mode, makeDefault }, observationId);
  }
  setWorkspaceTrust(trusted: boolean, observationId: number): Promise<PermissionMutation> {
    return this.submitPermission('workspace.trust', { trusted }, observationId);
  }
  private submitPermission(
    kind: PermissionSubmission['kind'],
    choice: { mode: PermissionModeState['mode']; makeDefault: boolean } | { trusted: boolean },
    observationId: number,
  ): Promise<PermissionMutation> {
    const snapshot = this.current,
      facts = snapshot?.permissions;
    if (this.disposed || !snapshot || !facts || facts.observationId !== observationId)
      return Promise.reject(new ClientError('permission_observation_changed'));
    if (facts.mode.scopeSessionId !== facts.mode.sessionId)
      return Promise.reject(new ClientError('permission_child_readonly'));
    const key = JSON.stringify([observationId, kind, choice]);
    const previous = this.permissionIntents.get(key);
    if (previous)
      return previous.promise ?? Promise.reject(new ClientError('permission_intent_saved'));
    if (
      [...this.permissionIntents.values()].some((entry) =>
        ['saved', 'submitting', 'unknown'].includes(entry.state.phase),
      )
    )
      return Promise.reject(new ClientError('permission_intent_pending'));
    // Any submitted choice consumes this observation. A new choice requires an explicit re-read.
    if ([...this.permissionIntents.keys()].some((value) => JSON.parse(value)[0] === observationId))
      return Promise.reject(new ClientError('permission_observation_consumed'));
    if (this.permissionIntents.size >= 128)
      return Promise.reject(new ClientError('permission_intent_limit'));
    const intent = structuredClone(
      kind === 'permission.mode'
        ? {
            expectedStoreId: facts.mode.storeId,
            commandId: crypto.randomUUID(),
            ...choice,
            ifRevision: facts.mode.revision,
            ifDefaultRevision: facts.mode.defaultRevision,
          }
        : {
            expectedStoreId: facts.mode.storeId,
            commandId: crypto.randomUUID(),
            ...choice,
            ifRevision: facts.trust.revision,
            canonicalIdentity: facts.trust.canonicalIdentity,
            externalReadScopeDigest: facts.trust.externalReadScopeDigest,
          },
    ) as SetPermissionModeRequest | SetWorkspaceTrustRequest;
    const entry: { state: PermissionSubmission; promise?: Promise<PermissionMutation> } = {
      state: {
        sessionId: facts.mode.sessionId,
        rootSessionId: facts.mode.scopeSessionId,
        workspaceId: facts.trust.workspaceId,
        intent,
        kind,
        phase: 'saved',
      },
    };
    this.permissionIntents.set(key, entry);
    this.publishPermission(entry.state);
    entry.promise = Promise.resolve().then(async () => {
      entry.state = { ...entry.state, phase: 'submitting' };
      this.publishPermission(entry.state);
      try {
        if (this.disposed) throw new ClientError('controller_disposed');
        const receipt =
          kind === 'permission.mode'
            ? await this.client.setPermissionMode(
                entry.state.rootSessionId,
                intent as SetPermissionModeRequest,
              )
            : await this.client.setWorkspaceTrust(
                entry.state.workspaceId,
                intent as SetWorkspaceTrustRequest,
              );
        this.applyPermissionReceipt(entry, receipt);
        return receipt;
      } catch (error) {
        const known =
          error instanceof ClientError &&
          ![
            'network_outcome_unknown',
            'connection_superseded',
            'permission_scope_mismatch',
          ].includes(error.code);
        entry.state = {
          ...entry.state,
          phase: known ? 'failed' : 'unknown',
          error: error instanceof ClientError ? error.code : 'network_outcome_unknown',
        };
        this.publishPermission(entry.state);
        throw error;
      } finally {
        entry.promise = undefined;
      }
    });
    return entry.promise;
  }
  private publishPermission(state: PermissionSubmission) {
    if (!this.disposed) this.options.onPermissionSubmission?.(structuredClone(state));
  }
  private applyPermissionReceipt(
    entry: { state: PermissionSubmission },
    receipt: PermissionMutation,
  ) {
    if (receipt.commandId !== entry.state.intent.commandId || receipt.kind !== entry.state.kind)
      throw new ClientError('permission_scope_mismatch');
    entry.state = {
      ...entry.state,
      phase:
        receipt.state === 'applied' ? 'applied' : receipt.state === 'failed' ? 'failed' : 'unknown',
      receipt,
      error:
        receipt.state === 'failed' || receipt.state === 'outcome_unknown'
          ? receipt.receipt.code
          : undefined,
    };
    this.publishPermission(entry.state);
  }
  lookupPermissionMutation(commandId: string): Promise<PermissionMutation> {
    if (this.disposed) return Promise.reject(new ClientError('controller_disposed'));
    const entry = [...this.permissionIntents.values()].find(
      (value) => value.state.intent.commandId === commandId,
    );
    if (!entry) return Promise.reject(new ClientError('permission_intent_not_saved'));
    if (entry.promise) return entry.promise;
    entry.promise = Promise.resolve().then(async () => {
      try {
        const receipt = await this.client.getPermissionMutation(commandId, {
          storeId: entry.state.intent.expectedStoreId,
        });
        this.applyPermissionReceipt(entry, receipt);
        return receipt;
      } finally {
        entry.promise = undefined;
      }
    });
    return entry.promise;
  }

  disposeNetwork(): void {
    this.cancelInteractionRead();
    this.clearAttachmentReads();
    this.disposed = true;
    this.generation++;
    this.observing?.abort(new Error('desktop_network_disposed'));
    this.client.disposeNetwork();
  }
  /** Main owns this explicit lifecycle operation. No view/component cleanup calls it. */
  async stopPairedService(): Promise<void> {
    if (!this.options.stopPairedService) throw new Error('paired_service_not_owned');
    await this.options.stopPairedService();
  }
}
export function createDesktopController(options: DesktopOptions): DesktopController {
  return new DesktopController(options);
}
