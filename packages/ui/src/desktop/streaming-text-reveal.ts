const CLOCK = '--kite-reveal-time';
const DURATION = 240;
const registered = new WeakSet<object>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let sequence = 0;
type Character = { name: string; start: number; end: number; at: number };

/** Animate highlight paint over one continuous text node; never split its shaping runs. */
export class StreamingTextReveal {
  private text = '';
  private characters: Character[] = [];
  private animation?: Animation;
  private style?: HTMLStyleElement;
  private motion?: MediaQueryList;
  private readonly prefix = `kite-reveal-${++sequence}`;
  private readonly element: HTMLSpanElement;
  constructor(element: HTMLSpanElement) {
    this.element = element;
  }

  private clear = () => {
    if (this.animation) {
      this.animation.onfinish = null;
      this.animation.cancel();
      this.animation = undefined;
    }
    const view = this.element.ownerDocument.defaultView;
    for (const character of this.characters) view?.CSS?.highlights?.delete(character.name);
    this.characters = [];
    this.style?.remove();
    this.style = undefined;
    this.element.style.removeProperty(CLOCK);
    this.motion?.removeEventListener('change', this.reduce);
    this.motion = undefined;
  };
  private reduce = () => {
    if (this.motion?.matches) this.clear();
  };
  dispose() {
    this.clear();
  }

  update(text: string, from: number | undefined, delay: number, step: number) {
    const previous = this.text;
    this.text = text;
    const document = this.element.ownerDocument,
      view = document.defaultView;
    let node = this.element.firstChild;
    if (node?.nodeType !== 3) {
      this.element.textContent = text;
      node = this.element.firstChild;
    } else if (node.textContent !== text) {
      const current = node.textContent ?? '';
      // appendData preserves ranges in the existing prefix, including the reader's selection.
      if (text.startsWith(current)) (node as Text).appendData(text.slice(current.length));
      else node.textContent = text;
    }
    if (
      !text.startsWith(previous) ||
      (text.length > previous.length &&
        (graphemes.segment(text).containing(previous.length)?.index ?? previous.length) <
          previous.length) ||
      !node ||
      node.nodeType !== 3 ||
      !view?.CSS?.highlights ||
      !view.CSS.registerProperty ||
      !view.Highlight ||
      !this.element.animate ||
      document.hidden ||
      this.element.closest('[hidden]') ||
      view.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      this.clear();
      return;
    }
    try {
      if (!registered.has(view.CSS)) {
        view.CSS.registerProperty({
          name: CLOCK,
          syntax: '<number>',
          inherits: true,
          initialValue: '0',
        });
        registered.add(view.CSS);
      }
      const now = view.performance.now();
      this.characters = this.characters.filter((character) => {
        if (character.at + DURATION > now) return true;
        view.CSS.highlights.delete(character.name);
        return false;
      });
      if (from !== undefined && from >= previous.length && from < text.length) {
        let index = 0;
        for (const part of graphemes.segment(text.slice(from))) {
          this.characters.push({
            name: `${this.prefix}-${from + part.index}`,
            start: from + part.index,
            end: from + part.index + part.segment.length,
            at: now + delay + index++ * step,
          });
        }
      }
      if (!this.characters.length) {
        this.clear();
        return;
      }
      this.style ??= document.head.appendChild(document.createElement('style'));
      // currentColor follows highlight inheritance; use the originating text's actual color.
      const color = view.getComputedStyle(this.element).color;
      this.style.textContent = this.characters
        .map(
          ({ name, at }) =>
            `::highlight(${name}){color:color-mix(in srgb,${color} clamp(0%,calc((var(${CLOCK}) - ${at}) * 100% / ${DURATION}),100%),transparent)}`,
        )
        .join('\n');
      this.element.style.setProperty(CLOCK, String(now));
      // Replacing CharacterData can reset live Range offsets. Rebind paint ranges after each append.
      for (const character of this.characters) {
        const range = document.createRange();
        range.setStart(node, character.start);
        range.setEnd(node, character.end);
        view.CSS.highlights.set(character.name, new view.Highlight(range));
      }
      if (!this.motion) {
        this.motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
        this.motion?.addEventListener('change', this.reduce);
      }
      if (this.animation) {
        this.animation.onfinish = null;
        this.animation.cancel();
      }
      const end = Math.max(...this.characters.map((character) => character.at + DURATION));
      this.animation = this.element.animate([{ [CLOCK]: String(now) }, { [CLOCK]: String(end) }], {
        duration: end - now,
        fill: 'both',
        easing: 'linear',
      });
      this.animation.onfinish = this.clear;
    } catch {
      this.clear();
    }
  }
}
