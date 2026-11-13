import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { offlineOfficeHtml } from '../../../../src/tools/documents/office-preview';

const fixture = `<html><head></head><body><p data-path="/body/p[1]">original</p><script>
function _wordInit(){
function positionFootnotes(){log.push('footnotes');}function wrapFloats(){log.push('floats');}function applyLineNumbers(){log.push('lines');}function applyPageFilter(){log.push('filter');}function scalePages(){log.push('scale');}function renderNewContent(){log.push('render');}
function paginate(){log.push('pass');var again=--remaining>0;
if(again){if(window._wpSync)paginate();else setTimeout(paginate,0);}
else if(window._wpSync){}
else{setTimeout(positionFootnotes,0);setTimeout(wrapFloats,0);setTimeout(applyLineNumbers,0);setTimeout(applyPageFilter,0);setTimeout(function(){scalePages(false);},0);}
}
window._wordPaginate=function(){renderNewContent();setTimeout(paginate,0);};
var _resizeTimer;window.addEventListener('resize',function(){clearTimeout(_resizeTimer);_resizeTimer=setTimeout(function(){scalePages(true);},100);});
window._wpSync=false;if(window._wpSync){paginate();}else{setTimeout(paginate,100);}
}_wordInit();</script></body></html>`;

function harness(
  options: { fonts?: Promise<void>; pages?: number; passes?: number; image?: boolean } = {},
) {
  let now = 0,
    id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const attrs = new Map<string, string>();
  const events = new EventTarget(),
    docEvents = new EventTarget();
  const fonts = Object.assign(new EventTarget(), {
    ready: options.fonts ?? Promise.resolve(),
    status: 'loaded',
  });
  let observe: ((changes: unknown[]) => void) | undefined;
  const log: string[] = [];
  class Image extends EventTarget {
    complete = false;
  }
  const image = options.image ? new Image() : undefined;
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) },
    body: {},
    fonts,
    images: image ? [image] : [],
    querySelectorAll: () => Array.from({ length: options.pages ?? 2 }),
    addEventListener: docEvents.addEventListener.bind(docEvents),
  };
  const context = {
    document,
    window: events,
    HTMLImageElement: Image,
    MutationObserver: class {
      constructor(fn: (changes: unknown[]) => void) {
        observe = fn;
      }
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    performance: { now: () => now },
    log,
    remaining: options.passes ?? 3,
    Promise,
    setTimeout: (fn: () => void, ms = 0) => {
      const n = ++id;
      timers.set(n, { at: now + ms, fn });
      return n;
    },
    clearTimeout: (n: number) => timers.delete(n),
    requestAnimationFrame: (fn: () => void) => {
      const n = ++id;
      timers.set(n, { at: now + 16, fn });
      return n;
    },
  };
  const html = offlineOfficeHtml(fixture, true);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    runInNewContext(match[1]!, context);
  async function tick() {
    await Promise.resolve();
    await Promise.resolve();
    const task = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!task) return;
    timers.delete(task[0]);
    now = task[1].at;
    task[1].fn();
    await Promise.resolve();
    await Promise.resolve();
  }
  async function settle() {
    for (let i = 0; i < 300 && attrs.get('data-kite-word-pagination-state') === 'pending'; i++)
      await tick();
  }
  return { attrs, log, fonts, image, events, context, observe, tick, settle };
}

test('Word recipe only enables exact unique locked anchors, preserving other formats/content', () => {
  expect(offlineOfficeHtml(fixture)).not.toContain('data-kite-word-pagination-state');
  for (const html of [
    fixture.replace('function paginate(){', 'function different(){'),
    fixture.replace('</script>', 'function paginate(){}</script>'),
  ]) {
    const result = offlineOfficeHtml(html, true);
    expect(result).toContain("'unavailable'");
    expect(result).not.toContain('var _kiteWordPagination=');
    expect(result).toContain('original');
  }
});
test('initial and recursive layout remain pending until every final layout task completes', async () => {
  const h = harness();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
  await h.settle();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  expect(h.log).toEqual([
    'pass',
    'pass',
    'pass',
    'footnotes',
    'floats',
    'lines',
    'filter',
    'scale',
  ]);
});
test('late fonts and images block layout; resize invalidates the previous generation', async () => {
  let ready!: () => void;
  const h = harness({ fonts: new Promise<void>((r) => (ready = r)), image: true });
  await Promise.resolve();
  expect(h.log).toEqual([]);
  h.image!.complete = true;
  h.image!.dispatchEvent(new Event('load'));
  ready();
  await h.settle();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  const generation = h.attrs.get('data-kite-word-pagination-generation');
  h.events.dispatchEvent(new Event('resize'));
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
  expect(h.attrs.get('data-kite-word-pagination-generation')).not.toBe(generation);
  await h.settle();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
});
test('an older queued final pass cannot settle a newer waiting generation', async () => {
  const h = harness({ passes: 1 });
  await h.tick(); // first run queues final pass
  let ready!: () => void;
  h.fonts.ready = new Promise<void>((r) => (ready = r));
  h.fonts.dispatchEvent(new Event('loading'));
  await h.tick();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
  ready();
  await h.settle();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  expect(h.log.filter((x) => x === 'scale')).toHaveLength(1);
});
for (const options of [{ pages: 501 }, { passes: 1000 }, { fonts: new Promise<void>(() => {}) }])
  test('layout budgets fail page capability closed without touching content', async () => {
    const h = harness(options);
    await h.settle();
    expect(h.attrs.get('data-kite-word-pagination-state')).toBe('unavailable');
  });

test('a rejected stale resource wait cannot invalidate the newer settled generation', async () => {
  let fail!: (error: Error) => void;
  const h = harness({
    fonts: new Promise<void>((_resolve, reject) => {
      fail = reject;
    }),
  });
  h.fonts.ready = Promise.resolve();
  h.fonts.dispatchEvent(new Event('loadingdone'));
  await h.settle();
  const generation = h.attrs.get('data-kite-word-pagination-generation');
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  fail(Error('old resource rejected'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  expect(h.attrs.get('data-kite-word-pagination-generation')).toBe(generation);
});

for (const frame of [0, 1])
  test(`page mutation during final frame ${frame} invalidates layout`, async () => {
    const h = harness({ passes: 1 });
    await h.tick();
    await h.tick();
    if (frame) await h.tick();
    const generation = h.attrs.get('data-kite-word-pagination-generation');
    h.observe!([
      { target: { nodeType: 3, parentElement: { closest: () => ({}) } }, type: 'characterData' },
    ]);
    expect(h.attrs.get('data-kite-word-pagination-generation')).not.toBe(generation);
    expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
    await h.settle();
    expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
    expect(h.log.filter((x) => x === 'scale')).toHaveLength(2);
  });
for (const kind of ['addedNodes', 'removedNodes'])
  test(`whole page ${kind} invalidates settled layout`, async () => {
    const h = harness();
    await h.settle();
    const generation = h.attrs.get('data-kite-word-pagination-generation');
    h.observe!([
      {
        type: 'childList',
        target: { nodeType: 1, closest: () => null },
        addedNodes: [],
        removedNodes: [],
        [kind]: [{ nodeType: 1, matches: () => true }],
      },
    ]);
    expect(h.attrs.get('data-kite-word-pagination-generation')).not.toBe(generation);
    expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
    await h.settle();
    expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  });
test('continuous resize settles only the last generation', async () => {
  const h = harness();
  await h.settle();
  for (let i = 0; i < 12; i++) {
    h.events.dispatchEvent(new Event('resize'));
    await h.tick();
  }
  const generation = h.attrs.get('data-kite-word-pagination-generation');
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('pending');
  await h.settle();
  expect(h.attrs.get('data-kite-word-pagination-state')).toBe('settled');
  expect(h.attrs.get('data-kite-word-pagination-generation')).toBe(generation);
});
