import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import {
  applyTheme,
  readThemePreference,
  type ThemePreference,
  useDesktopTheme,
} from '../../src/theme';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

let dark = false;
const listeners = new Set<(event: MediaQueryListEvent) => void>();
const nativePreferences: ThemePreference[] = [];
const media = {
  get matches() {
    return dark;
  },
  media: '(prefers-color-scheme: dark)',
  onchange: null,
  addListener: (listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener);
  },
  removeListener: (listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener);
  },
  addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener);
  },
  removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener);
  },
  dispatchEvent: () => true,
} as MediaQueryList;
Object.defineProperty(dom.window, 'matchMedia', {
  configurable: true,
  value: () => media,
});
Object.defineProperty(dom.window, 'kiteDesktop', {
  configurable: true,
  value: {
    setTheme: async (preference: ThemePreference) => {
      nativePreferences.push(preference);
    },
  },
});

let root: ReturnType<typeof createRoot> | undefined;
let current: ReturnType<typeof useDesktopTheme>;
function Probe() {
  current = useDesktopTheme();
  return <span>{current.value}</span>;
}
async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
}
async function change(preference: ThemePreference) {
  await act(async () => current.onChange(preference));
}
function setSystemDark(value: boolean) {
  dark = value;
  for (const listener of [...listeners]) listener({ matches: value } as MediaQueryListEvent);
}
async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = undefined;
}
afterEach(async () => {
  await unmount();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  window.localStorage.clear();
  listeners.clear();
  nativePreferences.length = 0;
  dark = false;
});
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('saved preference is restored after remount and forwarded to native bridge', async () => {
  await mount();
  expect(current.value).toBe('system');
  await change('dark');
  expect(readThemePreference()).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  await unmount();
  await mount();
  expect(current.value).toBe('dark');
  expect(nativePreferences).toEqual(['system', 'dark', 'dark']);
});

test('system follows media changes and fixed preferences ignore them', async () => {
  await mount();
  expect(document.documentElement.dataset.theme).toBe('light');
  setSystemDark(true);
  expect(document.documentElement.dataset.theme).toBe('dark');
  await change('light');
  expect(listeners.size).toBe(0);
  setSystemDark(false);
  setSystemDark(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  await change('dark');
  setSystemDark(false);
  expect(document.documentElement.dataset.theme).toBe('dark');
  await change('system');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(listeners.size).toBe(1);
  await unmount();
  expect(listeners.size).toBe(0);
});

test('storage refusal does not prevent changing appearance or notifying native bridge', async () => {
  const storagePrototype = Object.getPrototypeOf(window.localStorage);
  const originalSetItem = Object.getOwnPropertyDescriptor(storagePrototype, 'setItem')!;
  let attempted = false;
  Object.defineProperty(storagePrototype, 'setItem', {
    configurable: true,
    value: () => {
      attempted = true;
      throw new Error('storage denied');
    },
  });
  try {
    await mount();
    await change('dark');
    expect(attempted).toBe(true);
    expect(current.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(nativePreferences.at(-1)).toBe('dark');
  } finally {
    Object.defineProperty(storagePrototype, 'setItem', originalSetItem);
  }
});

test('invalid saved preference defaults to system and applyTheme sets both DOM hints', () => {
  window.localStorage.setItem('kite.desktop.theme', 'invalid');
  expect(readThemePreference()).toBe('system');
  applyTheme('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
});
