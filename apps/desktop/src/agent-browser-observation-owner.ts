import { type AgentBrowserObservation, AgentBrowserObserver } from './agent-browser-observer';
import type { NativeExtensionScope } from './extensions-bridge';
import type { NativeBridge, NativeCallerMetadata } from './native-bridge';

export type AgentBrowserObservationOwner = Pick<
  AgentBrowserObserver,
  'start' | 'stop' | 'setVisible' | 'setCanInvoke' | 'invoke' | 'checkOriginal'
>;
type Subscriber = {
  visible: boolean;
  canInvoke: boolean;
  changed(state: AgentBrowserObservation): void;
};
type Entry = {
  owner: AgentBrowserObserver;
  subscribers: Set<Subscriber>;
  state: AgentBrowserObservation;
  running: boolean;
};
type Manager = { entries: Map<string, Entry>; active?: Entry };
const managers = new WeakMap<NativeBridge, Manager>();

/** Main has one catalogue owner. Same-scope surfaces subscribe to that owner;
 * hiding a read-only picker must not revoke the toolbar's action observation. */
export function createAgentBrowserObservationOwner(
  bridge: NativeBridge,
  scope: NativeExtensionScope,
  changed: (state: AgentBrowserObservation) => void,
  canInvoke: boolean,
  submissions: readonly NativeCallerMetadata[] = [],
): AgentBrowserObservationOwner {
  let manager = managers.get(bridge);
  if (!manager) {
    manager = { entries: new Map() };
    managers.set(bridge, manager);
  }
  const shared = manager,
    key = JSON.stringify(scope),
    subscriber: Subscriber = { visible: false, canInvoke, changed };
  let entry: Entry | undefined;
  const publish = (target: Entry, state: AgentBrowserObservation) => {
    target.state = { ...state, fresh: state.fresh && target.running };
    for (const listener of target.subscribers) listener.changed(target.state);
  };
  const sync = (activate = true) => {
    if (!entry) return;
    const visible = [...entry.subscribers].some((item) => item.visible);
    entry.owner.setCanInvoke([...entry.subscribers].some((item) => item.visible && item.canInvoke));
    if (visible) {
      if (shared.active !== entry && activate) {
        const previous = shared.active;
        if (previous) {
          previous.running = false;
          previous.owner.stop();
          publish(previous, { ...previous.state, fresh: false });
        }
        shared.active = entry;
        entry.running = true;
        entry.owner.start(true);
      }
    } else if (shared.active === entry) {
      shared.active = undefined;
      entry.running = false;
      entry.owner.stop();
      publish(entry, { ...entry.state, fresh: false });
    }
  };
  return {
    start(visible) {
      if (entry) return;
      entry = shared.entries.get(key);
      if (!entry) {
        const target: Entry = {
          owner: undefined as unknown as AgentBrowserObserver,
          subscribers: new Set(),
          state: { fresh: false, loading: true, available: false, pending: false },
          running: false,
        };
        target.owner = new AgentBrowserObserver(
          bridge,
          scope,
          (state) => publish(target, state),
          false,
          submissions,
        );
        entry = target;
        shared.entries.set(key, target);
      }
      subscriber.visible = visible;
      entry.subscribers.add(subscriber);
      subscriber.changed(entry.state);
      sync(visible);
    },
    stop() {
      if (!entry) return;
      const previous = entry;
      previous.subscribers.delete(subscriber);
      sync(false);
      if (!previous.subscribers.size && shared.entries.get(key) === previous)
        shared.entries.delete(key);
      entry = undefined;
    },
    setVisible(visible) {
      subscriber.visible = visible;
      sync(visible);
    },
    setCanInvoke(value) {
      subscriber.canInvoke = value;
      sync(false);
    },
    invoke(action, input) {
      return entry && shared.active === entry && subscriber.visible && subscriber.canInvoke
        ? entry.owner.invoke(action, input)
        : Promise.resolve(false);
    },
    checkOriginal() {
      if (entry && shared.active === entry && subscriber.visible) entry.owner.checkOriginal();
    },
  };
}
