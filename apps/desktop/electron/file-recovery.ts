import { randomUUID } from 'node:crypto';
import {
  type AgentClient,
  ClientError,
  type FileCheckpointDetail,
  type FileCheckpointRecoveryBoundary,
} from '@kite-ai/client';
import {
  type FileRecoveryIntent,
  type FileRecoveryLeg,
  type FileRecoveryPreparationScope,
  lookupFileRecoveryLeg,
  planFileRecoveryIntent,
  prepareFileRecoveryLeg,
  submitFileRecoveryLeg,
} from '@kite-ai/client/file-recovery-intent';
import type { NativeFileRecoveryObservation } from '../src/native-bridge';
import { fileRecoveryIntentId, type NativeFileRecoveryJournal } from './file-recovery-journal';

type Scope = { generation: number; selection: number; storeId: string; sessionId: string };
type Read = { id: string; abort: AbortController; scope: Scope };
/** Main owns every mutation ID. Reads and renderer lifetime never retry a saved leg. */
export class NativeFileRecovery {
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly journal: NativeFileRecoveryJournal | undefined;
  private readonly entries = new Map<string, FileRecoveryIntent>();
  private readonly busy = new Set<string>();
  private readonly ready: Promise<void>;
  private unavailable = false;
  private sequence = 0;
  private read: Read | undefined;
  private observed:
    | {
        scope: Scope;
        facts: NativeFileRecoveryObservation;
        actual: FileRecoveryPreparationScope & { controlRevision: string };
      }
    | undefined;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void,
    journal?: NativeFileRecoveryJournal,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.journal = journal;
    this.ready = (async () => {
      try {
        for (const value of (await journal?.fileRecoveries()) ?? [])
          this.entries.set(fileRecoveryIntentId(value), value);
      } catch {
        this.unavailable = true;
      } finally {
        notify();
      }
    })();
  }
  get submissions() {
    return [...this.entries.values()].map((value) => structuredClone(value));
  }
  release() {
    this.read?.abort.abort();
    this.read = undefined;
    this.observed = undefined;
  }
  close(id: string) {
    if (this.read?.id === id) this.release();
  }
  private same(scope: Scope) {
    const now = this.current();
    return (
      !!now &&
      now.generation === scope.generation &&
      now.selection === scope.selection &&
      now.storeId === scope.storeId &&
      now.sessionId === scope.sessionId
    );
  }
  private start(id: string) {
    this.release();
    const scope = this.current();
    if (!scope) throw new ClientError('native_selection_changed');
    const read = { id, scope: { ...scope }, abort: new AbortController() };
    this.read = read;
    return read;
  }
  private live(read: Read) {
    if (this.read !== read || read.abort.signal.aborted || !this.same(read.scope))
      throw new ClientError('native_selection_changed');
  }
  private storage() {
    if (!this.journal || this.unavailable)
      throw new ClientError('file_recovery_storage_unavailable');
    return this.journal;
  }
  private async actual(
    scope: Scope,
    signal?: AbortSignal,
  ): Promise<FileRecoveryPreparationScope & { controlRevision: string }> {
    if (!this.same(scope)) throw new ClientError('native_selection_changed');
    const view = await this.client.getView(scope.sessionId, { signal });
    if (
      !this.same(scope) ||
      view.storeId !== scope.storeId ||
      view.session.id !== scope.sessionId ||
      view.session.deletedAt !== null ||
      view.session.parentSessionId !== null ||
      !this.client.serverInfo?.subjectId
    )
      throw new ClientError('file_recovery_readonly');
    return {
      storeId: view.storeId,
      sessionId: view.session.id,
      workspaceId: view.session.workspaceId,
      contextSelectionId: view.session.contextSelectionId,
      subjectId: this.client.serverInfo.subjectId,
      controlRevision: view.session.controlRevision,
    };
  }
  async list(readId: string, afterKey?: string) {
    const read = this.start(readId);
    const actual = await this.actual(read.scope, read.abort.signal);
    const page = await this.client.listFileCheckpoints(actual.sessionId, {
      afterKey,
      signal: read.abort.signal,
    });
    this.live(read);
    if (page.workspaceId !== actual.workspaceId)
      throw new ClientError('file_checkpoint_identity_mismatch');
    return page;
  }
  async detail(
    pointId: string,
    readId: string,
    inputRevision: number,
  ): Promise<NativeFileRecoveryObservation> {
    const read = this.start(readId),
      actual = await this.actual(read.scope, read.abort.signal);
    const [detail, boundary] = await Promise.all([
      this.client.getFileCheckpoint(actual.sessionId, pointId, { signal: read.abort.signal }),
      this.client.getFileCheckpointRecoveryBoundary(actual.sessionId, pointId, {
        signal: read.abort.signal,
      }),
    ]);
    this.live(read);
    const after = await this.actual(read.scope, read.abort.signal);
    this.live(read);
    this.match(actual, after);
    this.facts(actual, detail, boundary);
    const facts: NativeFileRecoveryObservation = {
      kind: 'fileRecovery.observation',
      observationId: ++this.sequence,
      inputRevision,
      detail,
      boundary,
    };
    this.observed = { scope: read.scope, facts: structuredClone(facts), actual };
    return facts;
  }
  private match(a: FileRecoveryPreparationScope, b: FileRecoveryPreparationScope) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new ClientError('file_recovery_observation_changed');
  }
  private facts(
    actual: FileRecoveryPreparationScope,
    detail: FileCheckpointDetail,
    boundary: FileCheckpointRecoveryBoundary,
  ) {
    if (
      detail.storeId !== actual.storeId ||
      boundary.storeId !== actual.storeId ||
      detail.sessionId !== actual.sessionId ||
      boundary.sessionId !== actual.sessionId ||
      detail.workspaceId !== actual.workspaceId ||
      boundary.workspaceId !== actual.workspaceId ||
      boundary.contextSelectionId !== actual.contextSelectionId ||
      JSON.stringify(detail.payload.checkpoint) !== JSON.stringify(boundary.checkpoint)
    )
      throw new ClientError('file_checkpoint_identity_mismatch');
  }
  async status(pointId: string, restoreId: string, readId: string) {
    const read = this.start(readId),
      actual = await this.actual(read.scope, read.abort.signal);
    const value = await this.client.getFileRestoreStatus(actual.sessionId, pointId, restoreId, {
      signal: read.abort.signal,
    });
    this.live(read);
    if (value.workspaceId !== actual.workspaceId)
      throw new ClientError('file_checkpoint_identity_mismatch');
    return value;
  }
  async saved() {
    await this.ready;
    this.storage();
    return this.submissions;
  }
  private async save(next: FileRecoveryIntent, previous: FileRecoveryIntent) {
    const value = await this.storage().updateFileRecovery(next, previous);
    this.entries.set(fileRecoveryIntentId(value), value);
    this.notify();
    return value;
  }
  async begin(
    observationId: number,
    scope: FileRecoveryIntent['scope'],
    title: string,
    inputRevision: number,
  ) {
    await this.ready;
    const observed = this.observed;
    if (
      !observed ||
      observed.facts.observationId !== observationId ||
      observed.facts.inputRevision !== inputRevision ||
      !this.same(observed.scope)
    )
      throw new ClientError('file_recovery_observation_changed');
    const read = this.read;
    this.observed = undefined;
    const actual = await this.actual(observed.scope, read?.abort.signal);
    this.match(observed.actual, actual);
    const pointId = observed.facts.boundary.checkpoint.id;
    const [detail, boundary] = await Promise.all([
      this.client.getFileCheckpoint(actual.sessionId, pointId),
      this.client.getFileCheckpointRecoveryBoundary(actual.sessionId, pointId),
    ]);
    if (!read) throw new ClientError('file_recovery_observation_changed');
    this.live(read);
    this.match(actual, await this.actual(observed.scope, read.abort.signal));
    this.live(read);
    this.facts(actual, detail, boundary);
    if (
      JSON.stringify(boundary) !== JSON.stringify(observed.facts.boundary) ||
      JSON.stringify(detail) !== JSON.stringify(observed.facts.detail)
    )
      throw new ClientError('file_recovery_observation_changed');
    if (
      scope !== 'session' &&
      detail.payload.files.some(
        (file) => file.status === 'conflict' || file.status === 'unavailable',
      )
    )
      throw new ClientError('file_recovery_code_unconfirmed');
    const intent = await planFileRecoveryIntent({
      scope,
      observation: boundary,
      subjectId: actual.subjectId,
      ...(scope === 'session'
        ? {}
        : { code: { commandId: randomUUID(), restoreId: randomUUID() } }),
      ...(scope === 'code'
        ? {}
        : { fork: { commandId: randomUUID(), newSessionId: randomUUID(), title } }),
    });
    const saved = await this.storage().prepareFileRecovery(intent);
    this.entries.set(fileRecoveryIntentId(saved.value), saved.value);
    this.notify();
    if (!saved.created) throw new ClientError('file_recovery_readonly');
    return this.submit(saved.value, scope === 'session' ? 'fork' : 'code', observed.scope);
  }
  private async submit(
    intent: FileRecoveryIntent,
    leg: FileRecoveryLeg,
    scope: Scope,
    codeProof?: Parameters<typeof prepareFileRecoveryLeg>[3]['codeProof'],
    currentDetail?: FileCheckpointDetail,
  ) {
    const id = fileRecoveryIntentId(intent);
    if (this.busy.has(id)) throw new ClientError('file_recovery_readonly');
    this.busy.add(id);
    try {
      let actual = await this.actual(scope);
      const preparation = {
        explicitContinue: true as const,
        ...(codeProof ? { codeProof } : {}),
        ...(currentDetail ? { currentDetail } : {}),
      };
      const prepared = prepareFileRecoveryLeg(intent, leg, actual, preparation);
      const durable = await this.save(prepared.intent, intent);
      const submitted = await submitFileRecoveryLeg(durable, leg, prepared.permit, {
        currentScope: () => {
          if (!this.same(scope)) throw new ClientError('native_selection_changed');
          return actual;
        },
        persist: async (next) => {
          await this.save(next, durable);
          actual = await this.actual(scope);
        },
        post: () =>
          leg === 'code'
            ? this.client.invokeExtension(intent.sessionId, intent.code!.request)
            : this.client.forkSession(intent.sessionId, intent.fork!.request),
      });
      let next = await this.save(submitted.intent, this.entries.get(id)!);
      if (submitted.response !== undefined) {
        next = await lookupFileRecoveryLeg(next, leg, actual, {
          getCommand: (key) => this.client.getCommand(key),
          getRestoreStatus: (s, p, r) => this.client.getFileRestoreStatus(s, p, r),
        });
        next = await this.save(next, this.entries.get(id)!);
      }
      return next;
    } finally {
      this.busy.delete(id);
    }
  }
  async lookup(intentId: string, readId: string) {
    await this.ready;
    const old = this.entries.get(intentId);
    if (!old) throw new ClientError('file_recovery_intent_missing');
    const read = this.start(readId);
    if (read.scope.storeId !== old.storeId || this.client.serverInfo?.subjectId !== old.subjectId)
      return old;
    const view = await this.client.getView(old.sessionId, { signal: read.abort.signal });
    this.live(read);
    if (
      view.storeId !== old.storeId ||
      view.session.id !== old.sessionId ||
      view.session.workspaceId !== old.workspaceId
    )
      throw new ClientError('file_recovery_readonly');
    const actual = {
      storeId: view.storeId,
      sessionId: view.session.id,
      workspaceId: view.session.workspaceId,
      subjectId: this.client.serverInfo!.subjectId!,
    };
    let value = old;
    for (const leg of ['code', 'fork'] as const)
      if (value[leg] && value[leg]!.phase !== 'not_started')
        value = await lookupFileRecoveryLeg(value, leg, actual, {
          getCommand: (key) => this.client.getCommand(key, { signal: read.abort.signal }),
          getRestoreStatus: (s, p, r) =>
            this.client.getFileRestoreStatus(s, p, r, { signal: read.abort.signal }),
        });
    this.live(read);
    if (this.busy.has(intentId) || this.entries.get(intentId) !== old)
      throw new ClientError('file_recovery_phase_conflict');
    return this.save(value, old);
  }
  async continue(intentId: string) {
    await this.ready;
    const intent = this.entries.get(intentId),
      scope = this.current();
    if (!intent || !scope || intent.scope !== 'both' || intent.fork?.phase !== 'not_started')
      throw new ClientError('file_recovery_readonly');
    const actual = await this.actual(scope),
      input = intent.code!.request.input;
    const restoreId =
      input && typeof input === 'object' && !Array.isArray(input) ? input.restoreId : undefined;
    if (typeof restoreId !== 'string') throw new ClientError('file_recovery_intent_invalid');
    const [command, restoreStatus, currentDetail] = await Promise.all([
      this.client.getCommand(intent.code!.request.commandId),
      this.client.getFileRestoreStatus(intent.sessionId, intent.checkpoint.id, restoreId),
      this.client.getFileCheckpoint(intent.sessionId, intent.checkpoint.id),
    ]);
    this.match(actual, await this.actual(scope));
    this.facts(actual, currentDetail, {
      storeId: intent.storeId,
      sessionId: intent.sessionId,
      workspaceId: intent.workspaceId,
      contextSelectionId: intent.contextSelectionId,
      checkpoint: intent.checkpoint,
      boundary: intent.boundary,
      trigger: intent.trigger,
    });
    if (currentDetail.payload.files.some((file) => file.status !== 'unchanged'))
      throw new ClientError('file_recovery_code_changed');
    return this.submit(intent, 'fork', scope, { command, restoreStatus }, currentDetail);
  }
}
