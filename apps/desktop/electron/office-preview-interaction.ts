/** Selection is descriptive evidence only. Paths never authorize file access or mutations. */
import type {
  OfficeExcelSelectionView,
  OfficePreviewControl,
  OfficeSelection,
} from '../src/output-files-bridge';
import { installPageRail as sharedPageRail } from './document-page-rail';
import { officeChromeCss } from './office-request-input';

export type { OfficePreviewControl } from '../src/output-files-bridge';
export type OfficeInteraction = {
  selection: OfficeSelection | null;
  excelSelection?: OfficeExcelSelectionView;
  currentSlide?: number;
  slideCount?: number;
  presentation?: boolean;
  zoom?: number | 'fit';
  floatingRequest?: number;
  requestInvalidated?: number;
  floatingSelection?: OfficeSelection;
  requestAnchor?: { x: number; y: number; width: number; height: number };
};
export const officeInteractionWorld = 1004;

export type WordTextSource = {
  text: string;
  offsetAt: (renderedOffset: number) => number;
};

/** Serialized into an isolated world: no preload, IPC, callbacks or host objects. */
function installInteraction(
  kind: 'word' | 'powerpoint',
  chromeCss: string,
  pageRail: typeof sharedPageRail,
  editable = true,
  wordSources?: WeakMap<Element, WordTextSource>,
) {
  const scope = globalThis as typeof globalThis & {
    kiteOfficeInteraction?: ReturnType<typeof controller>;
  };
  if (scope.kiteOfficeInteraction) return;
  const MAX_NODES = 50000,
    MAX_TEXT = 2_000_000;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
  let count = 0,
    length = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    count++;
    length += node.nodeType === 3 ? (node.textContent?.length ?? 0) : 0;
    if (count > MAX_NODES || length > MAX_TEXT) return;
  }
  const entries = new Map<Element, { path: string; text: string; wordOffset?: string }>();
  let indexedText = 0;
  for (const element of document.querySelectorAll('[data-path]')) {
    const path = element.getAttribute('data-path') ?? '';
    const text = element.textContent ?? '';
    indexedText += text.length;
    if (entries.size >= 10000 || indexedText > MAX_TEXT * 2) return;
    if (
      path.length <= 512 &&
      path.startsWith('/') &&
      !/[\r\n]/.test(path) &&
      !path.includes(String.fromCharCode(0)) &&
      text.length <= 32768
    ) {
      const wordOffset = kind === 'word' ? element.getAttribute('data-kite-word-offset') : null;
      entries.set(element, {
        path,
        text,
        ...(wordOffset && /^\d{1,7}$/.test(wordOffset) ? { wordOffset } : {}),
      });
    }
  }
  const slides = Array.from(
    document.querySelectorAll<HTMLElement>('.main > .slide-container'),
  ).slice(0, 1000);
  let selected: OfficeSelection | null = null;
  let zoom: number | 'fit' = 'fit';
  let wordRange: Range | null = null;
  let floatingSelection: OfficeSelection | undefined;
  let requestAnchor: OfficeInteraction['requestAnchor'];
  let requestElements: Element[] = [];
  let requestWordRange: Range | null = null;
  type ScopeTarget = { element: Element; selection: OfficeSelection; valid: () => boolean };
  const scopeTargets = new Map<Element, ScopeTarget>();
  let requestScope: ScopeTarget | undefined;
  let requestScopeSerial = 0,
    invalidatedSerial = 0;
  let refreshWordPages = () => {};
  let contextTarget: ScopeTarget | undefined;
  let contextNavigation: number | null = null;
  let requestedSelection: OfficeSelection | undefined;
  let selectionRect = { x: 12, y: 12, width: 0, height: 0 };
  let pending = 0,
    serial = 0,
    presentation = false,
    page = 1;
  let highlighted: Element[] = [];
  let refreshThumbnails = () => {};
  let refreshObject = () => {};
  const button = document.createElement('button');
  button.textContent = '请求修改';
  button.title = 'Ctrl Shift X';
  button.className = 'kite-office-chrome kite-office-request-trigger';
  button.style.cssText = 'display:none;position:fixed;z-index:2147483647';
  document.body.append(button);
  const menu = document.createElement('div');
  menu.className = 'kite-office-chrome kite-office-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '请求修改');
  menu.style.cssText = 'display:none;position:fixed;z-index:2147483647';
  const menuItem = document.createElement('button');
  menuItem.type = 'button';
  menuItem.setAttribute('role', 'menuitem');
  menuItem.textContent = '请求修改';
  menu.append(menuItem);
  document.body.append(menu);
  const style = document.createElement('style');
  style.textContent =
    chromeCss +
    `
.kite-office-context-menu{padding:4px;border:1px solid var(--office-border);border-radius:8px;background:var(--office-card);color:var(--office-foreground);box-shadow:0 2px 8px light-dark(rgb(0 0 0 / 10%),rgb(0 0 0 / 30%))}.kite-office-context-menu>button{display:block;border:0;border-radius:4px;padding:6px 12px;background:transparent;color:inherit;cursor:pointer}.kite-office-context-menu>button:hover,.kite-office-context-menu>button:focus-visible{background:var(--office-hover);outline:1px solid var(--office-border)}body .kite-office-context-menu,body .kite-office-context-menu>button{font:12px var(--office-font)!important}
.kite-office-request-trigger{max-width:calc(100vw - 8px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--office-border);border-radius:8px;padding:6px 10px;background:var(--office-card);color:var(--office-foreground);box-shadow:0 1px 6px light-dark(rgb(0 0 0 / 6%),rgb(0 0 0 / 28%));cursor:pointer;font-weight:500}
.kite-office-request-trigger:hover{background:color-mix(in srgb,var(--office-foreground) 5%,var(--office-card))}.kite-office-request-trigger:active{background:color-mix(in srgb,var(--office-foreground) 9%,var(--office-card))}
.kite-office-request-trigger:focus-visible,.kite-thumbnail-button:focus-visible{outline:1px solid var(--office-foreground);outline-offset:-2px}
body{background:#fafafa!important}
@media(prefers-color-scheme:dark){body{background:#181818!important}}
body .kite-office-chrome.kite-office-request-trigger,body .kite-office-chrome.kite-thumbnail-rail,body .kite-thumbnail-rail .kite-thumbnail-button,body .kite-thumbnail-rail .kite-thumbnail-number,body .kite-office-chrome.kite-word-rail,body .kite-word-rail .kite-word-page-button,body .kite-word-rail .kite-word-number{font-family:var(--office-font)!important}
body.kite-present .main>.slide-container{display:none!important}body.kite-present .main>.slide-container.kite-current{display:flex!important}
`;
  document.head.append(style);
  const paintHost = document.createElement('div');
  paintHost.className = 'kite-office-selection-paint';
  paintHost.inert = true;
  paintHost.setAttribute('aria-hidden', 'true');
  paintHost.style.cssText =
    'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:19!important';
  const paintRoot = paintHost.attachShadow({ mode: 'open' });
  const paintStyle = document.createElement('style');
  paintStyle.textContent = `:host{pointer-events:none}div{all:initial;display:block;box-sizing:border-box;pointer-events:none}.kite-office-object-selection{position:fixed;border:2px solid #737373;background:rgb(115 115 115 / 10%)}`;
  paintRoot.append(paintStyle);
  document.body.append(paintHost);
  const objectPaint = document.createElement('div');
  paintRoot.append(objectPaint);
  refreshObject = () => {
    objectPaint.replaceChildren();
    if (kind !== 'powerpoint' || selected?.kind !== 'powerpoint') return;
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    for (const element of highlighted) {
      if (!valid(element)) continue;
      const rect = element.getBoundingClientRect();
      const node = document.createElement('div');
      node.className = 'kite-office-object-selection';
      node.style.cssText = `left:${rect.left / scale}px;top:${rect.top / scale}px;width:${rect.width / scale}px;height:${rect.height / scale}px`;
      objectPaint.append(node);
    }
  };
  document.addEventListener('scroll', refreshObject, true);
  window.addEventListener('resize', refreshObject);

  const valid = (el: Element) => {
    const item = entries.get(el);
    return item &&
      el.isConnected &&
      el.getAttribute('data-path') === item.path &&
      (item.wordOffset === undefined ||
        el.getAttribute('data-kite-word-offset') === item.wordOffset) &&
      el.textContent === item.text
      ? item
      : undefined;
  };
  function clear() {
    selected = null;
    refreshObject();
    wordRange = null;
    for (const el of highlighted) el.removeAttribute('data-kite-selected');
    highlighted = [];
    button.style.display = 'none';
    button.textContent = '请求修改';
  }
  /** Convert viewport positions into the popup's CSS zoom space. */
  function placePopup(element: HTMLElement, x: number, y: number) {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const width = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
    const height = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
    element.style.boxSizing = 'border-box';
    element.style.maxWidth = `${Math.max(0, width - 8) / scale}px`;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(width - bounds.width - 4, Number.isFinite(x) ? x : 4)) / scale}px`;
    element.style.top = `${Math.max(4, Math.min(height - bounds.height - 4, Number.isFinite(y) ? y : 4)) / scale}px`;
  }
  function show(rect: DOMRect) {
    if (!editable) return;
    selectionRect = {
      x: rect.left,
      y: rect.top || 0,
      width: rect.width || 0,
      height: rect.height || rect.bottom - (rect.top || 0),
    };
    button.style.display = selected ? 'block' : 'none';
    placePopup(button, rect.left, rect.bottom + 5);
  }
  function currentSlide() {
    if (presentation) return page;
    let best = 0,
      preferred = 0,
      index = page;
    slides.forEach((slide, i) => {
      const r = (slide.querySelector('.slide') ?? slide).getBoundingClientRect();
      const height = r.bottom - r.top;
      const visible = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
      const fraction = height > 0 ? visible / height : 0;
      if (i + 1 === page) preferred = fraction;
      if (fraction > best) {
        best = fraction;
        index = i + 1;
      }
    });
    // Several short pages can be wholly visible together. Keep explicit navigation
    // (or the last stable page) across ties and sub-pixel layout differences. A real
    // scroll changes the winner once that page is meaningfully less visible.
    if (best > 0 && preferred < best - 0.01) page = index;
    return page;
  }
  function wordSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      clear();
      return;
    }
    const range = selection.getRangeAt(0);
    const endpoint = (n: Node, offset: number) => {
      const el = (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('[data-path]');
      const item = el && valid(el);
      if (!el || !item) return null;
      const source = wordSources?.get(el);
      if (wordSources && !source) return null;
      const before = document.createRange();
      before.selectNodeContents(el);
      before.setEnd(n, offset);
      const renderedOffset = before.toString().length;
      return {
        position: {
          path: item.path,
          offset: source
            ? source.offsetAt(renderedOffset)
            : Number(item.wordOffset ?? 0) + renderedOffset,
        },
        source,
      };
    };
    const start = endpoint(range.startContainer, range.startOffset),
      end = endpoint(range.endContainer, range.endOffset);
    const text =
      start?.source && end && start.position.path === end.position.path
        ? start.source.text.slice(start.position.offset, end.position.offset)
        : selection.toString();
    clear();
    if (start && end && text.length > 0 && text.length <= 8192) {
      wordRange = range.cloneRange();
      selected = { kind: 'word', start: start.position, end: end.position, text };
      show(range.getBoundingClientRect());
    }
  }
  function visible(el: Element) {
    const rect = el.getBoundingClientRect(),
      css = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      css.display !== 'none' &&
      css.visibility === 'visible' &&
      css.opacity !== '0' &&
      (!el.checkVisibility ||
        el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    );
  }
  function navigation() {
    return kind === 'powerpoint' ? currentSlide() : null;
  }
  function closeMenu() {
    contextTarget = undefined;
    menu.style.display = 'none';
  }
  function validMenu() {
    return (
      contextTarget?.valid() && visible(contextTarget.element) && contextNavigation === navigation()
    );
  }
  function requestScopeTarget() {
    const target = contextTarget;
    if (pending || requestScopeSerial || !target || !validMenu()) {
      closeMenu();
      return;
    }
    requestScope = target;
    requestElements = [];
    requestWordRange = null;
    requestedSelection = { ...target.selection };
    floatingSelection = { ...target.selection };
    requestAnchor = locateRequest();
    pending = ++serial;
    requestScopeSerial = pending;
    invalidatedSerial = 0;
    closeMenu();
  }
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!editable || !event.isTrusted || pending || requestScopeSerial) return;
      closeMenu();
      let element = event.target instanceof Element ? event.target : null;
      while (element && !scopeTargets.has(element)) element = element.parentElement;
      const target = element && scopeTargets.get(element);
      if (!target?.valid() || !visible(target.element)) return;
      event.preventDefault();
      contextTarget = target;
      contextNavigation = navigation();
      const rect = target.element.getBoundingClientRect();
      menu.style.display = 'block';
      placePopup(
        menu,
        Number.isFinite(event.clientX) ? event.clientX : rect.left,
        Number.isFinite(event.clientY) ? event.clientY : rect.bottom,
      );
      menuItem.focus({ preventScroll: true });
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted && !menu.contains(event.target as Node)) closeMenu();
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (event.isTrusted && event.target === menuItem) {
        event.preventDefault();
        requestScopeTarget();
      }
    },
    true,
  );
  window.addEventListener('blur', (event) => {
    if (event.isTrusted) closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  document.addEventListener('scroll', closeMenu, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeMenu();
  });
  document.addEventListener(
    'pointerup',
    (event) => {
      if (!event.isTrusted || button.contains(event.target as Node)) return;
      if (kind === 'word') {
        wordSelection();
        return;
      }
      const el = (event.target as Element)?.closest?.('[data-path]');
      clear();
      const container = el?.closest('.main > .slide-container');
      const data = el && valid(el),
        slide = slides.indexOf(container as HTMLElement) + 1;
      if (el && data && slide > 0 && data.path.startsWith(`/slide[${slide}]/`)) {
        page = slide;
        selected = {
          kind: 'powerpoint',
          slide,
          objectPath: data.path,
          text: data.text.slice(0, 8192),
        };
        highlighted = [el];
        el.setAttribute('data-kite-selected', '');
        show(el.getBoundingClientRect());
        refreshObject();
      }
    },
    true,
  );
  button.addEventListener('pointerdown', (e) => {
    if (e.isTrusted) e.preventDefault();
  });
  function requestSelection(allowPage = false) {
    if (!editable || pending || requestScopeSerial) return;
    // Validate the live selection before freezing the exact user-requested context.
    scope.kiteOfficeInteraction?.read(false);
    if (!selected && allowPage && kind === 'powerpoint' && slides.length) {
      selected = { kind: 'powerpoint', slide: currentSlide() };
      const rect = (
        slides[page - 1]?.querySelector('.slide') ?? slides[page - 1]
      )?.getBoundingClientRect();
      if (rect) selectionRect = { x: rect.left, y: rect.top, width: 0, height: 0 };
    }
    if (!selected) return;
    requestScope = undefined;
    invalidatedSerial = 0;
    closeMenu();
    requestAnchor = { ...selectionRect };
    requestElements = highlighted.slice();
    requestWordRange = wordRange?.cloneRange() ?? null;
    requestedSelection = JSON.parse(JSON.stringify(selected)) as OfficeSelection;
    requestAnchor = locateRequest();
    floatingSelection = JSON.parse(JSON.stringify(selected)) as OfficeSelection;
    pending = ++serial;
    requestScopeSerial = pending;
    button.style.display = 'none';
  }
  button.addEventListener('click', (e) => {
    if (e.isTrusted) requestSelection();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (contextTarget) {
        if (e.key === 'Escape') {
          e.preventDefault();
          const target = contextTarget.element;
          closeMenu();
          if (target instanceof HTMLElement && target.isConnected)
            target.focus({ preventScroll: true });
          return;
        }
        if (e.key === 'Tab') closeMenu();
        if (e.target === menuItem && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          if (!e.repeat && !e.isComposing && e.keyCode !== 229) requestScopeTarget();
          return;
        }
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyX' && selected && !e.repeat && !pending) {
        e.preventDefault();
        requestSelection();
      }
      if (
        kind === 'powerpoint' &&
        !requestScopeSerial &&
        (presentation || e.key.toLowerCase() === 'f')
      ) {
        if (
          [
            'ArrowRight',
            'ArrowDown',
            'PageDown',
            'ArrowLeft',
            'ArrowUp',
            'PageUp',
            'Escape',
            'f',
            'F',
          ].includes(e.key)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.key === 'Escape') control({ kind: 'presentation', value: false });
          else if (e.key.toLowerCase() === 'f')
            control({ kind: 'presentation', value: !presentation });
          else
            control({
              kind: 'slide',
              value: Math.max(
                1,
                Math.min(
                  slides.length,
                  page + (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) ? -1 : 1),
                ),
              ),
            });
        }
      }
    },
    true,
  );
  document.addEventListener('keyup', (e) => {
    if (e.isTrusted && kind === 'word' && e.key.startsWith('Arrow')) wordSelection();
  });
  function control(command: OfficePreviewControl) {
    closeMenu();
    if (command.kind === 'request-edit') {
      requestSelection(true);
      return;
    }
    if (command.kind === 'locate-selection') throw Error('preview_selection_replaced');
    if (command.kind === 'zoom') {
      zoom = command.value;
      document.documentElement.dataset.kiteOfficeFit = String(zoom === 'fit');
      document.documentElement.style.zoom = command.value === 'fit' ? '1' : String(command.value);
      window.dispatchEvent(new Event('resize'));
    } else if (kind === 'powerpoint' && slides.length) {
      clear();
      if (command.kind === 'presentation') {
        page = currentSlide();
        presentation = command.value;
        document.body.classList.toggle('kite-present', presentation);
      } else page = Math.max(1, Math.min(slides.length, command.value));
      slides.forEach((el, i) => {
        el.classList.toggle('kite-current', i + 1 === page);
      });
      const target = slides[page - 1];
      (target?.querySelector('.slide') ?? target)?.scrollIntoView({
        block: 'center',
        behavior: 'instant',
      });
      refreshThumbnails();
      window.dispatchEvent(new Event('resize'));
    }
  }
  function locateRequest() {
    let rect: DOMRect | undefined;
    if (requestScope?.valid()) rect = requestScope.element.getBoundingClientRect();
    else if (
      requestedSelection?.kind === 'word' &&
      !('scope' in requestedSelection) &&
      requestWordRange?.startContainer.isConnected &&
      requestWordRange.endContainer.isConnected &&
      requestWordRange.toString() === requestedSelection.text
    )
      rect = requestWordRange.getBoundingClientRect();
    else if (requestElements.length && requestElements.every((el) => valid(el)))
      rect = requestElements.at(-1)?.getBoundingClientRect();
    else if (requestedSelection?.kind === 'powerpoint' && !requestedSelection.objectPath) {
      const slide = slides[requestedSelection.slide - 1];
      const area = (slide?.querySelector('.slide') ?? slide)?.getBoundingClientRect();
      if (area) return { x: area.left, y: area.top, width: 0, height: 0 };
    }
    return rect
      ? { x: rect.left, y: rect.top || 0, width: rect.width || 0, height: rect.height || 0 }
      : requestAnchor;
  }
  function controller() {
    return {
      control,
      zoomScale() {
        if (requestScopeSerial) return;
        if (zoom !== 'fit') return zoom;
        const page =
          kind === 'powerpoint'
            ? slides[currentSlide() - 1]
            : document.querySelector<HTMLElement>('.page-wrapper');
        return Number(page?.style.zoom) || 1;
      },
      releaseScope(value: number) {
        if (value !== requestScopeSerial) return;
        requestScopeSerial = 0;
        requestScope = undefined;
        invalidatedSerial = 0;
        pending = 0;
        floatingSelection = undefined;
        requestedSelection = undefined;
        requestAnchor = undefined;
      },
      read(consume = true): OfficeInteraction {
        refreshWordPages();
        if (contextTarget && !validMenu()) closeMenu();
        if (requestScope && !requestScope.valid()) {
          invalidatedSerial = requestScopeSerial;
          pending = 0;
          floatingSelection = undefined;
          requestScope = undefined;
          requestAnchor = undefined;
        }
        if (selected?.kind === 'word' && !('scope' in selected)) {
          const current = window.getSelection();
          const range = current?.rangeCount === 1 ? current.getRangeAt(0) : null;
          const root = (n: Node) =>
            (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('[data-path]');
          const start = wordRange && root(wordRange.startContainer),
            end = wordRange && root(wordRange.endContainer);
          if (
            !range ||
            !wordRange ||
            !start ||
            !end ||
            !valid(start) ||
            !valid(end) ||
            current?.toString() !== selected.text ||
            range.compareBoundaryPoints(Range.START_TO_START, wordRange) !== 0 ||
            range.compareBoundaryPoints(Range.END_TO_END, wordRange) !== 0
          )
            clear();
        }
        if (highlighted.some((el) => !valid(el))) clear();
        const slide = kind === 'powerpoint' && slides.length ? currentSlide() : undefined;
        if (selected?.kind === 'powerpoint' && selected.slide !== slide) clear();
        refreshThumbnails();
        refreshObject();
        const request = pending;
        const result: OfficeInteraction = {
          selection: selected,
          ...(invalidatedSerial ? { requestInvalidated: invalidatedSerial } : {}),
          zoom,
          ...(kind === 'powerpoint' ? { presentation } : {}),
          ...(slide ? { currentSlide: slide, slideCount: slides.length } : {}),
          ...(request ? { floatingRequest: request, floatingSelection } : {}),
          ...(requestAnchor ? { requestAnchor: locateRequest() } : {}),
        };
        if (consume) {
          pending = 0;
          floatingSelection = undefined;
        }
        return result;
      },
    };
  }
  scope.kiteOfficeInteraction = controller();
  if (kind === 'powerpoint' && slides.length) installThumbnails();
  if (kind === 'word') installWordPages();
  function installPageRail(rail: HTMLElement) {
    pageRail(rail, () => presentation);
  }

  function installWordPages() {
    const initialState = document.documentElement.getAttribute('data-kite-word-pagination-state');
    if (initialState !== 'pending' && initialState !== 'settled') return;
    const roots = new Set(
      Array.from(document.querySelectorAll('.page-wrapper')).map((el) => el.parentElement),
    );
    if (!roots.size) return;
    const rail = document.createElement('nav');
    rail.className = 'kite-office-chrome kite-word-rail';
    rail.setAttribute('aria-label', 'Word 预览页');
    rail.style.cssText =
      'display:none;position:fixed;left:0;top:0;bottom:0;width:104px;overflow-y:auto;overflow-x:hidden;padding:8px 4px;box-sizing:border-box;background:var(--office-background);z-index:100';
    document.body.append(rail);
    installPageRail(rail);
    const css = document.createElement('style');
    css.textContent =
      'body.kite-word-pages{padding-left:112px!important}.kite-word-page-button{display:block;position:relative;width:100%;max-width:96px;height:128px;margin:0 auto 4px;padding:4px 2px 18px;border:1px solid var(--office-border);border-radius:8px;background:transparent;color:var(--office-muted);cursor:pointer;box-sizing:border-box}.kite-word-page-button:hover{background:var(--office-hover)}.kite-word-page-button:focus-visible{outline:1px solid var(--office-foreground);outline-offset:-2px}.kite-word-visual{position:relative;width:88px;height:104px;overflow:hidden;pointer-events:none}.kite-word-number{position:absolute;bottom:2px;left:0;right:0;text-align:center}body .kite-word-page-button,body .kite-word-number{font:11px var(--office-font)!important}';
    document.head.append(css);
    document.body.classList.add('kite-word-pages');
    type Page = {
      page: HTMLElement;
      body: Element;
      button: HTMLButtonElement;
      selection?: OfficeSelection;
      valid: () => boolean;
      navigable: () => boolean;
    };
    let generation = 0,
      pages: Page[] = [];
    const loaded = new Map<
      number,
      { element: HTMLElement; nodes: number; width: number; height: number }
    >();
    const complex = new Set<number>();
    let totalNodes = 0;
    function marker() {
      const state = document.documentElement.getAttribute('data-kite-word-pagination-state');
      const value = Number(
        document.documentElement.getAttribute('data-kite-word-pagination-generation'),
      );
      return state === 'settled' && Number.isSafeInteger(value) && value >= 1 ? value : 0;
    }
    function originalPages() {
      return Array.from(document.querySelectorAll<HTMLElement>('.page-wrapper > .page')).filter(
        (el) => roots.has(el.parentElement?.parentElement ?? null),
      );
    }
    function shape(element: Element, page: Element) {
      const a = element.getBoundingClientRect(),
        b = page.getBoundingClientRect();
      return [a.left - b.left, a.top - b.top, a.width, a.height]
        .map((value) => Math.round(value * 100) / 100)
        .join(',');
    }
    function fitWordThumbnail(visual: HTMLElement, width: number, height: number) {
      const available = Math.max(1, Math.min(88, (rail.clientWidth || 104) - 14));
      const scale = Math.min(available / width, 104 / height);
      visual.style.width = `${width * scale}px`;
      visual.style.height = `${height * scale}px`;
      const clone = visual.firstElementChild as HTMLElement | null;
      clone?.style.setProperty('transform', `scale(${scale})`, 'important');
    }
    function renderThumbnails() {
      for (const item of loaded.values()) fitWordThumbnail(item.element, item.width, item.height);
      const first = Math.max(0, Math.floor(rail.scrollTop / 132) - 1),
        last = Math.min(
          pages.length,
          first + Math.min(10, Math.max(3, Math.ceil((rail.clientHeight || 600) / 132) + 2)),
        );
      for (const [index, item] of loaded)
        if (index < first || index >= last) {
          item.element.remove();
          totalNodes -= item.nodes;
          loaded.delete(index);
        }
      for (let i = first; i < last; i++) {
        if (loaded.has(i) || complex.has(i)) continue;
        const original = pages[i]!.page,
          walker = document.createTreeWalker(original, NodeFilter.SHOW_ALL);
        let nodes = 1;
        for (let node = walker.nextNode(); node && nodes <= 1500; node = walker.nextNode()) nodes++;
        if (nodes > 1500) {
          complex.add(i);
          pages[i]!.button.title = '此页内容较复杂，请点击查看原页';
          continue;
        }
        if (totalNodes + nodes > 8000) continue;
        const clone = original.cloneNode(true) as HTMLElement;
        const source = [original, ...original.querySelectorAll<HTMLElement>('*')],
          copied = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
        // Copy a bounded visual snapshot. No source classes survive to participate in
        // upstream pagination, layout selectors or mutation observers.
        const properties = [
          'display',
          'position',
          'top',
          'right',
          'bottom',
          'left',
          'width',
          'height',
          'min-width',
          'max-width',
          'min-height',
          'max-height',
          'box-sizing',
          'margin',
          'padding',
          'border',
          'border-radius',
          'border-collapse',
          'border-spacing',
          'background',
          'color',
          'color-scheme',
          'font',
          'letter-spacing',
          'line-height',
          'text-align',
          'text-indent',
          'text-decoration',
          'white-space',
          'word-break',
          'overflow-wrap',
          'vertical-align',
          'list-style',
          'float',
          'clear',
          'overflow',
          'opacity',
          'transform',
          'transform-origin',
          'column-count',
          'column-gap',
          'flex',
          'flex-direction',
          'justify-content',
          'align-items',
        ];
        for (let j = 0; j < copied.length; j++) {
          const node = copied[j]!,
            computed = getComputedStyle(source[j]!);
          for (const attribute of [...node.attributes])
            if (
              attribute.name === 'id' ||
              attribute.name === 'class' ||
              attribute.name === 'href' ||
              attribute.name === 'tabindex' ||
              attribute.name.startsWith('on') ||
              attribute.name.startsWith('data-')
            )
              node.removeAttribute(attribute.name);
          for (const property of properties)
            node.style.setProperty(property, computed.getPropertyValue(property));
          node.style.setProperty('pointer-events', 'none', 'important');
          if (source[j] instanceof HTMLImageElement) {
            // Thumbnails must not add document.images or emit image-load events into
            // the renderer's pagination and resource observers.
            const picture = document.createElement('span');
            picture.style.cssText = node.style.cssText;
            picture.style.display =
              computed.display === 'inline' ? 'inline-block' : computed.display;
            const image = source[j] as HTMLImageElement;
            if (image.currentSrc || image.src)
              picture.style.backgroundImage = `url(${JSON.stringify(image.currentSrc || image.src)})`;
            picture.style.backgroundRepeat = 'no-repeat';
            picture.style.backgroundPosition = 'center';
            picture.style.backgroundSize =
              computed.objectFit === 'cover'
                ? 'cover'
                : computed.objectFit === 'fill'
                  ? '100% 100%'
                  : 'contain';
            node.replaceWith(picture);
          }
        }
        clone
          .querySelectorAll(
            'script,style,iframe,object,embed,audio,video,form,input,textarea,select,button',
          )
          .forEach((el) => {
            el.remove();
          });
        const computed = getComputedStyle(original),
          width = parseFloat(computed.width) || original.getBoundingClientRect().width,
          height = parseFloat(computed.height) || original.getBoundingClientRect().height;
        if (!(width > 0 && height > 0)) continue;
        clone.className = 'kite-word-page-preview';
        clone.inert = true;
        clone.setAttribute('aria-hidden', 'true');
        clone.style.cssText += `;position:absolute!important;left:0!important;top:0!important;width:${width}px!important;height:${height}px!important;margin:0!important;transform:scale(${Math.min(88 / width, 104 / height)})!important;transform-origin:0 0!important`;
        const visual = document.createElement('div');
        visual.className = 'kite-word-visual';
        // The source paper may live on .page-wrapper rather than .page. Keep
        // that backing under the snapshot; never inherit the dark chrome rail.
        const opaque = (color: string) => {
          if (!color || color === 'transparent') return false;
          const alpha = color.includes('/')
            ? color.match(/\/\s*([\d.]+)(%)?\s*\)$/)
            : color.startsWith('rgba(')
              ? color.match(/,\s*([\d.]+)(%)?\s*\)$/)
              : null;
          return !alpha || Number(alpha[1]) >= (alpha[2] ? 100 : 1);
        };
        const paper =
          [
            computed.backgroundColor,
            getComputedStyle(original.parentElement!).backgroundColor,
          ].find(opaque) ?? '#fff';
        visual.style.backgroundColor = paper;
        visual.style.margin = '0 auto';
        visual.inert = true;
        visual.setAttribute('aria-hidden', 'true');
        visual.append(clone);
        fitWordThumbnail(visual, width, height);
        pages[i]!.button.prepend(visual);
        loaded.set(i, { element: visual, nodes, width, height });
        totalNodes += nodes;
      }
    }
    refreshWordPages = () => {
      const next = marker();
      if (!next) {
        if (
          document.documentElement.getAttribute('data-kite-word-pagination-state') === 'unavailable'
        )
          document.body.classList.remove('kite-word-pages');
        rail.style.display = 'none';
        closeMenu();
        return;
      }
      if (next === generation) {
        rail.style.display = 'block';
        return;
      }
      closeMenu();
      for (const item of pages) scopeTargets.delete(item.button);
      rail.replaceChildren();
      loaded.clear();
      complex.clear();
      totalNodes = 0;
      pages = [];
      generation = next;
      const original = originalPages();
      if (!original.length || original.length > 500) return;
      const paths = new Map<string, number>();
      for (const page of original)
        for (const node of page.querySelectorAll('.page-body [data-path]')) {
          const path = node.getAttribute('data-path') ?? '';
          paths.set(path, (paths.get(path) ?? 0) + 1);
        }
      original.forEach((page, index) => {
        const body = page.querySelector(':scope > .page-body');
        if (!body) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'kite-word-page-button';
        button.setAttribute('aria-label', `预览第 ${index + 1} 页`);
        const number = document.createElement('span');
        number.className = 'kite-word-number';
        number.textContent = `预览 ${index + 1}`;
        button.append(number);
        rail.append(button);
        const elements = Array.from(body.querySelectorAll('[data-path]'));
        let complete = elements.length > 0 && elements.length <= 256;
        const blocks: { path: string; text: string }[] = [];
        for (const element of elements) {
          const item = valid(element);
          if (
            !item?.path.startsWith('/body/') ||
            item.text.length > 16000 ||
            paths.get(item.path) !== 1 ||
            element.parentElement?.closest('[data-path]')
          ) {
            complete = false;
            break;
          }
          blocks.push({ path: item.path, text: item.text });
        }
        const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = text.nextNode(); node; node = text.nextNode())
          if (
            node.textContent?.trim() &&
            !elements.includes(node.parentElement?.closest('[data-path]') as Element)
          ) {
            complete = false;
            break;
          }
        if (body.querySelector('img,canvas,svg,video,audio,object,iframe')) complete = false;
        const selection: OfficeSelection = {
          kind: 'word',
          scope: 'page',
          pageBasis: 'html-preview',
          page: index + 1,
          layoutGeneration: next,
          blocks,
        };
        if (new TextEncoder().encode(JSON.stringify(selection)).byteLength > 32768)
          complete = false;
        const bodyText = body.textContent;
        const geometry = elements.map((el) => shape(el, page)),
          pageShape = shape(page, page),
          bodyShape = shape(body, page);
        const pageValid = () =>
          marker() === next &&
          page.isConnected &&
          originalPages().length === original.length &&
          originalPages().every((item, i) => item === original[i]) &&
          page.querySelector(':scope > .page-body') === body &&
          body.textContent === bodyText &&
          body.querySelectorAll('[data-path]').length === elements.length &&
          button.parentElement === rail &&
          number.parentElement === button &&
          number.textContent === `预览 ${index + 1}` &&
          button.getAttribute('aria-label') === `预览第 ${index + 1} 页` &&
          shape(page, page) === pageShape &&
          shape(body, page) === bodyShape &&
          elements.every(
            (el, i) => valid(el) && el.closest('.page') === page && shape(el, page) === geometry[i],
          );
        const item: Page = {
          page,
          body,
          button,
          valid: pageValid,
          navigable: () =>
            marker() === next &&
            page.isConnected &&
            button.parentElement === rail &&
            originalPages().length === original.length &&
            originalPages().every((entry, i) => entry === original[i]),
          ...(complete ? { selection } : {}),
        };
        pages.push(item);
        if (complete) scopeTargets.set(button, { element: button, selection, valid: pageValid });
        else button.title = '此页无法完整定位，请选中文字请求修改';
      });
      rail.style.display = 'block';
      renderThumbnails();
    };
    document.addEventListener(
      'click',
      (event) => {
        if (!event.isTrusted || requestScopeSerial) return;
        const item = pages.find(
          (page) =>
            page.button === event.target ||
            (event.target instanceof Node && page.button.contains(event.target)),
        );
        if (!item?.navigable()) return;
        event.preventDefault();
        closeMenu();
        item.page.scrollIntoView({ block: 'start', behavior: 'instant' });
      },
      true,
    );
    rail.addEventListener('scroll', renderThumbnails);
    // Navigation also serves read-only previews, which never poll edit interactions.
    new MutationObserver(() => refreshWordPages()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-kite-word-pagination-state', 'data-kite-word-pagination-generation'],
    });
    refreshWordPages();
    window.dispatchEvent(new Event('resize'));
  }

  function installThumbnails() {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;
    // Render a bounded set of thumbnails for the scrollable rail.
    const rail = document.createElement('nav');
    rail.className = 'kite-office-chrome kite-thumbnail-rail';
    rail.setAttribute('aria-label', '幻灯片缩略图');
    rail.style.cssText =
      '--kite-thumb-scale:1;--kite-rail-width:104px;width:var(--kite-rail-width);min-width:var(--kite-rail-width);flex:0 0 var(--kite-rail-width);height:100vh;overflow-y:auto;overflow-x:hidden;padding:8px 4px;background:var(--office-background);box-sizing:border-box';
    main.style.minWidth = '0';
    main.before(rail);
    installPageRail(rail);
    const railStyle = document.createElement('style');
    railStyle.textContent =
      '.kite-thumbnail-button{display:block;position:relative;width:100%;height:calc(54px * var(--kite-thumb-scale) + 28px);margin:0;padding:4px 2px 18px;border:2px solid transparent;border-radius:8px;background:transparent;color:var(--office-muted);cursor:pointer;box-sizing:border-box}.kite-thumbnail-button:hover{background:var(--office-hover)}.kite-thumbnail-button:active{background:var(--office-pressed)}.kite-thumbnail-button[aria-current="true"]{border-color:var(--office-foreground);background:var(--office-selected);color:var(--office-foreground)}.kite-thumbnail-visual{position:relative;transform:scale(var(--kite-thumb-scale));transform-origin:left top;width:88px;height:54px;overflow:hidden;background:#eee;pointer-events:none}.kite-thumbnail-visual *{pointer-events:none!important}.kite-thumbnail-number{position:absolute;bottom:0;left:0;right:0;font:11px var(--office-font);text-align:center}body.kite-present .kite-thumbnail-rail{display:none!important}@media(max-width:480px){.kite-thumbnail-rail{--kite-rail-width:80px!important;--kite-thumb-scale:0.75!important}}@media(max-width:360px){.kite-thumbnail-rail{--kite-rail-width:64px!important;--kite-thumb-scale:0.55!important}}';
    document.head.append(railStyle);
    const buttons: HTMLButtonElement[] = [];
    const buttonPages = new Map<Element, number>();
    const loaded = new Map<number, { visual: HTMLElement; nodes: number }>();
    const complex = new Set<number>();
    let totalNodes = 0;
    slides.forEach((_slide, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'kite-thumbnail-button';
      item.setAttribute('aria-label', `第 ${i + 1} 页`);
      const number = document.createElement('span');
      number.className = 'kite-thumbnail-number';
      number.textContent = String(i + 1);
      item.append(number);
      rail.append(item);
      buttons.push(item);
      buttonPages.set(item, i + 1);
      scopeTargets.set(item, {
        element: item,
        selection: { kind: 'powerpoint', slide: i + 1 },
        valid: () =>
          item.isConnected &&
          item.parentElement === rail &&
          number.parentElement === item &&
          number.textContent === String(i + 1) &&
          item.getAttribute('aria-label') === `第 ${i + 1} 页` &&
          _slide.isConnected &&
          _slide.parentElement === main &&
          Array.from(main.children).filter((el) => el.classList.contains('slide-container'))[i] ===
            _slide,
      });
    });
    document.addEventListener(
      'click',
      (event) => {
        if (!event.isTrusted || requestScopeSerial) return;
        const item = (event.target as Element)?.closest?.('.kite-thumbnail-button');
        const index = item && buttonPages.get(item);
        if (index) {
          event.preventDefault();
          control({ kind: 'slide', value: index });
        }
      },
      true,
    );
    refreshThumbnails = () => {
      const activePage = currentSlide();
      buttons.forEach((item, i) => {
        item.setAttribute('aria-current', String(i + 1 === activePage));
      });
      // No clones while presenting; otherwise render viewport plus one-page overscan,
      // capped independently from the document size and from zoom/viewport claims.
      const first = Math.max(0, Math.floor(rail.scrollTop / (buttons[0]?.offsetHeight || 82)) - 1);
      const count = Math.min(
        12,
        Math.max(3, Math.ceil((rail.clientHeight || 600) / (buttons[0]?.offsetHeight || 82)) + 2),
      );
      const last = Math.min(slides.length, first + count);
      for (const [i, entry] of loaded) {
        if (presentation || i < first || i >= last) {
          entry.visual.remove();
          totalNodes -= entry.nodes;
          loaded.delete(i);
        }
      }
      if (presentation) return;
      for (let i = first; i < last; i++) {
        if (loaded.has(i) || complex.has(i)) continue;
        const original = slides[i]?.querySelector<HTMLElement>('.slide');
        if (!original) continue;
        const nodes = document.createTreeWalker(original, NodeFilter.SHOW_ALL);
        let nodeCount = 1;
        for (let node = nodes.nextNode(); node && nodeCount <= 1500; node = nodes.nextNode())
          nodeCount++;
        if (nodeCount > 1500) {
          complex.add(i);
          buttons[i]!.title = '此页内容较复杂，请点击查看原页';
          continue;
        }
        if (totalNodes + nodeCount > 8000) continue;
        const clone = original.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            'script,iframe,object,embed,audio,video,form,input,textarea,select,button',
          )
          .forEach((el) => {
            el.remove();
          });
        for (const el of [clone, ...clone.querySelectorAll('*')]) {
          for (const attribute of [...el.attributes]) {
            if (
              attribute.name === 'id' ||
              attribute.name === 'data-path' ||
              attribute.name === 'href' ||
              attribute.name === 'tabindex' ||
              attribute.name.startsWith('on')
            )
              el.removeAttribute(attribute.name);
          }
        }
        const computed = getComputedStyle(original);
        // The rail is client chrome; the clone must retain the source slide's
        // inherited text/scheme instead of inheriting the rail's dark UI palette.
        clone.style.color = computed.color;
        clone.style.colorScheme = computed.colorScheme;
        clone.style.font = computed.font;
        clone.style.letterSpacing = computed.letterSpacing;
        const width = parseFloat(computed.width) || 1280,
          height = parseFloat(computed.height) || 720;
        const scale = Math.min(88 / width, 54 / height);
        clone.style.cssText += `;position:absolute!important;left:0!important;top:0!important;width:${width}px!important;height:${height}px!important;margin:0!important;transform:scale(${scale})!important;transform-origin:0 0!important;pointer-events:none!important`;
        clone.inert = true;
        clone.setAttribute('aria-hidden', 'true');
        const visual = document.createElement('div');
        visual.className = 'kite-thumbnail-visual';
        visual.inert = true;
        visual.setAttribute('aria-hidden', 'true');
        visual.append(clone);
        buttons[i]!.prepend(visual);
        loaded.set(i, { visual, nodes: nodeCount });
        totalNodes += nodeCount;
      }
    };
    rail.addEventListener('scroll', refreshThumbnails);
    window.addEventListener('resize', refreshThumbnails);
    refreshThumbnails();
    window.dispatchEvent(new Event('resize'));
  }
}
export const officeInteractionInstallScript = (kind: 'word' | 'powerpoint') =>
  `(${installInteraction.toString()})(${JSON.stringify(kind)},${JSON.stringify(officeChromeCss)},${sharedPageRail.toString()})`;
export const officeInteractionReadScript =
  'globalThis.kiteOfficeInteraction?.read() ?? {selection:null}';
export const officeInteractionPeekScript =
  'globalThis.kiteOfficeInteraction?.read(false) ?? {selection:null}';
export function officeInteractionControlScript(command: OfficePreviewControl) {
  if (command.kind === 'locate-selection') {
    if (
      Object.keys(command).sort().join(',') !== 'kind,selectionSerial' ||
      !Number.isSafeInteger(command.selectionSerial) ||
      command.selectionSerial < 1
    )
      throw Error('preview_control_invalid');
    return `globalThis.kiteOfficeInteraction?.control(${JSON.stringify(command)})`;
  }
  if (command.kind === 'request-edit') {
    if (Object.keys(command).join(',') !== 'kind') throw Error('preview_control_invalid');
    return `globalThis.kiteOfficeInteraction?.control(${JSON.stringify(command)})`;
  }
  if (
    command.kind === 'zoom'
      ? !(
          command.value === 'fit' ||
          (typeof command.value === 'number' &&
            Number.isFinite(command.value) &&
            command.value >= 0.5 &&
            command.value <= 2)
        )
      : command.kind === 'slide'
        ? !(Number.isInteger(command.value) && command.value >= 1 && command.value <= 1000)
        : command.kind !== 'presentation' || typeof command.value !== 'boolean'
  )
    throw Error('preview_control_invalid');
  return `globalThis.kiteOfficeInteraction?.control(${JSON.stringify(command)})`;
}

/** Host-only lifetime acknowledgement; never surfaced as a document or renderer command. */
export function officeInteractionReleaseScript(serial: number) {
  if (!Number.isSafeInteger(serial) || serial < 1) throw Error('preview_request_invalid');
  return `globalThis.kiteOfficeInteraction?.releaseScope(${serial})`;
}
export function installRenderedOfficeInteraction(
  kind: 'word' | 'powerpoint',
  editable: boolean,
  wordSources?: WeakMap<Element, WordTextSource>,
) {
  installInteraction(kind, officeChromeCss, sharedPageRail, editable, wordSources);
}
