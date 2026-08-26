import type {
  KiteAppControlClient,
  KiteWorkspaceIdentity,
  ProviderModelSnapshot,
} from '@kite-ai/kite-app-contract';
import {
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  type NativeProviderCredentialClient,
  type NativeProviderCredentialRequest,
  type NativeProviderCredentialResult,
} from '@kite-ai/kite-local-runtime/client';
import type { ConnectionError, ConnectProviderResult, ProviderDefinition } from './types';

export interface FirstRunProviderClients {
  readonly credentialClient: NativeProviderCredentialClient;
  readonly appControl: KiteAppControlClient;
  readonly workspace: KiteWorkspaceIdentity;
}

type ConfirmedProviderState =
  | { readonly status: 'connected'; readonly modelName: string }
  | { readonly status: 'model-required'; readonly message: string };

function mutationId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `first-run-${Date.now()}`;
  }
}

function providerRequest(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL: string,
  modelName?: string,
): NativeProviderCredentialRequest {
  const request = {
    schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
    mutationId: mutationId(),
    operation: 'write_provider_api_key' as const,
    providerId: provider.type,
    apiKey,
    ...(baseURL.trim() && baseURL.trim() !== provider.defaultBaseURL
      ? { baseURL: baseURL.trim() }
      : {}),
    ...(modelName?.trim() ? { modelName: modelName.trim() } : {}),
  };
  return request;
}

function credentialError(code: string | undefined): ConnectionError {
  switch (code) {
    case 'credential_unavailable':
      return {
        kind: 'auth',
        message: 'The provider rejected the credential.',
        details: 'The API key was rejected.',
      };
    case 'not_found':
      return {
        kind: 'incompatible',
        message: 'The endpoint does not provide a model route.',
      };
    case 'model_required':
      return {
        kind: 'incompatible',
        message: 'The endpoint did not return a model list.',
      };
    case 'provider_incompatible':
      return {
        kind: 'incompatible',
        message: 'The endpoint response is not compatible with model discovery.',
      };
    case 'invalid_request':
      return {
        kind: 'generic',
        message: 'The provider settings are invalid.',
      };
    default:
      return {
        kind: 'unreachable',
        message: 'The provider endpoint could not be reached.',
      };
  }
}

function unknownError(modelName?: string): ConnectionError {
  return {
    kind: 'outcome-unknown',
    message: 'The credential write outcome is unknown. Review provider state before continuing.',
    ...(modelName === undefined ? {} : { confirmedModelName: modelName }),
  };
}

function providerSummary(
  snapshot: ProviderModelSnapshot,
  provider: ProviderDefinition,
): ConfirmedProviderState {
  const summary = snapshot.providers.find((entry) => entry.provider === provider.type);
  if (!summary) {
    return { status: 'model-required', message: 'No model is configured for this provider.' };
  }

  const selected =
    snapshot.selected?.provider === provider.type ? snapshot.selected.name : summary.selectedModel;
  if (summary.readiness === 'ready' && selected) {
    return { status: 'connected', modelName: selected };
  }
  if (summary.readiness === 'unavailable') {
    return { status: 'model-required', message: 'The provider state is unavailable.' };
  }
  return { status: 'model-required', message: 'Enter the model name for this endpoint.' };
}

async function confirmProviderState(
  clients: FirstRunProviderClients,
  provider: ProviderDefinition,
): Promise<
  ConfirmedProviderState | { readonly status: 'failed'; readonly error: ConnectionError }
> {
  try {
    const snapshot = await clients.appControl.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace: clients.workspace,
    });
    return providerSummary(snapshot, provider);
  } catch {
    return {
      status: 'failed',
      error: {
        kind: 'generic',
        message: 'Could not confirm provider state through App Control.',
      },
    };
  }
}

async function writeAndConfirm(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL: string,
  clients: FirstRunProviderClients,
  signal: AbortSignal | undefined,
  modelName?: string,
): Promise<ConnectProviderResult> {
  const request = providerRequest(provider, apiKey, baseURL, modelName);
  let response: NativeProviderCredentialResult;
  try {
    response = await clients.credentialClient.writeProviderCredential(request, { signal });
  } catch {
    if (signal?.aborted) {
      return { status: 'failed', error: { kind: 'generic', message: 'Cancelled' } };
    }
    // A rejected Native call may mean that the mutation was accepted but its
    // response was lost. Query the authoritative App Control state and leave
    // continuation to an explicit user action; never replay the write here.
    const confirmed = await confirmProviderState(clients, provider);
    if (confirmed.status === 'connected') {
      return {
        status: 'outcome-unknown',
        modelName: confirmed.modelName,
        message: 'State queried.',
      };
    }
    return { status: 'failed', error: unknownError() };
  }
  if (signal?.aborted) {
    return { status: 'failed', error: { kind: 'generic', message: 'Cancelled' } };
  }

  if (response.outcome === 'outcome_unknown') {
    const confirmed = await confirmProviderState(clients, provider);
    if (confirmed.status === 'failed') return { status: 'failed', error: unknownError() };
    if (confirmed.status === 'connected') {
      return {
        status: 'outcome-unknown',
        modelName: confirmed.modelName,
        message: 'State queried.',
      };
    }
    return { status: 'failed', error: unknownError() };
  }
  if (response.outcome !== 'applied') {
    if (response.errorCode === 'model_required') {
      return {
        status: 'model-required',
        message: 'No models were detected at this endpoint.',
      };
    }
    return { status: 'failed', error: credentialError(response.errorCode) };
  }

  const confirmed = await confirmProviderState(clients, provider);
  if (confirmed.status === 'failed') return confirmed;
  if (confirmed.status === 'connected') {
    return { status: 'connected', modelName: confirmed.modelName };
  }
  // The legacy config resolver treats an empty key as not configured even for
  // an optional custom endpoint. Preserve that first-run journey: let the user
  // explicitly edit the key instead of presenting a misleading model prompt.
  if (provider.apiKey === 'optional' && !apiKey.trim()) {
    return {
      status: 'failed',
      error: { kind: 'generic', message: 'The API key was rejected.' },
    };
  }
  return { status: 'model-required', message: confirmed.message };
}

export async function connectProvider(input: {
  provider: ProviderDefinition;
  clients: FirstRunProviderClients;
  signal?: AbortSignal;
}): Promise<ConnectProviderResult> {
  return writeAndConfirm(
    input.provider,
    '',
    input.provider.defaultBaseURL,
    input.clients,
    input.signal,
  );
}

export async function connectProviderWithKey(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL: string,
  clients: FirstRunProviderClients,
  signal?: AbortSignal,
): Promise<ConnectProviderResult> {
  return writeAndConfirm(provider, apiKey, baseURL, clients, signal);
}

export async function saveManualProviderModel(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL: string,
  modelName: string,
  clients: FirstRunProviderClients,
  signal?: AbortSignal,
): Promise<ConnectProviderResult> {
  return writeAndConfirm(provider, apiKey, baseURL, clients, signal, modelName);
}
