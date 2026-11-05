import type { NativeRecommendedModel } from './native-bridge';

export const nativeModelPreferenceChannel = 'kite:native:model-preference';
export type NativeModelPreferenceReply =
  | { ok: true; value: NativeRecommendedModel | null }
  | { ok: false; code: string };
export interface NativeModelPreferenceBridge {
  readRecommendedModel(storeId: string): Promise<NativeRecommendedModel | null>;
  rememberRecommendedModel(storeId: string, choice: NativeRecommendedModel): Promise<void>;
}
export function isNativeRecommendedModel(value: unknown): value is NativeRecommendedModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const choice = value as NativeRecommendedModel;
  return (
    typeof choice.modelId === 'string' &&
    /^[A-Za-z0-9_.:/-]{1,128}$/.test(choice.modelId) &&
    Object.keys(choice).every((name) => name === 'modelId' || name === 'reasoningEffort') &&
    (choice.reasoningEffort === undefined ||
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultar'].includes(
        choice.reasoningEffort,
      ))
  );
}
