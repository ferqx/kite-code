import {
  type AgentClient,
  ClientError,
  canonicalModelBody,
  type HostMutation,
  type ProviderSettingsRequest,
  type ProviderSettingsView,
} from '@kite-ai/client';
import type {
  NativeProviderOperation,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
} from '../src/native-bridge';
import type { NativeConfigurationData } from './configuration-journal';

type Scope = { generation: number; selection: number; storeId: string; sessionId?: string };
type Entry = {
  input: Omit<ProviderSettingsRequest, 'secret'>;
  state: NativeProviderSubmission;
  promise?: Promise<NativeProviderSubmission>;
};
const code = (error: unknown) => {
  const value = (error as { code?: string })?.code ?? (error as Error)?.message;
  return value && /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : 'network_outcome_unknown';
};
/** A renderer may edit Provider fields, never configuration paths or vault references. */
export class NativeProviderSettings {
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly data?: NativeConfigurationData;
  private readonly entries = new Map<string, Entry>();
  private reading?: AbortController;
  private sequence = 0;
  private unavailable = false;
  private observed?: {
    scope: Scope;
    view: ProviderSettingsView;
    facts: NativeProviderSettingsFacts;
  };
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void,
    data?: NativeConfigurationData,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.data = data;
    try {
      for (const row of data?.configurations() ?? []) {
        if (row.kind === 'provider')
          this.entries.set(`cold:${row.input.commandId}`, {
            input: row.input,
            state: { ...row.state, phase: 'unknown' },
          });
      }
    } catch {
      this.unavailable = true;
    }
  }
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  release() {
    this.reading?.abort();
    this.reading = undefined;
    this.observed = undefined;
  }
  cancelRead() {
    this.reading?.abort();
    this.reading = undefined;
  }
  private same(scope: Scope) {
    const current = this.current();
    return !!current && canonicalModelBody(current) === canonicalModelBody(scope);
  }
  async read(): Promise<NativeProviderSettingsFacts> {
    if (this.unavailable) throw new ClientError('configuration_storage_unavailable');
    this.release();
    const current = this.current();
    if (!current) throw new ClientError('native_generation_changed');
    const scope = { ...current };
    const reading = new AbortController();
    this.reading = reading;
    try {
      const view = await this.client.getProviderSettings({
        storeId: scope.storeId,
        signal: reading.signal,
      });
      reading.signal.throwIfAborted();
      if (!this.same(scope) || this.reading !== reading)
        throw new ClientError('native_selection_changed');
      const facts: NativeProviderSettingsFacts = {
        kind: 'settings.providers',
        observationId: ++this.sequence,
        storeId: view.storeId,
        canWrite: !!view.readSet && !view.errors.length,
        errors: [...view.errors],
        providers: view.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          defaultBaseURL: provider.defaultBaseURL,
          requiresCredential: provider.requiresCredential,
          connections: provider.connections.map((connection) => ({
            id: connection.id,
            baseURL: connection.baseURL,
            hasCredential: connection.hasCredential,
            modelNames: [...connection.modelNames],
            canWrite: connection.canWrite,
          })),
        })),
      };
      this.observed = { scope, view: structuredClone(view), facts: structuredClone(facts) };
      return facts;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
  }
  submit(
    observationId: number,
    operation: NativeProviderOperation,
    secret?: string,
  ): Promise<NativeProviderSubmission> {
    if (this.unavailable) throw new ClientError('configuration_storage_unavailable');
    const observed = this.observed;
    if (!observed || observationId !== observed.facts.observationId || !this.same(observed.scope))
      throw new ClientError('configuration_observation_changed');
    if (!observed.view.readSet || !observed.facts.canWrite)
      throw new ClientError('configuration_unavailable');
    try {
      const url = new URL(operation.baseURL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
    } catch {
      throw new ClientError('invalid_provider_endpoint');
    }
    const provider = observed.facts.providers.find((entry) => entry.id === operation.provider);
    const connection = provider?.connections.find((entry) => entry.id === operation.connectionId);
    if (!provider || (operation.connectionId !== null && (!connection || !connection.canWrite)))
      throw new ClientError('provider_settings_override');
    if (
      (operation.credential === 'replace') !== (secret !== undefined) ||
      (operation.credential === 'replace' && !secret?.trim()) ||
      (operation.credential === 'keep' && !connection?.hasCredential) ||
      (provider.requiresCredential && operation.credential === 'none')
    )
      throw new ClientError('provider_credential_required');
    const key = `${observationId}:${canonicalModelBody(operation)}`;
    const prior = this.entries.get(key);
    if (prior?.promise) return prior.promise;
    if (prior) throw new ClientError('configuration_intent_consumed');
    if (
      (this.data?.configurations().some((row) => row.state.storeId === observed.scope.storeId) ??
        false) ||
      [...this.entries.values()].some(
        (entry) =>
          entry.state.storeId === observed.scope.storeId &&
          ['submitting', 'unknown'].includes(entry.state.phase),
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
    const input: Omit<ProviderSettingsRequest, 'secret'> = {
      expectedStoreId: observed.scope.storeId,
      commandId: crypto.randomUUID(),
      expectedReadSet: structuredClone(observed.view.readSet),
      operation: structuredClone(operation),
    };
    const entry: Entry = {
      input,
      state: {
        kind: 'settings.providers.submission',
        commandId: input.commandId,
        storeId: input.expectedStoreId,
        observationId,
        operation: structuredClone(operation),
        phase: 'submitting',
      },
    };
    this.data?.saveConfiguration({ kind: 'provider', input, state: entry.state });
    this.entries.set(key, entry);
    this.notify();
    // The secret is carried by this one hot transport and never retained in Entry/private SQLite.
    entry.promise = this.client
      .updateProviderSettings({ ...input, ...(secret !== undefined ? { secret } : {}) })
      .then((receipt) => {
        this.apply(entry, receipt);
        this.data?.saveConfiguration({ kind: 'provider', input, state: entry.state });
        return structuredClone(entry.state);
      })
      .catch((error: unknown) => {
        entry.state.phase = 'unknown';
        entry.state.error = code(error);
        this.data?.saveConfiguration({ kind: 'provider', input, state: entry.state });
        throw error;
      })
      .finally(() => {
        entry.promise = undefined;
        this.notify();
      });
    return entry.promise;
  }
  private apply(entry: Entry, receipt: HostMutation) {
    if (
      receipt.kind !== 'provider_settings.update' ||
      receipt.scope !== 'user' ||
      receipt.workspaceId !== undefined ||
      receipt.commandId !== entry.input.commandId ||
      receipt.originStoreId !== entry.input.expectedStoreId ||
      receipt.ifMatch !== entry.input.expectedReadSet.userEtag ||
      canonicalModelBody(receipt.providerSettings) !==
        canonicalModelBody({
          expectedReadSet: entry.input.expectedReadSet,
          operation: entry.input.operation,
        })
    )
      throw new ClientError('network_outcome_unknown');
    entry.state.phase =
      receipt.state === 'applied' ? 'applied' : receipt.state === 'failed' ? 'failed' : 'unknown';
    const status = receipt.receipt as Record<string, unknown>;
    if (status.credentialState !== undefined)
      entry.state.credentialState =
        status.credentialState as NativeProviderSubmission['credentialState'];
    if (status.configurationState !== undefined)
      entry.state.configurationState =
        status.configurationState as NativeProviderSubmission['configurationState'];
    entry.state.error =
      receipt.state === 'failed' || receipt.state === 'outcome_unknown' ? code(status) : undefined;
  }
  lookup(commandId: string) {
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.input.commandId === commandId,
    );
    if (!entry) throw new ClientError('configuration_intent_missing');
    if (entry.promise) return entry.promise;
    entry.promise = this.client
      .getHostMutation(commandId, { storeId: entry.input.expectedStoreId })
      .then((receipt) => {
        this.apply(entry, receipt);
        this.data?.saveConfiguration({ kind: 'provider', input: entry.input, state: entry.state });
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
