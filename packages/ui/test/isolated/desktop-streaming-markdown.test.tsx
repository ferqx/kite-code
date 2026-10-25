import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { Activity, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationActivityContext } from '../../src/conversation-activity';
import { MessageContent } from '../../src/desktop/MessageContent';

type Fiber = {
  type?: { name?: string };
  memoizedProps: { children?: unknown; node?: unknown };
  child?: Fiber;
  sibling?: Fiber;
};

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let reduced = false;
  const motionListeners = new Set<() => void>();
  dom.window.matchMedia = (() => ({
    get matches() {
      return reduced;
    },
    addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  const reveals: { text: string; delay: number }[] = [];
  class TextHighlight {
    readonly range: Range;
    constructor(range: Range) {
      this.range = range;
    }
  }
  const highlights = new Map<string, TextHighlight>();
  const originalSet = highlights.set;
  highlights.set = function (name, highlight) {
    if (!this.has(name)) {
      const rule = dom.window.document.head.textContent
        ?.split('\n')
        .find((line) => line.includes(`::highlight(${name})`));
      const at = Number(
        rule
          ?.slice(rule.indexOf(`::highlight(${name})`))
          .match(/--kite-reveal-time\) - ([\d.]+)/)?.[1],
      );
      const now = Number(
        highlight.range.startContainer.parentElement?.style.getPropertyValue('--kite-reveal-time'),
      );
      reveals.push({ text: highlight.range.toString(), delay: at - now });
    }
    return originalSet.call(this, name, highlight);
  };
  Object.defineProperty(dom.window, 'Highlight', { value: TextHighlight, configurable: true });
  Object.defineProperty(dom.window, 'CSS', {
    value: { highlights, registerProperty() {} },
    configurable: true,
  });
  const animations: {
    text: string;
    delay: number;
    fill?: FillMode;
    cancelled: boolean;
    onfinish?: () => void;
    oncancel?: () => void;
  }[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
    value(this: HTMLElement, _keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {
        text: this.textContent!,
        delay: Number(options.delay ?? 0),
        fill: options.fill,
        cancelled: false,
        onfinish: undefined as (() => void) | undefined,
        oncancel: undefined as (() => void) | undefined,
        cancel() {
          this.cancelled = true;
          this.oncancel?.();
        },
      };
      animations.push(animation);
      return animation;
    },
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const render = (
    text: string,
    streaming: boolean | 'static' = true,
    active = true,
    openFile?: (path: string) => void,
    hidden = false,
  ) =>
    act(async () =>
      root.render(
        <ConversationActivityContext value={{ readActive: active, resume: 0 }}>
          <Activity mode={hidden ? 'hidden' : 'visible'}>
            <MessageContent
              text={text}
              streaming={streaming === 'static' ? undefined : streaming}
              openFile={openFile}
            />
          </Activity>
        </ConversationActivityContext>,
      ),
    );
  const textProps = () => {
    const result = new Map<string, object>();
    const walk = (fiber?: Fiber) => {
      if (!fiber) return;
      if (fiber.type?.name === 'MarkdownDocument') result.set('$document', fiber.memoizedProps);
      if (fiber.type?.name === 'MarkdownText' && typeof fiber.memoizedProps.children === 'string')
        result.set(fiber.memoizedProps.children, fiber.memoizedProps);
      walk(fiber.child);
      walk(fiber.sibling);
    };
    // Test-only Fiber inspection proves a React bailout, beyond merely reusing the same DOM.
    walk((root as unknown as { _internalRoot: { current: Fiber } })._internalRoot.current);
    return result;
  };
  return {
    dom,
    host,
    render,
    animations,
    reveals,
    highlights,
    textProps,
    reduce(value: boolean) {
      reduced = value;
      for (const listener of [...motionListeners]) listener();
    },
    listeners: motionListeners,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('stream appends bail out at unchanged elements, preserve selection and only reveal new text', async () => {
  const f = await fixture();
  try {
    const prefix =
      '# 固定标题\n\n固定 **粗体** [文件](src/a.ts)\n\n- 第一项\n- 第二项\n\n```ts\nconst stable = 1;\n```\n\n';
    let source = `${prefix}当前正文`;
    let opened = '';
    await f.render(source, true, true, (path) => {
      opened = `first:${path}`;
    });
    expect(f.reveals).toHaveLength(0);
    const props = f.textProps();
    expect(props.has('固定标题')).toBe(true);
    const heading = f.host.querySelector('h1')!;
    const listItem = f.host.querySelector('li')!;
    const code = f.host.querySelector('pre code')!;
    const tail = f.host.querySelector('.typeset-chat > p:last-child')!;
    const originalText = tail.firstChild;
    const selection = f.dom.window.getSelection()!;
    const range = f.dom.window.document.createRange();
    range.selectNodeContents(heading);
    selection.addRange(range);
    source += '，新增文字🙂';
    await f.render(source, true, true, (path) => {
      opened = `current:${path}`;
    });
    expect(f.reveals.map((animation) => animation.text)).toEqual([...'，新增文字🙂']);
    expect(f.reveals.map((animation) => animation.delay)).toEqual([0, 18, 36, 54, 72, 90]);
    expect(f.animations.every((animation) => animation.fill === 'both')).toBe(true);
    expect(tail.firstChild).toBe(originalText);
    expect(f.host.querySelector('h1')).toBe(heading);
    expect(f.host.querySelector('li')).toBe(listItem);
    expect(f.host.querySelector('pre code')).toBe(code);
    expect(selection.toString()).toBe('固定标题');
    for (const value of ['固定标题', '粗体', '第一项', '第二项'])
      expect(f.textProps().get(value)).toBe(props.get(value));
    await act(async () => (f.host.querySelector('.file-link') as HTMLElement).click());
    expect(opened).toBe('current:src/a.ts');
    const documentProps = f.textProps().get('$document');
    await f.render(source, true, false);
    await f.render(source, true, true);
    expect(f.textProps().get('$document')).toBe(documentProps);
    const span = tail.querySelector('span');
    const beforeParagraph = f.reveals.length;
    source += '\n\n下一段 **强调**';
    await f.render(source);
    expect(tail.querySelector('span')).toBe(span);
    expect(
      f.reveals
        .slice(beforeParagraph)
        .map((animation) => animation.text)
        .join(''),
    ).toBe('下一段 强调');
    const delays = f.reveals.slice(beforeParagraph).map((animation) => animation.delay);
    expect(delays.every((delay, index) => index === 0 || delay > delays[index - 1]!)).toBe(true);
    // An open list grows in place; its completed items do not render again.
    source += '\n\n- 完成项\n- 活动';
    await f.render(source);
    const itemProps = f.textProps().get('完成项');
    source += '项\n- 新项目';
    await f.render(source);
    expect(f.textProps().get('完成项')).toBe(itemProps);
    // Completion can carry one last suffix, without replaying previous text.
    source += '，最后一批';
    await f.render(source, false);
    expect(
      f.reveals
        .slice(-5)
        .map((animation) => animation.text)
        .join(''),
    ).toBe('，最后一批');
    const count = f.reveals.length;
    await f.render(source, false);
    expect(f.reveals).toHaveLength(count);
    for (const animation of f.animations) animation.onfinish?.();
    expect(f.listeners.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('ordinary asynchronous history calibration still reveals the next live append', async () => {
  const f = await fixture();
  try {
    await f.render('已经显示的正文');
    await f.render('已经显示的正文', true, false);
    await f.render('已经显示的正文，跨进程读取后新增', true, true);
    expect(f.reveals.map((animation) => animation.text)).toEqual([...'，跨进程读取后新增']);
  } finally {
    await f.close();
  }
});

test('paint reveal keeps a single continuous text node and preserves a selection in the live prefix', async () => {
  const f = await fixture();
  try {
    await f.render('AVATAR office 中文旧正文');
    const span = f.host.querySelector('p > span')!,
      node = span.firstChild!;
    const selection = f.dom.window.getSelection()!,
      range = f.dom.window.document.createRange();
    range.setStart(node, 7);
    range.setEnd(node, 13);
    selection.addRange(range);
    await f.render('AVATAR office 中文旧正文，再追加一段正文。');
    expect(span.childNodes).toHaveLength(1);
    expect(span.firstChild).toBe(node);
    expect(selection.toString()).toBe('office');
    expect(f.highlights.size).toBeGreaterThan(0);
    for (const animation of f.animations) animation.onfinish?.();
    expect(f.highlights.size).toBe(0);
    expect(f.dom.window.document.head.querySelectorAll('style')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('unsupported paint APIs retain complete plain text without per-character wrappers or animation', async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.dom.window, 'Highlight', { value: undefined });
    await f.render('原文');
    await f.render('原文，完整新文字');
    expect(f.host.textContent).toBe('原文，完整新文字');
    expect(f.host.querySelector('p > span')?.childNodes).toHaveLength(1);
    expect(f.animations).toHaveLength(0);
    expect(f.highlights.size).toBe(0);
  } finally {
    await f.close();
  }
});
test('a large append reveals whole graphemes individually in bounded source order across inline markup', async () => {
  const f = await fixture();
  try {
    await f.render('历史正文');
    const appended = '雪👩🏽‍💻e\u0301'.repeat(100);
    await f.render(`历史正文${appended} **结束**`);
    expect(f.reveals.map((animation) => animation.text)).toEqual([
      ...Array.from({ length: 100 }, () => ['雪', '👩🏽‍💻', 'e\u0301']).flat(),
      ' ',
      '结',
      '束',
    ]);
    expect(f.reveals[0]!.delay).toBe(0);
    expect(
      f.reveals.filter(
        (animation, index) => index > 0 && animation.delay <= f.reveals[index - 1]!.delay,
      ),
    ).toEqual([]);
    expect(f.reveals.at(-1)!.delay).toBeLessThanOrEqual(180.000001);
    expect(f.host.textContent).toBe(`历史正文${appended} 结束`);
  } finally {
    await f.close();
  }
});

test('history, cache resume, corrections and reduced motion never replay old text', async () => {
  const f = await fixture();
  try {
    let source = '历史正文';
    await f.render(source, false);
    source += '补齐全文';
    await f.render(source, false);
    await f.render(source, true);
    source += '实时新增';
    await f.render(source, true);
    expect(f.reveals.map((animation) => animation.text)).toEqual([...'实时新增']);
    const originalCount = f.reveals.length;
    f.reduce(true);
    expect(f.highlights.size).toBe(0);
    expect(f.animations.some((animation) => animation.cancelled)).toBe(true);
    expect(f.listeners.size).toBe(0);
    source += '减少动态效果';
    await f.render(source);
    f.reduce(false);
    source += '暂停时的内容';
    await f.render(source, true, false);
    await f.render(source, true, true);
    expect(f.reveals).toHaveLength(originalCount);
    source += '恢复后新增';
    await f.render(source);
    expect(
      f.reveals
        .slice(originalCount)
        .map((animation) => animation.text)
        .join(''),
    ).toBe('恢复后新增');
    const resumedCount = f.reveals.length;
    source += '显式读取的完整正文';
    await f.render(source, 'static');
    expect(f.reveals).toHaveLength(resumedCount);
    await f.render(source);
    await f.render(source, true, false, undefined, true);
    source += '后台积累';
    await f.render(source, true, false, undefined, true);
    await f.render(source, true, true);
    expect(f.reveals).toHaveLength(resumedCount);
    await f.render('纠正后的正文');
    expect(f.reveals).toHaveLength(resumedCount);
    expect(f.host.textContent).toBe('纠正后的正文');
    expect(f.highlights.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('late references and inline syntax correct existing semantics without fading old words', async () => {
  const f = await fixture();
  try {
    let source = '[旧链接][target]\n\n旧的 **强调';
    await f.render(source);
    source += '** 新增';
    await f.render(source);
    expect(f.host.querySelector('strong')?.textContent).toBe('强调');
    expect(f.reveals.map((animation) => animation.text)).toEqual([...' 新增']);
    const count = f.reveals.length;
    source += '\n\n[target]: https://example.com';
    await f.render(source);
    expect(f.host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(f.reveals).toHaveLength(count);
    source += '\n\n正文[^a]\n\n[^a]: 脚注';
    await f.render(source);
    const link = f.host.querySelector('[data-footnote-ref]')!;
    expect(link).not.toBeNull();
    expect(f.host.querySelector(link.getAttribute('href')!)?.textContent).toContain('脚注');
    expect(f.host.querySelector('kite-markdown-element, kite-markdown-text')).toBeNull();
  } finally {
    await f.close();
  }
});

test('growing Unicode text preserves completed segments across the long-node boundary', async () => {
  const f = await fixture();
  try {
    const text = '中'.repeat(2040) + 'e\u0301👩🏽‍💻𠮷漢字'.repeat(220);
    await f.render(text.slice(0, 3500));
    const paragraph = f.host.querySelector('p')!;
    const first = paragraph.firstChild;
    const props = f.textProps();
    await f.render(text);
    expect(paragraph.textContent).toBe(text);
    expect(paragraph.firstChild).toBe(first);
    expect(f.textProps().get(first?.textContent ?? '')).toBe(props.get(first?.textContent ?? ''));
    expect(f.reveals.every((animation) => !/^[\uDC00-\uDFFF]/u.test(animation.text))).toBe(true);
    await f.render('e');
    await f.render('e\u0301');
    expect(f.host.querySelector('p')?.childNodes).toHaveLength(1);
    await f.render('e\u0301👩');
    const beforeEmojiCompletion = f.reveals.length;
    await f.render('e\u0301👩🏽‍💻');
    expect(f.reveals).toHaveLength(beforeEmojiCompletion);
    expect(f.host.querySelector('p')?.childNodes).toHaveLength(1);
    expect(f.host.textContent).toBe('e\u0301👩🏽‍💻');
  } finally {
    await f.close();
  }
});

test('long entity and escaped text preserves source offsets for later live suffixes', async () => {
  const f = await fixture();
  try {
    for (const [encoded, decoded] of [
      ['&amp;', '&'],
      ['\\*', '*'],
    ]) {
      const body = 'x'.repeat(2050);
      const source = encoded + body;
      await f.render(source, false);
      expect(f.host.textContent).toBe(decoded + body);
      await f.render(source, true);
      const count = f.reveals.length;
      await f.render(`${source}NEW`);
      expect(f.host.textContent).toBe(`${decoded}${body}NEW`);
      expect(f.reveals.slice(count).map((animation) => animation.text)).toEqual(['N', 'E', 'W']);
    }
  } finally {
    await f.close();
  }
});
