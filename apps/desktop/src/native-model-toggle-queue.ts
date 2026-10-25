import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
} from './native-bridge';

type Mutation = Extract<
  NativeRequest,
  { method: 'settings.models.enabled' | 'settings.models.default' }
>;
type Lookup = Extract<NativeRequest, { method: 'settings.models.lookup' }>;
type Options = {
  blocked: boolean;
  pending: boolean;
  unknown: boolean;
  foreignPending: boolean;
  hardBlocked: boolean;
  acquireWrite?: () => (() => void) | undefined;
  onSaved?: () => void | Promise<void>;
  onRecovered?: () => void;
};
type Snapshot = {
  facts?: NativeModelSettingsFacts;
  reading: boolean;
  writing: boolean;
  healthy: boolean;
  error: string;
  local: NativeModelSettingsSubmission[];
};

// A detached worker still owns its original observation until its drain finishes.
// Do not let an older settings view close a newer view's observations in this generation.
const owners = new WeakMap<NativeBridge, Map<number, Set<NativeModelToggleQueue>>>();
const retained = new WeakMap<NativeBridge, Map<string, NativeModelToggleQueue>>();

export function nativeModelToggleQueue(
  bridge: NativeBridge,
  generation: number,
  identity: string,
  storeId?: string,
) {
  let queues = retained.get(bridge);
  if (!queues) {
    queues = new Map();
    retained.set(bridge, queues);
  }
  let queue = queues.get(identity);
  if (!queue) {
    queue = new NativeModelToggleQueue(bridge, generation, identity, storeId);
    queues.set(identity, queue);
  }
  return queue;
}

export class NativeModelToggleQueue {
  private snapshot: Snapshot = {
    reading: false,
    writing: false,
    healthy: false,
    error: '',
    local: [],
  };
  private confirmed?: NativeModelSettingsFacts;
  private listeners = new Set<() => void>();
  private queued = new Map<string, boolean>();
  private head?: Mutation;
  private unconfirmed?: { commandId: string; input: Mutation };
  private options: Options = {
    blocked: false,
    pending: false,
    unknown: false,
    foreignPending: false,
    hardBlocked: false,
  };
  private release?: () => void;
  private started = false;
  private detached = false;
  private invalid = false;
  private readSequence = 0;
  private needsSaved = false;
  private busy = false;
  private draining = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryAttempt = 0;
  private recoveryRunning = false;
  private recoveryStopped = false;
  private continuationWake?: () => void;
  private needsReadRecovery = false;
  private unknowns = new Map<string, NativeModelSettingsSubmission>();
  private hotCommands = new Set<string>();
  private sent?: Mutation;
  private lookupHot = false;
  private awaitingUnknown?: Mutation;
  private bridge: NativeBridge;
  private generation: number;
  private identity: string;
  private storeId?: string;

  constructor(bridge: NativeBridge, generation: number, identity: string, storeId?: string) {
    this.bridge = bridge;
    this.generation = generation;
    this.identity = identity;
    this.storeId = storeId;
  }

  getSnapshot = () => this.snapshot;
  get awaitingOriginal() {
    return !!this.awaitingUnknown;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(options: Options) {
    this.options = options;
  }
  private validSubmission(entry: unknown): entry is NativeModelSettingsSubmission {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = entry as NativeModelSettingsSubmission;
    return (
      value.kind === 'settings.models.submission' &&
      typeof value.commandId === 'string' &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(value.commandId) &&
      ['submitting', 'unknown', 'applied', 'failed'].includes(value.phase) &&
      !!value.operation &&
      typeof value.operation === 'object' &&
      typeof value.operation.modelId === 'string' &&
      value.operation.modelId.length > 0 &&
      (value.operation.kind === 'default' ||
        (value.operation.kind === 'enabled' && typeof value.operation.enabled === 'boolean'))
    );
  }
  private matches(input: Mutation | undefined, entry: NativeModelSettingsSubmission) {
    return (
      !!input &&
      this.validSubmission(entry) &&
      entry.storeId === this.storeId &&
      entry.scope === 'user' &&
      entry.workspaceId === undefined &&
      entry.observationId === input.observationId &&
      entry.operation.modelId === input.modelId &&
      (input.method === 'settings.models.enabled'
        ? entry.operation.kind === 'enabled' && entry.operation.enabled === input.enabled
        : entry.operation.kind === 'default')
    );
  }
  private hotUnknown() {
    return (
      !this.invalid &&
      !this.recoveryStopped &&
      (!!this.awaitingUnknown || [...this.unknowns.keys()].some((id) => this.hotCommands.has(id)))
    );
  }
  private cancelRecovery() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.continuationWake?.();
    this.continuationWake = undefined;
  }
  private recoveryError(cause: unknown) {
    const code = this.code(cause);
    if (
      [
        'native_generation_changed',
        'native_selection_changed',
        'configuration_scope_mismatch',
        'store_identity_mismatch',
        'configuration_storage_unavailable',
        'capability_unavailable',
        'permission_denied',
        'authorization_denied',
        'invalid_native_request',
        'connection_identity_mismatch',
        'connection_superseded',
        'connection_not_admitted',
      ].includes(code)
    ) {
      this.recoveryStopped = true;
      this.cancelRecovery();
    }
    return code;
  }
  private scheduleRecovery() {
    if (
      !this.started ||
      this.invalid ||
      this.recoveryStopped ||
      this.recoveryTimer ||
      this.recoveryRunning ||
      this.busy ||
      this.snapshot.reading
    )
      return;
    const unknown = [...this.unknowns.values()].find(
      (entry) => !this.detached || this.hotCommands.has(entry.commandId),
    );
    if (!unknown && !this.awaitingUnknown && (!this.needsReadRecovery || this.detached)) return;
    const delay = [250, 1000, 3000, 10000][Math.min(this.recoveryAttempt, 3)]!;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.invalid || this.recoveryStopped || this.busy || this.snapshot.reading) return;
      this.recoveryRunning = true;
      this.recoveryAttempt++;
      void (async () => {
        try {
          if (this.awaitingUnknown) await this.discoverOriginal();
          if (this.detached && this.needsSaved) await this.saved();
          const target = [...this.unknowns.values()].find(
            (entry) => !this.detached || this.hotCommands.has(entry.commandId),
          );
          if (target)
            await this.lookup(
              {
                method: 'settings.models.lookup',
                generation: this.generation,
                commandId: target.commandId,
              },
              true,
            );
          else if (!this.detached && !this.awaitingUnknown) await this.refresh(true);
        } catch (cause) {
          this.publish({ error: this.recoveryError(cause) });
        } finally {
          this.recoveryRunning = false;
          this.scheduleRecovery();
          this.closeWhenIdle();
        }
      })();
    }, delay);
  }
  private async discoverOriginal() {
    const input = this.awaitingUnknown;
    if (!input || this.invalid) return;
    const state = await this.bridge.request({ method: 'state', generation: this.generation });
    if (this.invalid || !state || !('creationSubmissions' in state)) return;
    if (state.generation !== this.generation) throw Error('native_generation_changed');
    const store = state.selection?.storeId ?? state.directory?.storeId;
    if (!store) return;
    if (store !== this.storeId || (state.directory && state.directory.storeId !== store))
      throw Error('store_identity_mismatch');
    const candidates = (state.modelSettingsSubmissions ?? []).filter((entry) =>
      this.matches(input, entry),
    );
    if (candidates.length !== 1) return;
    const original = candidates[0]!;
    this.hotCommands.add(original.commandId);
    this.remember(original);
    if (original.phase === 'unknown') {
      this.unconfirmed = { commandId: original.commandId, input };
      this.awaitingUnknown = undefined;
    } else if (['applied', 'failed'].includes(original.phase)) {
      if (original.phase === 'applied') {
        this.apply(input);
        this.needsSaved = true;
      }
      this.awaitingUnknown = undefined;
      this.unconfirmed = undefined;
      this.needsReadRecovery = true;
    }
  }
  foreignPending(entry: NativeModelSettingsSubmission) {
    if (!this.validSubmission(entry)) return false;
    const head = this.head;
    return (
      entry.storeId === this.storeId &&
      entry.scope === 'user' &&
      entry.workspaceId === undefined &&
      entry.phase === 'submitting' &&
      (!head ||
        entry.observationId !== head.observationId ||
        entry.operation.modelId !== head.modelId ||
        (head.method === 'settings.models.enabled'
          ? entry.operation.kind !== 'enabled' || entry.operation.enabled !== head.enabled
          : entry.operation.kind !== 'default'))
    );
  }
  suspend() {
    if (!this.busy || !this.snapshot.healthy) return;
    this.queued.clear();
    this.publish({ healthy: false });
  }
  reconcile(submissions: readonly NativeModelSettingsSubmission[]) {
    for (const entry of submissions) {
      if (!this.validSubmission(entry)) continue;
      if (
        entry.storeId !== this.storeId ||
        entry.scope !== 'user' ||
        entry.workspaceId !== undefined
      )
        continue;
      if (entry.phase === 'unknown') {
        this.unknowns.set(entry.commandId, entry);
        if (this.matches(this.sent, entry)) {
          this.hotCommands.add(entry.commandId);
          if (this.awaitingUnknown) {
            this.unconfirmed = { commandId: entry.commandId, input: this.awaitingUnknown };
            this.awaitingUnknown = undefined;
          }
        }
      } else if (
        ['applied', 'failed'].includes(entry.phase) &&
        (this.unknowns.delete(entry.commandId) || this.matches(this.awaitingUnknown, entry))
      ) {
        this.needsReadRecovery = true;
        if (this.confirmed) this.confirmed = { ...this.confirmed, canWrite: false };
        if (entry.phase === 'applied') this.needsSaved = true;
        if (this.matches(this.awaitingUnknown, entry)) this.awaitingUnknown = undefined;
        this.publish();
      }
    }
    if (
      this.busy &&
      this.snapshot.healthy &&
      submissions.some(
        (entry) =>
          entry.storeId === this.storeId &&
          entry.scope === 'user' &&
          entry.workspaceId === undefined &&
          (entry.phase === 'unknown' || this.foreignPending(entry)),
      )
    ) {
      this.suspend();
    }
    const confirmed = submissions.find(
      (entry) =>
        entry.commandId === this.unconfirmed?.commandId &&
        ['applied', 'failed'].includes(entry.phase),
    );
    if (confirmed) {
      if (confirmed.phase === 'applied' && this.unconfirmed) this.apply(this.unconfirmed.input);
      this.unconfirmed = undefined;
      this.publish();
    }
    this.scheduleRecovery();
  }
  start() {
    this.detached = false;
    if (this.started) return;
    this.started = true;
    let generations = owners.get(this.bridge);
    if (!generations) {
      generations = new Map();
      owners.set(this.bridge, generations);
    }
    let generation = generations.get(this.generation);
    if (!generation) {
      generation = new Set();
      generations.set(this.generation, generation);
    }
    generation.add(this);
    void this.refresh();
  }
  detach(invalidate = false) {
    this.detached = true;
    this.listeners.clear();
    if (!this.draining && !this.busy && this.needsSaved) void this.saved().catch(() => {});
    if (invalidate || (!this.draining && !this.hotUnknown() && !this.lookupHot)) {
      this.invalid = true;
      this.queued.clear();
      this.readSequence++;
      this.cancelRecovery();
      this.snapshot = { ...this.snapshot, reading: false };
      const queues = retained.get(this.bridge);
      if (queues?.get(this.identity) === this) queues.delete(this.identity);
    }
    this.closeWhenIdle();
  }
  private closeWhenIdle() {
    if (
      !this.detached ||
      (this.busy && (!this.invalid || this.draining || this.lookupHot)) ||
      this.hotUnknown()
    )
      return;
    const generations = owners.get(this.bridge);
    const generation = generations?.get(this.generation);
    generation?.delete(this);
    const queues = retained.get(this.bridge);
    if (queues?.get(this.identity) === this) queues.delete(this.identity);
    this.cancelRecovery();
    if (generation?.size !== 0) return;
    generations?.delete(this.generation);
    void this.bridge
      .request({ method: 'settings.models.close', generation: this.generation })
      .catch(() => {});
  }
  private publish(change: Partial<Snapshot> = {}) {
    let facts = this.confirmed;
    if (facts) {
      const head = this.head ?? this.unconfirmed?.input;
      const optimistic = new Map(this.queued);
      if (head?.method === 'settings.models.enabled' && !optimistic.has(head.modelId))
        optimistic.set(head.modelId, head.enabled);
      facts = {
        ...facts,
        ...(head?.method === 'settings.models.default' ? { defaultModelId: head.modelId } : {}),
        models: facts.models.map((model) =>
          optimistic.has(model.id) ? { ...model, enabled: optimistic.get(model.id)! } : model,
        ),
      };
    }
    this.snapshot = { ...this.snapshot, ...change, facts };
    for (const listener of this.listeners) listener();
  }
  private code(cause: unknown) {
    const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
    return /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code! : 'configuration_unavailable';
  }
  private async read(afterCommandId?: string) {
    const value = await this.bridge.request({
      method: 'settings.models.read',
      generation: this.generation,
      scope: 'user',
      ...(afterCommandId ? { afterCommandId } : {}),
    });
    if (!value || !('models' in value) || !('kind' in value) || value.kind !== 'settings.models')
      throw Error('configuration_unavailable');
    if (
      value.scope !== 'user' ||
      value.workspaceId !== undefined ||
      (this.storeId !== undefined && value.storeId !== this.storeId)
    )
      throw Error('configuration_scope_mismatch');
    this.storeId ??= value.storeId;
    return value;
  }
  private async readContinuation(commandId: string) {
    let attempt = 0;
    while (!this.invalid) {
      try {
        const value = await this.read(commandId);
        if (!value.canWrite || value.errors.length)
          throw Error('configuration_continuation_changed');
        this.publish({ error: '' });
        return value;
      } catch (cause) {
        const code = this.recoveryError(cause);
        if (
          this.invalid ||
          this.recoveryStopped ||
          ![
            'network_outcome_unknown',
            'network_unavailable',
            'service_unavailable',
            'request_timeout',
            'connection_failed',
            'fetch_failed',
          ].includes(code)
        )
          throw cause;
        this.publish({ error: code });
        const delay = [250, 1000, 3000, 10000][Math.min(attempt++, 3)]!;
        await new Promise<void>((resolve) => {
          this.continuationWake = resolve;
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            this.continuationWake = undefined;
            resolve();
          }, delay);
        });
      }
    }
    throw Error('native_selection_changed');
  }
  async refresh(automatic = false) {
    if (this.busy) return;
    if (this.unknowns.size) {
      this.scheduleRecovery();
      return;
    }
    this.cancelRecovery();
    const wasRecovering = this.needsReadRecovery;
    const sequence = ++this.readSequence;
    this.publish({ reading: true, ...(!automatic ? { error: '' } : {}) });
    try {
      const facts = await this.read();
      if (this.invalid || sequence !== this.readSequence) return;
      this.confirmed = facts;
      this.needsReadRecovery = facts.errors.length > 0 || !!this.awaitingUnknown;
      if (this.awaitingUnknown) this.confirmed = { ...facts, canWrite: false };
      if (!this.needsReadRecovery) {
        this.recoveryAttempt = 0;
        this.cancelRecovery();
      }
      this.publish(this.awaitingUnknown ? {} : { error: '' });
      const saved = this.needsSaved;
      if (saved) await this.saved();
      if (
        !this.invalid &&
        !this.detached &&
        sequence === this.readSequence &&
        wasRecovering &&
        !this.needsReadRecovery &&
        facts.canWrite &&
        !saved
      )
        this.options.onRecovered?.();
    } catch (cause) {
      if (!this.invalid && sequence === this.readSequence) {
        if (this.confirmed) this.confirmed = { ...this.confirmed, canWrite: false };
        this.needsReadRecovery = true;
        this.publish({ error: this.recoveryError(cause) });
      }
    } finally {
      if (sequence === this.readSequence) this.publish({ reading: false });
      this.scheduleRecovery();
      this.closeWhenIdle();
    }
  }
  private remember(result: NativeModelSettingsSubmission) {
    if (
      result.storeId === this.storeId &&
      result.scope === 'user' &&
      result.workspaceId === undefined
    ) {
      this.unknowns.delete(result.commandId);
      if (result.phase === 'unknown') this.unknowns.set(result.commandId, result);
    }
    this.publish({
      local: [
        ...this.snapshot.local.filter((entry) => entry.commandId !== result.commandId),
        result,
      ],
    });
  }
  private async submit(input: Mutation | Lookup) {
    const result = await this.bridge.request(input);
    if (!this.validSubmission(result) || result.phase === 'submitting')
      throw Error(
        input.method === 'settings.models.lookup'
          ? 'configuration_unavailable'
          : 'network_outcome_unknown',
      );
    if (input.method === 'settings.models.lookup') {
      if (result.commandId !== input.commandId) throw Error('configuration_scope_mismatch');
    } else if (
      result.storeId !== this.storeId ||
      result.scope !== 'user' ||
      result.workspaceId !== undefined ||
      result.observationId !== input.observationId ||
      result.operation.modelId !== input.modelId ||
      result.operation.kind !==
        (input.method === 'settings.models.enabled' ? 'enabled' : 'default') ||
      (input.method === 'settings.models.enabled' &&
        (result.operation.kind !== 'enabled' || result.operation.enabled !== input.enabled))
    )
      throw Error('network_outcome_unknown');
    if (input.method !== 'settings.models.lookup') this.hotCommands.add(result.commandId);
    this.remember(result);
    return result;
  }
  toggle(input: Extract<Mutation, { method: 'settings.models.enabled' }>) {
    const facts = this.confirmed;
    const model = facts?.models.find((entry) => entry.id === input.modelId);
    if (this.invalid || !facts?.canWrite || !model) return;
    if (this.busy) {
      if (
        !this.snapshot.healthy ||
        this.options.unknown ||
        this.options.foreignPending ||
        this.options.hardBlocked
      )
        return;
    } else if (!this.begin()) return;
    this.queued.set(input.modelId, input.enabled);
    this.publish();
    if (!this.draining) void this.drain();
  }
  private begin() {
    if (
      this.busy ||
      this.snapshot.reading ||
      this.options.blocked ||
      this.options.pending ||
      this.options.hardBlocked ||
      !this.confirmed?.canWrite
    )
      return false;
    const release = this.options.acquireWrite?.();
    if (this.options.acquireWrite && !release) return false;
    this.release = release;
    this.cancelRecovery();
    this.busy = true;
    this.publish({ writing: true, healthy: true, error: '' });
    return true;
  }
  private apply(input: Mutation) {
    if (!this.confirmed) return;
    this.confirmed = {
      ...this.confirmed,
      ...(input.method === 'settings.models.default' ? { defaultModelId: input.modelId } : {}),
      models: this.confirmed.models.map((model) =>
        input.method === 'settings.models.enabled' && model.id === input.modelId
          ? { ...model, enabled: input.enabled }
          : model,
      ),
    };
  }
  private stop(error: string, readonly = true) {
    this.queued.clear();
    this.head = undefined;
    if (readonly && this.confirmed) this.confirmed = { ...this.confirmed, canWrite: false };
    this.needsReadRecovery = readonly;
    this.publish({ healthy: false, error });
  }
  private async saved() {
    if (!this.needsSaved) return;
    this.needsSaved = false;
    await this.options.onSaved?.();
  }
  private async drain(first?: Mutation) {
    // Only the original head starts a worker; later toggles update the pending Map.
    if (this.draining) return;
    this.draining = true;
    let next = first;
    try {
      while (true) {
        if (this.invalid) this.queued.clear();
        if (
          this.queued.size &&
          (this.options.unknown || this.options.foreignPending || this.options.hardBlocked)
        ) {
          this.queued.clear();
          this.publish({ healthy: false });
        }
        if (!next && this.queued.size) {
          const [modelId, enabled] = this.queued.entries().next().value!;
          this.queued.delete(modelId);
          const facts = this.confirmed!;
          const model = facts.models.find((entry) => entry.id === modelId);
          if (!facts.canWrite || !model) throw Error('configuration_continuation_changed');
          if (model.enabled === enabled) continue;
          next = {
            method: 'settings.models.enabled',
            generation: this.generation,
            observationId: facts.observationId,
            modelId,
            enabled,
          };
        }
        if (!next) {
          await this.saved();
          if (this.queued.size) continue;
          break;
        }
        this.head = next;
        this.sent = next;
        this.publish({ healthy: next.method === 'settings.models.enabled' });
        const result = await this.submit(next);
        if (result.phase !== 'applied') {
          // Unknown retains the immutable original head's visible intent, never its tail.
          if (result.phase === 'unknown')
            this.unconfirmed = { commandId: result.commandId, input: next };
          this.stop(result.error ?? '', result.phase !== 'unknown');
          break;
        }
        this.apply(next);
        this.needsSaved = true;
        if (this.invalid) {
          this.queued.clear();
          this.head = undefined;
          next = undefined;
          continue;
        }
        this.publish({ reading: true });
        try {
          const continued = await this.readContinuation(result.commandId);
          if (!this.invalid) this.confirmed = continued;
        } catch (cause) {
          this.stop(`已保存模型配置，正在后台恢复。${this.recoveryError(cause)}`);
          break;
        } finally {
          this.publish({ reading: false });
        }
        this.head = undefined;
        next = undefined;
        this.publish();
      }
    } catch (cause) {
      const code = this.recoveryError(cause);
      if (this.head && /unknown|network|connection|timeout/.test(code))
        this.awaitingUnknown = this.head;
      this.stop(code);
    } finally {
      if (this.needsSaved)
        try {
          await this.saved();
        } catch (cause) {
          this.stop(`已保存模型配置，正在后台恢复。${this.recoveryError(cause)}`);
        }
      this.head = undefined;
      this.draining = false;
      this.busy = false;
      this.release?.();
      this.release = undefined;
      this.publish({ writing: false, healthy: false });
      this.scheduleRecovery();
      // A peer notification cannot replace the proof-bound observation while draining.
      // The final continuation already read current facts; only explicit recovery rereads on failure.
      this.closeWhenIdle();
    }
  }
  write(input: NativeRequest) {
    if (input.method === 'settings.models.enabled') return this.toggle(input);
    if (input.method === 'settings.models.default') {
      const model = this.confirmed?.models.find((entry) => entry.id === input.modelId);
      if (this.invalid || !model?.enabled || !model.configured || !this.begin()) return;
      void this.drain(input);
    } else if (input.method === 'settings.models.lookup') void this.lookup(input);
  }
  private async lookup(input: Lookup, automatic = false) {
    if (this.busy || this.invalid) return;
    this.cancelRecovery();
    this.busy = true;
    this.lookupHot = this.hotCommands.has(input.commandId);
    this.publish({ writing: true, ...(!automatic ? { error: '' } : {}) });
    let applied = false;
    try {
      const result = await this.submit(input);
      if (
        result.storeId !== this.storeId ||
        result.scope !== 'user' ||
        result.workspaceId !== undefined
      )
        return;
      if (result.phase === 'applied' || result.phase === 'failed') {
        if (this.confirmed) this.confirmed = { ...this.confirmed, canWrite: false };
        if (result.phase === 'applied') {
          if (this.unconfirmed?.commandId === result.commandId) this.apply(this.unconfirmed.input);
          this.needsSaved = true;
          applied = true;
        }
        this.unconfirmed = undefined;
        this.awaitingUnknown = undefined;
        this.needsReadRecovery = true;
        if (this.invalid || this.detached || this.unknowns.size) return;
        this.publish({ reading: true });
        // The original result settled. This is a new observation, never a replay of its tail.
        this.confirmed = await this.read();
        this.needsReadRecovery = this.confirmed.errors.length > 0;
        if (!this.needsReadRecovery) this.recoveryAttempt = 0;
        this.publish({ error: '' });
        if (
          !applied &&
          !this.invalid &&
          !this.detached &&
          !this.needsReadRecovery &&
          this.confirmed.canWrite
        )
          this.options.onRecovered?.();
      } else if (result.error) this.publish({ error: result.error });
    } catch (cause) {
      const code = this.recoveryError(cause);
      if (applied) this.stop(`已保存模型配置，正在后台恢复。${code}`);
      else this.publish({ error: code });
    } finally {
      try {
        await this.saved();
      } catch (cause) {
        this.stop(this.recoveryError(cause));
      }
      this.busy = false;
      this.lookupHot = false;
      this.publish({ writing: false, reading: false });
      this.scheduleRecovery();
      this.closeWhenIdle();
    }
  }
}
