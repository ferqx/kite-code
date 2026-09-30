import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});
dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(0), 0);
dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle);
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Element: dom.window.Element,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let root: import('react-dom/client').Root | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const { createRoot } = await import('react-dom/client');
const { ModelEffortSelector } = await import('../../src/ModelEffortSelector');

async function render(element: React.ReactNode) {
  root = createRoot(document.body);
  await act(() => root!.render(element));
}
async function click(element: HTMLElement | null) {
  if (!element) throw new Error('Expected a clickable selector element');
  await act(async () => {
    element.click();
  });
}
async function openSelector() {
  await click(document.querySelector('[data-model-trigger]'));
  expect(document.querySelector('.model-effort-popover')).not.toBeNull();
}

test('same-name models remain distinct by provider and the popup uses two columns without radio choices', async () => {
  const selected: Array<[string, string]> = [];
  const models = [
    { provider: 'OpenAI', name: 'shared-model', reasoningEffortSupported: true },
    { provider: 'Gateway', name: 'shared-model', reasoningEffortSupported: true },
  ];
  await render(
    <ModelEffortSelector
      model={{ provider: 'OpenAI', name: 'shared-model' }}
      models={models}
      onModelChange={(provider, name) => selected.push([provider, name])}
      onReasoningEffortChange={() => {}}
    />,
  );
  await openSelector();
  await click(document.querySelector('.model-effort-switch'));
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
  expect(document.querySelectorAll('[data-provider-scroll]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-model-scroll]')).toHaveLength(1);
  const gateway = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => tab.textContent === 'Gateway',
  );
  if (!gateway) throw new Error('Missing Gateway provider tab');
  await act(() => {
    gateway.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  expect(
    document.querySelector('.model-effort-columns [role="tab"][aria-selected="true"]')?.textContent,
  ).toBe('Gateway');
  await click(document.querySelector('.model-effort-columns [cmdk-item]'));
  expect(selected).toEqual([['Gateway', 'shared-model']]);
  expect(document.querySelector('.model-effort-panel')).not.toBeNull();
});

test('unknown configured effort stays visible as configured and absent effort remains default', async () => {
  const props = {
    model: { provider: 'OpenAI', name: 'model' },
    models: [{ provider: 'OpenAI', name: 'model', reasoningEffortSupported: true }],
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
  };
  await render(<ModelEffortSelector {...props} reasoningEffort="legacy-extra" />);
  await openSelector();
  expect(document.querySelector('.effort-value')?.textContent).toBe('legacy-extra');
  expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe(
    'legacy-extra',
  );
  await act(() => root!.render(<ModelEffortSelector {...props} reasoningEffort={undefined} />));
  expect(document.querySelector('.effort-value')?.textContent).toBe('默认');
  expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('默认');
});

test('unsupported or missing model does not offer an ineffective effort slider', async () => {
  const props = {
    model: { provider: 'DeepSeek', name: 'chat' },
    models: [{ provider: 'DeepSeek', name: 'chat', reasoningEffortSupported: false }],
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
  };
  await render(<ModelEffortSelector {...props} />);
  await openSelector();
  expect(document.querySelector('[role="slider"]')).toBeNull();
  expect(document.querySelector('.model-effort-unavailable')?.textContent).toContain('不支持');
  await click(document.querySelector('.model-effort-switch'));
  expect(document.querySelector('.model-effort-columns [cmdk-item]')).not.toBeNull();

  await act(() =>
    root!.render(<ModelEffortSelector {...props} model={{ provider: 'missing', name: 'chat' }} />),
  );
  await click(document.querySelector('[data-model-trigger]'));
  expect(document.querySelector('[role="slider"]')).toBeNull();
});
