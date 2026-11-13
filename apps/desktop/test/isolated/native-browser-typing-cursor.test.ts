import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, test } from '#kite-test';
import { browserTypingCursorScript } from '../../electron/browser-typing-cursor';

test('fixed focus read returns clipped viewport coordinates without reading text or changing focus', () => {
  const dom = new JSDOM('<input id="field"><button id="button">Button</button>');
  try {
    const { document } = dom.window;
    const field = document.getElementById('field') as HTMLInputElement;
    field.getBoundingClientRect = () => ({ left: -20, top: 20, right: 100, bottom: 60 }) as DOMRect;
    Object.defineProperty(field, 'value', {
      get: () => {
        throw Error('no_text_read');
      },
    });
    const read = () =>
      runInNewContext(browserTypingCursorScript, {
        document,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        innerWidth: 800,
        innerHeight: 600,
      });
    field.focus();
    expect(read()).toEqual({ x: 50, y: 40 });
    expect(document.activeElement).toBe(field);
    field.readOnly = true;
    expect(read()).toBeNull();
    field.readOnly = false;
    field.getBoundingClientRect = () =>
      ({ left: 900, top: 20, right: 1000, bottom: 60 }) as DOMRect;
    expect(read()).toBeNull();
    field.getBoundingClientRect = () => ({ left: NaN, top: 20, right: 100, bottom: 60 }) as DOMRect;
    expect(read()).toBeNull();
    document.getElementById('button')!.focus();
    expect(read()).toBeNull();
  } finally {
    dom.window.close();
  }
});

test('shadow focus is resolved locally; an iframe never invents coordinates for a different document', () => {
  const dom = new JSDOM('<div id="host"></div><iframe></iframe>');
  try {
    const { document } = dom.window;
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    const input = document.createElement('textarea');
    shadow.append(input);
    input.getBoundingClientRect = () =>
      ({ left: 100, top: 200, right: 200, bottom: 240 }) as DOMRect;
    const read = () =>
      runInNewContext(browserTypingCursorScript, {
        document,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        innerWidth: 800,
        innerHeight: 600,
      });
    input.focus();
    expect(read()).toEqual({ x: 150, y: 220 });
    document.querySelector('iframe')!.focus();
    expect(read()).toBeNull();
  } finally {
    dom.window.close();
  }
});
