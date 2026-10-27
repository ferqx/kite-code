import {
  Activity,
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ConversationActivityContext,
  type RetainedConversationResource,
} from '../conversation-activity';
import {
  CONVERSATION_CACHE_ENTRY_BYTES,
  CONVERSATION_CACHE_ENTRY_NODES,
  ConversationCacheCost,
} from './conversation-cache-cost';

export interface ConversationCacheScope {
  /** Different windows, connections and Stores must not share retained trees. */
  scope: string;
  /** Reset or directory membership changes retire inactive trees. */
  revision: string;
  /** Supplied by the host after its current reads and observation are admitted. */
  readActive: boolean;
  /** Current local folding may remain available while host reads recalibrate. */
  interactive?: boolean;
}

const MAX_INACTIVE = 8;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 20_000;

type Entry = {
  container: HTMLDivElement;
  resources: Set<RetainedConversationResource>;
  content?: ReactElement;
  used: number;
  cost: ConversationCacheCost;
};

function createEntry(document: Document): Entry {
  const container = document.createElement('div');
  container.className = 'conversation-cache-container';
  return { container, resources: new Set(), used: 0, cost: new ConversationCacheCost(container) };
}

function createEntryChanged(
  retire: (key: string, entry: Entry) => void,
  key: string,
  entry: Entry,
) {
  // Long-lived child callbacks must not retain a previous render's entire Map
  // through a shared lexical context after another entry has been retired.
  return () => retire(key, entry);
}

function admittedCost(entry: Entry) {
  const cost = entry.cost.snapshot();
  return cost &&
    cost.bytes <= CONVERSATION_CACHE_ENTRY_BYTES &&
    cost.nodes <= CONVERSATION_CACHE_ENTRY_NODES
    ? cost
    : undefined;
}

/** This sibling commits before portal descendants restore their layout effects. */
function CacheHost({
  container,
  onCommit,
}: {
  container?: HTMLDivElement;
  onCommit: (host: HTMLDivElement) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current!;
    onCommit(element);
    if (element.firstChild !== (container ?? null))
      element.replaceChildren(...(container ? [container] : []));
  });
  useLayoutEffect(() => {
    const view = container?.ownerDocument.defaultView;
    if (!container || !view?.requestAnimationFrame) return;
    // Resolve retained hover/opacity before descendants restore, then allow new animations.
    container.setAttribute('data-restoring', 'true');
    let frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => container.removeAttribute('data-restoring'));
    });
    return () => {
      view.cancelAnimationFrame(frame);
      container.removeAttribute('data-restoring');
    };
  }, [container]);
  return <div className="conversation-cache-host" ref={host} />;
}

function CacheEntry({
  active,
  readActive,
  interactive,
  resources,
  cost,
  onChanged,
  children,
}: {
  active: boolean;
  readActive: boolean;
  interactive: boolean;
  resources: Set<RetainedConversationResource>;
  cost: ConversationCacheCost;
  onChanged: () => void;
  children?: ReactElement;
}) {
  const [activation, setActivation] = useState({ active, resume: 0 });
  if (activation.active !== active)
    setActivation({ active, resume: activation.resume + (active ? 1 : 0) });
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const positions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const element = fieldset.current;
    for (const [target, position] of positions.current) {
      if (!element?.contains(target)) positions.current.delete(target);
      else if (active && !wasActive.current) {
        target.scrollTop = position.top;
        target.scrollLeft = position.left;
      }
    }
    wasActive.current = active;
  });
  const retain = useCallback(
    (resource: RetainedConversationResource) => {
      resources.add(resource);
      const unregister = cost.retain(resource);
      return () => {
        if (unregister()) resources.delete(resource);
      };
    },
    [resources, cost],
  );
  const changed = useRef(onChanged);
  useLayoutEffect(() => {
    changed.current = onChanged;
  });
  // This owner remains mounted while Activity disconnects its descendants' effects.
  useLayoutEffect(() => {
    cost.start(() => changed.current());
    return () => {
      cost.stop();
      for (const resource of resources) resource.release();
      resources.clear();
    };
  }, [resources, cost]);
  const activeState = useRef(active);
  activeState.current = active;
  const retention = useMemo(() => ({ retain, isPaused: () => !activeState.current }), [retain]);
  const permitted = active && interactive;
  const readsPermitted = active && readActive;
  const activity = useMemo(
    () => ({ readActive: readsPermitted, resume: activation.resume, retention }),
    [readsPermitted, activation.resume, retention],
  );
  return (
    <fieldset
      className="conversation-cache-entry"
      ref={fieldset}
      onScrollCapture={(event) => {
        const target = event.target;
        const Element = event.currentTarget.ownerDocument.defaultView!.HTMLElement;
        // Conversation already owns the outer viewport's follow/manual policy.
        if (
          !active ||
          !(target instanceof Element) ||
          target.classList.contains('conversation-viewport')
        )
          return;
        if (target.scrollTop || target.scrollLeft)
          positions.current.set(target, { top: target.scrollTop, left: target.scrollLeft });
        else positions.current.delete(target);
      }}
      aria-disabled={!permitted || undefined}
      aria-busy={(active && !readActive) || undefined}
      onClickCapture={(event) => {
        if (!permitted) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (!permitted && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <ConversationActivityContext value={activity}>
        <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>
      </ConversationActivityContext>
    </fieldset>
  );
}

/** Keep the same portal container and React tree; inactive containers stay detached. */
export function ConversationCache({
  identity,
  loading,
  visible,
  cache,
  children,
}: {
  identity: string;
  loading: boolean;
  visible: boolean;
  cache: ConversationCacheScope;
  children: ReactElement;
}) {
  const [state, setState] = useState(() => ({
    scope: cache.scope,
    revision: cache.revision,
    entries: new Map<string, Entry>(),
  }));
  const activeEntry = useRef<Entry | undefined>(undefined);
  const ownerDocument = useRef<Document | undefined>(undefined);
  const clock = useRef(0);
  if (state.scope !== cache.scope) {
    setState({ scope: cache.scope, revision: cache.revision, entries: new Map() });
  } else if (state.revision !== cache.revision) {
    setState({
      ...state,
      revision: cache.revision,
      entries: new Map([...state.entries].filter(([key]) => visible && key === identity)),
    });
  } else if (visible && !state.entries.has(identity)) {
    setState({
      ...state,
      entries: new Map(state.entries).set(identity, createEntry(document)),
    });
  } else if (visible) {
    const candidate = state.entries.get(identity)!;
    if (candidate.content && activeEntry.current !== candidate && !admittedCost(candidate))
      setState({
        ...state,
        entries: new Map(state.entries).set(identity, createEntry(document)),
      });
  }
  const active = visible ? state.entries.get(identity) : undefined;
  const retireChanged = useCallback((key: string, entry: Entry) => {
    if (activeEntry.current === entry) return;
    setState((previous) => {
      if (previous.entries.get(key) !== entry || activeEntry.current === entry) return previous;
      const entries = new Map(previous.entries);
      entries.delete(key);
      return { ...previous, entries };
    });
  }, []);
  const entries = useRef(state.entries);
  useLayoutEffect(() => {
    const document = ownerDocument.current!;
    const releaseHiddenMedia = () => {
      if (!document.hidden) return;
      for (const entry of entries.current.values()) {
        for (const resource of entry.resources)
          if (resource.releaseOnWindowHide) {
            entry.cost.remove(resource);
            entry.resources.delete(resource);
            resource.release();
          }
      }
    };
    document.addEventListener('visibilitychange', releaseHiddenMedia);
    return () => document.removeEventListener('visibilitychange', releaseHiddenMedia);
  }, []);
  useLayoutEffect(() => {
    if (active && !loading) {
      active.content = children;
      active.used = ++clock.current;
    }
    const inactive = [...state.entries].filter(([, entry]) => entry !== active);
    const retained = new Map(state.entries);
    let bytes = 0,
      nodes = 0;
    const candidates = inactive
      .filter(([key, entry]) => {
        const cost = admittedCost(entry);
        if (!entry.content || !cost) {
          retained.delete(key);
          return false;
        }
        bytes += cost.bytes;
        nodes += cost.nodes;
        return true;
      })
      .sort(([, a], [, b]) => a.used - b.used);
    while (candidates.length > MAX_INACTIVE || bytes > MAX_BYTES || nodes > MAX_NODES) {
      const [key, entry] = candidates.shift()!;
      retained.delete(key);
      const cost = entry.cost.snapshot()!;
      bytes -= cost.bytes;
      nodes -= cost.nodes;
    }
    if (retained.size !== state.entries.size) setState({ ...state, entries: retained });
  });
  return (
    <>
      <CacheHost
        container={active?.container}
        onCommit={(host) => {
          activeEntry.current = active;
          entries.current = state.entries;
          ownerDocument.current = host.ownerDocument;
        }}
      />
      {[...state.entries].map(([key, entry]) =>
        createPortal(
          <CacheEntry
            active={entry === active}
            resources={entry.resources}
            cost={entry.cost}
            onChanged={createEntryChanged(retireChanged, key, entry)}
            readActive={cache.readActive}
            interactive={!loading && (cache.interactive ?? cache.readActive)}
          >
            {entry === active && !loading
              ? children
              : (entry.content ?? (entry === active ? children : undefined))}
          </CacheEntry>,
          entry.container,
          JSON.stringify([state.scope, key]),
        ),
      )}
    </>
  );
}
