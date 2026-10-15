import { randomUUID } from 'node:crypto';
import type {
  AgentClient,
  ModelSettingsRequest,
  ProviderSettingsRequest,
  SetWorkspaceTrustRequest,
} from '@kite-ai/client';
import { ClientError } from '@kite-ai/client';
import type {
  TuiOnboardingConnection,
  TuiOnboardingPort,
  TuiOnboardingResult,
} from '@kite-ai/ui/tui';

type Client = Pick<
  AgentClient,
  | 'getProviderSettings'
  | 'updateProviderSettings'
  | 'discoverProviderSettings'
  | 'getHostMutation'
  | 'getModelSettings'
  | 'updateModelSettings'
  | 'getWorkspaceTrust'
  | 'setWorkspaceTrust'
  | 'getPermissionMutation'
>;
type Pending = {
  id: string;
  workspaceId: string;
  kind: 'trust' | 'provider' | 'enable' | 'default';
  modelId?: string;
  applied: boolean;
  modelRequest?: ModelSettingsRequest;
  providerRequest?: Omit<ProviderSettingsRequest, 'secret'>;
  trustRequest?: SetWorkspaceTrustRequest;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function sameEndpoint(first: string, second: string | undefined): boolean {
  try {
    return new URL(first).href.replace(/\/$/, '') === new URL(second ?? '').href.replace(/\/$/, '');
  } catch {
    return false;
  }
}
/** No local journal, secrets, or replay of original mutations. Public CAS owns publication. */
export function createTuiOnboardingPort(
  client: Client,
  storeId: string,
  observeUnavailableWorkspace?: (workspaceId: string, signal?: AbortSignal) => Promise<boolean>,
): TuiOnboardingPort {
  let pending: Pending | undefined;
  let inFlight = false;
  async function exclusive(
    action: () => Promise<TuiOnboardingResult>,
  ): Promise<TuiOnboardingResult> {
    if (inFlight) return { status: 'unknown' };
    inFlight = true;
    try {
      return await action();
    } finally {
      inFlight = false;
    }
  }
  const postModel: Client['updateModelSettings'] = (scope, request, options) => {
    if (pending) pending.modelRequest = structuredClone(request);
    return client.updateModelSettings(scope, request, options);
  };
  const postProvider: Client['updateProviderSettings'] = (request, options) => {
    if (pending)
      pending.providerRequest = structuredClone({
        expectedStoreId: request.expectedStoreId,
        commandId: request.commandId,
        expectedReadSet: request.expectedReadSet,
        operation: request.operation,
      });
    return client.updateProviderSettings(request, options);
  };
  const postTrust: Client['setWorkspaceTrust'] = (workspaceId, request, options) => {
    if (pending) pending.trustRequest = structuredClone(request);
    return client.setWorkspaceTrust(workspaceId, request, options);
  };
  let provider: TuiOnboardingConnection['provider'] | undefined;
  let endpoint: string | undefined;
  let priorConnectionIds = new Set<string>();
  let selectedConnectionId: string | undefined;
  let originalConnectionId: string | undefined;
  let selectedModelId: string | undefined;
  const models = (workspaceId: string, signal?: AbortSignal) =>
    client.getModelSettings('workspace', { storeId, workspaceId, signal });
  const ready = async (workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingResult> => {
    const state = await models(workspaceId, signal);
    if (state.errors.length) return { status: 'failed', code: 'configuration_unavailable' };
    const found = state.models.find(
      (model) => model.id === state.defaultModelId && model.enabled && model.configured,
    );
    return found
      ? { status: 'ready', modelName: found.model ?? found.id }
      : { status: 'model-required' };
  };
  async function confirm(signal?: AbortSignal): Promise<TuiOnboardingResult | undefined> {
    if (!pending) return undefined;
    try {
      const state =
        pending.kind === 'trust'
          ? await client.getPermissionMutation(pending.id, { storeId, signal })
          : await client.getHostMutation(pending.id, { storeId, signal });
      if (
        state.commandId !== pending.id ||
        (pending.kind === 'trust'
          ? state.kind !== 'workspace.trust'
          : state.kind !==
            (pending.kind === 'provider' ? 'provider_settings.update' : 'model_settings.update'))
      )
        return { status: 'unknown' };
      if (pending.kind === 'trust') {
        const expected = pending.trustRequest;
        if (!expected) return { status: 'unknown' };
        if (state.state === 'applied' && state.kind === 'workspace.trust') {
          if (
            !('trusted' in state.receipt) ||
            state.receipt.trusted !== expected.trusted ||
            state.receipt.canonicalIdentity !== expected.canonicalIdentity ||
            state.receipt.externalReadScopeDigest !== expected.externalReadScopeDigest ||
            BigInt(state.receipt.revision) <= BigInt(expected.ifRevision)
          )
            return { status: 'unknown' };
          const observed = await client.getWorkspaceTrust(pending.workspaceId, { storeId, signal });
          if (
            !observed.trusted ||
            observed.canonicalIdentity !== expected.canonicalIdentity ||
            observed.externalReadScopeDigest !== expected.externalReadScopeDigest ||
            BigInt(observed.revision) < BigInt(state.receipt.revision)
          )
            return { status: 'unknown' };
        }
      } else {
        if (
          !('originStoreId' in state) ||
          state.originStoreId !== storeId ||
          state.scope !== (pending.kind === 'provider' ? 'user' : 'workspace') ||
          state.workspaceId !== (pending.kind === 'provider' ? undefined : pending.workspaceId)
        )
          return { status: 'unknown' };
        const expected =
          pending.kind === 'provider' ? pending.providerRequest : pending.modelRequest;
        const marker = pending.kind === 'provider' ? state.providerSettings : state.modelSettings;
        if (
          !expected ||
          !marker ||
          state.ifMatch !==
            (pending.kind === 'provider'
              ? expected.expectedReadSet.userEtag
              : expected.expectedReadSet.workspaceEtag) ||
          canonical(marker) !==
            canonical({ expectedReadSet: expected.expectedReadSet, operation: expected.operation })
        )
          return { status: 'unknown' };
      }
      if (state.state === 'applied') {
        pending.applied = true;
        return undefined;
      }
      if (state.state === 'failed') {
        pending = undefined;
        const code =
          'code' in state.receipt &&
          typeof state.receipt.code === 'string' &&
          /^provider_[a-z_]+$/.test(state.receipt.code)
            ? state.receipt.code
            : 'configuration_write_failed';
        return { status: 'failed', code };
      }
      return { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
  async function publish(
    workspaceId: string,
    kind: Pending['kind'],
    action: (id: string) => Promise<unknown>,
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<TuiOnboardingResult | undefined> {
    pending = { id: randomUUID(), workspaceId, kind, modelId, applied: false };
    try {
      await action(pending.id);
    } catch (error) {
      if (
        error instanceof ClientError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== 'mutation_incomplete' &&
        error.code !== 'network_outcome_unknown'
      ) {
        pending = undefined;
        return { status: 'failed', code: error.code };
      }
      /* GET original identity even after response loss. */
    }
    return confirm(signal);
  }
  async function finish(workspaceId: string, signal?: AbortSignal): Promise<TuiOnboardingResult> {
    try {
      return await finishKnown(workspaceId, signal);
    } catch {
      return pending
        ? { status: 'unknown' }
        : { status: 'failed', code: 'configuration_unavailable' };
    }
  }
  async function finishKnown(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TuiOnboardingResult> {
    if (pending && !pending.applied) return { status: 'unknown' };
    if (pending?.kind === 'trust') {
      pending = undefined;
      const result = await ready(workspaceId, signal);
      return result.status === 'model-required'
        ? { status: 'model-required', stage: 'provider' }
        : result;
    }
    if (pending?.kind === 'default') {
      pending = undefined;
      return ready(workspaceId, signal);
    }
    const state = await models(workspaceId, signal);
    if (!state.readSet || state.errors.length)
      return { status: 'failed', code: 'configuration_unavailable' };
    const existing = await ready(workspaceId, signal);
    if (existing.status === 'ready') {
      pending = undefined;
      return existing;
    }
    if (!selectedConnectionId && !selectedModelId) {
      const facts = await client.getProviderSettings({ storeId, signal });
      if (facts.errors.length || !facts.readSet)
        return { status: 'failed', code: 'configuration_unavailable' };
      const connections =
        facts.providers
          .find((item) => item.id === provider)
          ?.connections.filter((item) => sameEndpoint(item.baseURL, endpoint)) ?? [];
      const retained = connections.find((item) => item.id === originalConnectionId);
      const created = connections.filter((item) => !priorConnectionIds.has(item.id));
      const exact = retained ?? (created.length === 1 ? created[0] : undefined);
      if (!exact) return { status: 'failed', code: 'provider_connection_unavailable' };
      selectedConnectionId = exact.id;
    }
    const targetId = pending?.modelId ?? selectedModelId;
    const chosen = targetId
      ? state.models.find(
          (item) =>
            item.id === targetId &&
            (selectedConnectionId === undefined || item.connectionId === selectedConnectionId),
        )
      : state.models.find((item) => item.configured && item.connectionId === selectedConnectionId);
    if (!chosen) {
      pending = undefined;
      return { status: 'model-required' };
    }
    if (!chosen.enabled) {
      const result = await publish(
        workspaceId,
        'enable',
        (commandId) =>
          postModel(
            'workspace',
            {
              expectedStoreId: storeId,
              commandId,
              workspaceId,
              expectedReadSet: state.readSet!,
              operation: { kind: 'enabled', modelId: chosen.id, enabled: true },
            },
            { signal },
          ),
        signal,
        chosen.id,
      );
      if (result) return result;
    }
    const refreshed = await models(workspaceId, signal);
    if (
      !refreshed.readSet ||
      refreshed.errors.length ||
      !refreshed.models.some(
        (item) =>
          item.id === chosen.id &&
          (selectedConnectionId === undefined || item.connectionId === selectedConnectionId) &&
          item.configured &&
          item.enabled,
      )
    )
      return { status: 'failed', code: 'configuration_unavailable' };
    const result = await publish(
      workspaceId,
      'default',
      (commandId) =>
        postModel(
          'workspace',
          {
            expectedStoreId: storeId,
            commandId,
            workspaceId,
            expectedReadSet: refreshed.readSet!,
            operation: { kind: 'default', modelId: chosen.id },
          },
          { signal },
        ),
      signal,
      chosen.id,
    );
    if (result) return result;
    pending = undefined;
    return ready(workspaceId, signal);
  }
  return {
    async read(workspaceId, signal) {
      if (await observeUnavailableWorkspace?.(workspaceId, signal))
        return { trusted: false, readScopes: [], hasModels: false, observer: 'workspace_missing' };
      const trust = await client.getWorkspaceTrust(workspaceId, { storeId, signal });
      if (!trust.trusted) return { trusted: false, readScopes: trust.readScopes, hasModels: false };
      const state = await models(workspaceId, signal);
      if (state.errors.length || !state.readSet) throw Error('configuration_unavailable');
      const selected = state.models.find(
        (item) => item.id === state.defaultModelId && item.enabled && item.configured,
      );
      return {
        trusted: true,
        readScopes: trust.readScopes,
        hasModels: state.models.length > 0,
        models: state.models.map((item) => ({
          id: item.id,
          name: item.model ?? item.id,
          configured: item.configured,
          enabled: item.enabled,
        })),
        modelName: selected && (selected.model ?? selected.id),
      };
    },
    async trust(workspaceId, signal) {
      return exclusive(async () => {
        if (pending) return { status: 'unknown' };
        const state = await client.getWorkspaceTrust(workspaceId, { storeId, signal });
        if (state.trusted) return ready(workspaceId, signal);
        const result = await publish(
          workspaceId,
          'trust',
          (commandId) =>
            postTrust(
              workspaceId,
              {
                expectedStoreId: storeId,
                commandId,
                canonicalIdentity: state.canonicalIdentity,
                externalReadScopeDigest: state.externalReadScopeDigest,
                trusted: true,
                ifRevision: state.revision,
              },
              { signal },
            ),
          signal,
        );
        return result ?? finish(workspaceId, signal);
      });
    },
    async selectModel(workspaceId, modelId, signal) {
      return exclusive(async () => {
        if (pending) return { status: 'unknown' };
        const trust = await client.getWorkspaceTrust(workspaceId, { storeId, signal });
        if (!trust.trusted) return { status: 'failed', code: 'workspace_untrusted' };
        const state = await models(workspaceId, signal);
        const selected = state.models.find((item) => item.id === modelId && item.configured);
        if (state.errors.length || !state.readSet || !selected)
          return { status: 'failed', code: 'model_unavailable' };
        selectedModelId = selected.id;
        selectedConnectionId = selected.connectionId;
        return finish(workspaceId, signal);
      });
    },
    async connect(workspaceId, input, signal, onPhase) {
      return exclusive(async () => {
        if (pending) return { status: 'unknown' };
        onPhase?.('discovering');
        const trust = await client.getWorkspaceTrust(workspaceId, { storeId, signal });
        if (!trust.trusted) return { status: 'failed', code: 'workspace_untrusted' };
        const state = await client.getProviderSettings({ storeId, signal });
        if (!state.readSet || state.errors.length)
          return { status: 'failed', code: 'configuration_unavailable' };
        const before = await models(workspaceId, signal);
        if (before.errors.length || !before.readSet)
          return { status: 'failed', code: 'configuration_unavailable' };
        priorConnectionIds = new Set(
          state.providers.flatMap((item) => item.connections.map((connection) => connection.id)),
        );
        selectedConnectionId = undefined;
        selectedModelId = undefined;
        provider = input.provider;
        endpoint = input.baseURL;
        const candidates =
          state.providers
            .find((item) => item.id === input.provider)
            ?.connections.filter((item) => sameEndpoint(item.baseURL, endpoint)) ?? [];
        if (candidates.length > 1)
          return { status: 'failed', code: 'provider_connection_ambiguous' };
        const connection = candidates[0];
        originalConnectionId = connection?.id;
        if (connection && !connection.canWrite)
          return { status: 'failed', code: 'provider_readonly' };
        const operation = {
          provider: input.provider,
          connectionId: connection?.id ?? null,
          baseURL: input.baseURL,
          credential: input.apiKey
            ? ('replace' as const)
            : connection?.hasCredential
              ? ('keep' as const)
              : ('none' as const),
        };
        let names = input.modelName ? [input.modelName] : undefined;
        if (!names) {
          try {
            const discovered = await client.discoverProviderSettings(
              {
                expectedStoreId: storeId,
                expectedReadSet: state.readSet,
                operation,
                ...(input.apiKey ? { secret: input.apiKey } : {}),
              },
              { signal },
            );
            if (signal?.aborted) return { status: 'cancelled' };
            names = discovered.modelNames;
          } catch (error) {
            if (signal?.aborted) return { status: 'cancelled' };
            return {
              status: 'failed',
              code: error instanceof ClientError ? error.code : 'provider_discovery_unavailable',
            };
          }
        }
        if (signal?.aborted) return { status: 'cancelled' };
        onPhase?.('publishing');
        const result = await publish(
          workspaceId,
          'provider',
          (commandId) =>
            postProvider(
              {
                expectedStoreId: storeId,
                commandId,
                expectedReadSet: state.readSet!,
                operation: { ...operation, modelNames: names },
                ...(input.apiKey ? { secret: input.apiKey } : {}),
              },
              { signal },
            ),
          signal,
        );
        return result ?? finish(workspaceId, signal);
      });
    },
    async recover(workspaceId, signal) {
      if (!pending) return ready(workspaceId, signal);
      if (pending.workspaceId !== workspaceId) return { status: 'unknown' };
      const result = await confirm(signal);
      return result ?? { status: 'unknown', canContinue: true };
    },
    async resume(workspaceId, signal) {
      return exclusive(async () => {
        if (!pending || pending.workspaceId !== workspaceId || !pending.applied)
          return { status: 'unknown' };
        return finish(workspaceId, signal);
      });
    },
  };
}
