import type { NativeBrowserRestoreScope, NativeBrowserState } from './native-browser-bridge';

const stores = new WeakMap<Window, Map<string, readonly NativeBrowserState[]>>();
function ownerKey(scope?: NativeBrowserRestoreScope, draft?: string) {
  return JSON.stringify(
    draft
      ? ['draft', draft]
      : scope
        ? ['session', scope.storeId, scope.sessionId, scope.generation, scope.viewSelection]
        : [],
  );
}
function displayStore() {
  let hints = stores.get(window);
  if (!hints) {
    hints = new Map();
    stores.set(window, hints);
  }
  return hints;
}
export function saveNativeBrowserDisplayHints(
  pages: readonly NativeBrowserState[],
  scope?: NativeBrowserRestoreScope,
  draft?: string,
) {
  const hints = displayStore(),
    key = ownerKey(scope, draft);
  hints.delete(key);
  hints.set(key, pages);
  while (hints.size > 16) hints.delete(hints.keys().next().value!);
}
export function nativeBrowserDisplayHint(
  id: string,
  scope?: NativeBrowserRestoreScope,
  draft?: string,
) {
  return displayStore()
    .get(ownerKey(scope, draft))
    ?.find((page) => page.id === id);
}
export function rememberNativeBrowserState(
  page: NativeBrowserState,
  scope?: NativeBrowserRestoreScope,
  draft?: string,
) {
  const previous = displayStore().get(ownerKey(scope, draft)) ?? [];
  saveNativeBrowserDisplayHints(
    [...previous.filter((item) => item.id !== page.id), page].slice(-8),
    scope,
    draft,
  );
}
