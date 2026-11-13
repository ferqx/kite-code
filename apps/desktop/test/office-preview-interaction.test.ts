import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  officeInteractionControlScript,
  officeInteractionInstallScript,
  officeInteractionPeekScript,
  officeInteractionReadScript,
  officeInteractionReleaseScript,
} from '../electron/office-preview-interaction';

function fixture(
  kind: 'word' | 'excel' | 'powerpoint',
  html: string,
  beforeInstall?: (win: JSDOM['window']) => void,
) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
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
test('Excel preserves original values and ranges, consumes floating intent once, clears on sheet change', () => {
  const f = fixture(
    'excel',
    '<div class="sheet-content active"><table><tr><td data-path="/预算/A1">12</td><td data-path="/预算/B1" data-formula="SUM(A1)">12</td></tr></table></div>',
  );
  const [a, b] = [...f.win.document.querySelectorAll('td')];
  f.click(a!);
  f.click(b!, { shiftKey: true });
  assert.deepEqual(f.read().selection, {
    kind: 'excel',
    sheet: '预算',
    range: 'A1:B1',
    cells: [
      { path: '/预算/A1', address: 'A1', value: '12' },
      { path: '/预算/B1', address: 'B1', value: '12', formula: 'SUM(A1)' },
    ],
  });
  f.fire('keydown', a!, { ctrlKey: true, shiftKey: true, code: 'KeyX', preventDefault() {} });
  assert.equal(f.read().floatingRequest, 1);
  assert.equal(f.read().floatingRequest, undefined);
  a!.closest('.sheet-content')!.classList.remove('active');
  assert.equal(f.read().selection, null);
  f.close();
});
test('synthetic clicks and changed source attributes cannot manufacture a selection', () => {
  const f = fixture(
    'excel',
    '<div class="sheet-content active"><table><tr><td data-path="/S/A1">x</td></tr></table></div>',
  );
  const a = f.win.document.querySelector('td')!;
  f.click(a, { isTrusted: false });
  assert.equal(f.read().selection, null);
  a.setAttribute('data-path', '/Other/B2');
  f.click(a);
  assert.equal(f.read().selection, null);
  f.close();
});
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
    '<div class="main"><div class="slide-container"><div data-path="/slide[1]/shape[@id=2]">one</div></div><div class="slide-container"><div class="slide-notes-body">notes</div></div></div>',
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

test('peek and attempted selection changes preserve one frozen range request through consumption', () => {
  const f = fixture(
    'excel',
    '<div class="sheet-content active"><table><tr><td data-path="/S/A1">first</td><td data-path="/S/B1">second</td></tr></table></div>',
  );
  const [a, b] = [...f.win.document.querySelectorAll('td')];
  const request = (target: Element) =>
    f.fire('keydown', target, { ctrlKey: true, shiftKey: true, code: 'KeyX', preventDefault() {} });
  f.click(a!);
  request(a!);
  const first = f.read(false);
  assert.equal(first.floatingRequest, 1);
  assert.equal(first.floatingSelection.range, 'A1');
  f.click(b!);
  request(b!);
  f.control({ kind: 'zoom', value: 1.25 });
  assert.equal(f.read(false).selection.range, 'A1');
  assert.equal(f.read(false).floatingRequest, 1);
  assert.deepEqual(f.read(false).floatingSelection, first.floatingSelection);
  b!.closest('.sheet-content')!.classList.remove('active');
  assert.equal(f.read(false).selection, null);
  assert.deepEqual(f.read().floatingSelection, first.floatingSelection);
  assert.equal(f.read().floatingRequest, undefined);
  assert.equal(f.read().floatingSelection, undefined);
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
    '<div class="sidebar"><div data-path="/slide[99]/shape[@id=1]">old clone</div></div><div class="main"><div class="slide-container"><div class="slide" style="width:1280px;height:720px"><div id="shape-one" data-path="/slide[1]/shape[@id=1]">Real first page</div></div></div><div class="slide-container"><div class="slide" style="width:1280px;height:720px"><div data-path="/slide[2]/shape[@id=2]">Real second page</div></div></div></div>',
  );
  const rail = f.win.document.querySelector<HTMLElement>('.kite-thumbnail-rail')!;
  assert.equal(f.win.document.querySelector('.sidebar'), null);
  assert.equal(f.read().slideCount, 2);
  assert.equal(rail.querySelectorAll('.kite-thumbnail-visual').length, 2);
  assert.match(rail.textContent!, /Real first page/);
  assert.match(rail.textContent!, /Real second page/);
  assert.equal(rail.querySelector('[data-path],[id],[onclick]'), null);
  assert.equal((rail.querySelector('.kite-thumbnail-visual') as HTMLElement).inert, true);
  assert.equal(rail.style.minWidth, '104px');
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

test('only the original OfficeCLI top-level duplicate page counter is hidden', () => {
  const f = fixture(
    'powerpoint',
    '<div class="main"><div class="slide-container"><div class="slide"><span class="page-counter">Document content</span></div></div></div><div class="page-counter">1 / 2</div>',
  );
  assert.equal(
    f.win.document.querySelector('body > .page-counter')!.getAttribute('aria-hidden'),
    'true',
  );
  assert.equal(
    f.win.document.querySelector('.main .page-counter')!.getAttribute('aria-hidden'),
    null,
  );
  assert.match(f.win.document.head.textContent!, /body>\.page-counter\{display:none!important\}/);
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

function excelGrid(rows: number, cols = 1, sheet = 'S', value = '') {
  const address = (col: number, row: number) => String.fromCharCode(64 + col) + row;
  return `<div class="sheet-content active"><table>${Array.from(
    { length: rows },
    (_, row) =>
      `<tr>${Array.from({ length: cols }, (_, col) => `<td data-path="/${sheet}/${address(col + 1, row + 1)}">${value}</td>`).join('')}</tr>`,
  ).join('')}</table></div>`;
}

test('Excel drag previews a complete rectangle, reverse drag, same cell and Shift extension', () => {
  const f = fixture(
    'excel',
    excelGrid(3, 3).replace('data-path="/S/B2"', 'data-path="/S/B2" data-formula="SUM(A1:A2)"'),
  );
  const cell = (address: string) => f.win.document.querySelector(`[data-path="/S/${address}"]`)!;
  f.fire('pointerdown', cell('A1'));
  f.fire('pointermove', cell('C3'));
  assert.equal(f.frameCount(), 1);
  assert.equal(f.read().selection.range, 'A1');
  f.frame();
  assert.equal(f.read().selection.range, 'A1:C3');
  assert.equal(f.win.document.querySelectorAll('[data-kite-selected]').length, 9);
  assert.equal(
    f.win.document.querySelector('.kite-office-request-trigger')?.textContent,
    '请求修改 · A1:C3',
  );
  f.fire('pointerup', cell('C3'));
  assert.deepEqual(
    f.read().selection.cells.map((c: { address: string }) => c.address),
    ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'],
  );
  assert.deepEqual(f.read().selection.cells[4], {
    path: '/S/B2',
    address: 'B2',
    value: '',
    formula: 'SUM(A1:A2)',
  });
  f.fire('pointerdown', cell('C3'));
  f.fire('pointermove', cell('A1'));
  f.frame();
  f.fire('pointerup', cell('A1'));
  assert.equal(f.read().selection.range, 'A1:C3');
  f.click(cell('B2'));
  assert.equal(f.read().selection.range, 'B2');
  f.click(cell('C3'), { shiftKey: true });
  assert.equal(f.read().selection.range, 'B2:C3');
  f.close();
});

test('Excel cancels incomplete drags on Escape, blur, cancellation, lost capture and viewport exit', () => {
  for (const cancel of [
    'Escape',
    'blur',
    'pointercancel',
    'lostpointercapture',
    'outside',
    'buttons',
  ]) {
    const f = fixture('excel', excelGrid(2, 2));
    const cells = f.win.document.querySelectorAll('td');
    f.fire('pointerdown', cells[0]!);
    f.fire('pointermove', cells[3]!);
    if (cancel === 'Escape') f.fire('keydown', cells[0]!, { key: 'Escape' });
    else if (cancel === 'blur') f.fireWindow('blur');
    else if (cancel === 'outside') f.fire('pointerup', cells[0]!, { clientX: -1, clientY: 20 });
    else if (cancel === 'buttons') f.fire('pointermove', cells[0]!, { buttons: 0 });
    else f.fire(cancel, cells[0]!);
    f.frame();
    f.fire('pointerup', cells[3]!);
    f.control({ kind: 'request-edit' });
    assert.equal(f.read().selection, null, cancel);
    assert.equal(f.read().floatingRequest, undefined, cancel);
    assert.equal(f.win.document.querySelectorAll('[data-kite-selected]').length, 0, cancel);
    f.close();
  }
});

test('Excel rejects cross-sheet, retired-document and untrusted pointer events', () => {
  const f = fixture('excel', excelGrid(2, 2) + excelGrid(1, 1, 'Other'));
  const cells = f.win.document.querySelectorAll('td');
  f.fire('pointerdown', cells[0]!, { isTrusted: false });
  f.fire('pointerup', cells[3]!);
  assert.equal(f.read().selection, null);
  f.fire('pointerdown', cells[0]!, { button: 2 });
  f.fire('pointerup', cells[3]!, { button: 2 });
  assert.equal(f.read().selection, null);
  f.fire('pointerdown', cells[0]!);
  f.fire('pointermove', cells[3]!, { isTrusted: false });
  f.fire('pointermove', cells[3]!, { pointerId: 2 });
  f.frame();
  assert.equal(f.read().selection.range, 'A1');
  f.fire('pointermove', cells[4]!);
  f.frame();
  assert.equal(f.read().selection, null);
  f.fire('pointerup', cells[3]!);
  assert.equal(f.read().selection, null);
  f.fire('pointerdown', cells[0]!);
  cells[0]!.closest('.sheet-content')!.classList.remove('active');
  assert.equal(f.read().selection, null);
  f.fire('pointerup', cells[3]!);
  assert.equal(f.read().selection, null);
  const other = fixture('excel', excelGrid(1));
  f.fire('pointerdown', other.win.document.querySelector('td')!);
  f.fire('pointerup', other.win.document.querySelector('td')!);
  assert.equal(f.read().selection, null);
  other.close();
  f.close();
});

test('Excel rejects edited original cells, formulas, moved ownership, invisible and fabricated targets', () => {
  for (const change of ['text', 'path', 'formula', 'replace', 'owner', 'hidden', 'fabricated']) {
    const f = fixture('excel', excelGrid(2, 2) + excelGrid(1, 1, 'Other'));
    const cells = f.win.document.querySelectorAll('td'),
      first = cells[0]!,
      end = cells[3]!;
    f.fire('pointerdown', first);
    if (change === 'text') cells[1]!.textContent = 'forged';
    if (change === 'path') cells[1]!.setAttribute('data-path', '/Foreign/X99');
    if (change === 'formula') cells[1]!.setAttribute('data-formula', 'FORGED()');
    if (change === 'replace') cells[1]!.replaceWith(cells[1]!.cloneNode(true));
    if (change === 'owner') cells[4]!.parentElement!.append(cells[1]!);
    if (change === 'hidden') end.setAttribute('style', 'opacity:0');
    let hit: Element = end;
    if (change === 'fabricated') {
      hit = end.cloneNode(true) as Element;
      end.parentElement!.append(hit);
    }
    f.fire('pointermove', hit);
    f.frame();
    f.fire('pointerup', hit);
    f.control({ kind: 'request-edit' });
    assert.equal(f.read().selection, null, change);
    assert.equal(f.read().floatingRequest, undefined, change);
    f.close();
  }
});

test('Excel range budget rejects rather than truncates, and a smaller range can recover', () => {
  const f = fixture('excel', excelGrid(257));
  const cells = f.win.document.querySelectorAll('td');
  f.fire('pointerdown', cells[0]!);
  f.fire('pointermove', cells[255]!);
  f.frame();
  assert.equal(f.read().selection.cells.length, 256);
  f.fire('pointermove', cells[256]!);
  f.frame();
  assert.equal(f.read().selection, null);
  assert.equal(f.win.document.querySelector('[role=status]')?.textContent, '最多选择 256 个单元格');
  f.fire('pointermove', cells[1]!);
  f.frame();
  f.fire('pointerup', cells[1]!);
  assert.equal(f.read().selection.range, 'A1:A2');
  f.close();
  const large = fixture('excel', excelGrid(10, 1, 'S', '中'.repeat(1200)));
  const largeCells = large.win.document.querySelectorAll('td');
  large.fire('pointerdown', largeCells[0]!);
  large.fire('pointerup', largeCells[9]!);
  assert.equal(large.read().selection, null);
  assert.equal(
    large.win.document.querySelector('[role=status]')?.textContent,
    '所选内容过多，请缩小范围',
  );
  large.close();
});

test('Excel missing, merged and duplicate coordinates never fabricate a rectangular payload', () => {
  for (const html of [
    '<td data-path="/S/A1">one</td><td data-path="/S/C1">three</td>',
    '<td data-path="/S/A1" colspan="2">merged</td><td data-path="/S/C1">three</td>',
    '<td data-path="/S/A1">one</td><td data-path="/S/A1">duplicate</td><td data-path="/S/B1">two</td>',
  ]) {
    const f = fixture(
      'excel',
      `<div class="sheet-content active"><table><tr>${html}</tr></table></div>`,
    );
    const cells = f.win.document.querySelectorAll('td');
    f.fire('pointerdown', cells[0]!);
    f.fire('pointerup', cells[cells.length - 1]!);
    assert.equal(f.read().selection, null);
    assert.equal(
      f.win.document.querySelector('[role=status]')?.textContent,
      '此区域不可用，请重新选择',
    );
    f.close();
  }
});

test('Excel request freezes the latest queued drag once and ignores its late release', () => {
  const f = fixture('excel', excelGrid(3, 3));
  const cells = f.win.document.querySelectorAll('td');
  f.fire('pointerdown', cells[0]!);
  f.fire('pointermove', cells[4]!);
  f.control({ kind: 'request-edit' });
  const frozen = f.read(false);
  assert.equal(frozen.floatingSelection.range, 'A1:B2');
  assert.equal(frozen.floatingSelection.cells.length, 4);
  assert.deepEqual(frozen.requestAnchor, { x: 10, y: 10, width: 80, height: 20 });
  f.fire('pointermove', cells[8]!);
  f.frame();
  f.fire('pointerup', cells[8]!);
  f.control({ kind: 'request-edit' });
  assert.deepEqual(f.read(false).floatingSelection, frozen.floatingSelection);
  assert.equal(f.read().floatingRequest, 1);
  assert.equal(f.read().floatingRequest, undefined);
  assert.equal(f.read().selection.range, 'A1:B2');
  f.close();
});

test('Excel small-range drag work is bounded independently of table size and moves coalesce', () => {
  const measurements = [];
  for (const size of [50, 9000]) {
    const f = fixture('excel', excelGrid(size));
    const cells = f.win.document.querySelectorAll('td');
    let checks = 0;
    const original = f.win.Element.prototype.getAttribute;
    f.win.Element.prototype.getAttribute = function (name: string) {
      if (name === 'data-path') checks++;
      return original.call(this, name);
    };
    const start = performance.now();
    f.fire('pointerdown', cells[0]!);
    for (let n = 0; n < 1000; n++) f.fire('pointermove', cells[2]!);
    assert.equal(f.frameCount(), 1);
    f.frame();
    f.fire('pointerup', cells[2]!);
    assert.equal(f.read().selection.range, 'A1:A3');
    assert.ok(checks < 40, 'only bounded selected cells should be validated');
    measurements.push({
      rows: size,
      moves: 1000,
      pathChecks: checks,
      elapsedMs: performance.now() - start,
    });
    f.close();
  }
  assert.equal(measurements[0]!.pathChecks, measurements[1]!.pathChecks);
  console.log(JSON.stringify({ measurement: 'excel-drag-handler-jsdom', samples: measurements }));
}, 20000);

const scopeSheetHtml =
  '<div class="sheet-content active" data-sheet="0"><table><tr><td data-path="/一表/A1">one</td></tr></table></div><div class="sheet-content" data-sheet="1"><table><tr><td data-path="/二表/A1">two</td></tr></table></div><div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">一表</div><div class="sheet-tab" data-sheet="1">二表</div></div>';
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

test('sheet tab request captures a nonactive sheet without fake range or cells and supports empty sheets', () => {
  for (const html of [
    scopeSheetHtml,
    scopeSheetHtml.replace('<td data-path="/二表/A1">two</td>', ''),
  ]) {
    const f = fixture('excel', html),
      doc = f.win.document,
      tab = doc.querySelectorAll('.sheet-tab')[1]!,
      item = doc.querySelector('[role=menuitem]')!;
    f.click(doc.querySelector('td')!);
    f.fire('contextmenu', tab, { button: 2 });
    assert.equal(f.read(false).floatingRequest, undefined);
    f.fire('keydown', item, { key: 'Enter', keyCode: 13 });
    f.fire('click', item);
    assert.deepEqual(f.read().floatingSelection, { kind: 'excel', scope: 'sheet', sheet: '二表' });
    assert.equal(f.read().floatingRequest, undefined);
    f.close();
  }
});

test('scope menus cancel on Escape outside click blur scroll resize navigation and active-sheet changes', () => {
  for (const action of ['escape', 'outside', 'blur', 'scroll', 'resize', 'sheet']) {
    const f = fixture('excel', scopeSheetHtml),
      doc = f.win.document,
      tab = doc.querySelectorAll('.sheet-tab')[1]!,
      item = doc.querySelector('[role=menuitem]')!;
    f.fire('contextmenu', tab, { button: 2 });
    if (action === 'escape') f.fire('keydown', item, { key: 'Escape' });
    if (action === 'outside') f.fire('pointerdown', doc.body);
    if (action === 'blur') f.fireWindow('blur');
    if (action === 'resize') f.fireWindow('resize');
    if (action === 'scroll') f.fire('scroll', doc.body);
    if (action === 'sheet') {
      doc.querySelector('.sheet-content.active')!.classList.remove('active');
      doc.querySelectorAll('.sheet-content')[1]!.classList.add('active');
    }
    f.fire('click', item);
    assert.equal(f.read().floatingRequest, undefined, action);
    f.close();
  }
  const f = fixture('powerpoint', scopePptHtml),
    doc = f.win.document;
  f.fire('contextmenu', doc.querySelectorAll('.kite-thumbnail-button')[1]!, { button: 2 });
  f.control({ kind: 'slide', value: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

test('scope menus reject synthetic events, forged targets, mutable identities and hidden targets', () => {
  for (const attack of [
    'synthetic-open',
    'synthetic-click',
    'synthetic-key',
    'repeat',
    'composing',
    'fake',
    'rename',
    'id',
    'move',
    'hidden',
    'sheet-id',
    'sheet-move',
    'remove',
  ]) {
    const f = fixture('excel', scopeSheetHtml),
      doc = f.win.document;
    let tab = doc.querySelectorAll('.sheet-tab')[1]!;
    const item = doc.querySelector('[role=menuitem]')!;
    if (attack === 'fake') {
      const clone = tab.cloneNode(true) as Element;
      tab.after(clone);
      tab = clone;
    }
    if (attack === 'rename') tab.textContent = '另一表';
    if (attack === 'id') tab.setAttribute('data-sheet', '0');
    if (attack === 'move') doc.body.append(tab);
    if (attack === 'hidden') (tab as HTMLElement).style.display = 'none';
    const sheet = doc.querySelectorAll('.sheet-content')[1]!;
    if (attack === 'sheet-id') sheet.setAttribute('data-sheet', '0');
    if (attack === 'sheet-move') doc.querySelector('.sheet-tabs')!.append(sheet);
    if (attack === 'remove') sheet.remove();
    f.fire('contextmenu', tab, { button: 2, isTrusted: attack !== 'synthetic-open' });
    if (['synthetic-key', 'repeat', 'composing'].includes(attack))
      f.fire('keydown', item, {
        key: 'Enter',
        isTrusted: attack !== 'synthetic-key',
        repeat: attack === 'repeat',
        isComposing: attack === 'composing',
      });
    else f.fire('click', item, { isTrusted: attack !== 'synthetic-click' });
    assert.equal(f.read().floatingRequest, undefined, attack);
    f.close();
  }
  for (const attack of ['clone', 'number', 'label', 'reorder']) {
    const f = fixture('powerpoint', scopePptHtml),
      doc = f.win.document;
    let target = doc.querySelectorAll('.kite-thumbnail-button')[1]!;
    if (attack === 'clone') {
      const clone = target.cloneNode(true) as Element;
      target.after(clone);
      target = clone;
    }
    if (attack === 'number') target.querySelector('.kite-thumbnail-number')!.textContent = '1';
    if (attack === 'label') target.setAttribute('aria-label', '第 1 页');
    if (attack === 'reorder')
      doc.querySelector('.main')!.prepend(doc.querySelectorAll('.slide-container')[1]!);
    f.fire('contextmenu', target, { button: 2 });
    f.fire('click', doc.querySelector('[role=menuitem]')!);
    assert.equal(f.read().floatingRequest, undefined, attack);
    f.close();
  }
});

test('frozen scope is not replaced by current selection and changed target before consumption invalidates it', () => {
  const f = fixture('excel', scopeSheetHtml),
    doc = f.win.document,
    tab = doc.querySelectorAll('.sheet-tab')[1]!,
    item = doc.querySelector('[role=menuitem]')!;
  f.fire('contextmenu', tab, { button: 2 });
  f.fire('click', item);
  f.click(doc.querySelector('td')!);
  assert.deepEqual(f.read(false).floatingSelection, {
    kind: 'excel',
    scope: 'sheet',
    sheet: '二表',
  });
  tab.setAttribute('data-sheet', '0');
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
  const b = fixture('excel', scopeSheetHtml),
    foreign = doc.querySelector('.sheet-tab')!;
  b.fire('contextmenu', foreign, { button: 2 });
  b.fire('click', b.win.document.querySelector('[role=menuitem]')!);
  assert.equal(b.read().floatingRequest, undefined);
  b.close();
});

test('ambiguous original sheet indices, names and path ownership do not expose sheet requests', () => {
  for (const html of [
    scopeSheetHtml.replace('data-sheet="1">二表', 'data-sheet="0">二表'),
    scopeSheetHtml.replace('data-sheet="1">二表', 'data-sheet="1">一表'),
    scopeSheetHtml.replace(
      'class="sheet-content" data-sheet="1"',
      'class="sheet-content" data-sheet="0"',
    ),
    scopeSheetHtml.replace('/二表/A1', '/其他/A1'),
  ]) {
    const f = fixture('excel', html),
      doc = f.win.document;
    f.fire('contextmenu', doc.querySelectorAll('.sheet-tab')[1]!, { button: 2 });
    f.fire('click', doc.querySelector('[role=menuitem]')!);
    assert.equal(f.read().floatingRequest, undefined);
    f.close();
  }
});

function wordPagesHtml(count = 2) {
  return `<html data-kite-word-pagination-state="settled" data-kite-word-pagination-generation="1"><body>${Array.from({ length: count }, (_, i) => `<div class="page-wrapper"><div class="page" style="width:600px;height:800px;background:white;color:black"><div class="page-body"><p data-path="/body/p[${i + 1}]" id="original-${i}">第${i + 1}页正文</p></div></div></div>`).join('')}</body></html>`;
}

test('consumed sheet request stays locked until exact host release, so a later invalidation still identifies the open view', () => {
  const f = fixture('excel', scopeSheetHtml),
    doc = f.win.document,
    tabs = doc.querySelectorAll('.sheet-tab'),
    item = doc.querySelector('[role=menuitem]')!;
  f.fire('contextmenu', tabs[1]!, { button: 2 });
  f.fire('click', item);
  assert.equal(f.read().floatingRequest, 1);
  f.fire('contextmenu', tabs[0]!, { button: 2 });
  f.fire('click', item);
  f.click(doc.querySelector('td')!);
  f.control({ kind: 'request-edit' });
  assert.equal(f.read().floatingRequest, undefined);
  tabs[1]!.setAttribute('data-sheet', '3');
  assert.equal(f.read().requestInvalidated, 1);
  assert.equal(f.read().requestInvalidated, 1);
  f.release(2);
  assert.equal(f.read().requestInvalidated, 1);
  f.release(1);
  assert.equal(f.read().requestInvalidated, undefined);
  f.fire('contextmenu', tabs[0]!, { button: 2 });
  f.fire('click', item);
  assert.equal(f.read().floatingRequest, 2);
  f.release(1);
  tabs[0]!.textContent = 'changed';
  assert.equal(f.read().requestInvalidated, 2);
  f.close();
  for (const invalid of [0, -1, 1.5, Infinity, NaN])
    assert.throws(() => officeInteractionReleaseScript(invalid));
});

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

test('Word rail chrome overrides converter fonts narrowly and fits thumbnails inside vertical-scrollbar width', () => {
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

test('only fixed converter filename chrome is hidden; authored Excel and PPT title content stays intact', () => {
  const excel = fixture(
    'excel',
    '<div class="file-title">source.xlsx</div><div class="sheet-content active" data-sheet="0"><table><tr><td data-path="/预算/A1" style="color:red;background:yellow;font-family:serif"><span class="file-title">作者标题</span></td></tr></table></div><div class="sheet-tabs" role="tablist"><div class="sheet-tab active" data-sheet="0" role="tab" tabindex="0">预算</div></div>',
  );
  const doc = excel.win.document,
    cell = doc.querySelector('td')!;
  assert.equal((doc.querySelector('body > .file-title') as HTMLElement).style.display, 'none');
  assert.equal(doc.querySelector('body > .file-title')!.getAttribute('aria-hidden'), 'true');
  assert.equal((cell.querySelector('.file-title') as HTMLElement).style.display, '');
  assert.equal(cell.textContent, '作者标题');
  assert.equal(cell.getAttribute('style'), 'color:red;background:yellow;font-family:serif');
  excel.click(cell);
  assert.equal(excel.read().selection.cells[0].value, '作者标题');
  excel.close();
  const ppt = fixture(
    'powerpoint',
    '<div class="main"><h1 class="file-title">source.pptx</h1><div class="slide-container"><div class="slide"><h1 class="file-title" data-path="/slide[1]/shape[1]" style="color:purple">原幻灯片标题</h1><div class="main"><h1 class="file-title">嵌套原文</h1></div></div></div></div>',
  );
  assert.equal(
    (ppt.win.document.querySelector('body > .main > h1.file-title') as HTMLElement).style.display,
    'none',
  );
  for (const title of ppt.win.document.querySelectorAll<HTMLElement>('.slide .file-title'))
    assert.equal(title.style.display, '');
  const title = ppt.win.document.querySelector('[data-path]')!;
  ppt.click(title);
  assert.equal(ppt.read().selection.text, '原幻灯片标题');
  assert.equal(title.getAttribute('style'), 'color:purple');
  ppt.close();
});

test('Excel tabs keep original author colors, navigation attributes and precise right-click scope under neutral client chrome', () => {
  const html = scopeSheetHtml
    .replace('<div class="sheet-tabs">', '<div class="sheet-tabs" role="tablist">')
    .replace(
      '<div class="sheet-tab active" data-sheet="0">',
      '<div class="sheet-tab active" data-sheet="0" role="tab" tabindex="0" onclick="switchSheet(0)" onkeydown="if(event.key===\'Enter\')switchSheet(0)">',
    )
    .replace(
      '<div class="sheet-tab" data-sheet="1">',
      '<div class="sheet-tab" data-sheet="1" role="tab" tabindex="0" onclick="switchSheet(1)" style="--tab-color:#A1B2C3">',
    );
  const f = fixture('excel', html),
    doc = f.win.document,
    bar = doc.querySelector('.sheet-tabs')!,
    tabs = doc.querySelectorAll<HTMLElement>('.sheet-tab');
  assert.ok(bar.classList.contains('kite-office-chrome'));
  assert.equal(bar.getAttribute('role'), 'tablist');
  assert.equal(tabs[0]!.getAttribute('role'), 'tab');
  assert.equal(tabs[0]!.getAttribute('tabindex'), '0');
  assert.equal(tabs[0]!.getAttribute('onclick'), 'switchSheet(0)');
  assert.equal(tabs[0]!.getAttribute('onkeydown'), "if(event.key==='Enter')switchSheet(0)");
  assert.equal(tabs[1]!.style.getPropertyValue('--tab-color'), '#A1B2C3');
  assert.equal(tabs[1]!.style.getPropertyValue('--kite-sheet-accent'), '#A1B2C3');
  assert.equal(tabs[0]!.style.getPropertyValue('--kite-sheet-accent'), '');
  assert.equal(tabs[1]!.getAttribute('onclick'), 'switchSheet(1)');
  assert.equal(tabs[1]!.textContent, '二表');
  const css = [...doc.querySelectorAll('style')].map((style) => style.textContent).join('');
  assert.ok(css.includes('body>.kite-office-sheet-tabs>.sheet-tab{'));
  assert.ok(css.includes('box-shadow:inset 0 -2px var(--kite-sheet-accent,transparent)'));
  assert.ok(css.includes('background:var(--office-selected)!important'));
  assert.ok(css.includes('.sheet-tab:focus-visible'));
  f.fire('contextmenu', tabs[1]!, { button: 2 });
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.deepEqual(f.read().floatingSelection, { kind: 'excel', scope: 'sheet', sheet: '二表' });
  f.release(1);
  doc.querySelector('.sheet-content.active')!.classList.remove('active');
  doc.querySelectorAll('.sheet-content')[1]!.classList.add('active');
  tabs[0]!.classList.remove('active');
  tabs[1]!.classList.add('active');
  f.click(doc.querySelectorAll('td')[1]!);
  assert.equal(f.read().selection.sheet, '二表');
  assert.equal(f.read().selection.cells[0].value, 'two');
  f.close();
});

function excelLayoutHtml() {
  return (
    '<div class="sheet-content active" data-sheet="0"><div class="table-wrapper"><table style="border-collapse:collapse"><colgroup><col><col><col><col></colgroup><thead><tr><th class="corner-cell"></th><th class="col-header">A</th><th class="col-header">B</th><th class="col-header">C</th></tr></thead><tbody>' +
    [1, 2]
      .map(
        (row) =>
          '<tr><th class="row-header">' +
          row +
          '</th>' +
          ['A', 'B', 'C']
            .map(
              (col) =>
                `<td data-path="/S/${col}${row}" ${col === 'B' && row === 2 ? 'data-formula="SUM(A1:A2)"' : ''} style="background:yellow;color:navy;border-left:3px solid red">${col}${row}</td>`,
            )
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table></div></div><div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0">S</div></div>'
  );
}
function mockExcelLayout(f: ReturnType<typeof fixture>) {
  const doc = f.win.document,
    wrapper = doc.querySelector('.table-wrapper')!;
  Object.defineProperties(wrapper, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
  wrapper.getBoundingClientRect = () => rect(0, 40, 400, 200);
  doc.querySelector('thead')!.getBoundingClientRect = () => rect(0, 40, 280, 20);
  for (const header of doc.querySelectorAll('.row-header'))
    header.getBoundingClientRect = () => rect(0, 60, 40, 24);
  for (const cell of doc.querySelectorAll('td')) {
    const address = cell.getAttribute('data-path')!.split('/').at(-1)!;
    cell.getBoundingClientRect = () =>
      rect(40 + (address.charCodeAt(0) - 65) * 80, 60 + (Number(address[1]) - 1) * 24, 80, 24);
  }
}

test('Excel exposes stable minimal range metadata and locates only its original live anchor', () => {
  const f = fixture('excel', excelLayoutHtml()),
    doc = f.win.document;
  mockExcelLayout(f);
  const cells = doc.querySelectorAll('td'),
    a1 = cells[0]!,
    b2 = cells[4]!;
  assert.equal(doc.querySelector('.kite-excel-bar'), null);
  assert.equal(f.read().excelSelection, undefined);
  f.fire('pointerdown', b2);
  const firstSerial = f.read().excelSelection.selectionSerial;
  f.fire('pointerup', a1);
  const current = f.read(false);
  assert.equal(current.selection.range, 'A1:B2');
  assert.deepEqual(current.excelSelection, {
    selectionSerial: firstSerial + 1,
    activeAddress: 'B2',
  });
  assert.equal(
    current.selection.cells.find((c: { address: string }) => c.address === 'B2').formula,
    'SUM(A1:A2)',
  );
  for (let i = 0; i < 3; i++) assert.deepEqual(f.read().excelSelection, current.excelSelection);
  let located = 0;
  b2.scrollIntoView = () => {
    located++;
  };
  assert.throws(
    () => f.control({ kind: 'locate-selection', selectionSerial: firstSerial }),
    /preview_selection_replaced/,
  );
  f.control({ kind: 'locate-selection', selectionSerial: current.excelSelection.selectionSerial });
  assert.equal(located, 1);
  assert.deepEqual(f.read().selection, current.selection);
  assert.equal(f.read().floatingRequest, undefined);
  f.fire('keydown', a1, { key: 'Escape' });
  assert.equal(f.read().excelSelection, undefined);
  assert.throws(() =>
    f.control({
      kind: 'locate-selection',
      selectionSerial: current.excelSelection.selectionSerial,
    }),
  );
  f.click(a1);
  const single = f.read().excelSelection;
  f.click(b2, { shiftKey: true });
  assert.equal(f.read().excelSelection.activeAddress, 'A1');
  assert.ok(f.read().excelSelection.selectionSerial > single.selectionSerial);
  f.close();
});

test('locate rejects invalid controls, stale ranges, frozen consumed requests and changed original ownership', () => {
  for (const selectionSerial of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      officeInteractionControlScript({ kind: 'locate-selection', selectionSerial }),
    );
  assert.throws(() =>
    officeInteractionControlScript({
      kind: 'locate-selection',
      selectionSerial: 1,
      path: '/S/A1',
    } as never),
  );
  for (const attack of ['sheet', 'path', 'text', 'formula', 'row', 'table', 'removed', 'request']) {
    const f = fixture('excel', excelLayoutHtml()),
      doc = f.win.document,
      cell = doc.querySelector('td')!;
    f.click(cell);
    const metadata = f.read().excelSelection;
    let located = 0;
    cell.scrollIntoView = () => {
      located++;
    };
    if (attack === 'sheet') doc.querySelector('.sheet-content')!.classList.remove('active');
    if (attack === 'path') cell.setAttribute('data-path', '/Other/A1');
    if (attack === 'text') cell.textContent = 'forged';
    if (attack === 'formula') cell.setAttribute('data-formula', '=FORGED()');
    if (attack === 'row') doc.querySelectorAll('tr')[2]!.append(cell);
    if (attack === 'table') {
      const t = doc.createElement('table');
      doc.querySelector('.sheet-content')!.append(t);
      t.append(cell.parentElement!);
    }
    if (attack === 'removed') cell.remove();
    if (attack === 'request') {
      f.control({ kind: 'request-edit' });
      assert.equal(f.read().floatingRequest, 1);
    }
    assert.throws(
      () => f.control({ kind: 'locate-selection', selectionSerial: metadata.selectionSerial }),
      /preview_selection_replaced/,
      attack,
    );
    assert.equal(located, 0, attack);
    if (attack === 'request') {
      // Consumption does not unlock. Only the matching host lifetime release does.
      f.release(2);
      assert.throws(() =>
        f.control({ kind: 'locate-selection', selectionSerial: metadata.selectionSerial }),
      );
      f.release(1);
      f.control({ kind: 'locate-selection', selectionSerial: metadata.selectionSerial });
      assert.equal(located, 1);
    } else assert.equal(f.read().excelSelection, undefined);
    f.close();
  }
});

test('Excel range decoration is a clipped perimeter with transparent anchor, not cell outlines or author style edits', () => {
  const f = fixture('excel', excelLayoutHtml()),
    doc = f.win.document;
  mockExcelLayout(f);
  const cells = [...doc.querySelectorAll('td')],
    originals = cells.map((cell) => cell.getAttribute('style'));
  f.fire('pointerdown', cells[4]!);
  f.fire('pointerup', cells[0]!);
  const host = doc.querySelector('.kite-office-selection-paint') as HTMLElement;
  const layer = host.shadowRoot!.querySelector('.kite-excel-range-layer') as HTMLElement;
  assert.equal(layer.getAttribute('aria-hidden'), 'true');
  assert.equal(layer.inert, true);
  assert.equal(layer.style.top, '40px');
  assert.equal(layer.style.left, '0px');
  assert.equal(layer.querySelectorAll('.kite-excel-range-fill').length, 3);
  assert.equal(layer.querySelectorAll('[data-edge]').length, 8);
  for (const edge of ['top', 'bottom', 'left', 'right'])
    assert.equal(layer.querySelectorAll(`[data-edge=${edge}]`).length, 2);
  assert.deepEqual(
    cells.map((cell) => cell.getAttribute('style')),
    originals,
  );
  assert.equal(doc.querySelector('table')!.style.borderCollapse, 'collapse');
  assert.ok(doc.querySelector('table')!.classList.contains('kite-excel-grid'));
  for (let i = 0; i < 20; i++) doc.dispatchEvent(new f.win.Event('scroll'));
  assert.equal(f.frameCount(), 1);
  f.frame();
  doc.querySelector('.sheet-content')!.classList.remove('active');
  f.read();
  assert.equal(layer.style.display, 'none');
  assert.equal(f.read().excelSelection, undefined);
  f.close();
});

test('sheet requests do not fabricate cell metadata and retired document controls cannot act', () => {
  const f = fixture('excel', excelLayoutHtml()),
    doc = f.win.document;
  f.click(doc.querySelector('td')!);
  const previous = f.read().excelSelection;
  f.fire('contextmenu', doc.querySelector('.sheet-tab')!, { button: 2 });
  assert.equal(f.read().excelSelection, undefined);
  f.fire('click', doc.querySelector('[role=menuitem]')!);
  assert.deepEqual(f.read().floatingSelection, { kind: 'excel', scope: 'sheet', sheet: 'S' });
  assert.throws(() =>
    f.control({ kind: 'locate-selection', selectionSerial: previous.selectionSerial }),
  );
  for (const name of ['kite-excel-name', 'kite-excel-expand', 'kite-excel-value']) {
    const forged = doc.createElement('button');
    forged.className = name;
    doc.body.append(forged);
    f.fire('click', forged);
  }
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

test('selection painting is in a noninteractive ShadowRoot without changing original object styles', () => {
  for (const kind of ['excel', 'powerpoint'] as const) {
    const html =
      kind === 'excel'
        ? excelLayoutHtml()
        : '<div class="main"><div class="slide-container"><div class="slide"><div data-path="/slide[1]/shape[@id=1]" style="background:red;outline:3px dashed blue">Object</div></div></div></div>';
    const f = fixture(kind, html),
      doc = f.win.document,
      original = doc.querySelector('[data-path]')!;
    const before = original.getAttribute('style');
    f.click(original);
    const host = doc.querySelector('.kite-office-selection-paint') as HTMLElement;
    assert.equal(host.inert, true);
    assert.equal(host.getAttribute('aria-hidden'), 'true');
    assert.equal(host.style.pointerEvents, 'none');
    assert.ok(host.shadowRoot);
    assert.equal(doc.querySelector('.kite-excel-range-layer'), null);
    assert.equal(doc.querySelector('.kite-office-object-selection'), null);
    assert.equal(original.getAttribute('style'), before);
    assert.ok(
      ![...doc.querySelectorAll('style')].some((s) =>
        s.textContent?.includes('[data-kite-selected]{'),
      ),
    );
    if (kind === 'powerpoint')
      assert.equal(host.shadowRoot!.querySelectorAll('.kite-office-object-selection').length, 1);
    f.close();
  }
});

test('only the exact generated offline notice is removed; authored details are never transferred', () => {
  const fixed =
    '<details role="note" style="position:fixed;top:8px;right:8px;z-index:10000"><summary>Kite 离线预览说明</summary>排版可能与 Office 不同；复杂 3D 与动画不受支持。</details>';
  const authored = '<details role="note" id="author"><summary>作者说明</summary>保留正文</details>';
  const f = fixture('excel', fixed + authored + excelLayoutHtml()),
    doc = f.win.document;
  assert.equal(doc.querySelectorAll('details').length, 1);
  assert.equal(doc.querySelector('#author')!.textContent, '作者说明保留正文');
  assert.equal(doc.querySelector('.kite-excel-bar'), null);
  f.close();
  const changed = fixture('excel', fixed.replace('排版可能', '作者排版可能') + excelLayoutHtml());
  assert.equal(changed.win.document.querySelectorAll('details').length, 1);
  changed.close();
});

function frozenPaintFixture(
  rows = 1000,
  paper = 'background:rgb(20,40,60)',
  beforeInstall?: (win: JSDOM['window']) => void,
) {
  const observed: Element[] = [],
    observedHeaders: Element[] = [];
  let notify: (targets: Element[], visible?: boolean) => void = () => {};
  let styles = 0,
    rects = 0;
  const f = fixture(
    'excel',
    `<style>*{opacity:1;background-image:none}td{border:0 solid transparent}.table-wrapper{${paper}}tr{background:rgba(255,0,0,.5)}</style><div class="sheet-content active"><div class="table-wrapper"><table><colgroup><col><col><col></colgroup><thead><tr><th></th><th class="col-header">A</th><th class="col-header">B</th></tr></thead><tbody>${Array.from({ length: rows }, (_, i) => `<tr><th class="row-header">${i + 1}</th><td data-path="/S/A${i + 1}" style="position:sticky;left:40px;z-index:1;${i === 0 ? 'border-top:2px solid red;border-left:2px dashed red;border-right:3px double blue;border-bottom:3px dotted blue;' : ''}">A${i + 1}</td><td data-path="/S/B${i + 1}">B${i + 1}</td></tr>`).join('')}</tbody></table></div></div>`,
    (win) => {
      win.IntersectionObserver = class {
        targets = new Set<Element>();
        constructor(callback: IntersectionObserverCallback) {
          const previous = notify;
          notify = (targets, visible = true) => {
            previous(targets, visible);
            callback(
              targets
                .filter((target) => this.targets.has(target))
                .map((target) => ({
                  target,
                  isIntersecting: visible,
                  intersectionRect: { width: 80, height: 20 },
                })) as IntersectionObserverEntry[],
              {} as IntersectionObserver,
            );
          };
        }
        observe(element: Element) {
          this.targets.add(element);
          (element.tagName === 'TH' ? observedHeaders : observed).push(element);
        }
      } as unknown as typeof win.IntersectionObserver;
      const compute = win.getComputedStyle.bind(win);
      win.getComputedStyle = ((...args: Parameters<typeof win.getComputedStyle>) => {
        styles++;
        return compute(...args);
      }) as typeof win.getComputedStyle;
      win.HTMLElement.prototype.getBoundingClientRect = function () {
        rects++;
        const top = this.tagName === 'TD' ? 30 : 10;
        return { left: 10, right: 90, top, bottom: top + 20, width: 80, height: 20 } as DOMRect;
      };
      const wrapper = win.document.querySelector('.table-wrapper')!;
      Object.defineProperty(wrapper, 'clientWidth', { value: 100 });
      Object.defineProperty(wrapper, 'clientHeight', { value: 100 });
      beforeInstall?.(win);
    },
  );
  return {
    ...f,
    observed,
    observedHeaders,
    notify: (targets: Element[], visible = true) => notify(targets, visible),
    metrics: () => ({ styles, rects }),
    resetMetrics: () => {
      styles = rects = 0;
    },
  };
}

test("frozen paper installation completes all sheets' style reads before applying any marker", () => {
  const events: { kind: 'read' | 'write'; path: string | null }[] = [];
  let originalStyles: (string | null)[] = [];
  const f = frozenPaintFixture(4, 'background:rgb(20,40,60)', (win) => {
    const second = win.document.querySelector('.sheet-content')!.cloneNode(true) as Element;
    second.classList.remove('active');
    for (const cell of second.querySelectorAll('[data-path]'))
      cell.setAttribute('data-path', cell.getAttribute('data-path')!.replace('/S/', '/T/'));
    win.document.body.append(second);
    originalStyles = [...win.document.querySelectorAll('td')].map((cell) =>
      cell.getAttribute('style'),
    );
    const compute = win.getComputedStyle.bind(win);
    win.getComputedStyle = ((...args: Parameters<typeof win.getComputedStyle>) => {
      events.push({ kind: 'read', path: args[0].getAttribute('data-path') });
      return compute(...args);
    }) as typeof win.getComputedStyle;
    const set = win.Element.prototype.setAttribute;
    win.Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (name === 'data-kite-frozen-paper')
        events.push({ kind: 'write', path: this.getAttribute('data-path') });
      return set.call(this, name, value);
    };
  });
  assert.equal(f.observed.length, 8);
  const writes = events.filter((event) => event.kind === 'write');
  assert.equal(writes.length, 8);
  assert.equal(new Set(writes.map((event) => event.path)).size, 8);
  const firstWrite = events.findIndex((event) => event.kind === 'write');
  assert.ok(firstWrite > 0);
  assert.equal(
    events.slice(firstWrite).some((event) => event.kind === 'read'),
    false,
  );
  for (const { path } of writes)
    assert.ok(
      events.slice(0, firstWrite).some((event) => event.kind === 'read' && event.path === path),
    );
  assert.equal(f.win.document.querySelectorAll('td[data-kite-frozen-paper]').length, 8);
  assert.deepEqual(
    [...f.win.document.querySelectorAll('td')].map((cell) => cell.getAttribute('style')),
    originalStyles,
  );
  f.close();
});

test('frozen paint measures only original visible candidates and composites actual paper without changing author data', () => {
  const f = frozenPaintFixture(),
    doc = f.win.document;
  assert.equal(f.observed.length, 1000);
  const first = f.observed[0]!,
    other = f.observed[24]!;
  const original = first.getAttribute('style'),
    text = first.textContent;
  f.resetMetrics();
  f.notify([first, other]);
  f.frame();
  assert.equal(doc.querySelectorAll('[data-kite-frozen-paper]').length, 1000);
  assert.equal(first.getAttribute('style'), original);
  assert.equal(first.textContent, text);
  const rules = [...doc.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n');
  assert.match(rules, /background:\s*rgb\(138,\s*20,\s*30\)/);
  assert.ok(f.metrics().styles < 30, JSON.stringify(f.metrics()));
  f.resetMetrics();
  for (let i = 0; i < 25; i++) f.fire('scroll', doc.querySelector('.table-wrapper')!);
  assert.equal(f.frameCount(), 1);
  f.frame();
  assert.ok(f.metrics().styles < 5, JSON.stringify(f.metrics()));
  assert.ok(f.metrics().rects < 20, JSON.stringify(f.metrics()));
  const border = doc.querySelector<HTMLElement>('.kite-excel-frozen-borders > div > div');
  // This fixture has no actual left displacement: original native border remains owner.
  assert.equal(border, null);
  first.getBoundingClientRect = () =>
    ({ left: 30, right: 110, top: 30, bottom: 50, width: 80, height: 20 }) as DOMRect;
  f.read(false);
  const painted = doc.querySelector<HTMLElement>('.kite-excel-frozen-borders > div > div')!;
  assert.equal(painted.style.borderLeft, '2px dashed rgb(255, 0, 0)');
  assert.equal(painted.style.borderRight, '3px double rgb(0, 0, 255)');
  assert.equal(painted.style.borderBottom, '3px dotted rgb(0, 0, 255)');
  assert.equal(first.getAttribute('style'), original);
  console.log(
    JSON.stringify({
      measurement: 'frozen-paint-visible-jsdom',
      indexed: f.observed.length,
      visible: 2,
      ...f.metrics(),
    }),
  );
  f.notify([first], false);
  f.frame();
  assert.equal(first.hasAttribute('data-kite-frozen-paper'), true);
  assert.equal(f.read(false).floatingRequest, undefined);
  f.close();
});

test('frozen paint fails closed on altered originals, foreign sheet, complex paper and over-budget visible sets', () => {
  const f = frozenPaintFixture(520),
    doc = f.win.document;
  const first = f.observed[0]!,
    other = f.observed[1]!;
  f.notify([first, other]);
  f.frame();
  assert.ok(first.hasAttribute('data-kite-frozen-paper'));
  first.setAttribute('data-path', '/Other/A1');
  f.read(false);
  assert.equal(first.hasAttribute('data-kite-frozen-paper'), false);
  other.setAttribute(
    'style',
    `${other.getAttribute('style')};background:linear-gradient(red,blue)`,
  );
  f.read(false);
  assert.equal(other.hasAttribute('data-kite-frozen-paper'), false);
  const valid = f.observed[2]!;
  f.notify([valid]);
  f.frame();
  assert.ok(valid.hasAttribute('data-kite-frozen-paper'));
  doc.querySelector('.sheet-content')!.classList.remove('active');
  f.read(false);
  assert.equal(valid.hasAttribute('data-kite-frozen-paper'), true);
  assert.equal(doc.querySelector('.kite-excel-frozen-borders')!.childElementCount, 0);
  doc.querySelector('.sheet-content')!.classList.add('active');
  f.notify(f.observed);
  f.frame();
  assert.equal(doc.querySelectorAll('[data-kite-frozen-paper]').length, 518);
  assert.equal(doc.querySelector('.kite-excel-frozen-borders')!.childElementCount, 0);
  const forged = valid.cloneNode(true) as Element;
  valid.parentElement!.append(forged);
  assert.equal(f.observed.includes(forged), false);
  assert.equal(f.read(false).floatingRequest, undefined);
  f.close();
});

test('frozen paper rejects initially complex backgrounds and retires changed offscreen originals', async () => {
  for (const paper of [
    'background:linear-gradient(red,blue)',
    'background:blue;opacity:.5',
    'background:blue;transform:rotate(2deg)',
  ]) {
    const f = frozenPaintFixture(2, paper);
    assert.equal(f.win.document.querySelectorAll('[data-kite-frozen-paper]').length, 0);
    f.close();
  }
  const f = frozenPaintFixture(3),
    cell = f.observed[2]!;
  assert.ok(cell.hasAttribute('data-kite-frozen-paper'));
  cell.textContent = 'changed offscreen';
  await Promise.resolve();
  assert.equal(cell.hasAttribute('data-kite-frozen-paper'), false);
  assert.equal(f.read(false).floatingRequest, undefined);
  f.close();
});

test('Excel perimeter covers both collapsed edge owners and cancellation or rejected merges leaves no stale range', () => {
  const f = fixture('excel', excelLayoutHtml(), (win) => {
    for (const cell of win.document.querySelectorAll<HTMLElement>('td'))
      cell.style.cssText = 'background:yellow;border:1px solid #e0e0e0';
    for (const cell of win.document.querySelectorAll<HTMLElement>(
      '[data-path="/S/B1"],[data-path="/S/B2"]',
    ))
      cell.style.borderLeft = '6px dashed purple';
    win.document.querySelector('[data-path="/S/C1"]')!.setAttribute('colspan', '2');
  });
  const doc = f.win.document;
  mockExcelLayout(f);
  const cells = [...doc.querySelectorAll('td')],
    before = cells.map((e) => e.getAttribute('style'));
  const a1 = cells[0]!,
    a2 = cells[3]!;
  f.fire('pointerdown', a1);
  f.fire('pointerup', a2);
  assert.equal(f.read().selection.range, 'A1:A2');
  const paint = doc.querySelector('.kite-office-selection-paint')!.shadowRoot!;
  const edges = [...paint.querySelectorAll<HTMLElement>('.kite-excel-range-edge[data-edge=right]')];
  assert.equal(edges.length, 2);
  // B's unselected left stroke owns the collapsed shared edge; A's own stroke is only 1px.
  for (const edge of edges) {
    assert.equal(edge.style.width, '6px');
    assert.equal(edge.style.left, '117px');
  }
  assert.equal(paint.querySelectorAll('.kite-excel-range-edge[data-edge=top]').length, 1);
  assert.equal(paint.querySelectorAll('.kite-excel-range-edge[data-edge=bottom]').length, 1);
  f.fire('keydown', a1, { key: 'Escape' });
  assert.equal(paint.querySelectorAll('.kite-excel-range-edge,.kite-excel-range-fill').length, 0);
  assert.equal(f.read().selection, null);
  f.click(a1);
  f.click(cells[2]!);
  assert.equal(f.read().selection, null);
  assert.equal(f.read().floatingRequest, undefined);
  assert.equal(paint.querySelectorAll('.kite-excel-range-edge,.kite-excel-range-fill').length, 0);
  assert.deepEqual(
    cells.map((e) => e.getAttribute('style')),
    before,
  );
  f.close();
});

test('Excel row-header gap paper is scoped to original chrome and only horizontal displacement', () => {
  const f = fixture('excel', excelLayoutHtml(), (win) => {
    win.document.querySelector<HTMLElement>('td')!.style.borderBottom = '3px solid red';
  });
  mockExcelLayout(f);
  const doc = f.win.document,
    table = doc.querySelector('table')!,
    wrapper = doc.querySelector<HTMLElement>('.table-wrapper')!;
  const before = [...doc.querySelectorAll('td')].map((e) => e.getAttribute('style'));
  assert.equal(table.hasAttribute('data-kite-scrolled-x'), false);
  assert.equal(doc.querySelectorAll('tbody th.kite-excel-row-header').length, 2);
  assert.equal(doc.querySelectorAll('td.kite-excel-row-header').length, 0);
  const css = [...doc.querySelectorAll('style')].map((e) => e.textContent).join('');
  assert.ok(css.includes('[data-kite-scrolled-x]'));
  assert.ok(
    css.includes('border-top-width:0;border-bottom-width:0;box-shadow:inset 0 -1px 0 #e0e0e0'),
  );
  assert.ok(css.includes(':not(.no-grid)'));
  assert.ok(css.includes('inset:0 -1px;z-index:-1;background:inherit;box-shadow:inherit'));
  assert.ok(css.includes('tr:first-child>.kite-excel-row-header::before{top:-2px}'));
  assert.equal(doc.querySelector('.kite-excel-row-lines'), null);
  wrapper.scrollLeft = 80;
  doc.dispatchEvent(new f.win.Event('scroll'));
  f.frame();
  assert.equal(table.hasAttribute('data-kite-scrolled-x'), true);
  wrapper.scrollTop = 200;
  doc.dispatchEvent(new f.win.Event('scroll'));
  f.frame();
  wrapper.scrollTop = 0;
  doc.dispatchEvent(new f.win.Event('scroll'));
  f.frame();
  assert.equal(table.hasAttribute('data-kite-scrolled-x'), true);
  wrapper.scrollLeft = 0;
  doc.dispatchEvent(new f.win.Event('scroll'));
  f.frame();
  assert.equal(table.hasAttribute('data-kite-scrolled-x'), false);
  assert.deepEqual(
    [...doc.querySelectorAll('td')].map((e) => e.getAttribute('style')),
    before,
  );
  f.close();
});

test('original frozen prefix remains paintable beside a later merge, never the merged cell or ambiguous suffix', async () => {
  // The source, including its later merge, exists before installation.
  const source =
    '<style>*{opacity:1;background-image:none}</style><div class="sheet-content active"><div class="table-wrapper" style="background:white"><table><colgroup><col><col><col><col></colgroup><thead><tr><th></th><th class="col-header">A</th></tr></thead><tbody><tr><th class="row-header">1</th><td data-path="/S/A1" style="position:sticky;left:40px">A</td><td data-path="/S/B1" colspan="2">merge</td></tr></tbody></table></div></div>';
  const g = fixture('excel', source, (win) => {
    Object.assign(win, {
      IntersectionObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  });
  const a = g.win.document.querySelector('[data-path="/S/A1"]')!,
    b = g.win.document.querySelector('[data-path="/S/B1"]')!;
  assert.ok(a.hasAttribute('data-kite-frozen-paper'));
  assert.equal(b.hasAttribute('data-kite-frozen-paper'), false);
  const before = a.getAttribute('style');
  b.setAttribute('colspan', '3');
  await Promise.resolve();
  g.frame();
  assert.equal(a.hasAttribute('data-kite-frozen-paper'), false);
  assert.equal(a.getAttribute('style'), before);
  g.close();
});

test('fixed scope menus clamp viewport coordinates before converting root zoom, preserving exact targets', () => {
  for (const kind of ['excel', 'powerpoint', 'word'] as const)
    for (const zoom of [1.25, 2]) {
      const html =
        kind === 'excel' ? scopeSheetHtml : kind === 'word' ? wordPagesHtml() : scopePptHtml;
      const f = fixture(kind, html),
        doc = f.win.document;
      Object.defineProperty(f.win, 'innerWidth', { value: 400 });
      Object.defineProperty(f.win, 'innerHeight', { value: 300 });
      Object.defineProperty(doc.documentElement, 'clientWidth', { value: 385 });
      Object.defineProperty(doc.documentElement, 'clientHeight', { value: 285 });
      doc.documentElement.style.zoom = String(zoom);
      const target = doc.querySelectorAll(
        kind === 'excel'
          ? '.sheet-tab'
          : kind === 'word'
            ? '.kite-word-page-button'
            : '.kite-thumbnail-button',
      )[1]!;
      const menu = doc.querySelector('[role=menu]') as HTMLElement;
      menu.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100 * zoom, height: 40 * zoom }) as DOMRect;
      for (const [x, y] of [
        [399, 299],
        [0, 0],
      ]) {
        f.fire('contextmenu', target, { button: 2, clientX: x, clientY: y });
        assert.equal(Number.parseFloat(menu.style.left) * zoom, x === 0 ? 4 : 385 - 100 * zoom - 4);
        assert.equal(Number.parseFloat(menu.style.top) * zoom, y === 0 ? 4 : 285 - 40 * zoom - 4);
        assert.equal(Number.parseFloat(menu.style.maxWidth) * zoom, 377);
        assert.equal(f.read(false).floatingRequest, undefined);
        f.fire('keydown', doc.querySelector('[role=menuitem]')!, { key: 'Escape' });
        assert.equal(menu.style.display, 'none');
      }
      f.fire('contextmenu', target, { button: 2, clientX: 399, clientY: 299 });
      f.fire('click', doc.querySelector('[role=menuitem]')!);
      const request = f.read();
      assert.equal(request.floatingRequest, 1);
      assert.equal(request.floatingSelection.kind, kind);
      if (kind === 'excel') assert.equal(request.floatingSelection.sheet, '二表');
      else assert.equal(request.floatingSelection[kind === 'word' ? 'page' : 'slide'], 2);
      assert.equal(f.read().floatingRequest, undefined);
      f.close();
    }
});

test('object request capsules and range status share zoom conversion without changing viewport request anchors', () => {
  for (const zoom of [1.25, 2]) {
    const f = fixture('powerpoint', scopePptHtml),
      doc = f.win.document;
    Object.defineProperty(f.win, 'innerWidth', { value: 400 });
    Object.defineProperty(f.win, 'innerHeight', { value: 300 });
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 385 });
    Object.defineProperty(doc.documentElement, 'clientHeight', { value: 285 });
    doc.documentElement.style.zoom = String(zoom);
    const target = doc.querySelector('[data-path]')!,
      button = doc.querySelector('.kite-office-request-trigger') as HTMLElement;
    target.getBoundingClientRect = () =>
      ({ left: 350, top: 250, right: 390, bottom: 290, width: 40, height: 40 }) as DOMRect;
    button.getBoundingClientRect = () => ({ width: 80 * zoom, height: 30 * zoom }) as DOMRect;
    f.click(target);
    assert.equal(parseFloat(button.style.left) * zoom, 385 - 80 * zoom - 4);
    assert.equal(parseFloat(button.style.top) * zoom, 285 - 30 * zoom - 4);
    f.control({ kind: 'request-edit' });
    assert.deepEqual(f.read().requestAnchor, { x: 350, y: 250, width: 40, height: 40 });
    f.close();
    const e = fixture('excel', excelGrid(257)),
      ed = e.win.document;
    Object.defineProperty(ed.documentElement, 'clientWidth', { value: 385 });
    Object.defineProperty(ed.documentElement, 'clientHeight', { value: 285 });
    ed.documentElement.style.zoom = String(zoom);
    Object.defineProperty(e.win, 'innerWidth', { value: 400 });
    Object.defineProperty(e.win, 'innerHeight', { value: 300 });
    const status = ed.querySelector('.kite-office-range-status') as HTMLElement;
    status.getBoundingClientRect = () => ({ width: 160 * zoom, height: 24 * zoom }) as DOMRect;
    const cells = ed.querySelectorAll('td');
    cells[256]!.getBoundingClientRect = () =>
      ({ left: 380, bottom: 299, width: 40, height: 20 }) as DOMRect;
    e.fire('pointerdown', cells[0]!);
    e.fire('pointerup', cells[256]!);
    assert.equal(status.style.display, 'block');
    assert.equal(parseFloat(status.style.left) * zoom, 385 - 160 * zoom - 4);
    assert.equal(parseFloat(status.style.top) * zoom, 285 - 24 * zoom - 4);
    assert.equal(e.read().selection, null);
    assert.equal(e.read().floatingRequest, undefined);
    e.close();
  }
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

test('only original Excel tab chrome counter-scales with root zoom while cell data and scope stay intact', () => {
  const f = fixture('excel', scopeSheetHtml, (win) => {
    win.document.documentElement.style.zoom = '2';
  });
  const doc = f.win.document,
    bar = doc.querySelector<HTMLElement>('.sheet-tabs')!,
    tab = bar.children[1]!,
    cell = doc.querySelector<HTMLElement>('td')!;
  const original = cell.outerHTML;
  assert.equal(bar.style.zoom, '0.5');
  const forged = bar.cloneNode(true) as HTMLElement;
  forged.style.zoom = '';
  doc.body.append(forged);
  for (const value of [1, 1.25, 2, 'fit'] as const) {
    f.control({ kind: 'zoom', value });
    assert.equal(doc.documentElement.style.zoom, String(value === 'fit' ? 1 : value));
    assert.equal(bar.style.zoom, String(value === 'fit' ? 1 : 1 / value));
    assert.equal(forged.style.zoom, '');
    assert.equal(cell.outerHTML, original);
    f.fire('contextmenu', tab, { button: 2, clientX: 40, clientY: 70 });
    f.fire('click', doc.querySelector('[role=menuitem]')!);
    const request = f.read();
    assert.deepEqual(request.floatingSelection, { kind: 'excel', scope: 'sheet', sheet: '二表' });
    f.release(request.floatingRequest);
  }
  f.fire('contextmenu', forged.children[1]!, { button: 2 });
  assert.equal(f.read().floatingSelection, undefined);
  f.close();
});

test('only the original fixed Excel flex shell reserves the unzoomed viewport for grid and tabs', () => {
  const html =
    '<style>body{display:flex;flex-direction:column}</style><div class="sheet-slider">' +
    scopeSheetHtml.replace('<div class="sheet-tabs">', '</div><div class="sheet-tabs">');
  const f = fixture('excel', html),
    doc = f.win.document;
  for (const zoom of [1, 1.25, 2, 'fit'] as const) {
    f.control({ kind: 'zoom', value: zoom });
    assert.equal(doc.body.style.height, `${f.win.innerHeight / (zoom === 'fit' ? 1 : zoom)}px`);
    assert.equal(doc.body.style.minHeight, '0px');
  }
  const slider = doc.querySelector('.sheet-slider')!;
  slider.remove();
  f.control({ kind: 'zoom', value: 2 });
  assert.equal(doc.body.style.height, `${f.win.innerHeight}px`);
  f.close();
  const other = fixture('excel', scopeSheetHtml);
  other.control({ kind: 'zoom', value: 2 });
  assert.equal(other.win.document.body.style.height, '');
  assert.equal(other.win.document.body.style.minHeight, '');
  other.close();
});

test('tab sizing rejects nonfinite viewport claims and a detached original bar without granting scope to replacements', () => {
  const html =
    '<style>body{display:flex;flex-direction:column}</style><div class="sheet-slider">' +
    scopeSheetHtml.replace('<div class="sheet-tabs">', '</div><div class="sheet-tabs">');
  const viewport = { height: Infinity };
  const f = fixture('excel', html, (win) =>
    Object.defineProperty(win, 'visualViewport', { value: viewport }),
  );
  const doc = f.win.document,
    bar = doc.querySelector('.sheet-tabs')!;
  f.control({ kind: 'zoom', value: 2 });
  assert.equal(doc.body.style.height, `${f.win.innerHeight / 2}px`);
  viewport.height = NaN;
  Object.defineProperty(f.win, 'innerHeight', { value: 0, configurable: true });
  f.control({ kind: 'zoom', value: 1.25 });
  assert.equal(doc.body.style.height, '384px');
  viewport.height = 600;
  f.fireWindow('resize');
  assert.equal(doc.body.style.height, '480px');
  const replacement = bar.cloneNode(true);
  bar.replaceWith(replacement);
  f.control({ kind: 'zoom', value: 2 });
  assert.equal(doc.body.style.height, '480px');
  f.fire('contextmenu', (replacement as Element).children[1]!, { button: 2 });
  assert.equal(f.read().floatingRequest, undefined);
  f.close();
});

test('only the original Excel request button stays at interface scale and clamps in viewport pixels', () => {
  for (const value of [0.75, 1, 1.25, 2, 'fit'] as const) {
    const f = fixture(
        'excel',
        '<div class="sheet-content active"><table><tr><td data-path="/S/A1">original</td></tr></table></div>',
      ),
      doc = f.win.document,
      cell = doc.querySelector('td')!,
      button = doc.querySelector('.kite-office-request-trigger') as HTMLElement;
    Object.defineProperty(f.win, 'innerWidth', { value: 400 });
    Object.defineProperty(f.win, 'innerHeight', { value: 300 });
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 385, configurable: true });
    Object.defineProperty(doc.documentElement, 'clientHeight', { value: 285 });
    const original = cell.outerHTML;
    const forged = button.cloneNode(true) as HTMLElement;
    doc.body.append(forged);
    f.control({ kind: 'zoom', value });
    const rootScale = value === 'fit' ? 1 : value;
    // Controlled geometry checks conversion, not Chromium zoom/hit-testing.
    button.getBoundingClientRect = () =>
      ({
        width:
          Math.min(120, parseFloat(button.style.maxWidth) || 120) *
          rootScale *
          (Number(button.style.zoom) || 1),
        height: 30 * rootScale * (Number(button.style.zoom) || 1),
      }) as DOMRect;
    for (const [left, top] of [
      [370, 270],
      [12, 24],
      [-20, -40],
    ]) {
      cell.getBoundingClientRect = () =>
        ({ left, top, right: left! + 20, bottom: top! + 10, width: 20, height: 10 }) as DOMRect;
      f.click(cell);
      assert.equal(button.style.zoom, String(1 / rootScale));
      assert.equal(button.style.transform, '');
      assert.equal(parseFloat(button.style.maxWidth), 377);
      assert.equal(parseFloat(button.style.left), Math.max(4, Math.min(261, left!)));
      assert.equal(parseFloat(button.style.top), Math.max(4, Math.min(251, top! + 15)));
      assert.equal(button.getBoundingClientRect().width, 120);
      assert.equal(button.getBoundingClientRect().height, 30);
      assert.equal(f.read(false).selection.range, 'A1');
    }
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 90 });
    f.click(cell);
    assert.equal(parseFloat(button.style.maxWidth), 82);
    assert.equal(button.getBoundingClientRect().width, 82);
    assert.equal(button.style.left, '4px');
    assert.equal(forged.style.zoom, '');
    const unchanged = cell.cloneNode(true) as Element;
    unchanged.removeAttribute('data-kite-selected');
    assert.equal(unchanged.outerHTML, original);
    f.control({ kind: 'request-edit' });
    const request = f.read();
    assert.equal(request.floatingSelection.range, 'A1');
    assert.deepEqual(request.requestAnchor, { x: -20, y: -40, width: 20, height: 10 });
    assert.equal(f.read().floatingRequest, undefined);
    f.close();
  }
});

test('Excel fixed-size request button tracks scroll and zoom without changing the range or authored cells', () => {
  const f = fixture('excel', excelLayoutHtml()),
    doc = f.win.document;
  mockExcelLayout(f);
  const cell = doc.querySelector('[data-path="/S/B2"]')!,
    wrapper = doc.querySelector('.table-wrapper')!,
    button = doc.querySelector('.kite-office-request-trigger') as HTMLElement,
    original = [...doc.querySelectorAll('td')].map((node) => node.outerHTML);
  let left = 120,
    top = 84;
  cell.getBoundingClientRect = () =>
    ({ left, top, right: left + 80, bottom: top + 24, width: 80, height: 24 }) as DOMRect;
  button.getBoundingClientRect = () => ({ width: 120, height: 30 }) as DOMRect;
  f.click(cell);
  const selection = f.read(false).selection;
  for (const value of [2, 0.75, 1.25, 'fit'] as const) {
    f.control({ kind: 'zoom', value });
    f.frame();
    assert.equal(button.style.zoom, String(value === 'fit' ? 1 : 1 / value));
    assert.equal(parseFloat(button.style.left), left);
    assert.equal(parseFloat(button.style.top), top + 29);
    left = left === 120 ? 80 : 120;
    top = top === 84 ? 110 : 84;
    f.fire('scroll', wrapper);
    f.frame();
    assert.equal(parseFloat(button.style.left), left);
    assert.equal(parseFloat(button.style.top), top + 29);
    assert.deepEqual(f.read(false).selection, selection);
  }
  assert.deepEqual(
    [...doc.querySelectorAll('td')].map((node) => {
      const copy = node.cloneNode(true) as Element;
      copy.removeAttribute('data-kite-selected');
      return copy.outerHTML;
    }),
    original,
  );
  f.fire('keydown', cell, { key: 'Escape' });
  assert.equal(button.style.display, 'none');
  assert.equal(f.read().selection, null);
  assert.deepEqual(
    [...doc.querySelectorAll('td')].map((node) => node.outerHTML),
    original,
  );
  f.close();
});

test('Excel request button stays inside the grid client area above Sheet tabs and native scrollbars', () => {
  const f = fixture('excel', excelLayoutHtml()),
    doc = f.win.document;
  mockExcelLayout(f);
  const cell = doc.querySelector('[data-path="/S/B2"]')!,
    wrapper = doc.querySelector('.table-wrapper')!,
    button = doc.querySelector('.kite-office-request-trigger') as HTMLElement;
  button.getBoundingClientRect = () => ({ width: 120, height: 30 }) as DOMRect;
  for (const value of [0.75, 1, 1.25, 2] as const) {
    f.control({ kind: 'zoom', value });
    const right = 400 * value,
      bottom = 40 + 200 * value;
    cell.getBoundingClientRect = () =>
      ({
        left: right - 90,
        top: bottom - 25,
        right: right - 10,
        bottom: bottom - 1,
        width: 80,
        height: 24,
      }) as DOMRect;
    f.click(cell);
    f.frame();
    assert.equal(button.style.display, 'block');
    assert.equal(parseFloat(button.style.left), right - 124);
    assert.equal(parseFloat(button.style.top), bottom - 34);
    assert.equal(button.style.zoom, String(1 / value));
    f.control({ kind: 'request-edit' });
    const request = f.read();
    assert.deepEqual(request.requestAnchor, {
      x: right - 90,
      y: bottom - 25,
      width: 80,
      height: 24,
    });
    f.release(request.floatingRequest);
  }
  wrapper.getBoundingClientRect = () =>
    ({
      left: 0,
      top: f.win.innerHeight - 20,
      right: 400,
      bottom: f.win.innerHeight + 180,
      width: 400,
      height: 200,
    }) as DOMRect;
  cell.getBoundingClientRect = () =>
    ({
      left: 120,
      top: f.win.innerHeight - 15,
      right: 200,
      bottom: f.win.innerHeight - 1,
      width: 80,
      height: 14,
    }) as DOMRect;
  f.click(cell);
  f.frame();
  assert.equal(button.style.display, 'none');
  assert.equal(button.style.left, '');
  assert.equal(button.style.top, '');
  assert.equal(f.read(false).selection.range, 'B2');
  f.control({ kind: 'request-edit' });
  assert.equal(f.read().floatingSelection.range, 'B2');
  f.close();
});
