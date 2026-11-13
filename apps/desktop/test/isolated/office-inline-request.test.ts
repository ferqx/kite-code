import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { decodeNativeRequest } from '../../electron/native-ipc';
import {
  officeChromeCss,
  officeRequestHtml,
  officeRequestInstallScript,
  officeRequestReadScript,
  officeRequestSettleScript,
} from '../../electron/office-request-input';

function fixture() {
  const dom = new JSDOM(officeRequestHtml, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const add = win.EventTarget.prototype.addEventListener;
  win.EventTarget.prototype.addEventListener = function (
    name: string,
    callback: unknown,
    options?: unknown,
  ) {
    handlers.set(name, [...(handlers.get(name) ?? []), callback as (event: unknown) => void]);
    return add.call(this, name, callback as EventListener, options as boolean);
  };
  win.eval(officeRequestInstallScript('请求修改 · 第 2 页'));
  const input = win.document.querySelector('textarea')!;
  return {
    win,
    input,
    fire: (name: string, extra: Record<string, unknown> = {}) =>
      handlers.get(name)?.forEach((fn) => {
        fn({ target: input, isTrusted: true, key: '', preventDefault() {}, ...extra });
      }),
    read: () => JSON.parse(JSON.stringify(win.eval(officeRequestReadScript))),
    settle: (serial: number, status: 'accepted' | 'failed' | 'unknown') =>
      win.eval(officeRequestSettleScript(serial, { status })),
    close: () => win.close(),
  };
}
test('inline Office Enter captures one exact prompt; blank, repeat, synthetic and IME Enter do not submit', () => {
  const f = fixture();
  for (const value of ['', '   ']) {
    f.input.value = value;
    f.fire('keydown', { key: 'Enter' });
    expect(f.read().pending).toBeUndefined();
  }
  f.input.value = '请精简这一段\n保留结论';
  f.fire('keydown', { key: 'Enter', target: f.win.document.querySelector('[data-cancel]') });
  expect(f.read().pending).toBeUndefined();
  for (const extra of [
    { shiftKey: true },
    { repeat: true },
    { isTrusted: false },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    f.fire('keydown', { key: 'Enter', ...extra });
    expect(f.read().pending).toBeUndefined();
  }
  f.fire('compositionstart');
  f.fire('keydown', { key: 'Enter' });
  expect(f.read().pending).toBeUndefined();
  f.fire('compositionend');
  f.fire('keydown', { key: 'Enter' });
  expect(f.read().pending).toEqual({ serial: 1, prompt: '请精简这一段\n保留结论' });
  f.fire('keydown', { key: 'Enter' });
  expect(f.read().pending.serial).toBe(1);
  expect(f.input.readOnly).toBe(true);
  f.close();
});
test('inline failed keeps text for explicit retry; unknown locks original request; accepted and Escape close', () => {
  const f = fixture();
  f.input.value = '更清楚';
  f.fire('keydown', { key: 'Enter' });
  f.settle(9, 'accepted');
  expect(f.read().cancelled).toBe(false);
  f.settle(1, 'failed');
  expect(f.input.value).toBe('更清楚');
  expect(f.input.readOnly).toBe(false);
  f.fire('keydown', { key: 'Enter' });
  expect(f.read().pending.serial).toBe(2);
  f.settle(2, 'unknown');
  f.fire('keydown', { key: 'Enter' });
  expect(f.read().pending.serial).toBe(2);
  expect(f.win.document.body.textContent).toContain('不会重复发送');
  f.settle(2, 'accepted');
  expect(f.read().cancelled).toBe(true);
  f.close();
  const cancelled = fixture();
  cancelled.input.value = '不要发送';
  cancelled.fire('keydown', { key: 'Escape' });
  expect(cancelled.read()).toEqual({ cancelled: true });
  cancelled.close();
});
test('inline outcome and open control decode only bounded data, not arbitrary commands', () => {
  const base = {
    method: 'outputs.preview.request.result',
    generation: 1,
    previewId: 'view',
    requestId: 'request',
    outcome: { status: 'failed', message: '稍后重试' },
  };
  expect(decodeNativeRequest(base)).toMatchObject(base);
  for (const outcome of [
    { status: 'eval' },
    { status: 'accepted', path: '/secret' },
    { status: 'unknown', message: 'x'.repeat(1025) },
  ])
    expect(() => decodeNativeRequest({ ...base, outcome })).toThrow();
  expect(
    decodeNativeRequest({
      method: 'outputs.preview.control',
      generation: 1,
      previewId: 'view',
      control: { kind: 'request-edit' },
    }),
  ).toBeDefined();
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.preview.control',
      generation: 1,
      previewId: 'view',
      control: { kind: 'request-edit', script: 'run' },
    }),
  ).toThrow();
  expect(officeRequestHtml).toContain("script-src 'none'");
});

test('isolated Office IPC rejects hidden generic attachments and ordinary draft proofs', () => {
  const target = {
    storeId: 'store',
    sessionId: 'session',
    fileId: 'file',
    locator: { kind: 'delivery', key: 'delivery/exact' },
  };
  const request = {
    method: 'submit',
    generation: 1,
    sessionId: 'session',
    intent: {
      kind: 'run.start',
      commandId: 'command',
      expectedStoreId: 'store',
      content: 'bounded request',
    },
    fileIds: ['chip'],
    officeDocument: {
      content: 'Please shorten',
      outputFiles: [
        {
          id: 'chip',
          name: 'deck.pptx',
          target,
          context: { sourceHash: 'a'.repeat(64), selection: { kind: 'powerpoint', slide: 1 } },
        },
      ],
    },
  };
  expect(decodeNativeRequest(request)).toBeDefined();
  for (const intent of [
    { ...request.intent, files: [] },
    { ...request.intent, images: [] },
  ])
    expect(() => decodeNativeRequest({ ...request, intent })).toThrow();
  expect(() =>
    decodeNativeRequest({
      ...request,
      officeDocument: { ...request.officeDocument, browserAnnotations: [] },
    }),
  ).toThrow();
  expect(() => decodeNativeRequest({ ...request, draft: { id: 'anything' } })).toThrow();
});

// The sandbox cannot load app styles or fonts. Pin its small static palette to the
// actual shared light tokens and the desktop content-frame dark overrides.
test('isolated Office chrome follows the client palette and platform font without external assets', () => {
  const shared = readFileSync(
    new URL('../../../../packages/ui/src/desktop/style.css', import.meta.url),
    'utf8',
  );
  const desktop = readFileSync(
    new URL('../../src/native-content-theme.css', import.meta.url),
    'utf8',
  );
  const value = (css: string, name: string) =>
    css.match(new RegExp(`--${name}:\\s*([^;]+);`))![1]!.trim();
  const dark = desktop.slice(
    desktop.indexOf('[data-theme="dark"] .kite-client .client-content-frame'),
  );
  for (const [office, client] of [
    ['background', 'background'],
    ['card', 'card'],
    ['foreground', 'foreground'],
    ['muted', 'muted-foreground'],
    ['border', 'border'],
    ['primary', 'primary'],
    ['primary-hover', 'primary-hover'],
    ['primary-foreground', 'primary-foreground'],
  ]) {
    expect(officeChromeCss).toContain(
      '--office-' +
        office +
        ': light-dark(' +
        value(shared, client!) +
        ', ' +
        value(dark, client!) +
        ')',
    );
  }
  expect(officeChromeCss).toContain(
    '--office-composer: light-dark(' +
      value(shared, 'card') +
      ', ' +
      value(dark, 'composer-background') +
      ')',
  );
  expect(officeChromeCss).toContain(
    '--office-composer-border: light-dark(' +
      value(shared, 'composer-border-color') +
      ', ' +
      value(dark, 'composer-border-color') +
      ')',
  );
  const platformFont =
    process.platform === 'win32'
      ? '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif'
      : process.platform === 'darwin'
        ? '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        : 'system-ui, "Ubuntu", "Droid Sans", sans-serif';
  expect(desktop).toContain(platformFont);
  expect(officeChromeCss).toContain(platformFont);
  expect(officeChromeCss).toContain('prefers-color-scheme: dark');
  expect(officeRequestHtml).not.toMatch(/<script|<link|url\(/i);
  expect(officeRequestHtml).toContain(`border-radius:${value(shared, 'radius')}`);
  expect(officeRequestHtml).toContain(`border-radius:${value(shared, 'button-radius')}`);
  for (const rule of [
    'button:hover:not(:disabled)',
    'button:active:not(:disabled)',
    'button:focus-visible',
    'button:disabled',
    'prefers-reduced-motion',
    '.request:focus-within',
  ])
    expect(officeRequestHtml).toContain(rule);
  expect(officeRequestHtml).not.toContain('#4b8df8');
});

test('Office toolbar keeps shared neutral states and compact client control metrics', () => {
  const css = readFileSync(new URL('../../src/native-office-toolbar.css', import.meta.url), 'utf8');
  for (const token of [
    '--font-ui',
    '--button-radius',
    '--control-hover',
    '--control-selected',
    '--control-pressed',
    '--foreground',
    '--border',
  ])
    expect(css).toContain(`var(${token}`);
  for (const state of [
    ':hover:not(:disabled)',
    ':active:not(:disabled)',
    ':focus-visible',
    ':disabled',
    '[aria-pressed="true"]',
  ])
    expect(css).toContain(state);
  expect(css).toContain('min-height: 28px');
  expect(css).not.toMatch(/#[0-9a-f]{3,8}|border-radius: (22|24)px/i);
});

test('request form keeps the idle surface concise and keyboard help discoverable', () => {
  const f = fixture();
  expect(f.win.document.querySelector('[role="status"]')?.textContent).toBe('');
  expect(f.win.document.body.textContent).not.toContain('Shift+Enter');
  expect(f.win.document.body.textContent).not.toContain('发送或关闭后可调整预览');
  expect(f.input.getAttribute('title')).toContain('Shift+Enter 换行');
  expect(f.input.getAttribute('aria-label')).toBe('修改要求');
  f.input.value = '修改';
  f.fire('keydown', { key: 'Enter' });
  expect(f.win.document.querySelector('[role="status"]')?.textContent).toBe('正在发送…');
  f.settle(1, 'unknown');
  expect(f.win.document.querySelector('[role="status"]')?.textContent).toContain('不会重复发送');
  f.close();
});

// Replays the observed native ordering; this handler harness is not a substitute
// for the separate Windows IME/candidate and Service receipt verification.
test('trusted non-composing release recovers after an untrusted IME end without submitting the candidate', () => {
  const f = fixture();
  f.input.value = 'qing';
  f.fire('keydown', { key: 'Process', keyCode: 229, isComposing: false });
  f.fire('compositionstart');
  for (const key of ['q', 'i', 'n', 'g', 'ArrowDown', 'ArrowUp']) {
    f.fire('keydown', { key: 'Process', keyCode: 229, isComposing: true });
    f.fire('keyup', { key: 'Process', keyCode: 229, isComposing: true });
    f.fire('keyup', { key, isComposing: true });
    expect(f.read().pending).toBeUndefined();
  }
  f.fire('keydown', { key: 'Process', keyCode: 229, isComposing: true });
  f.fire('compositionend', { isTrusted: false });
  expect(f.read().pending).toBeUndefined();
  f.fire('keyup', { key: 'Process', keyCode: 229, isComposing: false });
  expect(f.read().pending).toBeUndefined();
  f.input.value = '请将选中段落改为 Windows 文档编辑验证完成，并保留其他内容。';
  let prevented = false;
  f.fire('keydown', {
    key: 'Enter',
    keyCode: 13,
    isComposing: false,
    preventDefault() {
      prevented = true;
    },
  });
  expect(prevented).toBe(true);
  expect(f.read().pending).toEqual({ serial: 1, prompt: f.input.value });
  f.fire('keyup', { key: 'Enter', keyCode: 13, isComposing: false });
  f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false, repeat: true });
  expect(f.read().pending.serial).toBe(1);
  f.close();
});

test('synthetic, other-target and still-composing releases cannot clear the native composition guard', () => {
  const f = fixture();
  f.input.value = '候选文字';
  f.fire('compositionstart');
  f.fire('compositionend', { isTrusted: false });
  for (const extra of [
    { isTrusted: false, isComposing: false },
    { isComposing: true },
    { isComposing: undefined },
    { isComposing: false, target: f.win.document.querySelector('[data-cancel]') },
  ]) {
    f.fire('keyup', { key: 'Enter', keyCode: 13, ...extra });
    f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
    expect(f.read().pending).toBeUndefined();
  }
  f.fire('keyup', { key: 'Enter', keyCode: 13, isComposing: false });
  expect(f.read().pending).toBeUndefined();
  f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false, isTrusted: false });
  expect(f.read().pending).toBeUndefined();
  f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false, shiftKey: true });
  expect(f.read().pending).toBeUndefined();
  // Another composition creates a fresh guard even after the previous release.
  f.fire('compositionstart');
  f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
  expect(f.read().pending).toBeUndefined();
  f.fire('keyup', { key: 'Enter', keyCode: 13, isComposing: false });
  expect(f.read().pending).toBeUndefined();
  f.fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
  expect(f.read().pending).toEqual({ serial: 1, prompt: '候选文字' });
  f.close();
});
