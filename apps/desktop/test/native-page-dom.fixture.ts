import type { JSDOM } from 'jsdom';

/** Navigation admits Main work in the task following its first rendering opportunity. */
export function nextDesktopPresentation(dom: JSDOM): Promise<void> {
  return new Promise((resolve) => {
    dom.window.requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/** These tests assert Native ownership, not keyboard editing; use the actual editor state. */
export async function setPromptText(element: Element, value: string) {
  const { setEditorText } = await import('../../../packages/ui/test/prompt-editor.fixture');
  setEditorText(element as HTMLElement, value);
}
export function promptValue(element: Element | null | undefined) {
  const text = (node: Node): string =>
    node.nodeName === 'BR'
      ? '\n'
      : node.nodeType === 3
        ? (node.textContent ?? '')
        : [...node.childNodes].map(text).join('');
  return element
    ? [...element.children]
        .map((child) => (child.textContent ? text(child) : ''))
        .join('\n')
        .replace(/\r\n?/g, '\n')
    : undefined;
}

/** Browser APIs used by the retained desktop layout; these do not simulate Native facts or writes. */
export function prepareDesktopDom(dom: JSDOM) {
  const stylePrototype = Object.getPrototypeOf(dom.window.document.createElement('div').style);
  const clip = Object.getOwnPropertyDescriptor(stylePrototype, 'clip')!;
  // Radix uses a zero clipping rectangle for visually hidden controls. Keep that
  // geometry without JSDOM's deprecated numeric parser, which can stall in Bun.
  Object.defineProperty(stylePrototype, 'clip', {
    ...clip,
    set(value: string) {
      clip.set!.call(
        this,
        value === 'rect(0, 0, 0, 0)'
          ? 'var(--native-test-clip-zero, rect(0px, 0px, 0px, 0px))'
          : value,
      );
    },
  });
  Object.assign(dom.window.Range.prototype, {
    getBoundingClientRect: () => new dom.window.DOMRect(),
    getClientRects: () => [],
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.assign(dom.window, { ResizeObserver: ResizeObserverStub, matchMedia: media });
  const globals = {
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    Element: dom.window.Element,
    DOMRect: dom.window.DOMRect,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FileReader: dom.window.FileReader,
    getComputedStyle: dom.window.getComputedStyle,
    ResizeObserver: ResizeObserverStub,
    matchMedia: media,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    Object.defineProperty(stylePrototype, 'clip', clip);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
