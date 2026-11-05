import { createSdkModelAdapter, type SdkModelPreset } from '@kite-ai/ai/sdk';

const authorizationCheckOutputTokens = 256;

/** Business and checker adapters share one transport binding, never mutable presets. */
export function createRunModelAdapters(options: {
  modelId: string;
  models: Parameters<typeof createSdkModelAdapter>[0]['models'];
  preset: SdkModelPreset;
  supportsCheckOutputLimit: boolean;
}) {
  const model = createSdkModelAdapter({
    models: options.models,
    presets: new Map([[options.modelId, options.preset]]),
  });
  const checkOptions = options.supportsCheckOutputLimit
    ? {
        ...options.preset,
        maxOutputTokens: Math.min(
          options.preset.maxOutputTokens ?? authorizationCheckOutputTokens,
          authorizationCheckOutputTokens,
        ),
      }
    : options.preset;
  return {
    model,
    checkOptions,
    checkModel: options.supportsCheckOutputLimit
      ? createSdkModelAdapter({
          models: options.models,
          presets: new Map([[options.modelId, checkOptions]]),
        })
      : model,
  };
}
