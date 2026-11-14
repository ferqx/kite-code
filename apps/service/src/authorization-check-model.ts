import { createSdkModelAdapter, type SdkModelPreset } from '@kite-ai/ai/sdk';

const authorizationCheckOutputTokens = 256;

/** Business and checker adapters share one transport binding, never mutable presets. */
export function createRunModelAdapters(options: {
  modelId: string;
  models: Parameters<typeof createSdkModelAdapter>[0]['models'];
  preset: SdkModelPreset;
  limitCheckOutput: boolean;
  supportsCheckReasoning: boolean;
}) {
  const model = createSdkModelAdapter({
    models: options.models,
    presets: new Map([[options.modelId, options.preset]]),
  });
  const {
    reasoningEffort: _businessReasoning,
    maxOutputTokens: businessOutputTokens,
    ...baseOptions
  } = options.preset;
  const checkOptions: SdkModelPreset = {
    ...baseOptions,
    ...(options.supportsCheckReasoning ? { reasoningEffort: 'low' as const } : {}),
    ...(options.limitCheckOutput
      ? {
          maxOutputTokens: Math.min(
            businessOutputTokens ?? authorizationCheckOutputTokens,
            authorizationCheckOutputTokens,
          ),
        }
      : {}),
  };
  return {
    model,
    checkOptions,
    checkModel: createSdkModelAdapter({
      models: options.models,
      presets: new Map([[options.modelId, checkOptions]]),
    }),
  };
}
