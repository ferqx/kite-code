import {
  type AgentClient,
  ClientError,
  type HostMutation,
  type ModelSettingsRequest,
  type ModelSettingsView,
} from '@kite-ai/client';
import type { NativeModelSettingsFacts, NativeModelSettingsSubmission } from '../src/native-bridge';
import type { NativeConfigurationData } from './configuration-journal';

type Scope = { generation: number; selection: number; storeId: string; sessionId?: string };
type Entry = {
  state: NativeModelSettingsSubmission;
  input: ModelSettingsRequest;
  promise?: Promise<NativeModelSettingsSubmission>;
};
const code = (error: unknown) => {
  const value = (error as { code?: string })?.code;
  return value && /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : 'network_outcome_unknown';
};
/** Main owns frozen observations and original intents; closing a view only cancels its GET. */
export class NativeConfiguration {
  private reading?: AbortController;
  private sequence = 0;
  private observed?: {
    scope: Scope;
    configuration: ModelSettingsView;
    facts: NativeModelSettingsFacts;
  };
  private readonly entries = new Map<string, Entry>();
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly data?: NativeConfigurationData;
  private unavailable = false;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void = () => {},
    data?: NativeConfigurationData,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.data = data;
    try {
      for (const row of data?.configurations() ?? []) {
        if (row.kind !== 'model') continue;
        this.entries.set(`cold:${row.input.commandId}`, {
          input: row.input,
          state: { ...row.state, phase: 'unknown' },
        });
      }
    } catch {
      this.unavailable = true;
    }
  }
  get observation() {
    return this.observed && this.same(this.observed.scope)
      ? structuredClone(this.observed.facts)
      : undefined;
  }
  get submissions() {
    return [...this.entries.values()].map(({ state }) => structuredClone(state));
  }
  release() {
    this.reading?.abort();
    this.reading = undefined;
    this.observed = undefined;
  }
  private same(scope: Scope) {
    const now = this.current();
    return !!now && (Object.keys(scope) as (keyof Scope)[]).every((key) => scope[key] === now[key]);
  }
  async read(location: 'user' | 'workspace'): Promise<NativeModelSettingsFacts> {
    if (this.unavailable) throw new ClientError('configuration_storage_unavailable');
    this.release();
    const current = this.current();
    if (!current) throw new ClientError('native_generation_changed');
    const scope = { ...current };
    if (!this.client.serverInfo?.capabilities.includes('configuration_management'))
      throw new ClientError('capability_unavailable');
    const reading = new AbortController();
    this.reading = reading;
    try {
      let workspaceId: string | undefined;
      if (location === 'workspace') {
        if (!scope.sessionId) throw new ClientError('native_selection_changed');
        const view = await this.client.getView(scope.sessionId, { signal: reading.signal });
        if (!this.same(scope) || this.reading !== reading)
          throw new ClientError('native_selection_changed');
        if (view.storeId !== scope.storeId || view.session.id !== scope.sessionId)
          throw new ClientError('configuration_scope_mismatch');
        workspaceId = view.session.workspaceId;
      }
      const configuration = await this.client.getModelSettings(location, {
        storeId: scope.storeId,
        ...(workspaceId ? { workspaceId } : {}),
        signal: reading.signal,
      });
      reading.signal.throwIfAborted();
      if (!this.same(scope) || this.reading !== reading)
        throw new ClientError('native_selection_changed');
      if (
        configuration.storeId !== scope.storeId ||
        configuration.scope !== location ||
        configuration.workspaceId !== workspaceId
      )
        throw new ClientError('configuration_scope_mismatch');
      const facts: NativeModelSettingsFacts = {
        kind: 'settings.models',
        observationId: ++this.sequence,
        storeId: scope.storeId,
        scope: location,
        ...(workspaceId ? { workspaceId } : {}),
        canWrite: configuration.readSet !== null && configuration.errors.length === 0,
        errors: [...configuration.errors],
        defaultModelId: configuration.defaultModelId,
        models: configuration.models.map((model) => ({
          id: model.id,
          enabled: model.enabled,
          configured: model.configured,
          ...(model.provider === undefined ? {} : { provider: model.provider }),
          ...(model.model === undefined ? {} : { model: model.model }),
          ...(model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: model.reasoningEffort }),
          ...(model.reasoningEffortChoices === undefined
            ? {}
            : { reasoningEffortChoices: [...model.reasoningEffortChoices] }),
          diagnostics: [...model.diagnostics],
        })),
      };
      this.observed = {
        scope,
        configuration: structuredClone(configuration),
        facts: structuredClone(facts),
      };
      return facts;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
  }
  submit(observationId: number, operation: NativeModelSettingsSubmission['operation']) {
    if (this.unavailable) throw new ClientError('configuration_storage_unavailable');
    const observed = this.observed;
    if (!observed || observed.facts.observationId !== observationId || !this.same(observed.scope))
      throw new ClientError('configuration_observation_changed');
    if (!observed.facts.canWrite || !observed.configuration.readSet)
      throw new ClientError('configuration_unavailable');
    const model = observed.facts.models.find((model) => model.id === operation.modelId);
    if (!model) throw new ClientError('model_settings_model_missing');
    if (
      operation.kind === 'enabled' &&
      !operation.enabled &&
      observed.facts.defaultModelId === model.id
    )
      throw new ClientError('model_settings_default_disable_denied');
    if (operation.kind === 'default' && (!model.enabled || !model.configured))
      throw new ClientError('model_settings_model_unconfigured');
    const key = JSON.stringify([
      observationId,
      operation.kind,
      operation.modelId,
      operation.kind === 'enabled' ? operation.enabled : null,
    ]);
    const prior = this.entries.get(key);
    if (prior?.promise) return prior.promise;
    if (prior) throw new ClientError('configuration_intent_consumed');
    if (
      (this.data?.configurations().some((row) => row.state.storeId === observed.scope.storeId) ??
        false) ||
      [...this.entries.values()].some(
        ({ state }) =>
          state.storeId === observed.scope.storeId &&
          state.scope === observed.facts.scope &&
          state.workspaceId === observed.facts.workspaceId &&
          ['submitting', 'unknown'].includes(state.phase),
      )
    )
      throw new ClientError('configuration_mutation_pending');
    if (this.entries.size >= 128) {
      const terminal = [...this.entries].find(
        ([, entry]) =>
          ['applied', 'failed'].includes(entry.state.phase) &&
          entry.state.observationId !== observationId,
      );
      if (!terminal) throw new ClientError('configuration_intent_limit');
      this.entries.delete(terminal[0]);
    }
    const input: ModelSettingsRequest = {
      commandId: crypto.randomUUID(),
      expectedStoreId: observed.scope.storeId,
      ...(observed.facts.workspaceId ? { workspaceId: observed.facts.workspaceId } : {}),
      expectedReadSet: structuredClone(observed.configuration.readSet),
      operation: structuredClone(operation),
    };
    const entry: Entry = {
      input,
      state: {
        kind: 'settings.models.submission',
        commandId: input.commandId,
        storeId: input.expectedStoreId,
        scope: observed.facts.scope,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        observationId,
        operation: structuredClone(operation),
        phase: 'submitting',
      },
    };
    this.data?.saveConfiguration({ kind: 'model', input: entry.input, state: entry.state });
    this.entries.set(key, entry);
    this.notify();
    entry.promise = this.client
      .updateModelSettings(entry.state.scope, input)
      .then((receipt) => {
        this.apply(entry, receipt);
        this.data?.saveConfiguration({ kind: 'model', input: entry.input, state: entry.state });
        return structuredClone(entry.state);
      })
      .catch((error: unknown) => {
        const status = (error as { status?: number })?.status;
        entry.state.phase =
          status !== undefined && status >= 400 && status < 500 ? 'failed' : 'unknown';
        entry.state.error = code(error);
        this.data?.saveConfiguration({ kind: 'model', input: entry.input, state: entry.state });
        throw error;
      })
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
  private apply(entry: Entry, receipt: HostMutation) {
    const { input, state } = entry,
      marker = receipt.modelSettings;
    if (
      receipt.commandId !== input.commandId ||
      receipt.originStoreId !== input.expectedStoreId ||
      receipt.kind !== 'model_settings.update' ||
      receipt.scope !== state.scope ||
      receipt.workspaceId !== input.workspaceId ||
      !marker ||
      receipt.ifMatch !==
        (state.scope === 'user'
          ? input.expectedReadSet.userEtag
          : input.expectedReadSet.workspaceEtag) ||
      Object.keys(input.expectedReadSet).some(
        (key) =>
          marker.expectedReadSet[key as keyof typeof input.expectedReadSet] !==
          input.expectedReadSet[key as keyof typeof input.expectedReadSet],
      ) ||
      marker.operation.kind !== input.operation.kind ||
      marker.operation.modelId !== input.operation.modelId ||
      (input.operation.kind === 'enabled' &&
        (marker.operation.kind !== 'enabled' ||
          marker.operation.enabled !== input.operation.enabled))
    )
      throw new ClientError('network_outcome_unknown');
    state.phase =
      receipt.state === 'applied' ? 'applied' : receipt.state === 'failed' ? 'failed' : 'unknown';
    state.error = receipt.state === 'failed' ? code(receipt.receipt) : undefined;
  }
  lookup(commandId: string) {
    const entry = [...this.entries.values()].find(({ state }) => state.commandId === commandId);
    if (!entry) throw new ClientError('configuration_intent_missing');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getHostMutation(commandId, { storeId: entry.input.expectedStoreId })
      .then((receipt) => {
        this.apply(entry, receipt);
        this.data?.saveConfiguration({ kind: 'model', input: entry.input, state: entry.state });
        return structuredClone(entry.state);
      })
      .catch((error: unknown) => {
        entry.state.phase = 'unknown';
        entry.state.error = code(error);
        throw error;
      })
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
}
