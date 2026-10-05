import { type AgentClient, ClientError, type Command, type Session } from '@kite-ai/client';
import type { NativeSessionFacts, NativeSessionSubmission } from '../src/native-bridge';

function validNamespaceReport(value: unknown, omitted: unknown) {
  if (typeof omitted !== 'boolean' || !Array.isArray(value)) return false;
  const seen = new Set<string>();
  let anyOmitted = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            'extensionId',
            'contentType',
            'contentVersion',
            'ruleVersion',
            'mode',
            'copied',
            'rebuilt',
            'omitted',
          ].includes(key),
      ) ||
      !['extensionId', 'contentType'].every(
        (key) =>
          typeof row[key] === 'string' &&
          String(row[key]).length > 0 &&
          String(row[key]).length <= 256,
      ) ||
      !Number.isSafeInteger(row.contentVersion) ||
      Number(row.contentVersion) < 1 ||
      !(
        row.ruleVersion === null ||
        (typeof row.ruleVersion === 'string' &&
          row.ruleVersion.length > 0 &&
          row.ruleVersion.length <= 128)
      ) ||
      !['copy', 'rebuild', 'omit'].includes(String(row.mode)) ||
      !['copied', 'rebuilt', 'omitted'].every(
        (key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0,
      ) ||
      (row.mode !== 'copy' && row.copied !== 0) ||
      (row.mode !== 'rebuild' && row.rebuilt !== 0) ||
      (row.mode !== 'omit' && row.omitted !== 0)
    )
      return false;
    const key = JSON.stringify([row.extensionId, row.contentType, row.contentVersion]);
    if (seen.has(key)) return false;
    seen.add(key);
    anyOmitted ||= Number(row.omitted) > 0;
  }
  return omitted === anyOmitted;
}
type Scope = { generation: number; selection: number; storeId: string; sessionId: string };
export class NativeSessionManagement {
  private observed?: { scope: Scope; facts: NativeSessionFacts };
  private sequence = 0;
  private readonly entries = new Map<
    string,
    { state: NativeSessionSubmission; promise?: Promise<Command> }
  >();
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  constructor(client: AgentClient, current: () => Scope | undefined, notify: () => void) {
    this.client = client;
    this.current = current;
    this.notify = notify;
  }
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  release() {
    this.observed = undefined;
  }
  private same(scope: Scope) {
    const now = this.current();
    return !!now && (Object.keys(scope) as (keyof Scope)[]).every((key) => now[key] === scope[key]);
  }
  async observe(sessionId: string): Promise<NativeSessionFacts> {
    this.release();
    const scope = this.current();
    if (!scope || scope.sessionId !== sessionId) throw new ClientError('native_selection_changed');
    if (!this.client.serverInfo?.capabilities.includes('sessions'))
      throw new ClientError('capability_unavailable');
    const view = await this.client.getView(sessionId);
    if (!this.same(scope)) throw new ClientError('native_selection_changed');
    if (view.storeId !== scope.storeId || view.session.id !== sessionId)
      throw new ClientError('session_scope_mismatch');
    const facts = { observationId: ++this.sequence, session: structuredClone(view.session) };
    this.observed = { scope: { ...scope }, facts: structuredClone(facts) };
    return facts;
  }
  private observation(id: number) {
    const observed = this.observed;
    if (!observed || observed.facts.observationId !== id || !this.same(observed.scope))
      throw new ClientError('session_observation_changed');
    if (observed.facts.session.parentSessionId !== null)
      throw new ClientError('child_session_readonly');
    if (observed.facts.session.deletedAt !== null) throw new ClientError('session_deleted');
    return observed;
  }
  private async verify(observed: NonNullable<NativeSessionManagement['observed']>) {
    const view = await this.client.getView(observed.scope.sessionId);
    if (!this.same(observed.scope)) throw new ClientError('native_selection_changed');
    const original = observed.facts.session;
    if (
      view.storeId !== observed.scope.storeId ||
      view.session.id !== original.id ||
      view.session.workspaceId !== original.workspaceId ||
      view.session.parentSessionId !== null ||
      view.session.deletedAt !== null
    )
      throw new ClientError('session_scope_mismatch');
    if (
      view.session.controlRevision !== original.controlRevision ||
      view.session.contextSelectionId !== original.contextSelectionId
    )
      throw new ClientError('session_observation_changed');
  }
  submit(observationId: number, kind: NativeSessionSubmission['kind'], title?: string) {
    const observed = this.observation(observationId),
      original = observed.facts.session;
    if (
      kind !== 'delete' &&
      (typeof title !== 'string' || Buffer.byteLength(title) > 8192 || !title.trim())
    )
      throw new ClientError('invalid_session_title');
    if (kind === 'fork' && !this.client.serverInfo?.capabilities.includes('context'))
      throw new ClientError('capability_unavailable');
    const key = JSON.stringify([observationId, kind, title ?? null]),
      previous = this.entries.get(key);
    if (previous?.promise) return previous.promise;
    if (previous) throw new ClientError('session_intent_consumed');
    if (
      [...this.entries.values()].some((entry) =>
        ['saved', 'submitting', 'unknown'].includes(entry.state.phase),
      )
    )
      throw new ClientError('session_mutation_pending');
    if (this.entries.size >= 128) throw new ClientError('session_intent_limit');
    const state: NativeSessionSubmission = {
      kind,
      phase: 'saved',
      sessionId: original.id,
      workspaceId: original.workspaceId,
      intent: {
        expectedStoreId: observed.scope.storeId,
        commandId: crypto.randomUUID(),
        ifRevision: original.controlRevision,
        expectedContextSelectionId: original.contextSelectionId,
        ...(kind === 'fork' ? { newSessionId: crypto.randomUUID() } : {}),
        ...(title === undefined ? {} : { title }),
      },
    };
    const entry: { state: NativeSessionSubmission; promise?: Promise<Command> } = { state };
    this.entries.set(key, entry);
    this.notify();
    let dispatched = false;
    entry.promise = (async () => {
      try {
        await this.verify(observed);
        state.phase = 'submitting';
        dispatched = true;
        this.notify();
        const input = state.intent;
        const result =
          kind === 'fork'
            ? await this.client.forkSession(state.sessionId, {
                expectedStoreId: input.expectedStoreId,
                commandId: input.commandId,
                expectedContextSelectionId: input.expectedContextSelectionId,
                newSessionId: input.newSessionId!,
                title: input.title!,
              })
            : kind === 'rename'
              ? await this.client.renameSession(state.sessionId, {
                  expectedStoreId: input.expectedStoreId,
                  commandId: input.commandId,
                  ifRevision: input.ifRevision,
                  title: input.title!,
                })
              : await this.client.deleteSession(state.sessionId, {
                  expectedStoreId: input.expectedStoreId,
                  commandId: input.commandId,
                  ifRevision: input.ifRevision,
                });
        this.apply(state, result.command);
        return result.command;
      } catch (error) {
        const value = error as { code?: string; status?: number };
        state.phase =
          !dispatched || (value.status !== undefined && value.status >= 400 && value.status < 500)
            ? 'failed'
            : 'unknown';
        state.error =
          value.code && /^[a-z][a-z0-9_]{0,80}$/.test(value.code)
            ? value.code
            : 'network_outcome_unknown';
        throw error;
      } finally {
        entry.promise = undefined;
        this.notify();
      }
    })();
    return entry.promise;
  }
  private apply(state: NativeSessionSubmission, command: Command) {
    const input = state.intent,
      receipt = command.receipt;
    if (
      command.id !== input.commandId ||
      command.originStoreId !== input.expectedStoreId ||
      command.sessionId !== (state.kind === 'fork' ? input.newSessionId : state.sessionId) ||
      command.kind !== (state.kind === 'fork' ? 'session.create' : `session.${state.kind}`)
    )
      throw new ClientError('network_outcome_unknown');
    if (command.status === 'rejected') {
      state.phase = 'failed';
      state.error = 'session_mutation_rejected';
      return;
    }
    if (command.status !== 'applied') {
      state.phase = 'unknown';
      return;
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
      throw new ClientError('network_outcome_unknown');
    if (state.kind === 'fork') {
      if (
        receipt.sourceSessionId !== state.sessionId ||
        receipt.sourceSelectionId !== input.expectedContextSelectionId ||
        receipt.sessionId !== input.newSessionId ||
        !validNamespaceReport(receipt.namespaceReport, receipt.omittedExtensionState) ||
        typeof receipt.selectionId !== 'string'
      )
        throw new ClientError('network_outcome_unknown');
      state.newSessionId = input.newSessionId;
      state.omittedExtensionState = receipt.omittedExtensionState as boolean;
    } else {
      const session = receipt.session;
      if (
        !session ||
        typeof session !== 'object' ||
        Array.isArray(session) ||
        session.id !== state.sessionId ||
        session.workspaceId !== state.workspaceId ||
        session.controlRevision !== String(BigInt(input.ifRevision) + 1n) ||
        session.parentSessionId !== null ||
        (state.kind === 'rename'
          ? receipt.outcome !== 'renamed' ||
            session.title !== input.title ||
            session.deletedAt !== null
          : receipt.outcome !== 'delete_requested' ||
            receipt.stopConfirmed !== false ||
            typeof session.deletedAt !== 'number' ||
            session.deletedAt <= 0)
      )
        throw new ClientError('network_outcome_unknown');
      state.session = structuredClone(session) as Session;
      if (state.kind === 'delete') state.stopConfirmed = false;
    }
    state.phase = 'applied';
    state.error = undefined;
  }
  lookup(commandId: string) {
    const entry = [...this.entries.values()].find(
      (entry) => entry.state.intent.commandId === commandId,
    );
    if (!entry) throw new ClientError('session_intent_missing');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getCommand(commandId)
      .then((command) => {
        this.apply(entry.state, command);
        return command;
      })
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
}
