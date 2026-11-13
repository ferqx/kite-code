import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { afterAll, afterEach, expect, test } from '#kite-test';

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
const { ModelEffortSelector } = await import('../../src/desktop/ModelEffortSelector');

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

test('separate model and effort controls reuse the model columns and sparse gem slider independently', async () => {
  const modelChanges: string[] = [];
  const effortChanges: string[] = [];
  const models = [
    { id: 'a', provider: 'OpenAI', name: 'Same name' },
    {
      id: 'b',
      provider: 'Gateway',
      name: 'Same name',
      reasoningEffortChoices: ['low', 'high'] as const,
    },
  ];
  const props = {
    model: models[1],
    models,
    reasoningEffort: 'low',
    onModelChange: (_provider: string, _name: string, id?: string) => modelChanges.push(id!),
    onReasoningEffortChange: (effort: string) => effortChanges.push(effort),
  };
  await render(<ModelEffortSelector {...props} mode="model" />);
  expect(document.querySelector('[data-model-trigger]')!.getAttribute('aria-label')).toBe(
    '模型：Same name',
  );
  expect(document.querySelector('.model-effort-summary')).toBeNull();
  await openSelector();
  expect(document.querySelector('.model-effort-panel')).toBeNull();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(document.activeElement?.textContent).toBe('Gateway');
  await click(document.querySelector('[aria-label="选择模型 b"]'));
  expect(modelChanges).toEqual(['b']);
  expect(document.querySelector('.model-effort-popover')).toBeNull();
  expect(effortChanges).toEqual([]);

  await act(() => root!.render(<ModelEffortSelector {...props} mode="effort" />));
  expect(document.querySelector('[data-model-trigger]')).toBeNull();
  expect(document.querySelector('[data-effort-trigger]')!.textContent).toBe('轻度');
  await click(document.querySelector('[data-effort-trigger]'));
  expect(document.querySelector('.model-effort-columns')).toBeNull();
  expect(document.querySelector('.model-effort-switch')).toBeNull();
  expect(document.querySelectorAll('.gem-ticks i')).toHaveLength(2);
  await act(() =>
    document
      .querySelector('[role="slider"]')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(effortChanges).toContain('high');
  expect(effortChanges.every((effort) => effort === 'high')).toBe(true);
  expect(modelChanges).toEqual(['b']);
});

test('same-name models remain distinct by provider and the popup uses two columns without radio choices', async () => {
  const selected: Array<[string, string]> = [];
  const models = [
    { provider: 'OpenAI', name: 'shared-model' },
    { provider: 'Gateway', name: 'shared-model' },
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

test('configured effort stays visible and a missing configuration resolves to medium immediately', async () => {
  const changes: string[] = [];
  const props = {
    model: { provider: 'OpenAI', name: 'model' },
    models: [{ provider: 'OpenAI', name: 'model' }],
    onModelChange: () => {},
    onReasoningEffortChange: (value: string) => changes.push(value),
  };
  await render(<ModelEffortSelector {...props} reasoningEffort="legacy-extra" />);
  await openSelector();
  expect(document.querySelector('.effort-value')?.textContent).toBe('legacy-extra');
  expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe(
    'legacy-extra',
  );
  await act(() => root!.render(<ModelEffortSelector {...props} reasoningEffort={undefined} />));
  expect(document.querySelector('.effort-value')?.textContent).toBe('中');
  expect(document.querySelector('.model-effort-summary')?.textContent).toBe('中');
  expect(document.querySelector('[data-model-trigger]')?.getAttribute('aria-label')).toBe(
    '模型：model，思考程度：中',
  );
  expect(document.body.textContent).not.toContain('默认');
  expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('中');
  expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('1');
  expect(document.body.textContent).not.toContain('未指定');
  expect(changes).toEqual([]);
  await act(() =>
    root!.render(
      <ModelEffortSelector
        {...props}
        models={[{ ...props.models[0]!, reasoningEffort: 'high' }]}
      />,
    ),
  );
  expect(document.querySelector('.model-effort-summary')?.textContent).toBe('高');
  expect(document.querySelector('.effort-value')?.textContent).toBe('高');
  await act(() => root!.render(<ModelEffortSelector {...props} reasoningEffort="low" />));
  expect(document.querySelector('.model-effort-summary')?.textContent).toBe('轻度');
  expect(document.querySelector('.effort-value')?.textContent).toBe('轻度');
  expect(changes).toEqual([]);
});

test('every selected model offers effort adjustment without capability metadata; missing routes require selection', async () => {
  let chosenEffort: string | undefined;
  const props = {
    model: { provider: 'DeepSeek', name: 'chat' },
    models: [{ provider: 'DeepSeek', name: 'chat' }],
    onModelChange: () => {},
    onReasoningEffortChange: (effort: string) => {
      chosenEffort = effort;
    },
  };
  await render(<ModelEffortSelector {...props} />);
  await openSelector();
  const slider = document.querySelector('[role="slider"]')!;
  expect(slider).not.toBeNull();
  await act(() => {
    slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  });
  expect(chosenEffort).toBe('ultar');
  await click(document.querySelector('.model-effort-switch'));
  expect(document.querySelector('.model-effort-columns [cmdk-item]')).not.toBeNull();
  await click(document.querySelector('[data-model-trigger]'));

  await act(() =>
    root!.render(<ModelEffortSelector {...props} model={{ provider: 'missing', name: 'chat' }} />),
  );
  await openSelector();
  expect(document.querySelector('[role="slider"]')).toBeNull();
  expect(document.querySelector('.model-effort-panel')?.textContent).toBe('missing / chat');
});

test.each([
  'Home',
  'ArrowLeft',
  'ArrowDown',
  'PageDown',
])('the default medium slider moves once with %s and keeps all displayed values aligned', async (key) => {
  const changes: string[] = [];
  const model = { provider: 'Gateway', name: 'model' };
  function Host() {
    const [effort, setEffort] = useState<string>();
    return (
      <ModelEffortSelector
        model={model}
        models={[model]}
        reasoningEffort={effort}
        onModelChange={() => {}}
        onReasoningEffortChange={(value) => {
          changes.push(value);
          setEffort(value);
        }}
      />
    );
  }
  await render(<Host />);
  await openSelector();
  const slider = document.querySelector('[role="slider"]')!;
  expect(changes).toEqual([]);
  expect(document.querySelector('.gem-slider')?.hasAttribute('data-unselected')).toBe(false);
  expect(document.querySelectorAll('.gem-ticks [data-passed="true"]')).toHaveLength(2);
  expect(document.querySelector('.effort-value')?.textContent).toBe('中');
  await act(() =>
    slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })),
  );
  expect(changes).toEqual(['low']);
  expect(document.querySelector('.gem-slider')?.hasAttribute('data-unselected')).toBe(false);
  expect(document.querySelector('.effort-value')?.textContent).toBe('轻度');
  expect(document.querySelector('.model-effort-summary')?.textContent).toBe('轻度');
  expect(slider.getAttribute('aria-valuetext')).toBe('轻度');
  await act(() =>
    slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })),
  );
  expect(changes).toEqual(['low']);
});

test('the model trigger can describe its state without adding text to either popover view', async () => {
  const changes: string[] = [];
  let selectedEffort: string | undefined;
  await render(
    <ModelEffortSelector
      model={{ id: 'current', provider: 'OpenAI', name: 'current-model' }}
      models={[
        { id: 'current', provider: 'OpenAI', name: 'current-model' },
        { id: 'another', provider: 'OpenAI', name: 'another-model' },
      ]}
      onModelChange={(_provider, name) => changes.push(name)}
      onReasoningEffortChange={(effort) => {
        selectedEffort = effort;
      }}
      triggerDescription="所选思考档位当前不可用，请重新选择档位。"
    />,
  );
  const trigger = document.querySelector('[data-model-trigger]')!;
  expect(trigger.getAttribute('aria-description')).toBe('所选思考档位当前不可用，请重新选择档位。');
  await openSelector();
  expect(document.body.textContent).not.toContain('所选思考档位当前不可用');
  const slider = document.querySelector('[role="slider"]')!;
  await act(() =>
    slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(selectedEffort).toBe('ultar');
  await click(document.querySelector('.model-effort-switch'));
  expect(document.body.textContent).not.toContain('所选思考档位当前不可用');
  await click(document.querySelector('[aria-label="选择模型 another"]'));
  expect(changes).toEqual(['another-model']);
});
