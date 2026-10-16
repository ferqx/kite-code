import { ConfigurationError } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { type ReasoningEffort, reasoningEfforts, type SdkModelPreset } from '@kite-ai/ai/sdk';

/** Pure validation shared by Run binding and finite model-settings candidate checks. */
export function parseModelPreset(value: Json | undefined): SdkModelPreset {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('invalid_model_options');
  if (
    Object.keys(value).some(
      (key) => !['temperature', 'topP', 'maxOutputTokens', 'reasoningEffort'].includes(key),
    )
  )
    throw new ConfigurationError('unsupported_model_options');
  const { temperature, topP, maxOutputTokens, reasoningEffort } = value;
  if (
    (reasoningEffort !== undefined &&
      (typeof reasoningEffort !== 'string' ||
        !reasoningEfforts.includes(reasoningEffort as ReasoningEffort))) ||
    (temperature !== undefined &&
      (typeof temperature !== 'number' ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2)) ||
    (topP !== undefined &&
      (typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0 || topP > 1)) ||
    (maxOutputTokens !== undefined &&
      (typeof maxOutputTokens !== 'number' ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > 1000000))
  )
    throw new ConfigurationError('invalid_model_options');
  return Object.freeze({
    ...(reasoningEffort === undefined
      ? {}
      : { reasoningEffort: reasoningEffort as ReasoningEffort }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}
