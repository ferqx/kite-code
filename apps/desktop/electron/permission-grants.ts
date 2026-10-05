import {
  type AgentClient,
  type ClearPermissionGrantsRequest,
  ClientError,
  type PermissionMutation,
} from '@kite-ai/client';
import type { NativeGrantFacts, NativeGrantSubmission } from '../src/native-bridge';

type Scope = {
  generation: number;
  selection: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
/** Only current-view facts and original clear intents; never an executable grant cache. */
export class NativePermissionGrants {
  private observed: { scope: Scope; facts: NativeGrantFacts } | undefined;
  private reading: AbortController | undefined;
  private sequence = 0;
  private readonly entries = new Map<
    string,
    { state: NativeGrantSubmission; promise?: Promise<PermissionMutation> }
  >();
  constructor(
    privateClient: AgentClient,
    currentScope: () => Scope | undefined,
    notify: () => void,
  ) {
    this.client = privateClient;
    this.current = currentScope;
    this.notify = notify;
  }
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  get pending() {
    return [...this.entries.values()].some((entry) =>
      ['saved', 'submitting', 'unknown'].includes(entry.state.phase),
    );
  }
  private same(scope: Scope) {
    const now = this.current();
    return (
      !!now &&
      Object.keys(scope).every((key) => now[key as keyof Scope] === scope[key as keyof Scope])
    );
  }
  release() {
    this.reading?.abort();
    this.reading = undefined;
    this.observed = undefined;
  }
  async read(input: {
    sessionId: string;
    afterSeq?: string;
    upperSeq?: string;
    revision?: string;
  }) {
    this.release();
    if (!this.client.serverInfo?.capabilities.includes('permission_grants'))
      throw new ClientError('capability_unavailable');
    const scope = this.current();
    if (!scope || scope.sessionId !== input.sessionId)
      throw new ClientError('native_selection_changed');
    const abort = new AbortController();
    this.reading = abort;
    try {
      const page = await this.client.listPermissionGrants(
        scope.sessionId,
        {
          storeId: scope.storeId,
          limit: 200,
          ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
          ...(input.upperSeq === undefined ? {} : { upperSeq: input.upperSeq }),
        },
        { signal: abort.signal },
      );
      abort.signal.throwIfAborted();
      if (!this.same(scope)) throw new ClientError('native_selection_changed');
      if (page.storeId !== scope.storeId || page.sessionId !== scope.sessionId)
        throw new ClientError('permission_scope_mismatch');
      if (input.revision !== undefined && page.revision !== input.revision)
        throw new ClientError('directory_snapshot_changed');
      const facts = Object.freeze({ observationId: ++this.sequence, page: structuredClone(page) });
      this.observed = { scope: { ...scope }, facts };
      return facts;
    } catch (error) {
      if (this.reading === abort) this.observed = undefined;
      throw error;
    } finally {
      if (this.reading === abort) this.reading = undefined;
    }
  }
  clear(observationId: number): Promise<PermissionMutation> {
    if (!this.client.serverInfo?.capabilities.includes('permission_grants'))
      throw new ClientError('capability_unavailable');
    const existing = [...this.entries.values()].find(
      (entry) => entry.state.observationId === observationId,
    );
    if (existing?.promise) return existing.promise;
    if (existing) throw new ClientError('permission_observation_consumed');
    const observation = this.observed;
    if (
      !observation ||
      observation.facts.observationId !== observationId ||
      !this.same(observation.scope)
    )
      throw new ClientError('permission_observation_changed');
    if (this.pending) throw new ClientError('permission_intent_pending');
    if (this.entries.size >= 128) throw new ClientError('permission_intent_limit');
    const intent: ClearPermissionGrantsRequest = Object.freeze({
      expectedStoreId: observation.scope.storeId,
      commandId: crypto.randomUUID(),
      ifRevision: observation.facts.page.revision,
    });
    const state: NativeGrantSubmission = {
      sessionId: observation.scope.sessionId,
      workspaceId: observation.scope.workspaceId,
      observationId,
      intent,
      phase: 'saved',
    };
    const entry: { state: NativeGrantSubmission; promise?: Promise<PermissionMutation> } = {
      state,
    };
    this.entries.set(intent.commandId, entry);
    this.observed = undefined;
    state.phase = 'submitting';
    this.notify();
    entry.promise = this.client
      .clearPermissionGrants(state.sessionId, intent)
      .then((receipt) => this.apply(entry, receipt))
      .catch((error) => {
        const code = error instanceof ClientError ? error.code : 'permission_result_unavailable';
        const knownRejection =
          error instanceof ClientError &&
          error.problem &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status);
        state.phase = knownRejection ? 'failed' : 'unknown';
        state.error = code;
        throw error;
      })
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
  private apply(entry: { state: NativeGrantSubmission }, receipt: PermissionMutation) {
    const state = entry.state;
    if (
      receipt.commandId !== state.intent.commandId ||
      receipt.kind !== 'permission.grants.clear' ||
      (receipt.state === 'applied' &&
        (receipt.receipt.sessionId !== state.sessionId ||
          BigInt(receipt.receipt.revision) <= BigInt(state.intent.ifRevision)))
    )
      throw new ClientError('permission_scope_mismatch');
    state.receipt = structuredClone(receipt);
    state.phase =
      receipt.state === 'applied' ? 'applied' : receipt.state === 'failed' ? 'failed' : 'unknown';
    if ('code' in receipt.receipt) state.error = receipt.receipt.code;
    return receipt;
  }
  lookup(commandId: string) {
    const entry = this.entries.get(commandId);
    if (!entry) throw new ClientError('permission_intent_missing');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getPermissionMutation(commandId, { storeId: entry.state.intent.expectedStoreId })
      .then((receipt) => this.apply(entry, receipt))
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
}
