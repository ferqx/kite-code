import { AgentError } from '@kite-ai/agent';
import { createConfigurationSnapshot, type ModelConfiguration } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { RunRecord } from '@kite-ai/agent/storage';
import { parseModelPreset } from './model-options';
import { isSupportedModelProvider, modelProtocol } from './model-providers';

const object = (value: Json | undefined): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Historical selection is a preference, never a credential, route or authorization grant. */
export function compressionModelPreference(run: RunRecord, executionModelId: string) {
  try {
    const manifest = run.configuration;
    if (!object(manifest) || manifest.modelId !== executionModelId) throw Error();
    let snapshot = manifest.snapshot;
    if (object(snapshot) && snapshot.kind === 'human_input_processing')
      snapshot = snapshot.originalConfiguration;
    if (
      !object(snapshot) ||
      snapshot.version !== 1 ||
      !object(snapshot.configuration) ||
      createConfigurationSnapshot(snapshot.configuration).digest !== snapshot.digest ||
      !Array.isArray(snapshot.configuration.models)
    )
      throw Error();
    const models = snapshot.configuration.models.filter(
      (model) => object(model) && model.id === executionModelId,
    );
    if (models.length !== 1 || !object(models[0])) throw Error();
    const model = models[0];
    if (
      !isSupportedModelProvider(model.provider) ||
      typeof model.baseURL !== 'string' ||
      typeof model.model !== 'string'
    )
      throw Error();
    return {
      modelId: executionModelId,
      bindingDigest:
        typeof snapshot.modelBindingDigest === 'string' ? snapshot.modelBindingDigest : undefined,
      provider: model.provider,
      protocol: modelProtocol(model.provider, model.protocol),
      baseURL: model.baseURL,
      remoteModel: model.model,
      reasoningEffort: parseModelPreset(model.options).reasoningEffort,
    };
  } catch {
    throw new AgentError('session_model_preference_unavailable');
  }
}

export function assertCompressionModelPreference(
  preference: ReturnType<typeof compressionModelPreference>,
  current: ModelConfiguration,
) {
  if (
    current.id !== preference.modelId ||
    current.enabled === false ||
    current.provider !== preference.provider ||
    current.baseURL !== preference.baseURL ||
    current.model !== preference.remoteModel ||
    modelProtocol(current.provider, current.protocol) !== preference.protocol
  )
    throw new AgentError('session_model_preference_changed');
}

/** Inspect the actual trusted Run registrations, not just workspace-owned extensions. */
export function hasCompressionArchiveTools(
  extensions: readonly {
    id: string;
    version: string;
    tools?: readonly { id: string; version: string }[];
  }[],
  selected: readonly string[],
  hidden: readonly string[],
): boolean {
  return ['files.view_images', 'files.reinspect_images'].every(
    (id) =>
      selected.includes(id) &&
      !hidden.includes(id) &&
      extensions.some(
        (extension) =>
          extension.id === 'builtin.files' &&
          extension.version === '1' &&
          extension.tools?.some((tool) => tool.id === id && tool.version === '1'),
      ),
  );
}
