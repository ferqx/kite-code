import {
  type AgentClient,
  ClientError,
  type Command,
  decodeJobReportResumeCommand,
  decodeRunResumeCommand,
  decodeSessionRecoveryCommand,
} from '@kite-ai/client';
import type {
  NativeRecoveryFacts,
  NativeRecoveryIntent,
  NativeRecoverySubmission,
} from '../src/native-bridge';

type Scope = { generation: number; selection: number; storeId: string; sessionId: string };
type Read = { id: string; abort: AbortController };
type Entry = {
  state: NativeRecoverySubmission;
  promise?: Promise<NativeRecoverySubmission>;
  revision: number;
};
export interface NativeRecoveryJournal {
  recoveries(): NativeRecoveryIntent[];
  beginRecovery(input: NativeRecoveryIntent): { created: boolean; value: NativeRecoveryIntent };
  finishRecovery(
    commandId: string,
    phase: NativeRecoveryIntent['phase'],
    error?: string,
  ): NativeRecoveryIntent;
}
const unsettled = (state: NativeRecoveryIntent) =>
  ['submitting', 'accepted', 'outcome_unknown'].includes(state.phase);
/** Main freezes original IDs. Closing a view read never releases saved mutation identity. */
export class NativeRecovery {
  private sequence = 0;
  private observed?: { scope: Scope; facts: NativeRecoveryFacts };
  private read?: Read;
  private readonly entries = new Map<string, Entry>();
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly journal?: NativeRecoveryJournal;
  private journalUnavailable = false;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void,
    journal?: NativeRecoveryJournal,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.journal = journal;
    try {
      for (const saved of journal?.recoveries() ?? []) {
        const state =
          saved.phase === 'submitting'
            ? journal!.finishRecovery(saved.commandId, 'outcome_unknown')
            : saved;
        this.entries.set(state.commandId, { state, revision: 0 });
        this.sequence = Math.max(this.sequence, state.observationId);
      }
    } catch {
      this.journalUnavailable = true;
    }
  }
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  release() {
    this.read?.abort.abort();
    this.read = undefined;
    this.observed = undefined;
  }
  close(readId: string) {
    if (this.read?.id === readId) {
      this.read.abort.abort();
      this.read = undefined;
    }
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
  private live(read: Read) {
    return this.read === read && !read.abort.signal.aborted;
  }
  private storage() {
    if (!this.journal || this.journalUnavailable)
      throw new ClientError('recovery_storage_unavailable');
    return this.journal;
  }
  private commit(entry: Entry, next: NativeRecoverySubmission) {
    const saved = this.storage().finishRecovery(next.commandId, next.phase, next.error);
    entry.state = saved.phase === next.phase ? next : saved;
    entry.revision++;
    this.notify();
  }
  async prepare(
    kind: NativeRecoveryFacts['kind'],
    targetId: string | undefined,
    readId: string,
  ): Promise<NativeRecoveryFacts> {
    this.release();
    const scope = this.current();
    if (!scope) throw new ClientError('native_selection_changed');
    const read: Read = { id: readId, abort: new AbortController() };
    this.read = read;
    try {
      const view = await this.client.getView(scope.sessionId, { signal: read.abort.signal });
      if (
        view.storeId !== scope.storeId ||
        view.session.id !== scope.sessionId ||
        view.session.parentSessionId !== null ||
        view.session.rootSessionId !== scope.sessionId
      )
        throw new ClientError('recovery_scope_unavailable');
      let originalCommandId: string | undefined;
      if (kind !== 'interrupt') {
        if (!targetId) throw new ClientError('recovery_target_required');
        const original =
          kind === 'run'
            ? await this.client.getRun(targetId, { signal: read.abort.signal })
            : await this.client.getCommand(targetId, { signal: read.abort.signal });
        if (
          original.id !== targetId ||
          original.originStoreId !== scope.storeId ||
          original.sessionId !== scope.sessionId ||
          (kind === 'report' && (original as Command).kind !== 'job.report')
        )
          throw new ClientError('recovery_scope_unavailable');
        originalCommandId =
          kind === 'run'
            ? (original as Awaited<ReturnType<AgentClient['getRun']>>).originCommandId
            : targetId;
      }
      if (!this.live(read) || !this.same(scope)) throw new ClientError('native_selection_changed');
      if (!Number.isSafeInteger(this.sequence + 1))
        throw new ClientError('recovery_observation_limit');
      const facts: NativeRecoveryFacts = {
        observationId: ++this.sequence,
        storeId: scope.storeId,
        sessionId: scope.sessionId,
        kind,
        ...(targetId ? { targetId } : {}),
        ...(originalCommandId ? { originalCommandId } : {}),
      };
      this.observed = { scope, facts };
      return structuredClone(facts);
    } finally {
      if (this.read === read) this.read = undefined;
    }
  }
  submit(observationId: number, confirm: boolean): Promise<NativeRecoverySubmission> {
    const previous = [...this.entries.values()].find(
      (entry) => entry.state.observationId === observationId,
    );
    if (previous) return previous.promise ?? Promise.resolve(structuredClone(previous.state));
    const observed = this.observed;
    if (!observed || observed.facts.observationId !== observationId || !this.same(observed.scope))
      return Promise.reject(new ClientError('recovery_observation_changed'));
    if (observed.facts.kind === 'interrupt' && !confirm)
      return Promise.reject(new ClientError('recovery_confirmation_required'));
    if (this.entries.size >= 128) return Promise.reject(new ClientError('recovery_intent_limit'));
    if (
      [...this.entries.values()].some(
        (entry) =>
          entry.state.storeId === observed.scope.storeId &&
          entry.state.sessionId === observed.scope.sessionId &&
          unsettled(entry.state),
      )
    )
      return Promise.reject(new ClientError('recovery_intent_pending'));
    const facts = structuredClone(observed.facts),
      commandId = crypto.randomUUID(),
      state: NativeRecoveryIntent = { ...facts, commandId, phase: 'submitting' };
    try {
      this.storage().beginRecovery(state);
    } catch (error) {
      return Promise.reject(error);
    }
    const entry: Entry = { state, revision: 0 };
    this.entries.set(commandId, entry);
    entry.promise = Promise.resolve().then(async () => {
      try {
        const command =
          facts.kind === 'run'
            ? await this.client.resumeRun(facts.sessionId, {
                kind: 'run.resume',
                expectedStoreId: facts.storeId,
                commandId,
                runId: facts.targetId!,
              })
            : facts.kind === 'report'
              ? await this.client.resumeJobReport(facts.sessionId, facts.targetId!, {
                  expectedStoreId: facts.storeId,
                  commandId,
                })
              : await this.client.recoverSession(facts.sessionId, {
                  kind: 'session.recover',
                  expectedStoreId: facts.storeId,
                  commandId,
                  decision: 'interrupt',
                });
        this.commit(entry, await this.decode(entry.state, command));
      } catch (error) {
        const rejected =
          error instanceof ClientError &&
          error.problem &&
          error.status &&
          [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status);
        this.commit(entry, {
          ...state,
          phase: rejected ? 'failed' : 'outcome_unknown',
          ...(rejected ? { error: error.code } : {}),
        });
      }
      return structuredClone(entry.state);
    });
    this.notify();
    return entry.promise;
  }
  private async decode(
    state: NativeRecoverySubmission,
    command: Command,
    signal?: AbortSignal,
  ): Promise<NativeRecoverySubmission> {
    if (
      command.id !== state.commandId ||
      command.originStoreId !== state.storeId ||
      command.sessionId !== state.sessionId ||
      command.kind !==
        (state.kind === 'run'
          ? 'run.resume'
          : state.kind === 'report'
            ? 'job.report.resume'
            : 'session.recover')
    )
      throw new ClientError('invalid_response');
    if (command.status === 'rejected' || command.status === 'needs_review')
      return { ...state, phase: 'failed', command };
    if (state.kind === 'interrupt') {
      const checked = decodeSessionRecoveryCommand(command);
      if (
        checked.receipt.storeId !== state.storeId ||
        checked.receipt.sessionId !== state.sessionId
      )
        throw new ClientError('invalid_response');
      return { ...state, phase: 'interrupted', command };
    }
    let runId: string;
    if (state.kind === 'run') {
      const checked = decodeRunResumeCommand(command);
      if (checked.status === 'accepted') return { ...state, phase: 'accepted', command };
      if (
        checked.receipt.runId !== state.targetId ||
        checked.receipt.originalCommandId !== state.originalCommandId
      )
        throw new ClientError('invalid_response');
      runId = checked.receipt.runId;
    } else {
      const checked = decodeJobReportResumeCommand(command);
      if (checked.receipt.reportCommandId !== state.targetId)
        throw new ClientError('invalid_response');
      if (checked.receipt.outcome === 'report_suppressed')
        return { ...state, phase: 'suppressed', command };
      runId = checked.receipt.runId;
    }
    const run = await this.client.getRun(runId, { signal });
    if (
      run.id !== runId ||
      run.originStoreId !== state.storeId ||
      run.sessionId !== state.sessionId ||
      run.originCommandId !== state.originalCommandId
    )
      throw new ClientError('invalid_response');
    return { ...state, phase: 'resumed', command, run };
  }
  async lookup(commandId: string, readId: string): Promise<NativeRecoverySubmission> {
    const entry = this.entries.get(commandId);
    if (!entry) throw new ClientError('recovery_intent_unavailable');
    if (entry.state.phase === 'submitting') return entry.promise ?? structuredClone(entry.state);
    this.close(this.read?.id ?? '');
    const read: Read = { id: readId, abort: new AbortController() };
    this.read = read;
    const revision = entry.revision;
    try {
      const command = await this.client.getCommand(commandId, { signal: read.abort.signal });
      const next = await this.decode(entry.state, command, read.abort.signal);
      if (this.live(read) && revision === entry.revision) this.commit(entry, next);
    } catch {
      if (this.live(read) && revision === entry.revision && unsettled(entry.state))
        this.commit(entry, { ...entry.state, phase: 'outcome_unknown' });
    } finally {
      if (this.read === read) this.read = undefined;
    }
    return structuredClone(entry.state);
  }
}
