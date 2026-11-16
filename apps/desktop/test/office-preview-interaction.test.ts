import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
} from '../electron/office-preview-interaction';

function fixture(
  kind: 'word' | 'powerpoint',
  html: string,
  beforeInstall?: (win: JSDOM['window']) => void,
) {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;
  const observers = new Set<MutationObserver>();
  const NativeMutationObserver = win.MutationObserver;
  win.MutationObserver = class extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.add(this);
    }
  };
  const callbacks = new Map<string, ((event: unknown) => void)[]>();
  const windowCallbacks = new Map<string, ((event: unknown) => void)[]>();
  const addWindow = win.addEventListener.bind(win);
  win.addEventListener = ((name: string, cb: (event: unknown) => void, options: boolean) => {
    windowCallbacks.set(name, [...(windowCallbacks.get(name) ?? []), cb]);
    addWindow(name, cb as EventListener, options);
  }) as typeof win.addEventListener;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  win.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  win.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  // JSDOM drops window.document on close but does not cancel queued observer delivery.
  // Dispose harness-owned work before tearing down the simulated browsing context.
  const closeWindow = win.close.bind(win);
  win.close = () => {
    for (const observer of observers) observer.disconnect();
    observers.clear();
    frames.clear();
    callbacks.clear();
    windowCallbacks.clear();
    closeWindow();
  };
  Object.assign(win, { TextEncoder });
  win.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }) as DOMRect;
  const add = win.document.addEventListener.bind(win.document);
  win.document.addEventListener = ((
    name: string,
    cb: (event: unknown) => void,
    options: boolean,
  ) => {
    callbacks.set(name, [...(callbacks.get(name) ?? []), cb]);
    add(name, cb as EventListener, options);
  }) as typeof win.document.addEventListener;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.Range.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 20 }) as DOMRect;
  beforeInstall?.(win);
  win.eval(officeInteractionInstallScript(kind));
  const fire = (name: string, target: Element, extra = {}) =>
    callbacks.get(name)?.forEach((cb) => {
      cb({
        isTrusted: true,
        target,
        key: '',
        pointerId: 1,
        button: 0,
        buttons: name === 'pointerup' ? 0 : 1,
        preventDefault() {},
        ...extra,
      });
    });
  return {
    win,
    errors,
    frame: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    frameCount: () => frames.size,
    fireWindow: (name: string, extra = {}) =>
      windowCallbacks.get(name)?.forEach((callback) => {
        callback({ isTrusted: true, ...extra });
      }),
    click: (target: Element, extra = {}) => {
      fire('pointerdown', target, extra);
      fire('pointerup', target, extra);
    },
    read: (consume = true) =>
      JSON.parse(
        JSON.stringify(
          win.eval(consume ? officeInteractionReadScript : officeInteractionPeekScript),
        ),
      ),
    // Harness invokes captured handlers; this is not evidence of actual browser trust.
    fire,
    control: (value: Parameters<typeof officeInteractionControlScript>[0]) =>
      win.eval(officeInteractionControlScript(value)),
    release: (serial: number) => win.eval(officeInteractionReleaseScript(serial)),
    close: () => win.close(),
  };
}
test('Word reports exact block offsets and clears a collapsed selection', () => {
  const f = fixture('word', '<p data-path="/body/p[1]">Hello <b>world</b></p>');
  const p = f.win.document.querySelector('p')!,
    text = p.querySelector('b')!.firstChild!;
  const range = f.win.document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 4);
  f.win.getSelection()!.addRange(range);
  f.click(p);
  assert.deepEqual(f.read().selection, {
    kind: 'word',
    start: { path: '/body/p[1]', offset: 7 },
    end: { path: '/body/p[1]', offset: 10 },
    text: 'orl',
  });
  f.win.getSelection()!.removeAllRanges();
  assert.equal(f.read().selection, null);
  f.close();
});
test('PPT controls choose current slide, expose notes and clear old object selection', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div data-path="/slide[1]/shape[@id=2]">one</div></div><div class="slide-container"><div class="slide-notes"><div class="slide-notes-label">Notes</div><div class="slide-notes-body">notes</div></div></div></div>',
  );
  f.click(f.win.document.querySelector('[data-path]')!);
  assert.equal(f.read().selection.slide, 1);
  f.control({ kind: 'presentation', value: true });
  f.control({ kind: 'slide', value: 2 });
  assert.equal(f.read().currentSlide, 2);
  assert.equal(f.read().notes, 'notes');
  assert.equal(f.read().selection, null);
  f.control({ kind: 'zoom', value: 1.5 });
  assert.equal(f.win.document.documentElement.style.zoom, '1.5');
  f.close();
});
test('bounded controls reject arbitrary commands and invalid numeric values', () => {
  for (const value of [NaN, Infinity, 0, -1, 100])
    assert.throws(() => officeInteractionControlScript({ kind: 'zoom', value }));
  assert.throws(() => officeInteractionControlScript({ kind: 'slide', value: 1.1 }));
  assert.throws(() => officeInteractionControlScript({ kind: 'eval', value: 'alert(1)' } as never));
});

test('Word does not retain an identical quote selected at a different offset', () => {
  const f = fixture('word', '<p data-path="/body/p[1]">same same</p>');
  const p = f.win.document.querySelector('p')!,
    text = p.firstChild!;
  const first = f.win.document.createRange();
  first.setStart(text, 0);
  first.setEnd(text, 4);
  f.win.getSelection()!.addRange(first);
  f.click(p);
  assert.equal(f.read().selection.start.offset, 0);
  const second = f.win.document.createRange();
  second.setStart(text, 5);
  second.setEnd(text, 9);
  f.win.getSelection()!.removeAllRanges();
  f.win.getSelection()!.addRange(second);
  assert.equal(f.read().selection, null);
  f.close();
});

test('oversized documents fail closed without installing interactions', () => {
  const f = fixture('word', `<p data-path="/body/p[1]">${'x'.repeat(2_000_001)}</p>`);
  assert.deepEqual(f.read(), { selection: null });
  assert.equal(f.win.document.querySelector('button'), null);
  f.close();
});

test('PPT page and presentation controls do not consume the requested old object', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div data-path="/slide[1]/shape[@id=2]">one</div></div><div class="slide-container"></div></div>',
  );
  const object = f.win.document.querySelector('[data-path]')!;
  f.click(object);
  f.fire('keydown', object, {
    ctrlKey: true,
    shiftKey: true,
    code: 'KeyX',
    key: 'X',
    preventDefault() {},
  });
  f.control({ kind: 'presentation', value: true });
  f.control({ kind: 'slide', value: 2 });
  const peek = f.read(false);
  assert.equal(peek.currentSlide, 2);
  assert.equal(peek.selection, null);
  assert.deepEqual(peek.floatingSelection, {
    kind: 'powerpoint',
    slide: 1,
    objectPath: '/slide[1]/shape[@id=2]',
    text: 'one',
  });
  assert.equal(f.read().floatingRequest, 1);
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

test('real slide thumbnails navigate only from trusted clicks and contain no selection paths', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide" style="width:1280px;height:720px"><div id="shape-one" data-path="/slide[1]/shape[@id=1]">Real first page</div></div></div><div class="slide-container"><div class="slide" style="width:1280px;height:720px"><div data-path="/slide[2]/shape[@id=2]">Real second page</div></div></div></div>',
  );
  const rail = f.win.document.querySelector<HTMLElement>('.kite-thumbnail-rail')!;
  assert.equal(f.read().slideCount, 2);
  assert.equal(rail.querySelectorAll('.kite-thumbnail-visual').length, 2);
  assert.match(rail.textContent!, /Real first page/);
  assert.match(rail.textContent!, /Real second page/);
  assert.equal(rail.querySelector('[data-path],[id],[onclick]'), null);
  assert.equal((rail.querySelector('.kite-thumbnail-visual') as HTMLElement).inert, true);
  assert.equal(rail.style.minWidth, 'var(--kite-rail-width)');
  assert.equal(rail.style.getPropertyValue('--kite-rail-width'), '104px');
  assert.equal(f.win.document.querySelector<HTMLElement>('.main')!.style.minWidth, '0px');
  const calls: Element[] = [];
  f.win.HTMLElement.prototype.scrollIntoView = function () {
    calls.push(this);
  };
  const next = rail.querySelectorAll('button')[1]!;
  f.fire('click', next, { isTrusted: false, preventDefault() {} });
  assert.equal(calls.length, 0);
  f.fire('click', next, { preventDefault() {} });
  assert.equal(calls[0], f.win.document.querySelectorAll('.main > .slide-container .slide')[1]);
  f.click(rail.querySelector('.kite-thumbnail-visual .slide')!);
  assert.equal(f.read().selection, null);
  f.control({ kind: 'presentation', value: true });
  assert.equal(f.win.document.body.classList.contains('kite-present'), true);
  assert.equal(rail.querySelectorAll('.kite-thumbnail-visual').length, 0);
  assert.match(
    f.win.document.head.textContent!,
    /body\.kite-present \.kite-thumbnail-rail\{display:none!important\}/,
  );
  f.control({ kind: 'presentation', value: false });
  assert.equal(rail.querySelectorAll('.kite-thumbnail-visual').length, 2);
  f.close();
});

test('thumbnail clones are viewport bounded, evicted on scroll and skip over-complex pages', () => {
  const pages = Array.from(
    { length: 40 },
    (_, i) =>
      `<div class="slide-container"><div class="slide"><span data-path="/slide[${i + 1}]/shape[@id=1]">Page ${i + 1}</span></div></div>`,
  ).join('');
  const f = fixture('powerpoint', `<div class="main">${pages}</div>`);
  const rail = f.win.document.querySelector<HTMLElement>('.kite-thumbnail-rail')!;
  assert.equal(rail.querySelectorAll('button').length, 40);
  assert.ok(rail.querySelectorAll('.kite-thumbnail-visual').length <= 12);
  rail.scrollTop = 82 * 20;
  rail.dispatchEvent(new f.win.Event('scroll'));
  const visuals = [...rail.querySelectorAll('.kite-thumbnail-visual')];
  assert.ok(visuals.length <= 12);
  assert.equal(
    visuals.some((el) => el.textContent === 'Page 1'),
    false,
  );
  assert.ok(visuals.some((el) => el.textContent === 'Page 21'));
  f.close();
  const complex = fixture(
    'powerpoint',
    `<div class="main"><div class="slide-container"><div class="slide">${'<span>x</span>'.repeat(1501)}</div></div></div>`,
  );
  assert.equal(complex.win.document.querySelectorAll('.kite-thumbnail-visual').length, 0);
  assert.match(
    complex.win.document.querySelector<HTMLButtonElement>('.kite-thumbnail-button')!.title,
    /复杂/,
  );
  complex.close();
});

test('explicit PPT page and object remain stable when two pages are wholly visible; manual scrolling changes winner', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide"><span data-path="/slide[1]/shape[@id=1]">First</span></div></div><div class="slide-container"><div class="slide"><span data-path="/slide[2]/shape[@id=2]">Second</span></div></div></div>',
  );
  const [first, second] = [
    ...f.win.document.querySelectorAll<HTMLElement>('.main > .slide-container'),
  ];
  const rect = (top: number, bottom: number) => ({
    top,
    bottom,
    height: bottom - top,
    left: 104,
    right: 530,
    width: 426,
    x: 104,
    y: top,
    toJSON() {},
  });
  first!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(10, 210);
  second!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(225, 425.25);
  f.control({ kind: 'slide', value: 2 });
  assert.equal(f.read().currentSlide, 2);
  const firstButton = f.win.document.querySelector('.kite-thumbnail-button')!;
  f.fire('click', firstButton, { preventDefault() {} });
  assert.equal(f.read().currentSlide, 1);
  assert.equal(f.read().currentSlide, 1);
  assert.equal(firstButton.getAttribute('aria-current'), 'true');
  f.control({ kind: 'slide', value: 2 });
  f.click(first!.querySelector('[data-path]')!);
  assert.equal(f.read().currentSlide, 1);
  assert.equal(f.read().selection.slide, 1);
  // A tiny clipping/layout difference must not clear an object chosen on page one.
  first!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(-0.5, 199.5);
  assert.equal(f.read().currentSlide, 1);
  assert.equal(f.read().selection.slide, 1);
  // Simulated genuine scrolling makes page one substantially less visible.
  first!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(-160, 40);
  second!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(55, 255.25);
  assert.equal(f.read().currentSlide, 2);
  assert.equal(f.read().selection, null);
  first!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(10, 210);
  second!.querySelector<HTMLElement>('.slide')!.getBoundingClientRect = () => rect(750, 950);
  assert.equal(f.read().currentSlide, 1);
  f.close();
});

test('PPT page visibility and navigation target actual slides instead of long speaker notes', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide">First slide</div><div class="slide-notes-body">Long notes</div></div><div class="slide-container"><div class="slide">Second slide</div></div></div>',
  );
  const containers = [...f.win.document.querySelectorAll<HTMLElement>('.main > .slide-container')];
  const pages = containers.map((el) => el.querySelector<HTMLElement>('.slide')!);
  const rect = (top: number, bottom: number) => ({
    top,
    bottom,
    height: bottom - top,
    left: 104,
    right: 530,
    width: 426,
    x: 104,
    y: top,
    toJSON() {},
  });
  containers[0]!.getBoundingClientRect = () => rect(0, 4000);
  pages[0]!.getBoundingClientRect = () => rect(10, 210);
  containers[1]!.getBoundingClientRect = () => rect(20, 400);
  pages[1]!.getBoundingClientRect = () => rect(800, 1000);
  const calls: Element[] = [];
  f.win.HTMLElement.prototype.scrollIntoView = function () {
    calls.push(this);
  };
  f.control({ kind: 'slide', value: 1 });
  assert.equal(calls[0], pages[0]);
  assert.equal(f.read().currentSlide, 1);
  f.close();
});

test('request anchor is recomputed after movement and tracks the same frozen object after consumption', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide"><span data-path="/slide[1]/shape[1]">Title</span></div></div></div>',
  );
  const object = f.win.document.querySelector<HTMLElement>('[data-path]')!;
  let x = 20;
  object.getBoundingClientRect = () =>
    ({ left: x, top: 40, width: 80, height: 30, bottom: 70 }) as DOMRect;
  f.click(object);
  x = 180;
  f.control({ kind: 'request-edit' });
  assert.equal(f.read().requestAnchor.x, 180);
  x = 260;
  assert.equal(f.read().requestAnchor.x, 260);
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

test('selection request and thumbnail chrome share client theme tokens without changing document text', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide"><span data-path="/slide[1]/shape[1]">Original text</span></div></div></div>',
  );
  const trigger = f.win.document.querySelector('.kite-office-request-trigger');
  assert.ok(trigger?.classList.contains('kite-office-chrome'));
  assert.ok(
    f.win.document.querySelector('.kite-thumbnail-rail')?.classList.contains('kite-office-chrome'),
  );
  assert.equal(f.win.document.querySelector('[data-path]')?.textContent, 'Original text');
  const styles = [...f.win.document.querySelectorAll('style')]
    .map((style) => style.textContent)
    .join('\n');
  for (const rule of [
    '--office-card: light-dark(#fff, #222)',
    'var(--office-hover)',
    'var(--office-pressed)',
    ':focus-visible',
    'color-scheme: light dark',
  ])
    assert.ok(styles.includes(rule), rule);
  assert.ok(!styles.includes('#4b8df8'));
  f.close();
});

test('Office themes are confined to chrome and thumbnail text retains the source inheritance', () => {
  const f = fixture(
    'powerpoint',
    '<style>body{color:rgb(12,34,56);font:22px/1.6 serif;letter-spacing:1px}.slide{background:white;width:1280px;height:720px}</style><div class="main"><div class="slide-container"><div class="slide"><span data-path="/slide[1]/shape[1]">Default color title</span></div></div></div>',
  );
  const original = f.win.document.querySelector('.main .slide')!;
  const clone = f.win.document.querySelector<HTMLElement>('.kite-thumbnail-visual .slide')!;
  assert.ok(clone);
  assert.equal(clone.style.color, f.win.getComputedStyle(original).color);
  assert.equal(clone.style.colorScheme, f.win.getComputedStyle(original).colorScheme);
  assert.equal(clone.style.font, f.win.getComputedStyle(original).font);
  assert.equal(clone.style.letterSpacing, f.win.getComputedStyle(original).letterSpacing);
  const rules = [...f.win.document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
  // No root/body scheme or foreground override can turn UA CanvasText white on
  // the converter's white paper. Electron light/dark screenshot QA covers pixels.
  for (const rule of rules) {
    if (!('selectorText' in rule) || !/^(?:html|:root|body)$/.test(String(rule.selectorText)))
      continue;
    const style = (rule as unknown as { style: CSSStyleDeclaration }).style;
    assert.equal(style.getPropertyValue('color-scheme'), '');
  }
  assert.equal(f.win.document.documentElement.classList.contains('kite-office-chrome'), false);
  assert.equal(f.win.document.body.classList.contains('kite-office-chrome'), false);
  assert.equal(f.win.getComputedStyle(original).color, 'rgb(12, 34, 56)');
  f.close();
});
const scopePptHtml =
  '<div class="main"><div class="slide-container"><div class="slide"><p data-path="/slide[1]/shape[1]">one</p></div></div><div class="slide-container"><div class="slide"><p data-path="/slide[2]/shape[1]">two</p></div></div></div>';

test('right click precise noncurrent PPT thumbnail opens a menu then one page request without an old object', () => {
  const f = fixture('powerpoint', scopePptHtml),
    doc = f.win.document;
  f.click(doc.querySelector('[data-path]')!);
  assert.equal(f.read().selection.objectPath, '/slide[1]/shape[1]');
  const target = doc.querySelectorAll('.kite-thumbnail-button')[1]!,
    item = doc.querySelector('[role=menuitem]')!;
  f.fire('contextmenu', target, { button: 2 });
  assert.equal(f.read(false).floatingRequest, undefined);
  assert.equal(f.read(false).currentSlide, 1);
  assert.equal((doc.querySelector('[role=menu]') as HTMLElement).style.display, 'block');
  target.getBoundingClientRect = () => ({ left: 23, top: 81, width: 96, height: 82 }) as DOMRect;
  f.fire('click', item);
  f.fire('click', item);
  const request = f.read();
  assert.equal(request.floatingRequest, 1);
  assert.deepEqual(request.floatingSelection, { kind: 'powerpoint', slide: 2 });
  assert.deepEqual(request.requestAnchor, { x: 23, y: 81, width: 96, height: 82 });
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

function wordPagesHtml(count = 2) {
  return `<html data-kite-word-pagination-state="settled" data-kite-word-pagination-generation="1"><body>${Array.from({ length: count }, (_, i) => `<div class="page-wrapper"><div class="page" style="width:600px;height:800px;background:white;color:black"><div class="page-body"><p data-path="/body/p[${i + 1}]" id="original-${i}">第${i + 1}页正文</p></div></div></div>`).join('')}</body></html>`;
}

test('Word preview rail renders bounded visual snapshots without source pagination selectors or paths', () => {
  const f = fixture('word', wordPagesHtml(20)),
    doc = f.win.document;
  assert.equal(doc.querySelectorAll('.page').length, 20);
  assert.equal(doc.querySelectorAll('.page-wrapper').length, 20);
  assert.equal(doc.querySelectorAll('.page-body').length, 20);
  assert.equal(doc.querySelectorAll('.kite-word-page-button').length, 20);
  const rail = doc.querySelector('.kite-word-rail')!;
  assert.equal(
    rail.querySelectorAll('[data-path],[id],.page,.page-wrapper,.page-body,[onclick]').length,
    0,
  );
  const clones = rail.querySelectorAll('.kite-word-page-preview');
  assert.ok(clones.length > 0 && clones.length <= 10);
  assert.equal(clones[0]!.textContent, '第1页正文');
  assert.equal((clones[0] as HTMLElement).style.color, 'rgb(0, 0, 0)');
  f.fire('contextmenu', doc.querySelectorAll('.kite-word-page-button')[1]!, { button: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.deepEqual(f.read().floatingSelection, {
    kind: 'word',
    scope: 'page',
    pageBasis: 'html-preview',
    page: 2,
    layoutGeneration: 1,
    blocks: [{ path: '/body/p[2]', text: '第2页正文' }],
  });
  doc.documentElement.setAttribute('data-kite-word-pagination-state', 'pending');
  doc.documentElement.setAttribute('data-kite-word-pagination-generation', '2');
  assert.equal(f.read().requestInvalidated, 1);
  assert.equal(f.read().requestInvalidated, 1);
  f.release(1);
  doc.documentElement.setAttribute('data-kite-word-pagination-state', 'settled');
  f.read();
  f.fire('contextmenu', doc.querySelectorAll('.kite-word-page-button')[0]!, { button: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.equal(f.read().floatingSelection.layoutGeneration, 2);
  f.close();
});

test('Word missing unsettled unavailable and malformed pagination markers never enable page scope', () => {
  for (const [state, generation] of [
    ['pending', '1'],
    ['unavailable', '1'],
    ['settled', '0'],
    ['settled', '1.5'],
    ['', '1'],
    ['settled', 'Infinity'],
  ]) {
    const f = fixture(
      'word',
      wordPagesHtml()
        .replace('state="settled"', `state="${state}"`)
        .replace('generation="1"', `generation="${generation}"`),
    );
    assert.equal(f.win.document.querySelectorAll('.kite-word-page-button').length, 0);
    assert.equal(f.read().floatingRequest, undefined);
    f.close();
  }
});

test('Word page mapping rejects unknown, duplicate, oversized and mutated blocks while preserving text selection', () => {
  for (const change of [
    'unknown',
    'duplicate',
    'large',
    'image',
    'late-text',
    'path',
    'reorder',
    'geometry',
    'fake-button',
  ]) {
    let html = wordPagesHtml();
    if (change === 'unknown') html = html.replace('data-path="/body/p[1]"', '');
    if (change === 'duplicate') html = html.replace('/body/p[2]', '/body/p[1]');
    if (change === 'large') html = html.replace('第1页正文', 'x'.repeat(16001));
    if (change === 'image') html = html.replace('第1页正文', '<img src="offline.png">第1页正文');
    const f = fixture('word', html),
      doc = f.win.document;
    let target = doc.querySelector('.kite-word-page-button')!;
    if (change === 'late-text') doc.querySelector('.page-body')!.append('not mapped');
    if (change === 'path')
      doc.querySelector('[data-path]')!.setAttribute('data-path', '/body/p[9]');
    if (change === 'reorder') doc.body.prepend(doc.querySelectorAll('.page-wrapper')[1]!);
    if (change === 'geometry')
      doc.querySelector('.page')!.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 700, height: 900 }) as DOMRect;
    if (change === 'fake-button') {
      const clone = target.cloneNode(true) as Element;
      target.after(clone);
      target = clone;
    }
    f.fire('contextmenu', target, { button: 2 });
    f.fire('click', doc.querySelector('[role=menuitem]')!);
    assert.equal(f.read().floatingRequest, undefined, change);
    f.close();
  }
});

test('Word page request detects changed layout after consumption and cannot be replaced by a new generation', () => {
  const f = fixture('word', wordPagesHtml()),
    doc = f.win.document;
  f.fire('contextmenu', doc.querySelector('.kite-word-page-button')!, { button: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.equal(f.read().floatingRequest, 1);
  doc.documentElement.setAttribute('data-kite-word-pagination-generation', '2');
  f.read();
  f.fire('contextmenu', doc.querySelectorAll('.kite-word-page-button')[1]!, { button: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  const invalid = f.read();
  assert.equal(invalid.requestInvalidated, 1);
  assert.equal(invalid.floatingRequest, undefined);
  f.close();
});

test('Word visual image snapshots do not add source images or pagination selectors to resource watchers', () => {
  const f = fixture(
      'word',
      wordPagesHtml().replace(
        '第1页正文',
        '<img src="https://example.test/image.png" style="width:100px;height:60px">第1页正文',
      ),
    ),
    doc = f.win.document;
  assert.equal(doc.images.length, 1);
  assert.equal(doc.querySelectorAll('.page').length, 2);
  const rail = doc.querySelector('.kite-word-rail')!;
  assert.equal(rail.querySelectorAll('img').length, 0);
  assert.ok(rail.querySelector('span[style*="background-image"]'));
  for (let i = 0; i < 20; i++) f.read();
  assert.equal(doc.querySelectorAll('.page').length, 2);
  assert.equal(doc.documentElement.getAttribute('data-kite-word-pagination-generation'), '1');
  f.close();
});

test('unmapped Word page still supports original text-range requests, and complex thumbnails degrade without cloning', () => {
  const f = fixture(
      'word',
      wordPagesHtml().replace('第1页正文', '<img src="offline.png">第1页正文'),
    ),
    doc = f.win.document,
    p = doc.querySelector('[data-path]')!,
    text = p.lastChild!,
    range = doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 2);
  f.win.getSelection()!.addRange(range);
  f.click(p);
  f.control({ kind: 'request-edit' });
  assert.equal(f.read().floatingSelection.text, '第1');
  f.close();
  const complex = fixture(
    'word',
    wordPagesHtml().replace('第1页正文', '<span>x</span>'.repeat(800)),
  );
  assert.match(
    complex.win.document.querySelector('.kite-word-page-button')!.getAttribute('title') ?? '',
    /复杂/,
  );
  assert.equal(
    complex.win.document
      .querySelector('.kite-word-page-button')!
      .querySelector('.kite-word-page-preview'),
    null,
  );
  complex.close();
});

test('Word thumbnail paper retains author or wrapper backing on both light and dark rails without changing the source', () => {
  for (const railColor of ['rgb(250, 250, 250)', 'rgb(24, 24, 24)'])
    for (const variant of ['wrapper', 'author', 'black', 'fallback']) {
      let html = wordPagesHtml(1);
      const paper =
        variant === 'author'
          ? 'rgb(255, 250, 220)'
          : variant === 'black'
            ? 'rgb(0, 0, 0)'
            : 'transparent';
      html = html.replace('background:white', `background:${paper}`);
      if (variant === 'wrapper')
        html = html.replace(
          'class="page-wrapper"',
          'class="page-wrapper" style="background:white"',
        );
      const f = fixture('word', html),
        doc = f.win.document,
        source = doc.querySelector('.page') as HTMLElement;
      (doc.querySelector('.kite-word-rail') as HTMLElement).style.backgroundColor = railColor;
      const visual = doc.querySelector('.kite-word-visual') as HTMLElement,
        clone = doc.querySelector('.kite-word-page-preview') as HTMLElement;
      assert.equal(
        visual.style.backgroundColor,
        variant === 'author' || variant === 'black' ? paper : 'rgb(255, 255, 255)',
      );
      assert.equal(f.win.getComputedStyle(source).color, 'rgb(0, 0, 0)');
      assert.equal(clone.style.color, 'rgb(0, 0, 0)');
      assert.equal(
        source.getAttribute('style'),
        `width:600px;height:800px;background:${paper};color:black`,
      );
      assert.ok(parseFloat(visual.style.width) <= 88 && parseFloat(visual.style.height) <= 104);
      f.close();
    }
});

test('Word rail chrome keeps the interface font and fits thumbnails inside vertical-scrollbar width', () => {
  const f = fixture(
      'word',
      wordPagesHtml(12).replaceAll('color:black', 'color:black;font:16px serif'),
    ),
    doc = f.win.document;
  const rail = doc.querySelector('.kite-word-rail') as HTMLElement;
  assert.equal(rail.style.overflowX, 'hidden');
  assert.equal(rail.style.overflowY, 'auto');
  const css = [...doc.querySelectorAll('style')].map((style) => style.textContent).join('');
  for (const selector of [
    'body .kite-office-chrome.kite-word-rail',
    'body .kite-word-rail .kite-word-page-button',
    'body .kite-word-rail .kite-word-number',
  ])
    assert.ok(css.includes(selector));
  assert.match(css, /kite-word-page-button\{[^}]*width:100%;max-width:96px/);
  const pagesBefore = [...doc.querySelectorAll('.page')],
    pathsBefore = doc.querySelectorAll('[data-path]').length;
  Object.defineProperty(rail, 'clientWidth', { value: 76, configurable: true });
  rail.dispatchEvent(new f.win.Event('scroll'));
  for (const visual of rail.querySelectorAll<HTMLElement>('.kite-word-visual')) {
    assert.ok(parseFloat(visual.style.width) <= 62);
    assert.ok(parseFloat(visual.style.height) <= 104);
    assert.ok((visual.firstElementChild as HTMLElement).style.transform.startsWith('scale('));
  }
  assert.deepEqual([...doc.querySelectorAll('.page')], pagesBefore);
  assert.equal(doc.querySelectorAll('[data-path]').length, pathsBefore);
  assert.equal(rail.querySelectorAll('.page,.page-wrapper,.page-body,[data-path],img').length, 0);
  assert.equal((doc.querySelector('.page') as HTMLElement).style.fontFamily, 'serif');
  assert.equal(
    (rail.querySelector('.kite-word-page-preview') as HTMLElement).style.fontFamily,
    'serif',
  );
  f.close();
});

test('selection painting is in a noninteractive ShadowRoot without changing original object styles', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide"><div data-path="/slide[1]/shape[@id=1]" style="background:red;outline:3px dashed blue">Object</div></div></div></div>',
  );
  const doc = f.win.document;
  const original = doc.querySelector('[data-path]')!;
  const before = original.getAttribute('style');
  f.click(original);
  const host = doc.querySelector('.kite-office-selection-paint') as HTMLElement;
  assert.equal(host.inert, true);
  assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.equal(host.style.pointerEvents, 'none');
  assert.ok(host.shadowRoot);
  assert.equal(doc.querySelector('.kite-office-object-selection'), null);
  assert.equal(original.getAttribute('style'), before);
  assert.ok(
    ![...doc.querySelectorAll('style')].some((s) =>
      s.textContent?.includes('[data-kite-selected]{'),
    ),
  );
  assert.equal(host.shadowRoot.querySelectorAll('.kite-office-object-selection').length, 1);
  f.close();
});

test('Word native text request capsule remains visible under zoom while its quote anchor stays in viewport pixels', () => {
  for (const zoom of [1.25, 2]) {
    const f = fixture('word', '<p data-path="/body/p[1]">原始文字</p>'),
      doc = f.win.document;
    Object.defineProperty(f.win, 'innerWidth', { value: 400 });
    Object.defineProperty(f.win, 'innerHeight', { value: 300 });
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 385 });
    Object.defineProperty(doc.documentElement, 'clientHeight', { value: 285 });
    doc.documentElement.style.zoom = String(zoom);
    f.win.Range.prototype.getBoundingClientRect = () =>
      ({ left: 350, top: 250, right: 390, bottom: 290, width: 40, height: 40 }) as DOMRect;
    const p = doc.querySelector('p')!,
      range = doc.createRange();
    range.selectNodeContents(p);
    f.win.getSelection()!.addRange(range);
    const button = doc.querySelector('.kite-office-request-trigger') as HTMLElement;
    button.getBoundingClientRect = () => ({ width: 80 * zoom, height: 30 * zoom }) as DOMRect;
    f.fire('pointerup', p);
    assert.equal(parseFloat(button.style.left) * zoom, 385 - 80 * zoom - 4);
    assert.equal(parseFloat(button.style.top) * zoom, 285 - 30 * zoom - 4);
    f.control({ kind: 'request-edit' });
    const result = f.read();
    assert.equal(result.floatingSelection.text, '原始文字');
    assert.deepEqual(result.requestAnchor, { x: 350, y: 250, width: 40, height: 40 });
    f.close();
  }
});

test('PPT keeps exact page-four notes available to the host while preserving author content', () => {
  const note = '店长每天闭店前核对新品销量、试饮份数和复购券核销。';
  const slides = Array.from(
    { length: 5 },
    (_, index) =>
      `<div class="slide-container"><div class="slide"><div data-path="/slide[${index + 1}]/shape[@id=1]">Page ${index + 1}<div class="slide-notes"><div class="slide-notes-body">Authored slide content</div></div></div></div>${index === 3 ? `<div class="slide-notes"><div class="slide-notes-label">Notes</div><div class="slide-notes-body"><div>${note}</div></div></div>` : ''}</div>`,
  ).join('');
  const f = fixture('powerpoint', `<div class="main">${slides}</div>`);
  const containers = f.win.document.querySelectorAll('.main > .slide-container');
  const notes = containers[3]!.querySelector<HTMLElement>(':scope > .slide-notes')!;
  const authored = containers[3]!.querySelector<HTMLElement>('.slide .slide-notes')!;
  const authoredText = authored.outerHTML;
  assert.equal(notes.style.getPropertyValue('display'), 'none');
  assert.equal(notes.style.getPropertyPriority('display'), 'important');
  assert.equal(notes.querySelector('.slide-notes-body')!.textContent, note);
  assert.equal(authored.style.display, '');
  assert.equal(authored.hasAttribute('aria-hidden'), false);
  f.control({ kind: 'slide', value: 4 });
  assert.equal(f.read().currentSlide, 4);
  assert.equal(f.read().notes, note);
  for (const value of [true, false]) {
    f.control({ kind: 'presentation', value });
    assert.equal(f.read().notes, note);
    assert.equal(f.read().currentSlide, 4);
    assert.equal(notes.style.display, 'none');
    assert.equal(authored.outerHTML, authoredText);
    assert.notEqual(f.win.getComputedStyle(authored).display, 'none');
  }
  f.control({ kind: 'slide', value: 5 });
  assert.equal(f.read().notes, '');
  assert.equal(f.win.document.querySelectorAll('.kite-thumbnail-button').length, 5);
  f.win.close();
});

test('PPT navigation counter-scales at interface size and compact gutter never follows hover', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide">One</div></div></div>',
  );
  const rail = f.win.document.querySelector<HTMLElement>('.kite-page-rail')!;
  for (const value of [1, 1.5, 2, 'fit'] as const) {
    f.control({ kind: 'zoom', value });
    const scale = value === 'fit' ? 1 : value;
    assert.equal(Number(rail.style.zoom), 1 / scale);
    assert.equal(parseFloat(f.win.document.body.style.paddingLeft), 112 / scale);
  }
  Object.defineProperty(f.win, 'innerWidth', { configurable: true, value: 400 });
  f.fireWindow('resize');
  assert.equal(rail.classList.contains('kite-rail-compact'), true);
  assert.equal(rail.tabIndex, 0);
  assert.equal(f.win.document.body.style.paddingLeft, '40px');
  f.control({ kind: 'zoom', value: 2 });
  assert.equal(rail.style.zoom, '0.5');
  assert.equal(f.win.document.body.style.paddingLeft, '20px');
  f.control({ kind: 'presentation', value: true });
  assert.equal(f.win.document.body.style.paddingLeft, '0px');
  f.win.close();
});

test('Word navigation survives geometry changes without accepting stale modification scope', () => {
  const f = fixture('word', wordPagesHtml()),
    d = f.win.document;
  const page = d.querySelectorAll<HTMLElement>('.page')[1]!,
    button = d.querySelectorAll('.kite-word-page-button')[1]!;
  let navigated = 0;
  page.scrollIntoView = () => {
    navigated++;
  };
  page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 1600 }) as DOMRect;
  f.control({ kind: 'zoom', value: 2 });
  f.fire('click', button);
  assert.equal(navigated, 1);
  f.fire('contextmenu', button, { button: 2 });
  f.fire('click', d.querySelector('[role=menuitem]')!);
  assert.equal(f.read().floatingRequest, undefined);
  d.documentElement.setAttribute('data-kite-word-pagination-generation', '2');
  f.fire('click', button);
  assert.equal(navigated, 1);
  f.close();
  const g = fixture('word', wordPagesHtml()),
    doc = g.win.document;
  const original = doc.querySelectorAll<HTMLElement>('.page')[1]!,
    target = doc.querySelectorAll('.kite-word-page-button')[1]!;
  let stale = 0;
  original.scrollIntoView = () => {
    stale++;
  };
  original.replaceWith(original.cloneNode(true));
  g.fire('click', target);
  assert.equal(stale, 0);
  g.close();
});

test('read-only Word navigation becomes ready after pagination without interaction polling', async () => {
  const f = fixture('word', wordPagesHtml().replace('state="settled"', 'state="pending"'));
  const doc = f.win.document;
  try {
    assert.equal(doc.querySelectorAll('.kite-word-page-button').length, 0);
    doc.documentElement.setAttribute('data-kite-word-pagination-state', 'settled');
    await Promise.resolve();
    assert.equal(doc.querySelectorAll('.kite-word-page-button').length, 2);
    assert.equal((doc.querySelector('.kite-word-rail') as HTMLElement).style.display, 'block');
    doc.documentElement.setAttribute('data-kite-word-pagination-state', 'pending');
    await Promise.resolve();
    assert.equal((doc.querySelector('.kite-word-rail') as HTMLElement).style.display, 'none');
  } finally {
    f.close();
  }
});

test('Word fixture closes safely with queued pagination changes', async () => {
  const f = fixture('word', wordPagesHtml());
  f.win.document.documentElement.setAttribute('data-kite-word-pagination-generation', '2');
  f.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.errors, []);
  assert.equal(f.frameCount(), 0);
});
