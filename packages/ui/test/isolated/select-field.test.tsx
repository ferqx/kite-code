import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ReactNode, useState } from 'react';

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLFormElement',
    'HTMLSelectElement',
    'HTMLInputElement',
    'DocumentFragment',
    'Node',
    'Element',
    'Event',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value =
      key === 'window'
        ? dom.window
        : key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : Reflect.get(dom.window, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { SelectField } = await import('../../src/desktop/components/ui/select-field');
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  return {
    SelectField,
    host,
    render: (node: ReactNode) => act(() => root.render(node)),
    async choose(label: string) {
      const select = host.querySelector('select')!;
      const option = [...select.options].find((option) => option.textContent === label);
      expect(option).toBeDefined();
      await act(() => {
        select.value = option!.value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    },
    async close() {
      await act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('explicit empty selection retains required validation and exact arbitrary original values', async () => {
  const f = await fixture();
  const changes: string[] = [];
  function Form() {
    const [value, setValue] = useState('');
    return (
      <form>
        <f.SelectField
          aria-label="字段"
          required
          value={value}
          options={[
            { value: '', label: '请选择' },
            { value: 'option:0', label: '原始标记' },
            { value: '雪🙂', label: 'Unicode' },
          ]}
          onValueChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
        />
      </form>
    );
  }
  try {
    await f.render(<Form />);
    expect(changes).toEqual([]);
    expect(f.host.querySelector('form')!.checkValidity()).toBe(false);
    await f.choose('Unicode');
    expect(changes).toEqual(['雪🙂']);
    expect(f.host.querySelector('form')!.checkValidity()).toBe(true);
    await f.choose('请选择');
    expect(changes).toEqual(['雪🙂', '']);
    expect(f.host.querySelector('form')!.checkValidity()).toBe(false);
    await f.choose('原始标记');
    expect(changes).toEqual(['雪🙂', '', 'option:0']);
    expect(f.host.querySelector('[role="combobox"]')!.textContent).toBe('原始标记');
  } finally {
    await f.close();
  }
});

test('option replacement and temporary absence never choose a default or clear the external draft', async () => {
  const f = await fixture();
  const changes: string[] = [];
  const render = (options: { value: string; label: string }[]) =>
    f.render(
      <f.SelectField
        aria-label="字段"
        value="kept"
        placeholder="未选择"
        options={options}
        onValueChange={(next) => changes.push(next)}
      />,
    );
  try {
    await render([
      { value: 'kept', label: '原选择' },
      { value: 'other', label: '其他' },
    ]);
    await render([
      { value: 'other', label: '其他' },
      { value: 'kept', label: '原选择' },
    ]);
    expect(f.host.querySelector('[role="combobox"]')!.textContent).toBe('原选择');
    await render([{ value: 'other', label: '其他' }]);
    expect(f.host.querySelector('[role="combobox"]')!.textContent).toBe('未选择');
    await render([{ value: 'kept', label: '原选择' }]);
    expect(f.host.querySelector('[role="combobox"]')!.textContent).toBe('原选择');
    expect(changes).toEqual([]);
  } finally {
    await f.close();
  }
});
