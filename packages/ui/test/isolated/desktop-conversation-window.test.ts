import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from '../../src/desktop/conversation-window';

test('anchor restoration follows the visible entry itself and ignores simultaneous tail growth', () => {
  const dom = new JSDOM('<main id="viewport"></main>');
  try {
    const viewport = dom.window.document.getElementById('viewport')!;
    viewport.scrollTop = 500;
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 300);
    Object.defineProperty(viewport, 'scrollHeight', {
      get() {
        throw Error('tail_height_is_not_a_reading_anchor');
      },
    });
    let prependHeight = 0;
    const entry = (key: string, top: number, height: number) => {
      const element = dom.window.document.createElement('article');
      element.setAttribute('data-conversation-entry-key', key);
      element.getBoundingClientRect = () =>
        new dom.window.DOMRect(0, 100 + top + prependHeight - viewport.scrollTop, 400, height);
      viewport.append(element);
      return element;
    };
    entry('above', 100, 100);
    const firstVisible = entry('visible', 440, 140);
    entry('later', 650, 100);
    const anchor = captureConversationScrollAnchor(viewport)!;
    expect(anchor).toEqual({ entryKey: 'visible', offset: -60 });
    prependHeight = 80;
    expect(restoreConversationScrollAnchor(viewport, anchor)).toBe(true);
    expect(viewport.scrollTop).toBe(580);
    expect(firstVisible.getBoundingClientRect().top).toBe(40);
    // Replacing a DOM node during metadata regrouping still uses its exact entry key.
    const replacement = entry('visible', 440, 140);
    firstVisible.replaceWith(replacement);
    prependHeight = 120;
    expect(restoreConversationScrollAnchor(viewport, anchor)).toBe(true);
    expect(viewport.scrollTop).toBe(620);
    expect(replacement.getBoundingClientRect().top).toBe(40);
  } finally {
    dom.window.close();
  }
});

test('missing, hidden or invalid anchors cannot write a fabricated scroll position', () => {
  const dom = new JSDOM('<main id="viewport"></main>');
  try {
    const viewport = dom.window.document.getElementById('viewport')!;
    viewport.scrollTop = 200;
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 300);
    expect(captureConversationScrollAnchor(viewport)).toBeUndefined();
    expect(restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: 0 })).toBe(
      false,
    );
    expect(
      restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: Number.NaN }),
    ).toBe(false);
    expect(viewport.scrollTop).toBe(200);
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 0);
    expect(captureConversationScrollAnchor(viewport)).toBeUndefined();
    viewport.remove();
    expect(restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: 0 })).toBe(
      false,
    );
    expect(viewport.scrollTop).toBe(200);
  } finally {
    dom.window.close();
  }
});
