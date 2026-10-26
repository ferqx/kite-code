import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeferredProcessContent as DeferredProcessContentType } from '../../src/desktop/DeferredProcessContent';
import type { ToolActivity as ToolActivityType } from '../../src/desktop/ToolActivity';
import type { Message } from '../../src/desktop/types';

let DeferredProcessContent: typeof DeferredProcessContentType;
let ToolActivity: typeof ToolActivityType;
let Collapsible: typeof import('../../src/desktop/components/ui/collapsible').Collapsible;
let CollapsibleTrigger: typeof import('../../src/desktop/components/ui/collapsible').CollapsibleTrigger;

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  DeferredProcessContent ??= (await import('../../src/desktop/DeferredProcessContent'))
    .DeferredProcessContent;
  ToolActivity ??= (await import('../../src/desktop/ToolActivity')).ToolActivity;
  const collapsible = await import('../../src/desktop/components/ui/collapsible');
  Collapsible ??= collapsible.Collapsible;
  CollapsibleTrigger ??= collapsible.CollapsibleTrigger;
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const projections: string[] = [];
  const mounted: string[] = [];
  const released: string[] = [];
  const toggles: boolean[] = [];
  function Probe({ label }: { label: string }) {
    useEffect(() => {
      mounted.push(label);
      return () => {
        released.push(label);
      };
    }, [label]);
    return <p data-probe="">{label}</p>;
  }
  const render = (open: boolean, label: string, restored = false) =>
    act(async () =>
      root.render(
        <Collapsible open={open} onOpenChange={(next) => toggles.push(next)}>
          <div data-restored-expanded={restored || undefined}>
            <CollapsibleTrigger>Process summary</CollapsibleTrigger>
            <DeferredProcessContent
              className="agent-turn-content"
              open={open}
              render={() => {
                projections.push(label);
                return <Probe label={label} />;
              }}
            />
          </div>
        </Collapsible>,
      ),
    );
  const renderTool = (messages: Message[], open = false, grouped = false) =>
    act(async () =>
      root.render(
        <ToolActivity
          messages={messages}
          aggregate={grouped}
          expanded={open}
          onToggle={(next) => toggles.push(next)}
          renderItem={(message) => {
            projections.push(message.text);
            return <Probe label={message.text} />;
          }}
          renderChildren={(id) => {
            projections.push(`child-${id}`);
            return <Probe key={id} label={`child-${id}`} />;
          }}
        />,
      ),
    );
  return {
    host,
    dom,
    projections,
    mounted,
    released,
    toggles,
    render,
    renderTool,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('a cold closed process does not create content, project descendants or start their effects', async () => {
  const f = await fixture();
  try {
    await f.render(false, 'old hidden history');
    await f.render(false, 'latest hidden history');
    expect(f.host.querySelector('.agent-turn-content')).toBeNull();
    expect(f.projections).toEqual([]);
    expect(f.mounted).toEqual([]);
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(f.toggles).toEqual([true]);
    await f.render(true, 'latest hidden history');
    expect(f.projections).toEqual(['latest hidden history']);
    expect(f.mounted).toEqual(['latest hidden history']);
    expect(f.host.querySelector('.agent-turn-content')?.getAttribute('data-state')).toBe('open');
    expect(f.host.querySelector('.collapsible-motion-reveal-inner')?.textContent).toBe(
      'latest hidden history',
    );
  } finally {
    await f.close();
  }
});

test('default open and restored processes immediately render their original complete disclosure', async () => {
  const f = await fixture();
  try {
    await f.render(true, 'active process', true);
    expect(f.projections).toEqual(['active process']);
    expect(f.mounted).toEqual(['active process']);
    expect(f.host.querySelector('[data-restored-expanded="true"]')).not.toBeNull();
    expect(f.host.querySelector('.agent-turn-content')?.getAttribute('data-state')).toBe('open');
    expect(f.host.querySelector('.collapsible-motion-reveal')).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('closing retires descendants and further closed updates remain lazy while reopening uses latest data', async () => {
  const f = await fixture();
  try {
    await f.render(true, 'first reading');
    await f.render(false, 'closed update');
    // Radix keeps children for the closing commit / optional exit animation.
    // Its current facts still replace old reader identities before unmount.
    expect(f.released).toEqual(['first reading', 'closed update']);
    expect(f.projections).toEqual(['first reading', 'closed update']);
    const content = f.host.querySelector('.agent-turn-content');
    expect(content).not.toBeNull();
    expect(content?.getAttribute('data-state')).toBe('closed');
    await f.render(false, 'second closed update');
    expect(f.projections).toEqual(['first reading', 'closed update']);
    await f.render(true, 'latest reopened reading');
    expect(f.host.querySelector('.agent-turn-content') === content).toBe(true);
    expect(f.projections).toEqual(['first reading', 'closed update', 'latest reopened reading']);
    expect(f.mounted).toEqual(['first reading', 'closed update', 'latest reopened reading']);
  } finally {
    await f.close();
  }
});

const tool = (id: string, text = `Detail ${id}`): Message => ({
  id: `tool:${id}`,
  role: 'tool',
  toolName: 'custom_tool',
  text,
  settled: true,
  status: 'completed',
});

test('closed aggregate tools defer original per-item renderers until expanded and use current records', async () => {
  const f = await fixture();
  try {
    await f.renderTool([tool('one'), tool('two')], false, true);
    expect(f.projections).toEqual([]);
    expect(f.mounted).toEqual([]);
    expect(f.host.querySelector('.tool-activity-content')).toBeNull();
    await f.renderTool([tool('one'), tool('two'), tool('three')], false, true);
    expect(f.projections).toEqual([]);
    await f.renderTool([tool('one'), tool('two'), tool('three')], true, true);
    expect(f.projections).toEqual(['Detail one', 'Detail two', 'Detail three']);
    expect(f.mounted).toHaveLength(3);
    expect(f.host.querySelector('[data-slot="trace-collapsible-content"]')).not.toBeNull();
    await f.renderTool([tool('one')], false, true);
    expect(f.released).toHaveLength(3);
    const closingProjections = f.projections.length;
    expect(closingProjections).toBe(4);
    await f.renderTool([tool('one'), tool('two')], false, true);
    expect(f.projections).toHaveLength(closingProjections);
  } finally {
    await f.close();
  }
});

test('known leaf detail defers child projection; ambiguous empty leaves retain their disclosure test without mounting children', async () => {
  const f = await fixture();
  try {
    await f.renderTool([tool('one')]);
    expect(f.projections).toEqual([]);
    expect(f.mounted).toEqual([]);
    await f.renderTool([tool('one')], true);
    expect(f.projections).toEqual(['child-one']);
    expect(f.host.textContent).toContain('Detail one');
    expect(f.mounted).toEqual(['child-one']);
    await f.renderTool([tool('empty', '')]);
    expect(f.projections).toEqual(['child-one', 'child-empty']);
    expect(f.mounted).toEqual(['child-one', 'child-empty']);
    expect(f.released).toEqual(['child-one', 'child-empty']);
    expect(f.host.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  } finally {
    await f.close();
  }
});
