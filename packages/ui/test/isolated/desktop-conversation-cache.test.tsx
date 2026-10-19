import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect, useState } from 'react';
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
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const effects = new Set<string>(),
    reads = new Set<string>(),
    calls: string[] = [],
    released: string[] = [];
  function Probe({
    id,
    text,
    nodes = 0,
    mediaBytes = 0,
  }: {
    id: string;
    text: string;
    nodes?: number;
    mediaBytes?: number;
  }) {
    const readable = useConversationReadActive();
    const retention = useConversationResourceRetention();
    useEffect(() => {
      if (!mediaBytes || !retention) return;
      const release = () => {
        released.push(id);
        unregister();
      };
      const unregister = retention.retain({ bytes: mediaBytes, release });
      return () => {
        if (!retention.isPaused()) release();
      };
    }, [id, mediaBytes, retention]);
    const [count, setCount] = useState(0);
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
      <section data-probe={id}>
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
      } = {},
    ) {
      await act(async () =>
        root.render(
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
            />
          </ConversationCache>,
        ),
      );
      return host.querySelector<HTMLElement>('[data-probe]')!;
    },
    async close() {
      await act(async () => root.unmount());
      expect(effects.size).toBe(0);
      expect(reads.size).toBe(0);
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

test('three inactive trees use recent access for eviction and a reset retires inactive trees without replacing the active DOM', async () => {
  const f = await fixture();
  try {
    const a = await f.render('a');
    const b = await f.render('b');
    await f.render('c');
    await f.render('d');
    expect((await f.render('a')) === a).toBe(true);
    await f.render('e');
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
