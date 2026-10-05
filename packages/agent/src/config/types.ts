import type { Json } from '../storage/types';

export type { Json } from '../storage/types';
export interface JsonObject {
  [key: string]: Json;
}
export class ConfigurationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export type NamedConfiguration = JsonObject & { id: string; enabled?: boolean };
export type ModelConfiguration = NamedConfiguration & {
  provider: string;
  model: string;
  baseURL?: string;
  credentialRef?: string;
  options?: JsonObject;
};
export type EffectiveConfiguration = JsonObject & {
  modelId?: string | null;
  models?: ModelConfiguration[];
  tools?: NamedConfiguration[];
  skills?: NamedConfiguration[];
  mcp?: NamedConfiguration[];
};
export interface ConfigurationSnapshot {
  readonly version: 1;
  readonly digest: string;
  readonly configuration: Readonly<EffectiveConfiguration>;
}
const secretKey =
  /^(api[-_]?key|private[-_]?key|client[-_]?secret|bearer[-_]?token|id[-_]?token|token|access[-_]?token|refresh[-_]?token|password|secret|authorization|credentials|headers|env)$/i;
export function assertJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 32) throw new ConfigurationError('configuration_limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) assertJson(entry, depth + 1);
    return;
  }
  if (
    typeof value === 'object' &&
    value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    if (Object.keys(value).length > 4096) throw new ConfigurationError('configuration_limit');
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new ConfigurationError('invalid_configuration');
      assertJson(entry, depth + 1);
    }
    return;
  }
  throw new ConfigurationError('invalid_configuration');
}
export function assertNoCredentialBody(value: Json): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCredentialBody(entry);
  } else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      if (secretKey.test(key)) throw new ConfigurationError('credential_reference_required');
      assertNoCredentialBody(entry);
    }
}
export function object(value: unknown): JsonObject {
  assertJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('invalid_configuration');
  return value;
}
