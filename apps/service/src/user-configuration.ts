import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  type ConfigurationDocument,
  type ConfigurationEdit,
  ConfigurationError,
  type JsonObject,
  readConfigurationFile,
  updateConfigurationFile,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { providerConnectionId } from './model-providers';
import { userConfigurationPath } from './user-configuration-path';

const object = (value: Json | undefined): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('invalid_user_configuration');
  return value;
};
const routeId = (provider: string, name: string) =>
  `model-${createHash('sha256')
    .update(JSON.stringify([provider, name]))
    .digest('hex')
    .slice(0, 40)}`;
const secretReference = (provider: string, secret: string) => {
  const hash = createHash('sha256')
    .update(JSON.stringify(['user-config-key-v1', provider, secret]))
    .digest('hex');
  return `credential:${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};
const nameOf = (entry: Json) => (typeof entry === 'string' ? entry : object(entry).name);
const assemblyForm = (raw: JsonObject) =>
  raw.provider === undefined && (raw.models !== undefined || raw.modelId !== undefined);
function route(value: Json | undefined): { provider: string; name: string } | undefined {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    const separator = value.indexOf(':');
    if (separator > 0 && value.slice(separator + 1).trim())
      return {
        provider: value.slice(0, separator).trim(),
        name: value.slice(separator + 1).trim(),
      };
  } else {
    const entry = object(value);
    if (entry.default !== undefined) return route(entry.default);
    if (typeof entry.provider === 'string' && typeof entry.name === 'string')
      return { provider: entry.provider, name: entry.name };
  }
  throw new ConfigurationError('invalid_user_model_selection');
}
/** One user document. Raw keys stay private; callers receive the neutral assembly shape. */
export function createUserConfiguration(path = userConfigurationPath(homedir())) {
  const readRaw = () => readConfigurationFile({ path, windowsPathPolicy: 'private' });
  function connection(alias: string, provider: JsonObject): JsonObject {
    const family =
      provider.type === 'openai-compatible' ||
      (provider.type === undefined && !['openai', 'deepseek', 'ollama'].includes(alias))
        ? 'compatible'
        : (provider.type ?? alias);
    const endpoint =
      provider.baseURL ??
      (
        {
          openai: 'https://api.openai.com/v1',
          deepseek: 'https://api.deepseek.com/v1',
          ollama: 'http://localhost:11434/v1',
        } as Record<string, string>
      )[String(family)];
    return {
      provider: family,
      providerName: alias,
      ...(typeof provider.name === 'string' ? { providerLabel: provider.name } : {}),
      ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
      ...(endpoint === undefined ? {} : { baseURL: endpoint }),
      ...(typeof provider.credentialRef === 'string'
        ? { credentialRef: provider.credentialRef }
        : typeof provider.apiKey === 'string' && provider.apiKey
          ? { credentialRef: secretReference(alias, provider.apiKey) }
          : {}),
    };
  }
  function readProviderConnections(): JsonObject[] {
    const raw = readRaw().value;
    if (assemblyForm(raw)) return [];
    const providers = raw.provider === undefined ? {} : object(raw.provider);
    return Object.entries(providers).map(([alias, value]) =>
      connection(
        alias,
        value && typeof value === 'object' && !Array.isArray(value)
          ? value
          : { type: 'unsupported' },
      ),
    );
  }
  function normalize(raw: JsonObject): JsonObject {
    // The assembly form remains valid in this same file for explicitly configured hosts.
    if (assemblyForm(raw)) return { ...structuredClone(raw), _providerConnections: [] };
    const providers = raw.provider === undefined ? {} : object(raw.provider);
    const disabled = raw.disabledModels ?? [];
    if (!Array.isArray(disabled)) throw new ConfigurationError('invalid_user_configuration');
    const overrides = raw.modelOptions === undefined ? {} : object(raw.modelOptions);
    const models: JsonObject[] = [];
    const connections: JsonObject[] = [];
    let preferred: string | undefined;
    for (const [alias, value] of Object.entries(providers)) {
      const provider = object(value);
      const metadataConnection = connection(alias, provider);
      connections.push(metadataConnection);
      const entries =
        provider.models ?? (typeof provider.model === 'string' ? [provider.model] : []);
      if (!Array.isArray(entries)) throw new ConfigurationError('invalid_user_configuration');
      const names = new Set<string>();
      const kwargs = provider.modelKwargs === undefined ? {} : object(provider.modelKwargs);
      for (const entry of entries) {
        const name = nameOf(entry);
        if (typeof name !== 'string' || !name.trim() || names.has(name))
          throw new ConfigurationError('invalid_user_model');
        names.add(name);
        const id = routeId(alias, name);
        const metadata = typeof entry === 'string' ? {} : object(entry);
        const enabled = !disabled.some((item) => {
          const selected = route(item);
          return selected?.provider === alias && selected.name === name;
        });
        const options: JsonObject = {
          ...(typeof provider.effort === 'string' ? { reasoningEffort: provider.effort } : {}),
          ...(typeof metadata.maxOutputTokens === 'number'
            ? { maxOutputTokens: metadata.maxOutputTokens }
            : {}),
          ...(kwargs.maxTokens === undefined ? {} : { maxOutputTokens: kwargs.maxTokens }),
          ...Object.fromEntries(
            ['temperature', 'topP', 'maxOutputTokens'].flatMap((key) =>
              kwargs[key] === undefined ? [] : [[key, kwargs[key]!]],
            ),
          ),
          ...(overrides[id] === undefined ? {} : object(overrides[id])),
        };
        models.push({
          id,
          ...metadataConnection,
          model: name,
          enabled,
          ...(typeof metadata.contextWindowTokens === 'number' ||
          typeof metadata.maxOutputTokens === 'number'
            ? {
                modelCapabilities: {
                  ...(typeof metadata.contextWindowTokens === 'number'
                    ? { contextWindowTokens: metadata.contextWindowTokens }
                    : {}),
                  ...(typeof metadata.maxOutputTokens === 'number'
                    ? { maxOutputTokens: metadata.maxOutputTokens }
                    : {}),
                },
              }
            : {}),
          ...(Object.keys(options).length ? { options } : {}),
        });
        if (enabled && (provider.model === name || metadata.default === true)) preferred ??= id;
      }
    }
    const selection = route(raw.model);
    const result = structuredClone(raw);
    for (const key of ['provider', 'model', 'disabledModels', 'modelOptions']) delete result[key];
    return {
      ...result,
      models,
      _providerConnections: connections,
      modelId: selection
        ? routeId(selection.provider, selection.name)
        : (preferred ?? models.find((model) => model.enabled)?.id ?? null),
    };
  }
  const read = (): ConfigurationDocument => {
    const document = readRaw();
    return { ...document, value: normalize(document.value) };
  };
  function createModels(
    provider: string,
    names: readonly string[],
    related: readonly JsonObject[],
  ) {
    if (!names.length) return [];
    const raw = readRaw().value;
    if (assemblyForm(raw))
      return names.map((model) => ({ id: `model-${crypto.randomUUID()}`, model }));
    const providers = raw.provider === undefined ? {} : object(raw.provider);
    let alias = related.find((model) => typeof model.providerName === 'string')?.providerName as
      | string
      | undefined;
    if (!alias) {
      // Never recycle a deleted route namespace: saved sessions must not rebind to a new account.
      do {
        alias = `${provider}-${crypto.randomUUID()}`;
      } while (Object.hasOwn(providers, alias));
    }
    return names.map((model) => ({ id: routeId(alias, model), providerName: alias, model }));
  }
  function adaptEdits(
    raw: JsonObject,
    operations: readonly ConfigurationEdit[],
    removeProviderConnection?: string,
  ) {
    const createsAssemblyModels =
      raw.provider === undefined &&
      operations.some(
        (edit) =>
          edit.kind === 'set' &&
          edit.path.length === 1 &&
          edit.path[0] === 'models' &&
          Array.isArray(edit.value) &&
          edit.value.every((model) => object(model).providerName === undefined),
      );
    if (assemblyForm(raw) || createsAssemblyModels) return operations;
    const original = normalize(raw);
    const removedAlias =
      removeProviderConnection === undefined
        ? undefined
        : (original._providerConnections as JsonObject[]).find(
            (entry) => providerConnectionId(entry) === removeProviderConnection,
          )?.providerName;
    if (removeProviderConnection !== undefined && typeof removedAlias !== 'string')
      throw new ConfigurationError('provider_settings_override');
    const desired = structuredClone(original);
    for (const edit of operations) {
      let parent: JsonObject | Json[] = desired;
      for (let i = 0; i < edit.path.length - 1; i++) {
        const key = edit.path[i]!;
        const target = parent as Record<string | number, Json>;
        target[key] ??= typeof edit.path[i + 1] === 'number' ? [] : {};
        parent = target[key] as JsonObject | Json[];
      }
      const key = edit.path.at(-1)!;
      if (edit.kind === 'remove') {
        if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
        else delete (parent as Record<string | number, Json>)[key];
      } else (parent as Record<string | number, Json>)[key] = structuredClone(edit.value);
    }
    const edits: ConfigurationEdit[] = operations.filter(
      (edit) => !['models', 'modelId'].includes(String(edit.path[0])),
    );
    if (operations.some((edit) => edit.path[0] === 'models' || edit.path[0] === 'modelId')) {
      const models = (desired.models ?? []) as JsonObject[];
      const providers = raw.provider === undefined ? {} : object(raw.provider);
      const disabled = ((raw.disabledModels ?? []) as Json[]).filter((item) => {
        const selected = route(item);
        if (selected?.provider === removedAlias) return false;
        const model = models.find(
          (entry) => entry.providerName === selected?.provider && entry.model === selected?.name,
        );
        return !model || model.enabled === false;
      });
      const modelOptions: JsonObject =
        raw.modelOptions === undefined ? {} : structuredClone(object(raw.modelOptions));
      for (const removed of (original.models as JsonObject[]).filter(
        (model) => model.providerName === removedAlias,
      ))
        delete modelOptions[String(removed.id)];
      const grouped = new Map<string, JsonObject[]>();
      for (const model of models) {
        if (typeof model.providerName !== 'string')
          throw new ConfigurationError('user_model_route_missing');
        const entries = grouped.get(model.providerName) ?? [];
        entries.push(model);
        grouped.set(model.providerName, entries);
        if (
          model.enabled === false &&
          !disabled.some((item) => {
            const selected = route(item);
            return selected?.provider === model.providerName && selected?.name === model.model;
          })
        )
          disabled.push({ provider: model.providerName, name: model.model! });
        const before = (original.models as JsonObject[]).find((entry) => entry.id === model.id);
        if (JSON.stringify(before?.options) !== JSON.stringify(model.options)) {
          if (model.options === undefined) delete modelOptions[String(model.id)];
          else modelOptions[String(model.id)] = model.options;
        }
      }
      for (const [alias, entries] of grouped) {
        const originalModels = (original.models as JsonObject[]).filter(
          (item) => item.providerName === alias,
        );
        if (JSON.stringify(entries) === JSON.stringify(originalModels)) continue;
        const model = entries[0]!;
        if (
          entries.some((item) =>
            ['provider', 'protocol', 'baseURL', 'credentialRef', 'providerLabel'].some(
              (key) => item[key] !== model[key],
            ),
          )
        )
          throw new ConfigurationError('user_model_connection_conflict');
        const rawProvider = providers[alias] === undefined ? {} : object(providers[alias]);
        const originalModel =
          (original.models as JsonObject[]).find((item) => item.providerName === alias) ??
          (original._providerConnections as JsonObject[]).find(
            (item) => item.providerName === alias,
          );
        const originalEntries = Array.isArray(rawProvider.models)
          ? rawProvider.models
          : typeof rawProvider.model === 'string'
            ? [rawProvider.model]
            : [];
        const names = entries.map(
          (item) => originalEntries.find((entry) => nameOf(entry) === item.model) ?? item.model!,
        );
        if (JSON.stringify(originalEntries) !== JSON.stringify(names))
          edits.push({ kind: 'set', path: ['provider', alias, 'models'], value: names });
        if (!originalModel || originalModel.provider !== model.provider)
          edits.push({
            kind: 'set',
            path: ['provider', alias, 'type'],
            value: model.provider === 'compatible' ? 'openai-compatible' : model.provider!,
          });
        if (originalModel?.providerLabel !== model.providerLabel)
          edits.push(
            model.providerLabel === undefined
              ? { kind: 'remove', path: ['provider', alias, 'name'] }
              : { kind: 'set', path: ['provider', alias, 'name'], value: model.providerLabel },
          );
        if (originalModel?.protocol !== model.protocol)
          edits.push(
            model.protocol === undefined
              ? { kind: 'remove', path: ['provider', alias, 'protocol'] }
              : { kind: 'set', path: ['provider', alias, 'protocol'], value: model.protocol },
          );
        if (!originalModel || originalModel.baseURL !== model.baseURL)
          edits.push({ kind: 'set', path: ['provider', alias, 'baseURL'], value: model.baseURL! });
        if (!originalModel || originalModel.credentialRef !== model.credentialRef) {
          edits.push(
            model.credentialRef === undefined
              ? { kind: 'remove', path: ['provider', alias, 'credentialRef'] }
              : {
                  kind: 'set',
                  path: ['provider', alias, 'credentialRef'],
                  value: model.credentialRef,
                },
          );
          if (rawProvider.apiKey !== undefined)
            edits.push({ kind: 'remove', path: ['provider', alias, 'apiKey'] });
        }
      }
      for (const alias of Object.keys(providers)) {
        if (alias === removedAlias) {
          edits.push({ kind: 'remove', path: ['provider', alias] });
          continue;
        }
        if (
          !grouped.has(alias) &&
          (original.models as JsonObject[]).some((model) => model.providerName === alias)
        )
          edits.push({ kind: 'set', path: ['provider', alias, 'models'], value: [] });
      }
      const selected = models.find((model) => model.id === desired.modelId);
      if (desired.modelId && !selected) throw new ConfigurationError('user_model_route_missing');
      if (selected && desired.modelId !== original.modelId) {
        const selection = raw.model;
        const nested =
          selection &&
          typeof selection === 'object' &&
          !Array.isArray(selection) &&
          selection.default !== undefined;
        const previous = nested ? selection.default : selection;
        edits.push({
          kind: 'set',
          path: nested ? ['model', 'default'] : ['model'],
          value:
            previous && typeof previous === 'object'
              ? { provider: selected.providerName!, name: selected.model! }
              : `${selected.providerName}:${selected.model}`,
        });
      } else if (!selected && raw.model !== undefined)
        edits.push({ kind: 'remove', path: ['model'] });
      if (JSON.stringify(raw.disabledModels ?? []) !== JSON.stringify(disabled))
        edits.push({ kind: 'set', path: ['disabledModels'], value: disabled });
      if (JSON.stringify(raw.modelOptions ?? {}) !== JSON.stringify(modelOptions))
        edits.push({ kind: 'set', path: ['modelOptions'], value: modelOptions });
    }
    return edits;
  }
  function update(
    options: Omit<Parameters<typeof updateConfigurationFile>[0], 'path' | 'adaptEdits'> & {
      path?: string;
      removeProviderConnection?: string;
    },
  ) {
    const result = updateConfigurationFile({
      ...options,
      path,
      windowsPathPolicy: 'private',
      adaptEdits: (raw) => adaptEdits(raw, options.operations, options.removeProviderConnection),
      validateCandidate: (candidate) => options.validateCandidate?.(normalize(candidate)),
    });
    return { ...result, value: normalize(result.value) };
  }
  function resolveCredential(reference: string): string | undefined {
    const raw = readRaw().value;
    if (raw.provider === undefined) return;
    for (const [alias, value] of Object.entries(object(raw.provider))) {
      const provider = object(value);
      if (
        typeof provider.apiKey === 'string' &&
        provider.apiKey &&
        secretReference(alias, provider.apiKey) === reference
      )
        return provider.apiKey;
    }
    return undefined;
  }
  return {
    path,
    read,
    normalize,
    update,
    createModels,
    resolveCredential,
    readProviderConnections,
  };
}
export type UserConfiguration = ReturnType<typeof createUserConfiguration>;

/** Projects can select tools and extensions; model routes belong to the user document. */
export function withoutProjectModels(value: JsonObject): JsonObject {
  const result = { ...value };
  delete result.models;
  delete result.modelId;
  delete result.provider;
  delete result.model;
  return result;
}
