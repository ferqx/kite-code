import {
  ClientError,
  canonicalConfigurationRequest,
  canonicalModelBody,
  type ModelSettingsRequest,
  type ProviderSettingsRequest,
} from '@kite-ai/client';
import type { NativeModelSettingsSubmission, NativeProviderSubmission } from '../src/native-bridge';

export type NativeConfigurationRecord =
  | { kind: 'model'; input: ModelSettingsRequest; state: NativeModelSettingsSubmission }
  | {
      kind: 'provider';
      input: Omit<ProviderSettingsRequest, 'secret'>;
      state: NativeProviderSubmission;
    };
export interface NativeConfigurationData {
  configurations(): NativeConfigurationRecord[];
  saveConfiguration(record: NativeConfigurationRecord): void;
  modelRoute(storeId: string, sessionId: string): string | undefined;
  rememberModelRoute(storeId: string, sessionId: string, modelId: string): void;
}
const fail = (): never => {
  throw new ClientError('configuration_storage_unavailable');
};
/** A cold row contains no secret and permits only an original GET, never a saved POST. */
export function parseConfigurationRecord(value: unknown): NativeConfigurationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as NativeConfigurationRecord;
  if (
    Object.keys(row).sort().join(',') !== 'input,kind,state' ||
    !['model', 'provider'].includes(row.kind)
  )
    fail();
  canonicalConfigurationRequest(row.kind, row.input);
  if ('secret' in row.input) fail();
  const state = row.state;
  const allowed = [
    'kind',
    'commandId',
    'storeId',
    'observationId',
    'operation',
    'phase',
    'error',
    ...(row.kind === 'provider'
      ? ['credentialState', 'configurationState']
      : ['scope', 'workspaceId']),
  ];
  if (
    !state ||
    Object.keys(state).some((key) => !allowed.includes(key)) ||
    state.kind !==
      (row.kind === 'provider' ? 'settings.providers.submission' : 'settings.models.submission') ||
    state.commandId !== row.input.commandId ||
    state.storeId !== row.input.expectedStoreId ||
    !Number.isSafeInteger(state.observationId) ||
    state.observationId < 1 ||
    !['submitting', 'unknown', 'applied', 'failed'].includes(state.phase) ||
    canonicalModelBody(state.operation) !== canonicalModelBody(row.input.operation) ||
    (state.error !== undefined && !/^[a-z][a-z0-9_]{0,80}$/.test(state.error))
  )
    fail();
  if (row.kind === 'model') {
    const model = row.state;
    if (
      row.input.operation.kind === 'effort' ||
      !['user', 'workspace'].includes(model.scope) ||
      model.workspaceId !== row.input.workspaceId ||
      (model.scope === 'workspace') !== (row.input.expectedReadSet.workspaceEtag !== null)
    )
      fail();
  } else {
    if (
      row.input.expectedReadSet.workspaceEtag !== null ||
      (row.state.credentialState !== undefined &&
        !['unchanged', 'stored', 'outcome_unknown'].includes(row.state.credentialState)) ||
      (row.state.configurationState !== undefined &&
        !['not_attempted', 'published', 'outcome_unknown'].includes(row.state.configurationState))
    )
      fail();
    try {
      const url = new URL(row.input.operation.baseURL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        fail();
    } catch {
      fail();
    }
  }
  return structuredClone(row);
}
