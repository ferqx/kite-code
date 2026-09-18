import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  type AppModelProviderType,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SET_ENABLED_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSetEnabledRequest,
  type ProviderModelSetEnabledResponse,
  type ProviderModelSnapshot,
} from '@kite-ai/kite-app-contract';
import {
  listAvailableModels,
  probeAgentConfig,
  resolveConfiguredDefaultModel,
  saveModelEnabledWithRevisionGuard,
  saveModelSelectionWithRevisionGuard,
} from '#kite-service/config';
import { defaultConfigPath, projectConfigPath } from '#kite-service/config/paths';
import type { ProviderModelHandlerPort } from '../ports';

export interface ProviderModelOwnerOptions {
  readonly workspace: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity;
  readonly userConfigPath?: string;
  readonly onSelected?: (provider: string, name: string) => Promise<void> | void;
}

function revision(input: ProviderModelOwnerOptions): string {
  const paths = [
    input.userConfigPath ?? defaultConfigPath(),
    projectConfigPath(input.workspace.canonicalPath),
  ];
  const hash = createHash('sha256').update('kite.provider-model.v1\0');
  for (const path of paths) {
    hash.update(path).update('\0');
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0)).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function providerType(value: string): AppModelProviderType {
  return value === 'deepseek' || value === 'openai' || value === 'ollama'
    ? value
    : 'openai-compatible';
}

function snapshot(input: ProviderModelOwnerOptions): ProviderModelSnapshot {
  const models = listAvailableModels(input.userConfigPath, input.workspace.canonicalPath);
  const providers = new Map<string, typeof models>();
  for (const model of models) {
    const entries = providers.get(model.provider) ?? [];
    entries.push(model);
    providers.set(model.provider, entries);
  }
  const selectedProbe = probeAgentConfig({
    ...(input.userConfigPath === undefined ? {} : { configPath: input.userConfigPath }),
    workspace: input.workspace.canonicalPath,
  });
  const selected =
    resolveConfiguredDefaultModel(input.userConfigPath, input.workspace.canonicalPath) ??
    (selectedProbe.status === 'ready'
      ? { provider: selectedProbe.config.providerName, name: selectedProbe.config.modelName }
      : undefined);
  return {
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace: input.workspace,
    revision: revision(input),
    providers: [...providers.entries()].map(([provider, entries]) => {
      const enabledModel = entries.find((entry) => entry.enabled !== false);
      const readiness = enabledModel
        ? probeAgentConfig({
            ...(input.userConfigPath === undefined ? {} : { configPath: input.userConfigPath }),
            workspace: input.workspace.canonicalPath,
            providerName: provider,
            modelName: enabledModel.name,
          })
        : undefined;
      const config = readiness?.status === 'ready' ? readiness.config : undefined;
      return {
        provider,
        type: providerType(config?.providerType ?? provider),
        readiness:
          readiness?.status === 'ready'
            ? ('ready' as const)
            : readiness?.status === 'not-configured'
              ? ('not_configured' as const)
              : ('unavailable' as const),
        models: entries.map((entry) => ({
          provider,
          name: entry.name,
          isDefault: entry.isDefault,
          enabled: entry.enabled,
          ...(entry.contextWindow === undefined
            ? {}
            : { contextWindowTokens: entry.contextWindow }),
          ...(entry.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: entry.maxOutputTokens }),
          ...(config?.reasoning === undefined ? {} : { reasoning: config.reasoning }),
          ...(config?.modelCapabilities?.streaming === undefined
            ? {}
            : { streaming: config.modelCapabilities.streaming }),
        })),
        ...(selected?.provider === provider ? { selectedModel: selected.name } : {}),
        ...(readiness?.status === 'invalid' ? { diagnosticCode: 'config_invalid' } : {}),
      };
    }),
    ...(selected === undefined ? {} : { selected }),
  };
}

/** Workspace-scoped provider/model projection; credential material never leaves this owner. */
export function createProviderModelOwner(
  input: ProviderModelOwnerOptions,
): ProviderModelHandlerPort {
  return Object.freeze({
    async snapshot(): Promise<ProviderModelSnapshot> {
      return snapshot(input);
    },
    async select(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse> {
      const before = snapshot(input);
      if (request.expectedRevision !== before.revision) {
        return {
          schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
          outcome: 'conflict',
          snapshot: before,
        };
      }
      const available = before.providers
        .flatMap((provider) => provider.models)
        .some(
          (model) =>
            model.provider === request.provider &&
            model.name === request.name &&
            model.enabled !== false,
        );
      if (!available) {
        return {
          schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
          outcome: 'invalid_model',
          snapshot: before,
        };
      }
      if (before.selected?.provider === request.provider && before.selected.name === request.name) {
        await input.onSelected?.(request.provider, request.name);
        return {
          schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
          outcome: 'already_selected',
          snapshot: before,
        };
      }
      const saved = saveModelSelectionWithRevisionGuard({
        provider: request.provider,
        name: request.name,
        configPath: input.userConfigPath ?? defaultConfigPath(),
        guardPaths: [projectConfigPath(input.workspace.canonicalPath)],
        isCurrent: () => revision(input) === request.expectedRevision,
      });
      if (saved === 'saved') await input.onSelected?.(request.provider, request.name);
      return {
        schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
        outcome: saved === 'saved' ? 'applied' : saved === 'conflict' ? 'conflict' : 'unavailable',
        snapshot: snapshot(input),
      };
    },
    async setEnabled(
      request: ProviderModelSetEnabledRequest,
    ): Promise<ProviderModelSetEnabledResponse> {
      const before = snapshot(input);
      const respond = (
        outcome: ProviderModelSetEnabledResponse['outcome'],
        current = before,
      ): ProviderModelSetEnabledResponse => ({
        schema: PROVIDER_MODEL_SET_ENABLED_RESPONSE_SCHEMA_,
        outcome,
        snapshot: current,
      });
      if (request.expectedRevision !== before.revision) return respond('conflict');
      const model = before.providers
        .flatMap((provider) => provider.models)
        .find((route) => route.provider === request.provider && route.name === request.name);
      if (!model) return respond('invalid_model');
      if (
        !request.enabled &&
        before.selected?.provider === request.provider &&
        before.selected.name === request.name
      ) {
        return respond('invalid_model');
      }
      if ((model.enabled !== false) === request.enabled) return respond('already_selected');
      const saved = saveModelEnabledWithRevisionGuard({
        provider: request.provider,
        name: request.name,
        enabled: request.enabled,
        configPath: input.userConfigPath ?? defaultConfigPath(),
        guardPaths: [projectConfigPath(input.workspace.canonicalPath)],
        isCurrent: () => revision(input) === request.expectedRevision,
      });
      return respond(
        saved === 'saved' ? 'applied' : saved === 'conflict' ? 'conflict' : 'unavailable',
        snapshot(input),
      );
    },
  });
}
