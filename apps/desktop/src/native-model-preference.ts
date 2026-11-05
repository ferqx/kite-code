import type { NativeRecommendedModel } from './native-bridge';
import { isNativeRecommendedModel as valid } from './native-model-preference-bridge';

const key = (storeId: string) => `kite.desktop.recommended-model.${storeId}`;

/** A display preference, never a Session route or permission to send. Reads preserve invalid bytes. */
export async function readNativeRecommendedModel(
  storeId: string,
): Promise<NativeRecommendedModel | undefined> {
  try {
    const host = window.kiteNative;
    if (host?.readRecommendedModel) {
      const saved = await host.readRecommendedModel(storeId);
      if (saved !== null) return valid(saved) ? saved : undefined;
    }
    const raw = window.localStorage.getItem(key(storeId));
    if (raw === null || raw.length > 1024) return;
    const choice: unknown = JSON.parse(raw);
    if (valid(choice)) {
      // Import an existing preference once, while its old renderer origin is still available.
      await host?.rememberRecommendedModel?.(storeId, choice);
      return choice;
    }
  } catch {
    // As with theme preferences, unavailable storage still permits choosing a model in this window.
  }
  return undefined;
}

export async function rememberNativeRecommendedModel(
  storeId: string,
  choice: NativeRecommendedModel,
) {
  if (!valid(choice)) throw Error('model_preference_invalid');
  if (window.kiteNative?.rememberRecommendedModel)
    await window.kiteNative.rememberRecommendedModel(storeId, choice);
  else window.localStorage.setItem(key(storeId), JSON.stringify(choice));
}
