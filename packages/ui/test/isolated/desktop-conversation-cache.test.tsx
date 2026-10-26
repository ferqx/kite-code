import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, Profiler, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useConversationReadActive,
  useConversationResourceRetention,
} from '../../src/conversation-activity';
import { ConversationCache } from '../../src/desktop/ConversationCache';

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const original = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const costTasks = new Map<number, () => void>();
  let timerId = 0;
  dom.window.setTimeout = ((task: () => void) => {
    const id = ++timerId;
    costTasks.set(id, task);
    return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id) => {
    costTasks.delete(id!);
  };
  let scans = 0;
  const createTreeWalker = dom.window.document.createTreeWalker.bind(dom.window.document);
  dom.window.document.createTreeWalker = (...args) => {
    if (
      args[0] instanceof dom.window.HTMLElement &&
      args[0].className === 'conversation-cache-container'
    )
      scans++;
    return createTreeWalker(...args);
  };
  const flushCosts = () =>
    act(async () => {
      await Promise.resolve();
      for (let count = 0; costTasks.size; count++) {
        expect(count).toBeLessThan(1000);
        const [id, task] = costTasks.entries().next().value!;
        costTasks.delete(id);
        task();
        await Promise.resolve();
      }
    });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const effects = new Set<string>(),
    reads = new Set<string>(),
    calls: string[] = [],
    released: string[] = [];
  const layouts: { id: string; connected: boolean; top?: number }[] = [];
  const visibleCommits: { id: string; connected: boolean }[] = [];
  const commits: string[] = [];
  function Probe({
    id,
    text,
    nodes = 0,
    mediaBytes = 0,
    withViewport = false,
    repeatMediaRegistration = false,
  }: {
    id: string;
    text: string;
    nodes?: number;
    mediaBytes?: number;
    withViewport?: boolean;
    repeatMediaRegistration?: boolean;
  }) {
    const readable = useConversationReadActive();
    const retention = useConversationResourceRetention();
    useEffect(() => {
      if (!mediaBytes || !retention) return;
      const release = () => {
        released.push(id);
        unregister();
      };
      const resource = { bytes: mediaBytes, release };
      const original = retention.retain(resource);
      const unregister = repeatMediaRegistration ? retention.retain(resource) : original;
      if (repeatMediaRegistration) original();
      return () => {
        if (!retention.isPaused()) release();
      };
    }, [id, mediaBytes, repeatMediaRegistration, retention]);
    const [count, setCount] = useState(0);
    const element = useRef<HTMLElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const reading = useRef(0);
    useLayoutEffect(() => {
      visibleCommits.push({ id, connected: element.current!.isConnected });
    });
    useLayoutEffect(() => {
      const view = viewport.current;
      if (view) view.scrollTop = reading.current;
      layouts.push({ id, connected: element.current!.isConnected, top: view?.scrollTop });
      return () => {
        if (view) reading.current = view.scrollTop;
      };
    }, [id]);
    useEffect(() => {
      effects.add(id);
      return () => {
        effects.delete(id);
      };
    }, [id]);
    useEffect(() => {
      if (!readable) return;
      reads.add(id);
      return () => {
        reads.delete(id);
      };
    }, [readable, id]);
    return (
      <section data-probe={id} ref={element}>
        {withViewport && (
          <div className="conversation-viewport" ref={viewport} style={{ overflow: 'auto' }}>
            <div style={{ height: 1000 }}>reading viewport</div>
          </div>
        )}
        <textarea defaultValue={id} />
        <button
          type="button"
          onClick={() => {
            calls.push(id);
            setCount((value) => value + 1);
          }}
        >
          count {count}
        </button>
        <pre>{text}</pre>
        <div data-table="" style={{ overflow: 'auto', width: 30 }}>
          <table>
            <tbody>
              <tr>
                <td>wide table content</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          {Array.from({ length: nodes }, (_, index) => (
            <span key={index}>node</span>
          ))}
        </div>
      </section>
    );
  }
  return {
    host,
    effects,
    reads,
    calls,
    released,
    layouts,
    visibleCommits,
    commits,
    flushCosts,
    get scans() {
      return scans;
    },
    get pendingCosts() {
      return costTasks.size;
    },
    async render(
      id: string,
      options: {
        loading?: boolean;
        readable?: boolean;
        visible?: boolean;
        scope?: string;
        revision?: string;
        text?: string;
        nodes?: number;
        mediaBytes?: number;
        accounted?: boolean;
        withViewport?: boolean;
        repeatMediaRegistration?: boolean;
      } = {},
    ) {
      await act(async () =>
        root.render(
          <Profiler
            id="cache"
            onRender={(_id, phase) => {
              commits.push(phase);
            }}
          >
            <ConversationCache
              identity={id}
              loading={options.loading ?? false}
              visible={options.visible ?? true}
              cache={{
                scope: options.scope ?? 'store/window',
                revision: options.revision ?? '1',
                readActive: options.readable ?? true,
              }}
            >
              <Probe
                id={id}
                text={options.text ?? id}
                nodes={options.nodes}
                mediaBytes={options.mediaBytes}
                withViewport={options.withViewport}
                repeatMediaRegistration={options.repeatMediaRegistration}
              />
            </ConversationCache>
          </Profiler>,
        ),
      );
      if (options.accounted !== false) await flushCosts();
      return host.querySelector<HTMLElement>('[data-probe]')!;
    },
    async close() {
      await act(async () => root.unmount());
      expect(effects.size).toBe(0);
      expect(reads.size).toBe(0);
      expect(costTasks.size).toBe(0);
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('KeepAlive restores the same DOM, component state and table position while hidden effects stop and cached preview rejects operations', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a');
    a.querySelector('textarea')!.value = 'local DOM draft';
    const table = a.querySelector<HTMLElement>('[data-table]')!;
    table.scrollLeft = 39;
    await act(async () =>
      table.dispatchEvent(new table.ownerDocument.defaultView!.Event('scroll')),
    );
    await act(async () => a.querySelector('button')!.click());
    await f.flushCosts();
    const b = await f.render('b');
    table.scrollLeft = 0; // Real browsers can clear detached nested scroll offsets.
    expect(a.isConnected).toBe(false);
    expect(f.host.textContent?.includes('count 1')).toBe(false);
    expect([...f.effects]).toEqual(['b']);
    expect([...f.reads]).toEqual(['b']);
    await act(async () => a.querySelector('button')!.click());
    expect(f.calls).toEqual(['a']);
    const cached = await f.render('a', {
      loading: true,
      readable: false,
      text: 'unverified replacement',
    });
    expect(cached === a).toBe(true);
    expect(a.querySelector('button')!.matches(':disabled')).toBe(false);
    expect(a.closest('fieldset')!.getAttribute('aria-disabled')).toBe('true');
    expect(b.isConnected).toBe(false);
    expect(a.querySelector('textarea')!.value).toBe('local DOM draft');
    expect(table.scrollLeft).toBe(39);
    expect(a.textContent?.includes('count 1')).toBe(true);
    expect(a.textContent?.includes('unverified replacement')).toBe(false);
    expect([...f.effects]).toEqual(['a']);
    expect(f.reads.size).toBe(0);
    await act(async () => a.querySelector('button')!.click());
    expect(f.calls).toEqual(['a']);
    expect((await f.render('a', { text: 'fresh replacement' })) === a).toBe(true);
    expect(a.textContent?.includes('fresh replacement')).toBe(true);
    expect(a.querySelector('[data-table]') === table).toBe(true);
    expect([...f.reads]).toEqual(['a']);
  } finally {
    await f.close();
  }
});

test('eight inactive trees use recent access for eviction and a reset retires inactive trees without replacing the active DOM', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a');
    const b = await f.render('b');
    for (const id of ['c', 'd', 'e', 'f', 'g', 'h', 'i']) await f.render(id);
    expect((await f.render('a')) === a).toBe(true);
    await f.render('j');
    expect((await f.render('b')) === b).toBe(false);
    const current = f.host.querySelector('[data-probe]');
    expect((await f.render('b', { revision: 'reset' })) === current).toBe(true);
    expect((await f.render('a', { revision: 'reset' })) === a).toBe(false);
    const previous = f.host.querySelector('[data-probe]');
    expect((await f.render('a', { scope: 'new-store' })) === previous).toBe(false);
    expect(f.effects.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('an oversized active conversation remains complete but its DOM is released on leaving', async () => {
  const f = await fixture();
  try {
    const text = 'x'.repeat(4 * 1024 * 1024 + 1);
    const a = await f.render('a', { text });
    expect(a.querySelector('pre')!.textContent?.length).toBe(text.length);
    await f.render('b');
    expect((await f.render('a', { text })) === a).toBe(false);
    expect(f.host.querySelector('pre')!.textContent?.length).toBe(text.length);
    await f.render('a', { visible: false });
    expect(f.host.textContent).toBe('');
    expect(f.effects.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('node budgets evict large trees before the session count limit without truncating the active view', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a', { nodes: 4000 });
    expect(a.querySelectorAll('span').length).toBe(4000);
    await f.render('b', { nodes: 4000 });
    await f.render('c', { nodes: 4000 });
    await f.render('d');
    expect((await f.render('a', { nodes: 4000 })) === a).toBe(false);
    expect(f.host.querySelectorAll('span').length).toBe(4000);
    for (let index = 0; index < 100; index++) {
      await f.render(`session-${index}`);
      expect(f.effects.size).toBe(1);
      expect(f.reads.size).toBe(1);
      expect(f.host.querySelectorAll('[data-probe]').length).toBe(1);
    }
  } finally {
    await f.close();
  }
});

test('retained media participates in the entry and total budgets and is released on eviction and scope disposal', async () => {
  const f = await fixture();
  try {
    const large = await f.render('large', { mediaBytes: 8 * 1024 * 1024 });
    await f.render('a', { mediaBytes: 6 * 1024 * 1024 });
    expect(f.released).toEqual(['large']);
    const a = await f.render('a', { mediaBytes: 6 * 1024 * 1024 });
    await f.render('b', { mediaBytes: 6 * 1024 * 1024 });
    await f.render('c', { mediaBytes: 6 * 1024 * 1024 });
    await f.render('d');
    expect(f.released).toEqual(['large', 'a']);
    expect(large.isConnected || a.isConnected).toBe(false);
    await f.render('d', { scope: 'another-store' });
    expect(f.released).toEqual(['large', 'a', 'b', 'c']);
  } finally {
    await f.close();
  }
});

test('a stale resource unregister cannot omit the current resource from budget eviction or unmount release', async () => {
  const f = await fixture();
  try {
    const options = { mediaBytes: 6 * 1024 * 1024, repeatMediaRegistration: true };
    const a = await f.render('a', options);
    await f.render('b', options);
    await f.render('c', options);
    await f.render('d');
    expect(a.isConnected).toBe(false);
    expect(f.released).toEqual(['a']);
  } finally {
    await f.close();
  }
  expect(f.released).toEqual(['a', 'b', 'c']);
});

test('unchanged commits and admitted warm switches do not scan the DOM in their layout path', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a');
    const firstScans = f.scans;
    for (let index = 0; index < 5; index++) await f.render('a', { readable: index % 2 === 0 });
    expect(f.scans).toBe(firstScans);
    expect(f.pendingCosts).toBe(0);
    await f.render('b');
    const beforeSwitch = f.scans;
    expect((await f.render('a', { loading: true, readable: false, accounted: false })) === a).toBe(
      true,
    );
    expect(f.scans).toBe(beforeSwitch);
    expect(f.pendingCosts).toBe(0);
  } finally {
    await f.close();
  }
});

test('unmeasured and newly dirty outgoing DOM is released without performing a switch-time scan', async () => {
  const f = await fixture();
  try {
    const unknown = await f.render('unknown', { accounted: false });
    expect(f.scans).toBe(0);
    await f.render('b', { accounted: false });
    expect(unknown.isConnected).toBe(false);
    expect(f.scans).toBe(0);
    expect((await f.render('unknown')) === unknown).toBe(false);
    const measured = f.host.querySelector<HTMLElement>('[data-probe]')!;
    measured.querySelector('pre')!.firstChild!.nodeValue = 'changed after the last measurement';
    const beforeSwitch = f.scans;
    await f.render('b', { accounted: false });
    expect(measured.isConnected).toBe(false);
    expect(f.scans).toBe(beforeSwitch);
    expect((await f.render('unknown')) === measured).toBe(false);
  } finally {
    await f.close();
  }
});

test('hidden DOM changes retire the original cache entry and scope disposal cancels pending accounting', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a');
    await f.render('b');
    const before = f.scans;
    await act(async () => {
      a.querySelector('pre')!.firstChild!.nodeValue = 'late hidden mutation';
      await Promise.resolve();
    });
    expect(f.scans).toBe(before);
    expect((await f.render('a')) === a).toBe(false);
    await f.render('pending', { nodes: 2000, accounted: false });
    expect(f.pendingCosts).toBeGreaterThan(0);
    await f.render('other-scope', { scope: 'new-scope', accounted: false });
    const beforeFlush = f.scans;
    await f.flushCosts();
    expect(f.scans).toBe(beforeFlush + 1);
    expect(f.pendingCosts).toBe(0);
  } finally {
    await f.close();
  }
});

test('a warm portal connects before descendant layout restoration without a nested visible commit', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a', { withViewport: true });
    const viewport = a.querySelector<HTMLElement>('.conversation-viewport')!;
    const nested = a.querySelector<HTMLElement>('[data-table]')!;
    viewport.scrollTop = 87;
    nested.scrollLeft = 39;
    await act(async () =>
      nested.dispatchEvent(new nested.ownerDocument.defaultView!.Event('scroll')),
    );
    await f.render('b', { withViewport: true });
    expect(a.isConnected).toBe(false);
    viewport.scrollTop = 0;
    nested.scrollLeft = 0;
    const before = f.commits.length;
    const beforeVisible = f.visibleCommits.length;
    expect(
      (await f.render('a', {
        withViewport: true,
        loading: true,
        readable: false,
        accounted: false,
      })) === a,
    ).toBe(true);
    // Activity may finish a hidden tree in another background update. Restoring
    // the visible tree must not schedule the former nested setAttached commit.
    expect(f.commits.slice(before).every((phase) => phase === 'update')).toBe(true);
    expect(f.visibleCommits.slice(beforeVisible)).toEqual([{ id: 'a', connected: true }]);
    expect(f.layouts.every((layout) => layout.connected)).toBe(true);
    expect(f.layouts.at(-1)).toEqual({ id: 'a', connected: true, top: 87 });
    expect(viewport.scrollTop).toBe(87);
    expect(nested.scrollLeft).toBe(39);
    expect(a.closest('.conversation-cache-container')?.hasAttribute('data-restoring')).toBe(true);
    expect(a.closest('fieldset')?.getAttribute('aria-disabled')).toBe('true');
    expect(f.reads.size).toBe(0);
    expect([...f.effects]).toEqual(['a']);
  } finally {
    await f.close();
  }
});
