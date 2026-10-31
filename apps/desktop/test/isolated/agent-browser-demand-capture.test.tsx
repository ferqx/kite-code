import { expect, test } from 'bun:test';
import type { ExtensionCommandRequest } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { BrowserNoteInput } from '../../src/browser-annotation-drafts';
import type { NativeExtensionScope } from '../../src/extensions-bridge';
import { browserFixture, browserScope, browserView } from '../agent-browser.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const data = (value: string) => Buffer.from(value).toString('base64');
function captured(browserId: string, marker: string, seq = '2') {
  return {
    ...browserView(),
    browserId,
    seq,
    title: marker,
    frame: { mimeType: 'image/jpeg' as const, data: data(marker), width: 800, height: 600, seq },
  };
}

async function setup(
  onCapture?: (
    request: ExtensionCommandRequest,
    fixture: ReturnType<typeof browserFixture>,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { AgentBrowserPanel } = await import('../../src/agent-browser-panel');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const f = browserFixture({
    async beforeAction(request) {
      if (request.actionId !== 'browser.capture')
        throw Error(`unexpected_annotation_action:${request.actionId}`);
      if (onCapture) await onCapture(request, f);
      else f.view = captured('browser', 'captured-A');
    },
  });
  // Only this instance advertises the new on-demand Action. Shared fixtures stay unchanged.
  f.catalogue[0]!.actions.push({
    id: 'browser.capture',
    version: '1',
    description: 'Capture this exact page',
    inputSchema: { type: 'object' },
  });
  f.view = { ...browserView(), frame: null, annotations: [] };
  const quotes: BrowserNoteInput[] = [];
  const flush = async (action: () => void = () => {}, ms = 30) => {
    await act(async () => {
      action();
      await Bun.sleep(ms);
    });
  };
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end)
        throw Error(`capture_DOM_timeout:${dom.window.document.body.textContent}`);
      await flush();
    }
  };
  const render = (
    visible = true,
    scope: NativeExtensionScope = browserScope,
    expectedBrowserId = 'browser',
    annotationOnly = true,
  ) =>
    flush(() =>
      root.render(
        <AgentBrowserPanel
          bridge={f.bridge}
          scope={scope}
          expectedBrowserId={expectedBrowserId}
          canRead
          canInvoke
          visible={visible}
          annotationOnly={annotationOnly}
          onAnnotate={(note) => quotes.push(note)}
        />,
      ),
    );
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
  const decode = async () => {
    await until(() => !!dom.window.document.querySelector('img'));
    const image = dom.window.document.querySelector('img')!;
    image.getBoundingClientRect = () => ({
      left: 20,
      top: 30,
      width: 400,
      height: 300,
      right: 420,
      bottom: 330,
      x: 20,
      y: 30,
      toJSON() {},
    });
    // This is a DOM decode-completion fixture, not proof of actual Native pixel decoding.
    await flush(() => image.dispatchEvent(new dom.window.Event('load')));
    await until(() => image.alt === '用于注释的冻结网页快照');
    return image;
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    await act(async () => {
      await Bun.sleep(30);
    });
    dom.window.close();
    restore();
    Object.assign(globalThis, globals);
  };
  return {
    dom,
    host: dom.window.document,
    f,
    quotes,
    flush,
    until,
    render,
    button,
    decode,
    cleanup,
  };
}

test('opening annotation-only from a frame-less ordinary view captures once and retains the frozen draft across hide/reopen', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const x = await setup(async (_request, f) => {
    await gate;
    f.view = captured('browser', 'captured-A');
  });
  try {
    await x.render(true, browserScope, 'browser', false);
    await x.until(() => x.host.body.textContent!.includes('尚无可用画面'));
    expect(x.f.submitted).toEqual([]);
    await x.render();
    await x.until(() => x.f.submitted.length === 1);
    expect(x.f.submitted[0]).toMatchObject({
      actionId: 'browser.capture',
      input: { browserId: 'browser', generation: 'browser-generation' },
    });
    expect(x.host.querySelector('img')).toBeNull();
    // Renders and observation scheduling while the original capture is pending
    // must not submit another capture or invent a usable frame.
    await x.render();
    await x.flush(() => {}, 350);
    expect(x.f.submitted).toHaveLength(1);
    expect(x.host.querySelector('img')).toBeNull();
    await x.flush(release);
    const image = await x.decode();
    expect(image.src).toBe(`data:image/jpeg;base64,${data('captured-A')}`);
    const picker = x.host.querySelector<HTMLButtonElement>('.agent-browser-frame')!;
    expect(picker.classList.contains('is-pointing')).toBe(true);
    expect(picker.disabled).toBe(false);
    await x.flush(() =>
      picker.dispatchEvent(
        new x.dom.window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 90 }),
      ),
    );
    const note = x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]')!;
    await x.flush(() => {
      Object.getOwnPropertyDescriptor(
        x.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(note, 'Keep this exact frozen element');
      note.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
    });
    expect(note.value).toBe('Keep this exact frozen element');
    await x.render(false);
    x.f.view = captured('browser', 'live-after-hide', '3');
    await x.flush(() => {}, 350);
    expect(x.f.submitted).toHaveLength(1);
    await x.render(true);
    await x.flush(() => {}, 350);
    expect(x.f.submitted.map((request) => request.actionId)).toEqual(['browser.capture']);
    expect(x.host.querySelector('img')!.src).toBe(`data:image/jpeg;base64,${data('captured-A')}`);
    expect(x.host.querySelector<HTMLTextAreaElement>('[aria-label="注释说明"]')!.value).toBe(
      'Keep this exact frozen element',
    );
    await x.flush(() => x.button('加入提示词')!.click());
    expect(x.quotes).toHaveLength(1);
    expect(x.quotes[0]).toMatchObject({
      note: 'Keep this exact frozen element',
      element: { ref: '@e1' },
      source: { frameSeq: '2' },
    });
    expect(x.f.submitted).toHaveLength(1);
  } finally {
    release();
    await x.cleanup();
  }
});

test('a delayed captured frame from the previous scope cannot replace the new scope frozen observation', async () => {
  let releaseCapture!: () => void;
  const captureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const x = await setup(async (request, f) => {
    const id = (request.input as { browserId: string }).browserId;
    if (id === 'browser') {
      await captureGate;
      f.view = captured(id, 'late-captured-A');
    } else f.view = captured('browser-B', 'captured-B');
  });
  let late: ReturnType<typeof x.f.deferNextResponse> | undefined;
  try {
    await x.render();
    await x.until(() => x.f.submitted.length === 1);
    late = x.f.deferNextResponse('extensions.query');
    await x.flush(releaseCapture);
    await x.until(() => !!late!.held);
    const other = {
      ...browserScope,
      sessionId: 'session-B',
      contextSelectionId: 'context-B',
      viewSelection: 2,
    };
    x.f.scope = other;
    x.f.view = { ...browserView(), browserId: 'browser-B', frame: null, annotations: [] };
    await x.render(true, other, 'browser-B');
    await x.until(() => x.f.submitted.length === 2);
    const image = await x.decode();
    expect(image.src).toBe(`data:image/jpeg;base64,${data('captured-B')}`);
    expect(
      x.f.submitted.map((request) => (request.input as { browserId: string }).browserId),
    ).toEqual(['browser', 'browser-B']);
    await x.flush(() => late!.release());
    await x.flush(() => {}, 350);
    expect(x.host.querySelector('img')!.src).toBe(`data:image/jpeg;base64,${data('captured-B')}`);
    expect(x.host.querySelector('.agent-browser-frame')!.classList.contains('is-pointing')).toBe(
      true,
    );
    expect(x.host.body.textContent).not.toContain('late-captured-A');
    expect(x.f.submitted).toHaveLength(2);
    expect(x.quotes).toEqual([]);
  } finally {
    releaseCapture();
    late?.release();
    await x.cleanup();
  }
});
