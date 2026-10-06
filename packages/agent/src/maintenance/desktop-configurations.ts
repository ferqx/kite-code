import type { Database } from 'bun:sqlite';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { MaintenanceError } from './types';

const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const modelId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const oneOf = (value: unknown, choices: readonly string[]) =>
  typeof value === 'string' && choices.includes(value);
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw Error();
  return row;
}
function validate(raw: unknown, commandId: string): void {
  const row = object(raw, ['kind', 'input', 'state']);
  if (row.kind !== 'model' && row.kind !== 'provider') throw Error();
  const provider = row.kind === 'provider';
  const input = object(
    row.input,
    ['expectedStoreId', 'commandId', 'expectedReadSet', 'operation'],
    provider ? [] : ['workspaceId'],
  );
  if (
    !id(input.expectedStoreId) ||
    !id(input.commandId) ||
    input.commandId !== commandId ||
    (input.workspaceId !== undefined && !id(input.workspaceId))
  )
    throw Error();
  const readSet = object(input.expectedReadSet, [
    'userEtag',
    'workspaceEtag',
    'explicitDigest',
    'effectiveDigest',
  ]);
  if (
    ![readSet.userEtag, readSet.explicitDigest, readSet.effectiveDigest].every(hash) ||
    (readSet.workspaceEtag !== null && !hash(readSet.workspaceEtag))
  )
    throw Error();
  const operation = provider
    ? object(input.operation, ['provider', 'connectionId', 'baseURL', 'modelNames', 'credential'])
    : object(input.operation, ['kind', 'modelId'], ['enabled']);
  if (provider) {
    if (
      !oneOf(operation.provider, ['openai', 'deepseek', 'compatible', 'ollama']) ||
      (operation.connectionId !== null && !hash(operation.connectionId)) ||
      typeof operation.baseURL !== 'string' ||
      operation.baseURL.length > 4096 ||
      !Array.isArray(operation.modelNames) ||
      operation.modelNames.some(
        (name) => typeof name !== 'string' || name.length < 1 || name.length > 256,
      ) ||
      !oneOf(operation.credential, ['keep', 'replace', 'none']) ||
      readSet.workspaceEtag !== null
    )
      throw Error();
    const url = new URL(operation.baseURL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
  } else if (
    !modelId(operation.modelId) ||
    (operation.kind === 'enabled'
      ? typeof operation.enabled !== 'boolean'
      : operation.kind !== 'default' || Object.hasOwn(operation, 'enabled'))
  )
    throw Error();
  const state = object(
    row.state,
    [
      'kind',
      'commandId',
      'storeId',
      'observationId',
      'operation',
      'phase',
      ...(provider ? [] : ['scope']),
    ],
    ['error', ...(provider ? ['credentialState', 'configurationState'] : ['workspaceId'])],
  );
  if (
    state.kind !== (provider ? 'settings.providers.submission' : 'settings.models.submission') ||
    state.commandId !== input.commandId ||
    state.storeId !== input.expectedStoreId ||
    !Number.isSafeInteger(state.observationId) ||
    Number(state.observationId) < 1 ||
    !oneOf(state.phase, ['submitting', 'unknown']) ||
    canonicalJson(state.operation as Json) !== canonicalJson(input.operation as Json) ||
    (state.error !== undefined &&
      (typeof state.error !== 'string' || !/^[a-z][a-z0-9_]{0,80}$/.test(state.error)))
  )
    throw Error();
  if (provider) {
    if (
      (state.credentialState !== undefined &&
        !oneOf(state.credentialState, ['unchanged', 'stored', 'outcome_unknown'])) ||
      (state.configurationState !== undefined &&
        !oneOf(state.configurationState, ['not_attempted', 'published', 'outcome_unknown']))
    )
      throw Error();
  } else if (
    !oneOf(state.scope, ['user', 'workspace']) ||
    state.workspaceId !== input.workspaceId ||
    (state.scope === 'workspace') !== (readSet.workspaceEtag !== null) ||
    (state.scope === 'workspace') !== (input.workspaceId !== undefined)
  )
    throw Error();
}
/** DB6 contains only non-secret original GET metadata and per-Session preferences, never POST authority. */
export function verifyDesktopConfigurationRows(db: Database): void {
  let count = 0,
    bytes = 0;
  try {
    for (const row of db
      .query<{ command_id: string; state: string; state_hex: string }, []>(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM configuration_intents ORDER BY command_id',
      )
      .iterate()) {
      if (
        typeof row.state !== 'string' ||
        Buffer.from(row.state).toString('hex').toUpperCase() !== row.state_hex ||
        ++count > 128
      )
        throw Error();
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16777216) throw Error();
      validate(JSON.parse(row.state), row.command_id);
    }
    for (const row of db
      .query<{ store_id: string; session_id: string; model_id: string }, []>(
        'SELECT store_id,session_id,model_id FROM model_routes ORDER BY store_id,session_id',
      )
      .iterate())
      if (!id(row.store_id) || !id(row.session_id) || !modelId(row.model_id)) throw Error();
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
