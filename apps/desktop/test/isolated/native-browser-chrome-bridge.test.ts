import { expect, test } from 'bun:test';
import {
  isNativeBrowserChromeEnvelope,
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeSnapshot,
  type NativeBrowserChromeSnapshot,
} from '../../src/native-browser-chrome-bridge';

function snapshot(): NativeBrowserChromeSnapshot {
  return {
    scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 },
    revision: 1,
    theme: 'dark',
    interactive: true,
    covered: false,
    hosted: false,
    tabs: {
      scopeKey: 'tabs',
      tabs: [
        { id: 'browser', kind: 'browser', title: 'Example' },
        { id: 'child', kind: 'child', title: 'Child', sessionId: 'child-session' },
      ],
      active: 'browser',
      visible: true,
      present: true,
      restoring: false,
      restoreIssue: false,
    },
    toolbar: {
      id: 'browser',
      address: 'https://example.com/',
      readonlyURL: 'https://example.com/',
      loading: false,
      hasPage: true,
      canGoBack: false,
      canGoForward: false,
      canNavigate: true,
      notesAvailable: true,
      notesOpen: false,
      optionsAvailable: true,
    },
  };
}
const event = () => ({
  attachment: 'attachment',
  pageToken: 'page',
  sequence: 1,
  revision: 1,
  part: 'toolbar',
  action: { type: 'navigate' },
});

test('Chrome transports only bounded display data and rejects callbacks, unknown fields and oversized Unicode payloads', () => {
  const value = snapshot();
  expect(isNativeBrowserChromeSnapshot(value)).toBe(true);
  expect(
    isNativeBrowserChromeEnvelope({
      attachment: 'attachment',
      pageToken: 'page',
      hosted: true,
      actionable: false,
      snapshot: value,
    }),
  ).toBe(true);
  for (const changed of [
    { ...value, serviceCaller: 'not-a-display-field' },
    { ...value, toolbar: { ...value.toolbar, dispatch: () => {} } },
    { ...value, tabs: { ...value.tabs, tabs: [...value.tabs.tabs, value.tabs.tabs[0]] } },
    {
      ...value,
      tabs: {
        ...value.tabs,
        tabs: Array.from({ length: 9 }, (_, i) => ({ id: String(i), kind: 'browser', title: 'x' })),
      },
    },
    { ...value, toolbar: { ...value.toolbar, address: 'x'.repeat(2049) } },
    {
      ...value,
      control: {
        id: 'browser',
        label: 'Agent',
        detail: 'x',
        handoffAvailable: true,
        closeAvailable: true,
        pending: false,
        details: Array(16).fill('雪'.repeat(2048)),
      },
    },
    { ...value, scope: { ...value.scope, generation: -1 } },
    { ...value, revision: NaN },
  ])
    expect(isNativeBrowserChromeSnapshot(changed)).toBe(false);
  const cycle: Record<string, unknown> = { ...value };
  cycle.self = cycle;
  expect(isNativeBrowserChromeSnapshot(cycle)).toBe(false);
});

test('Chrome action surface has no generic execution, request, CDP or navigation method escape', () => {
  for (const action of [
    { part: 'tabs', action: { type: 'select', id: 'child' } },
    { part: 'toolbar', action: { type: 'address-change', value: 'https://example.org/' } },
    {
      part: 'control',
      action: { type: 'show-menu', anchor: { x: 1, y: 2, width: 28, height: 28 } },
    },
    { part: 'escape' },
    { part: 'focus-root' },
  ])
    expect(
      isNativeBrowserChromeEvent({
        ...event(),
        ...action,
        ...(action.part === 'escape' || action.part === 'focus-root' ? { action: undefined } : {}),
      }),
    ).toBe(true);
  for (const changed of [
    { ...event(), part: 'cdp', action: { type: 'Runtime.evaluate', expression: 'not executable' } },
    { ...event(), action: { type: 'request', method: 'browser.navigate' } },
    { ...event(), action: { type: 'navigate', code: 'not executable' } },
    { ...event(), part: 'tabs', action: { type: 'close', id: 'browser', sessionId: 'foreign' } },
    { ...event(), sequence: 0 },
    { ...event(), revision: 1.5 },
    { ...event(), attachment: '' },
    { ...event(), action: { type: 'address-change', value: 'x'.repeat(2049) } },
    { ...event(), action: { type: 'show-options', anchor: { x: -1, y: 2, width: 1, height: 1 } } },
    {
      ...event(),
      action: { type: 'show-options', anchor: { x: 1, y: 2, width: 1, height: Infinity } },
    },
  ])
    expect(isNativeBrowserChromeEvent(changed)).toBe(false);
});
