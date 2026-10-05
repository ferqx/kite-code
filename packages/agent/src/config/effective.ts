import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import {
  assertJson,
  assertNoCredentialBody,
  ConfigurationError,
  type ConfigurationSnapshot,
  type EffectiveConfiguration,
  type Json,
  type JsonObject,
  type ModelConfiguration,
  type NamedConfiguration,
  object,
} from './types';

const namedKeys = ['models', 'tools', 'skills', 'mcp'] as const;
function named(value: Json): NamedConfiguration[] {
  if (!Array.isArray(value)) throw new ConfigurationError('invalid_configuration');
  const ids = new Set<string>();
  return value.map((entry) => {
    const item = object(entry);
    if (
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item.id) ||
      ids.has(item.id) ||
      (item.enabled !== undefined && typeof item.enabled !== 'boolean') ||
      (item.remove !== undefined && typeof item.remove !== 'boolean')
    )
      throw new ConfigurationError('invalid_configuration');
    ids.add(item.id);
    return item as NamedConfiguration;
  });
}
/** Only these four arrays merge by id. Every other top-level value is replaced. */
export function resolveConfiguration(layers: {
  defaults: JsonObject;
  user?: JsonObject;
  workspace?: JsonObject;
  explicit?: JsonObject;
}): EffectiveConfiguration {
  let result: JsonObject = {};
  for (const layer of [layers.defaults, layers.user, layers.workspace, layers.explicit]) {
    if (!layer) continue;
    object(layer);
    const next: JsonObject = { ...result, ...structuredClone(layer) };
    for (const key of namedKeys)
      if (Object.hasOwn(layer, key)) {
        const incoming = named(layer[key]!);
        const merged = new Map(named(result[key] ?? []).map((item) => [item.id, item]));
        for (const item of incoming) {
          if (item.remove === true) merged.delete(item.id);
          else {
            const nextItem = { ...merged.get(item.id), ...item };
            delete nextItem.remove;
            merged.set(item.id, nextItem);
          }
        }
        next[key] = [...merged.values()];
      }
    result = next;
  }
  if (result.modelId !== undefined && result.modelId !== null && typeof result.modelId !== 'string')
    throw new ConfigurationError('invalid_configuration');
  return result as EffectiveConfiguration;
}
function endpoint(value: Json | undefined) {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new ConfigurationError('invalid_configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('invalid_configuration');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ConfigurationError('credential_reference_required');
}
function reference(value: Json | undefined) {
  if (
    value !== undefined &&
    (typeof value !== 'string' || !/^credential:[0-9a-f-]{36}$/.test(value))
  )
    throw new ConfigurationError('credential_reference_required');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}
/** Projection is the host's supported assembly contract; unknown fields remain in the file. */
export function createConfigurationSnapshot(
  effective: EffectiveConfiguration,
): ConfigurationSnapshot {
  object(effective);
  if (
    effective.modelId !== undefined &&
    effective.modelId !== null &&
    typeof effective.modelId !== 'string'
  )
    throw new ConfigurationError('invalid_configuration');
  const configuration: EffectiveConfiguration = {};
  if (effective.modelId !== undefined) configuration.modelId = effective.modelId;
  const fields: Record<(typeof namedKeys)[number], readonly string[]> = {
    models: ['id', 'enabled', 'provider', 'model', 'baseURL', 'credentialRef', 'options'],
    tools: ['id', 'enabled', 'definitionVersion', 'options'],
    skills: ['id', 'enabled', 'path', 'digest', 'options'],
    mcp: ['id', 'enabled', 'transport', 'url', 'command', 'args', 'credentialRef', 'options'],
  };
  for (const key of namedKeys)
    if (effective[key] !== undefined) {
      const items = named(effective[key]!).map((item) => {
        const projected: JsonObject = {};
        for (const field of fields[key])
          if (item[field] !== undefined) projected[field] = structuredClone(item[field]!);
        assertNoCredentialBody(projected);
        reference(projected.credentialRef);
        endpoint(projected.baseURL);
        endpoint(projected.url);
        if (projected.options !== undefined) object(projected.options);
        if (
          key === 'models' &&
          (typeof projected.provider !== 'string' || typeof projected.model !== 'string')
        )
          throw new ConfigurationError('invalid_configuration');
        return projected as NamedConfiguration;
      });
      if (key === 'models') configuration.models = items as ModelConfiguration[];
      else configuration[key] = items;
    }
  assertJson(configuration);
  return freeze({
    version: 1 as const,
    digest: createHash('sha256').update(canonicalJson(configuration)).digest('hex'),
    configuration,
  });
}
