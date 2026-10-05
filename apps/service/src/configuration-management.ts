import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { createCredentialVault } from '@kite-ai/agent/config';
import {
  type ConfigurationEdit,
  ConfigurationError,
  createConfigurationSnapshot,
  inspectConfigurationFile,
  type JsonObject,
  readConfigurationFile,
  repairConfigurationFile,
  resolveConfiguration,
  updateConfigurationFile,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { type ReasoningEffort, reasoningEfforts } from '@kite-ai/ai';
import { parseModelPreset } from './configuration';

export type ConfigurationScope = 'user' | 'workspace';
export interface ConfigurationLocation {
  scope: ConfigurationScope;
  workspaceId?: string;
}
export interface ManagementMutation {
  commandId: string;
  originStoreId: string;
  scope: ConfigurationScope;
  workspaceId?: string;
  ifMatch?: string;
  kind:
    | 'config.patch'
    | 'config.repair'
    | 'credential.put'
    | 'credential.revoke'
    | 'model_settings.update';
  modelSettings?: { expectedReadSet: ModelSettingsReadSet; operation: ModelSettingsOperation };
  state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
  receipt: Json;
}
export interface ConfigurationRead {
  storeId?: string;
  scope: ConfigurationScope;
  workspaceId?: string;
  etag: string;
  raw: Json | null;
  effective: Json | null;
  snapshot: Json | null;
  errors: string[];
}
export interface ModelSettingsReadSet {
  userEtag: string;
  workspaceEtag: string | null;
  explicitDigest: string;
  effectiveDigest: string;
}
export type ModelSettingsOperation =
  | { kind: 'enabled'; modelId: string; enabled: boolean }
  | { kind: 'default'; modelId: string }
  | { kind: 'effort'; modelId: string; reasoningEffort: ReasoningEffort | null };
export interface ModelSettingsView extends ConfigurationLocation {
  storeId: string;
  readSet: ModelSettingsReadSet | null;
  defaultModelId: string | null;
  models: {
    id: string;
    enabled: boolean;
    configured: boolean;
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    reasoningEffortChoices?: ReasoningEffort[];
    reasoningEffortSupport?: 'compatible_wire' | 'unsupported';
    reasoningEffortReadonlyReason?:
      | 'model_settings_override'
      | 'model_reasoning_effort_unsupported'
      | null;
    diagnostics: string[];
  }[];
  errors: string[];
}
interface MutationIdentity {
  commandId: string;
  expectedStoreId: string;
  subjectId: string;
}
export interface ConfigurationManagementPort {
  read(input: ConfigurationLocation & { expectedStoreId?: string }): Promise<ConfigurationRead>;
  readModels(
    input: ConfigurationLocation & { expectedStoreId: string },
  ): Promise<ModelSettingsView>;
  updateModels(
    input: ConfigurationLocation &
      MutationIdentity & {
        expectedReadSet: ModelSettingsReadSet;
        operation: ModelSettingsOperation;
      },
  ): Promise<ManagementMutation>;
  patch(
    input: ConfigurationLocation &
      MutationIdentity & { ifMatch: string; operations: readonly ConfigurationEdit[] },
  ): Promise<ManagementMutation>;
  repair(
    input: ConfigurationLocation & MutationIdentity & { ifMatch: string; value: JsonObject },
  ): Promise<ManagementMutation>;
  putCredential(input: MutationIdentity & { secret: string }): Promise<ManagementMutation>;
  revokeCredential(input: MutationIdentity & { opaqueRef: string }): Promise<ManagementMutation>;
  getMutation(input: MutationIdentity): Promise<ManagementMutation | null>;
}
function publicMutation(
  record: NonNullable<Awaited<ReturnType<AgentRuntime['getHostMutation']>>>,
): ManagementMutation {
  const request = record.safeRequest as JsonObject;
  const kind =
    request.modelSettings !== undefined
      ? 'model_settings.update'
      : record.kind === 'config.user.write' || record.kind === 'config.workspace.write'
        ? 'config.patch'
        : (record.kind as ManagementMutation['kind']);
  const scope = request.scope;
  if (scope !== 'user' && scope !== 'workspace') throw new AgentError('mutation_unavailable');
  const value = record.receipt as JsonObject;
  let receipt: Json = {};
  if (record.state === 'applied')
    receipt =
      kind.startsWith('config.') || kind === 'model_settings.update'
        ? { status: 'applied', etag: value.etag! }
        : { status: 'applied', opaqueRef: value.opaqueRef!, persistence: value.persistence! };
  else if (record.state !== 'pending') receipt = { status: record.state, code: value.code! };
  return {
    commandId: record.id,
    originStoreId: record.originStoreId,
    kind,
    scope,
    ...(scope === 'workspace' ? { workspaceId: record.scope } : {}),
    ...(typeof request.ifMatch === 'string' ? { ifMatch: request.ifMatch } : {}),
    ...(kind === 'model_settings.update'
      ? {
          modelSettings: structuredClone(request.modelSettings) as unknown as NonNullable<
            ManagementMutation['modelSettings']
          >,
        }
      : {}),
    state: record.state,
    receipt,
  };
}
/** Unknown data are preserved on disk but are never promoted to HTTP-visible execution inputs. */
function redacted(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'modelId')
      result[key] = typeof entry === 'string' || entry === null ? entry : '[invalid]';
    else if (['models', 'tools', 'skills', 'mcp'].includes(key) && Array.isArray(entry))
      result[key] = entry.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '[unsupported]';
        const projected: JsonObject = {};
        for (const [field, data] of Object.entries(item)) {
          if (field === 'credentialRef')
            projected[field] =
              typeof data === 'string' && /^credential:[0-9a-f-]{36}$/.test(data)
                ? data
                : '[redacted]';
          else if (
            [
              'id',
              'enabled',
              'remove',
              'provider',
              'model',
              'definitionVersion',
              'path',
              'digest',
              'transport',
            ].includes(field)
          )
            projected[field] = ['enabled', 'remove'].includes(field)
              ? typeof data === 'boolean'
                ? data
                : '[invalid]'
              : typeof data === 'string'
                ? data
                : '[invalid]';
          else if ((field === 'baseURL' || field === 'url') && typeof data === 'string') {
            try {
              const url = new URL(data);
              url.username = '';
              url.password = '';
              url.search = '';
              url.hash = '';
              projected[field] = url.href;
            } catch {
              projected[field] = '[invalid]';
            }
          } else if (
            field === 'options' &&
            data &&
            typeof data === 'object' &&
            !Array.isArray(data)
          )
            projected[field] = Object.fromEntries(
              Object.entries(data).map(([option, actual]) => [
                option,
                ['temperature', 'topP', 'maxOutputTokens'].includes(option) &&
                typeof actual === 'number'
                  ? actual
                  : option === 'reasoningEffort' &&
                      typeof actual === 'string' &&
                      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(actual)
                    ? actual
                    : '[unsupported]',
              ]),
            );
          else projected[field] = '[unsupported]';
        }
        return projected;
      });
    else result[key] = '[unsupported]';
  }
  return result;
}
function publicError(error: unknown): AgentError {
  return error instanceof AgentError
    ? error
    : new AgentError(
        error instanceof ConfigurationError ? error.code : 'configuration_unavailable',
      );
}
function stableKey(profile: ProfileSelection): Buffer {
  const path = join(profile.coordinationPath, 'host-mutation-key.jsonc');
  const initial = readConfigurationFile({ path, windowsPathPolicy: 'private' });
  if (!initial.exists) {
    try {
      updateConfigurationFile({
        path,
        windowsPathPolicy: 'private',
        ifMatch: initial.etag,
        operations: [{ kind: 'set', path: ['hmacKey'], value: randomBytes(32).toString('hex') }],
      });
    } catch (error) {
      if (
        !(error instanceof ConfigurationError) ||
        !['configuration_conflict', 'configuration_busy'].includes(error.code)
      )
        throw error;
    }
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new ConfigurationError('configuration_path_unsafe');
  const key = readConfigurationFile({ path, windowsPathPolicy: 'private' }).value.hmacKey;
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))
    throw new ConfigurationError('configuration_unavailable');
  return Buffer.from(key, 'hex');
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

/** Journal must be the current Store's durable finite audit API, never an in-memory cache. */
export function createConfigurationManagement(options: {
  profile: ProfileSelection;
  runtime?: AgentRuntime;
  vault: ReturnType<typeof createCredentialVault>;
  persistence: 'os' | 'temporary';
  explicit: () => JsonObject;
}): ConfigurationManagementPort {
  const userPath = join(options.profile.profilePath, 'config.jsonc');
  async function pathFor(input: ConfigurationLocation): Promise<string> {
    if (input.scope === 'user') {
      if (input.workspaceId !== undefined) throw new AgentError('invalid_configuration_scope');
      return userPath;
    }
    if (!input.workspaceId || !options.runtime) throw new AgentError('workspace_missing');
    const workspace = await options.runtime.getWorkspace(input.workspaceId);
    if (!workspace) throw new AgentError('workspace_missing');
    try {
      const uri = new URL(workspace.rootUri);
      if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
        throw new Error();
      return join(fileURLToPath(uri), 'kite-agent.jsonc');
    } catch {
      throw new AgentError('workspace_configuration_unavailable');
    }
  }
  function configured(model: JsonObject): string[] {
    try {
      if (model.provider !== 'compatible')
        throw new ConfigurationError('model_provider_unsupported');
      if (
        typeof model.model !== 'string' ||
        !model.model.trim() ||
        typeof model.baseURL !== 'string' ||
        !model.baseURL
      )
        throw new ConfigurationError('invalid_model_configuration');
      createConfigurationSnapshot(resolveConfiguration({ defaults: { models: [model] } }));
      parseModelPreset(model.options);
      return [];
    } catch (error) {
      return [publicError(error).code];
    }
  }
  function rawModels(input: ConfigurationLocation, path: string) {
    const user = readConfigurationFile({ path: userPath, windowsPathPolicy: 'private' });
    const project = input.scope === 'workspace' ? readConfigurationFile({ path }) : undefined;
    const explicit = structuredClone(options.explicit());
    const effective = resolveConfiguration({
      defaults: { modelId: null, models: [], tools: [], skills: [], mcp: [] },
      user: user.value,
      ...(project ? { workspace: project.value } : {}),
      explicit,
    });
    const sealed = createConfigurationSnapshot(effective);
    const readSet: ModelSettingsReadSet = {
      userEtag: user.etag,
      workspaceEtag: project?.etag ?? null,
      explicitDigest: createHash('sha256').update(canonical(explicit)).digest('hex'),
      effectiveDigest: sealed.digest,
    };
    return { user, project, explicit, effective, readSet };
  }
  function assertReadSet(
    input: ConfigurationLocation,
    path: string,
    expected: ModelSettingsReadSet,
  ) {
    const observed = rawModels(input, path);
    if (canonical(observed.readSet) !== canonical(expected))
      throw new ConfigurationError('configuration_read_set_conflict');
    return observed;
  }
  async function mutate(
    input: MutationIdentity,
    kind: ManagementMutation['kind'],
    scope: string,
    safeRequest: Json,
    body: Json,
    effect: () => Promise<Json>,
  ): Promise<ManagementMutation> {
    if (!options.runtime) throw new AgentError('store_unavailable');
    if ((await options.runtime.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_mismatch');
    const requestDigest = createHmac('sha256', stableKey(options.profile))
      .update(canonical(body))
      .digest('hex');
    const storageKind =
      kind === 'config.patch' || kind === 'model_settings.update'
        ? (safeRequest as JsonObject).scope === 'user'
          ? 'config.user.write'
          : 'config.workspace.write'
        : kind;
    const accepted = await options.runtime.beginHostMutation({
      commandId: input.commandId,
      expectedStoreId: input.expectedStoreId,
      subjectId: input.subjectId,
      kind: storageKind,
      scope,
      safeRequest,
      requestDigest,
    });
    if (!accepted.created) {
      if (accepted.record.state === 'pending') throw new AgentError('mutation_incomplete');
      return publicMutation(accepted.record);
    }
    let receipt: Json;
    try {
      receipt = { status: 'applied', ...((await effect()) as JsonObject) };
    } catch (error) {
      const failure = publicError(error);
      const uncertain =
        failure.code === 'configuration_publication_uncertain' ||
        (kind.startsWith('credential.') && failure.code === 'credential_unavailable');
      await options.runtime.finishHostMutation({
        expectedStoreId: input.expectedStoreId,
        requestDigest,
        commandId: input.commandId,
        subjectId: input.subjectId,
        state: uncertain ? 'outcome_unknown' : 'failed',
        receipt: { status: uncertain ? 'outcome_unknown' : 'failed', code: failure.code },
      });
      throw failure;
    }
    try {
      const final = await options.runtime.finishHostMutation({
        expectedStoreId: input.expectedStoreId,
        requestDigest,
        commandId: input.commandId,
        subjectId: input.subjectId,
        state: 'applied',
        receipt,
      });
      return publicMutation(final);
    } catch {
      throw new AgentError('mutation_outcome_unknown');
    }
  }
  return {
    async read(input) {
      try {
        const storeId = options.runtime ? (await options.runtime.getMetadata()).storeId : undefined;
        if (storeId !== input.expectedStoreId) throw new AgentError('store_mismatch');
        const path = await pathFor(input);
        const selected = inspectConfigurationFile({
          path,
          windowsPathPolicy: input.scope === 'user' ? 'private' : 'scope',
        });
        const user =
          input.scope === 'user'
            ? selected
            : inspectConfigurationFile({ path: userPath, windowsPathPolicy: 'private' });
        const errors = [selected.error, user.error].filter(
          (error): error is string => error !== null,
        );
        let effective: JsonObject | null = null;
        let snapshot: Json | null = null;
        if (errors.length === 0) {
          try {
            const resolved = resolveConfiguration({
              defaults: { modelId: null, models: [], tools: [], skills: [], mcp: [] },
              user: user.value ?? {},
              workspace: input.scope === 'workspace' ? (selected.value ?? {}) : {},
              explicit: options.explicit(),
            });
            const sealed = createConfigurationSnapshot(resolved);
            effective = redacted(resolved);
            snapshot = {
              version: sealed.version,
              digest: sealed.digest,
              configuration: redacted(sealed.configuration as JsonObject),
            };
          } catch (error) {
            errors.push(publicError(error).code);
          }
        }
        return {
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(storeId ? { storeId } : {}),
          etag: selected.etag,
          raw: selected.value === null ? null : redacted(selected.value),
          effective,
          snapshot,
          errors: [...new Set(errors)],
        };
      } catch (error) {
        throw publicError(error);
      }
    },
    async readModels(input) {
      if (
        !options.runtime ||
        (await options.runtime.getMetadata()).storeId !== input.expectedStoreId
      )
        throw new AgentError('store_mismatch');
      const path = await pathFor(input);
      try {
        const state = rawModels(input, path);
        return {
          storeId: input.expectedStoreId,
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          readSet: state.readSet,
          defaultModelId: state.effective.modelId ?? null,
          models: (state.effective.models ?? []).map((model) => {
            const diagnostics = configured(model);
            const explicitModel = Array.isArray(state.explicit.models)
              ? (state.explicit.models.find(
                  (item) =>
                    item &&
                    typeof item === 'object' &&
                    !Array.isArray(item) &&
                    item.id === model.id,
                ) as JsonObject | undefined)
              : undefined;
            return {
              id: model.id,
              enabled: model.enabled !== false,
              configured: diagnostics.length === 0,
              ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
              ...(typeof model.model === 'string' ? { model: model.model } : {}),
              reasoningEffort:
                diagnostics.length === 0
                  ? (parseModelPreset(model.options).reasoningEffort ?? null)
                  : null,
              reasoningEffortChoices:
                model.provider === 'compatible' && diagnostics.length === 0
                  ? [...reasoningEfforts]
                  : [],
              reasoningEffortSupport:
                model.provider === 'compatible' && diagnostics.length === 0
                  ? 'compatible_wire'
                  : 'unsupported',
              reasoningEffortReadonlyReason:
                model.provider !== 'compatible' || diagnostics.length
                  ? 'model_reasoning_effort_unsupported'
                  : explicitModel && Object.hasOwn(explicitModel, 'options')
                    ? 'model_settings_override'
                    : null,
              diagnostics,
            };
          }),
          errors: [],
        };
      } catch (error) {
        return {
          storeId: input.expectedStoreId,
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          readSet: null,
          defaultModelId: null,
          models: [],
          errors: [publicError(error).code],
        };
      }
    },
    async updateModels(input) {
      const path = await pathFor(input);
      const ifMatch =
        input.scope === 'user'
          ? input.expectedReadSet.userEtag
          : input.expectedReadSet.workspaceEtag!;
      return mutate(
        input,
        'model_settings.update',
        input.scope === 'user' ? 'user' : input.workspaceId!,
        {
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ifMatch,
          operationCount: 1,
          modelSettings: {
            expectedReadSet: input.expectedReadSet as unknown as Json,
            operation: input.operation,
          },
        },
        {
          scope: input.scope,
          workspaceId: input.workspaceId ?? null,
          expectedReadSet: input.expectedReadSet as unknown as Json,
          operation: input.operation,
        },
        async () => {
          const state = assertReadSet(input, path, input.expectedReadSet);
          const selected = state.effective.models?.find(
            (model) => model.id === input.operation.modelId,
          );
          if (!selected) throw new AgentError('model_settings_model_missing');
          if (
            input.operation.kind === 'enabled' &&
            !input.operation.enabled &&
            state.effective.modelId === selected.id
          )
            throw new AgentError('model_settings_default_disable_denied');
          if (
            (input.operation.kind === 'default' ||
              (input.operation.kind === 'enabled' && input.operation.enabled)) &&
            configured(selected).length
          )
            throw new AgentError('model_settings_model_unconfigured');
          if (input.operation.kind === 'default' && selected.enabled === false)
            throw new AgentError('model_settings_model_disabled');
          const target = input.scope === 'user' ? state.user.value : state.project!.value;
          const index = Array.isArray(target.models)
            ? target.models.findIndex(
                (model) =>
                  !!model &&
                  typeof model === 'object' &&
                  !Array.isArray(model) &&
                  model.id === selected.id,
              )
            : -1;
          let edit: ConfigurationEdit =
            input.operation.kind === 'default'
              ? { kind: 'set', path: ['modelId'], value: selected.id }
              : index >= 0
                ? {
                    kind: 'set',
                    path: ['models', index, 'enabled'],
                    value: input.operation.kind === 'enabled' ? input.operation.enabled : false,
                  }
                : Array.isArray(target.models)
                  ? {
                      kind: 'set',
                      path: ['models', target.models.length],
                      value: {
                        id: selected.id,
                        enabled:
                          input.operation.kind === 'enabled' ? input.operation.enabled : false,
                      },
                    }
                  : {
                      kind: 'set',
                      path: ['models'],
                      value: [
                        {
                          id: selected.id,
                          enabled:
                            input.operation.kind === 'enabled' ? input.operation.enabled : false,
                        },
                      ],
                    };
          if (input.operation.kind === 'effort') {
            if (selected.provider !== 'compatible' || configured(selected).length)
              throw new AgentError('model_reasoning_effort_unsupported');
            if (
              input.operation.reasoningEffort !== null &&
              !reasoningEfforts.includes(input.operation.reasoningEffort)
            )
              throw new AgentError('invalid_model_options');
            const explicitModel = Array.isArray(state.explicit.models)
              ? (state.explicit.models.find(
                  (m) => m && typeof m === 'object' && !Array.isArray(m) && m.id === selected.id,
                ) as JsonObject | undefined)
              : undefined;
            if (explicitModel && Object.hasOwn(explicitModel, 'options'))
              throw new ConfigurationError('model_settings_override');
            const localModel = index >= 0 ? (target.models as JsonObject[])[index]! : undefined;
            if (input.operation.reasoningEffort === null) {
              const localOptions = localModel?.options;
              if (
                localOptions &&
                typeof localOptions === 'object' &&
                !Array.isArray(localOptions) &&
                Object.hasOwn(localOptions, 'reasoningEffort')
              ) {
                const remaining = { ...localOptions };
                delete remaining.reasoningEffort;
                edit = Object.keys(remaining).length
                  ? { kind: 'set', path: ['models', index, 'options'], value: remaining }
                  : { kind: 'remove', path: ['models', index, 'options'] };
              } else {
                // A clear without a local override is an idempotent metadata intent.
                edit = {
                  kind: 'set',
                  path: [
                    'models',
                    index >= 0 ? index : Array.isArray(target.models) ? target.models.length : 0,
                  ],
                  value: localModel ?? { id: selected.id },
                };
                if (!Array.isArray(target.models))
                  edit = { kind: 'set', path: ['models'], value: [{ id: selected.id }] };
              }
            } else {
              const value = {
                ...(selected.options as JsonObject | undefined),
                reasoningEffort: input.operation.reasoningEffort,
              };
              edit =
                index >= 0
                  ? { kind: 'set', path: ['models', index, 'options'], value }
                  : Array.isArray(target.models)
                    ? {
                        kind: 'set',
                        path: ['models', target.models.length],
                        value: { id: selected.id, options: value },
                      }
                    : {
                        kind: 'set',
                        path: ['models'],
                        value: [{ id: selected.id, options: value }],
                      };
            }
          }
          const result = updateConfigurationFile({
            path,
            windowsPathPolicy: input.scope === 'user' ? 'private' : 'scope',
            ifMatch,
            operations: [edit],
            validateCandidate(candidate) {
              const fresh = assertReadSet(input, path, input.expectedReadSet);
              const effective = resolveConfiguration({
                defaults: { modelId: null, models: [], tools: [], skills: [], mcp: [] },
                user: input.scope === 'user' ? candidate : fresh.user.value,
                ...(input.scope === 'workspace' ? { workspace: candidate } : {}),
                explicit: fresh.explicit,
              });
              createConfigurationSnapshot(effective);
              const actual = effective.models?.find((model) => model.id === selected.id);
              if (
                !actual ||
                (input.operation.kind === 'default'
                  ? effective.modelId !== selected.id
                  : input.operation.kind === 'effort'
                    ? input.operation.reasoningEffort !== null &&
                      parseModelPreset(actual.options).reasoningEffort !==
                        input.operation.reasoningEffort
                    : actual.enabled !== input.operation.enabled &&
                      !(input.operation.enabled && actual.enabled === undefined))
              )
                throw new ConfigurationError('model_settings_override');
              const defaultModel = effective.models?.find(
                (model) => model.id === effective.modelId,
              );
              if (
                effective.modelId !== null &&
                effective.modelId !== undefined &&
                (!defaultModel || defaultModel.enabled === false || configured(defaultModel).length)
              )
                throw new ConfigurationError('model_settings_default_unconfigured');
            },
            validatePublication() {
              assertReadSet(input, path, input.expectedReadSet);
            },
          });
          return { etag: result.etag };
        },
      );
    },
    async patch(input) {
      const path = await pathFor(input);
      if (
        input.operations.some(
          (operation) =>
            !['modelId', 'models', 'tools', 'skills', 'mcp'].includes(String(operation.path[0])),
        )
      )
        throw new AgentError('unsupported_configuration_field');
      return mutate(
        input,
        'config.patch',
        input.scope === 'workspace' ? input.workspaceId! : 'user',
        {
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ifMatch: input.ifMatch,
          operationCount: input.operations.length,
        },
        {
          scope: input.scope,
          workspaceId: input.workspaceId ?? null,
          ifMatch: input.ifMatch,
          operations: input.operations as unknown as Json,
        },
        async () => ({
          etag: updateConfigurationFile({
            path,
            windowsPathPolicy: input.scope === 'user' ? 'private' : 'scope',
            ifMatch: input.ifMatch,
            operations: input.operations,
          }).etag,
        }),
      );
    },
    async repair(input) {
      const path = await pathFor(input);
      return mutate(
        input,
        'config.repair',
        input.scope === 'workspace' ? input.workspaceId! : 'user',
        {
          scope: input.scope,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ifMatch: input.ifMatch,
        },
        {
          scope: input.scope,
          workspaceId: input.workspaceId ?? null,
          ifMatch: input.ifMatch,
          value: input.value,
        },
        async () => {
          const result = repairConfigurationFile({
            path,
            windowsPathPolicy: input.scope === 'user' ? 'private' : 'scope',
            ifMatch: input.ifMatch,
            value: input.value,
          });
          return { etag: result.etag };
        },
      );
    },
    async putCredential(input) {
      return mutate(
        input,
        'credential.put',
        'user',
        { scope: 'user', persistence: options.persistence },
        { secret: input.secret },
        async () => {
          const ref = await options.vault.put(input.secret);
          return { opaqueRef: ref.id, persistence: ref.persistence };
        },
      );
    },
    async revokeCredential(input) {
      return mutate(
        input,
        'credential.revoke',
        'user',
        { scope: 'user', opaqueRef: input.opaqueRef, persistence: options.persistence },
        { opaqueRef: input.opaqueRef },
        async () => {
          await options.vault.revoke(input.opaqueRef);
          return { opaqueRef: input.opaqueRef, persistence: options.persistence };
        },
      );
    },
    async getMutation(input) {
      if (!options.runtime) throw new AgentError('store_unavailable');
      const record = await options.runtime.getHostMutation({
        ...input,
        expectedStoreId: input.expectedStoreId,
      });
      if (!record) return null;
      if (
        record.kind !== 'config.user.write' &&
        record.kind !== 'config.workspace.write' &&
        record.kind !== 'config.repair' &&
        record.kind !== 'credential.put' &&
        record.kind !== 'credential.revoke'
      )
        return null;
      return publicMutation(record);
    },
  };
}
