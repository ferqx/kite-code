const CLOCK = '--kite-reveal-time';
const DURATION = 240;
const MAX_DELAY = 180;
const registered = new WeakSet<object>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let sequence = 0;
type Character = { name: string; start: number; end: number; at: number };
type PendingCharacter = Omit<Character, 'at'> & { delay: number; step: number };
type Paint = {
  read: () => string | undefined;
  write: (color: string) => void;
  discard: () => void;
};
const paintBatches = new WeakMap<Document, Map<object, Paint>>();

function queuePaint(document: Document, owner: object, paint: Paint) {
  let batch = paintBatches.get(document);
  if (!batch) {
    batch = new Map();
    paintBatches.set(document, batch);
    const pending = batch;
    queueMicrotask(() => {
      paintBatches.delete(document);
      const jobs = [...pending.values()];
      pending.clear();
      // CSS property getters can flush style lazily. Finish every color read
      // before any owner writes its highlight rules, clock or paint ranges.
      const colors = jobs.map((job) => job.read());
      jobs.forEach((job, index) => {
        const color = colors[index];
        if (color !== undefined) job.write(color);
        else job.discard();
      });
    });
  }
  batch.set(owner, paint);
}

/** Animate highlight paint over one continuous text node; never split its shaping runs. */
export class StreamingTextReveal {
  private text = '';
  private characters: Character[] = [];
  private pending: PendingCharacter[] = [];
  private epoch = 0;
  private animation?: Animation;
  private style?: HTMLStyleElement;
  private motion?: MediaQueryList;
  private readonly prefix = `kite-reveal-${++sequence}`;
  private readonly element: HTMLSpanElement;
  constructor(element: HTMLSpanElement) {
    this.element = element;
  }

  private retirePending() {
    this.epoch++;
    this.pending = [];
    paintBatches.get(this.element.ownerDocument)?.delete(this);
  }
  private clear = () => {
    this.retirePending();
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
    if (this.element.classList.contains(this.prefix)) this.element.classList.remove(this.prefix);
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
    this.epoch++;
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
      !view.StaticRange ||
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
      if (from !== undefined && from >= previous.length && from < text.length) {
        let index = 0;
        for (const part of graphemes.segment(text.slice(from))) {
          this.pending.push({
            name: `${this.prefix}-${from + part.index}`,
            start: from + part.index,
            end: from + part.index + part.segment.length,
            delay: delay + index++ * step,
            step,
          });
        }
      }
      if (!this.characters.length && !this.pending.length) {
        this.clear();
        return;
      }
      const epoch = this.epoch;
      let discardedEpoch: number | undefined;
      const discard = () => {
        this.retirePending();
        discardedEpoch = this.epoch;
      };
      queuePaint(document, this, {
        read: () => {
          if (epoch !== this.epoch) return;
          try {
            if (
              !this.element.isConnected ||
              document.hidden ||
              this.element.closest('[hidden]') ||
              view.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ) {
              discard();
              return;
            }
            // currentColor follows highlight inheritance; keep the real source color.
            return view.getComputedStyle(this.element).color;
          } catch {
            discard();
          }
          return undefined;
        },
        write: (color) => {
          if (epoch === this.epoch) this.paint(color);
        },
        discard: () => {
          if (discardedEpoch === this.epoch) this.clear();
        },
      });
    } catch {
      this.clear();
    }
  }

  private paint(color: string) {
    const document = this.element.ownerDocument,
      view = document.defaultView!,
      node = this.element.firstChild!;
    try {
      const now = view.performance.now();
      this.characters = this.characters.filter((character) => {
        if (character.at + DURATION > now) return true;
        view.CSS.highlights.delete(character.name);
        return false;
      });
      if (
        this.pending.some(
          (character, index) => index > 0 && character.delay <= this.pending[index - 1]!.delay,
        )
      ) {
        const step = this.pending.reduce(
          (smallest, character) => Math.min(smallest, character.step),
          Infinity,
        );
        const start = Math.min(
          this.pending[0]!.delay,
          Math.max(0, MAX_DELAY - step * (this.pending.length - 1)),
        );
        const interval = Math.min(step, (MAX_DELAY - start) / (this.pending.length - 1));
        this.pending.forEach((character, index) => {
          character.delay = start + index * interval;
        });
      }
      for (const { delay, step: _step, ...character } of this.pending)
        this.characters.push({ ...character, at: now + delay });
      this.pending = [];
      if (!this.characters.length) {
        this.clear();
        return;
      }
      // Each highlight belongs to this Text's origin. Global highlight rules
      // make unrelated UI elements participate in every glyph's style update.
      // :where keeps the original pseudo-element-only rule specificity.
      this.element.classList.add(this.prefix);
      this.style ??= document.head.appendChild(document.createElement('style'));
      this.style.textContent = this.characters
        .map(
          ({ name, at }) =>
            `:where(.${this.prefix})::highlight(${name}){color:color-mix(in srgb,${color} clamp(0%,calc((var(${CLOCK}) - ${at}) * 100% / ${DURATION}),100%),transparent)}`,
        )
        .join('\n');
      this.element.style.setProperty(CLOCK, String(now));
      // Paint ranges are immutable snapshots, so registering one grapheme does
      // not make later Text/Range updates walk every existing live Range.
      // Rebind snapshots after each append; the reader's own selection stays live.
      for (const character of this.characters) {
        const range = new view.StaticRange({
          startContainer: node,
          startOffset: character.start,
          endContainer: node,
          endOffset: character.end,
        });
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
