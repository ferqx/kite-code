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

const MAX_INACTIVE = 3;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_NODES = 10_000;

type Entry = {
  container: HTMLDivElement;
  resources: Set<RetainedConversationResource>;
  content?: ReactElement;
  used: number;
  cost?: { bytes: number; nodes: number };
};

// Budget DOM payload and registered encoded media, not total heap or decoded pixels.
function retainedCost({ container, resources }: Entry) {
  const walker = container.ownerDocument.createTreeWalker(container, 0xffffffff);
  let nodes = 0,
    bytes = [...resources].reduce((sum, resource) => sum + resource.bytes, 0);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes++;
    bytes += 96 + (node.nodeValue?.length ?? 0) * 2;
    if (nodes > MAX_ENTRY_NODES || bytes > MAX_ENTRY_BYTES) break;
  }
  return { bytes, nodes };
}

function CacheEntry({
  active,
  readActive,
  interactive,
  resources,
  children,
}: {
  active: boolean;
  readActive: boolean;
  interactive: boolean;
  resources: Set<RetainedConversationResource>;
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
      return () => {
        resources.delete(resource);
      };
    },
    [resources],
  );
  // This owner remains mounted while Activity disconnects its descendants' effects.
  useLayoutEffect(
    () => () => {
      for (const resource of resources) resource.release();
      resources.clear();
    },
    [resources],
  );
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
  const host = useRef<HTMLDivElement>(null);
  const [attached, setAttached] = useState<HTMLDivElement | null>(null);
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
    const container = document.createElement('div');
    container.className = 'conversation-cache-container';
    setState({
      ...state,
      entries: new Map(state.entries).set(identity, { container, resources: new Set(), used: 0 }),
    });
  }
  const active = visible ? state.entries.get(identity) : undefined;
  const entries = useRef(state.entries);
  entries.current = state.entries;
  useLayoutEffect(() => {
    const document = host.current!.ownerDocument;
    const releaseHiddenMedia = () => {
      if (!document.hidden) return;
      for (const entry of entries.current.values()) {
        for (const resource of entry.resources)
          if (resource.releaseOnWindowHide) resource.release();
        entry.cost = undefined;
      }
    };
    document.addEventListener('visibilitychange', releaseHiddenMedia);
    return () => document.removeEventListener('visibilitychange', releaseHiddenMedia);
  }, []);
  const container = active?.container;
  useLayoutEffect(() => {
    const view = container?.ownerDocument.defaultView;
    if (!container || !view?.requestAnimationFrame) return;
    // Reattachment must resolve hover/opacity immediately; later interactions still animate.
    container.setAttribute('data-restoring', 'true');
    let frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => container.removeAttribute('data-restoring'));
    });
    return () => {
      view.cancelAnimationFrame(frame);
      container.removeAttribute('data-restoring');
    };
  }, [container]);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const container = active?.container ?? null;
    if (container !== attached) {
      element.replaceChildren(...(container ? [container] : []));
      setAttached(container);
    }
    if (active && attached === active.container && !loading) {
      active.content = children;
      active.used = ++clock.current;
      active.cost = undefined;
    }
    const inactive = [...state.entries].filter(([, entry]) => entry !== active);
    const retained = new Map(state.entries);
    let bytes = 0,
      nodes = 0;
    const candidates = inactive
      .filter(([key, entry]) => {
        const cost = entry.cost ?? retainedCost(entry);
        entry.cost = cost;
        if (!entry.content || cost.bytes > MAX_ENTRY_BYTES || cost.nodes > MAX_ENTRY_NODES) {
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
      bytes -= entry.cost!.bytes;
      nodes -= entry.cost!.nodes;
    }
    if (retained.size !== state.entries.size) setState({ ...state, entries: retained });
  });
  return (
    <div className="conversation-cache-host" ref={host}>
      {[...state.entries].map(([key, entry]) =>
        createPortal(
          <CacheEntry
            active={entry === active && attached === entry.container}
            resources={entry.resources}
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
    </div>
  );
}
