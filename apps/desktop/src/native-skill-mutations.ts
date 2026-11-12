import type { NativeBridge, NativeSkillsScope } from './native-bridge';

type Listener = NativeSkillsScope & { changed: () => void };
const listeners = new WeakMap<NativeBridge, Set<Listener>>();

// A mutation can outlive its settings page. Only the current matching reader refreshes.
export function watchNativeSkillMutations(
  bridge: NativeBridge,
  scope: NativeSkillsScope,
  changed: () => void,
) {
  let subscribers = listeners.get(bridge);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(bridge, subscribers);
  }
  const listener = { ...scope, changed };
  subscribers.add(listener);
  return () => {
    if (!subscribers.delete(listener)) return;
    if (!subscribers.size) listeners.delete(bridge);
  };
}

export function notifyNativeSkillMutation(bridge: NativeBridge, scope: NativeSkillsScope) {
  for (const listener of listeners.get(bridge) ?? []) {
    if (listener.generation === scope.generation && listener.storeId === scope.storeId)
      listener.changed();
  }
}
