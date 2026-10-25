import type { NativeReasoningEffort, NativeRecommendedModel } from './native-bridge';

const key = (storeId: string) => `kite.desktop.recommended-model.${storeId}`;
const efforts: readonly NativeReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultar',
];
function valid(value: unknown): value is NativeRecommendedModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const choice = value as NativeRecommendedModel;
  return (
    typeof choice.modelId === 'string' &&
    /^[A-Za-z0-9_.:/-]{1,128}$/.test(choice.modelId) &&
    Object.keys(choice).every((name) => name === 'modelId' || name === 'reasoningEffort') &&
    (choice.reasoningEffort === undefined || efforts.includes(choice.reasoningEffort))
  );
}

/** A display preference, never a Session route or permission to send. Reads preserve invalid bytes. */
export function readNativeRecommendedModel(storeId: string): NativeRecommendedModel | undefined {
  try {
    const raw = window.localStorage.getItem(key(storeId));
    if (raw === null || raw.length > 1024) return;
    const choice: unknown = JSON.parse(raw);
    if (valid(choice)) return choice;
  } catch {
    // As with theme preferences, unavailable storage still permits choosing a model in this window.
  }
  return undefined;
}

export function rememberNativeRecommendedModel(storeId: string, choice: NativeRecommendedModel) {
  if (!valid(choice)) throw Error('model_preference_invalid');
  window.localStorage.setItem(key(storeId), JSON.stringify(choice));
}
