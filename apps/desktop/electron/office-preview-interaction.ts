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
  notes?: string;
  presentation?: boolean;
  zoom?: number | 'fit';
  floatingRequest?: number;
  requestInvalidated?: number;
  floatingSelection?: OfficeSelection;
  requestAnchor?: { x: number; y: number; width: number; height: number };
};
export const officeInteractionWorld = 1004;

/** Serialized into an isolated world: no preload, IPC, callbacks or host objects. */
function installInteraction(
  kind: 'word' | 'excel' | 'powerpoint',
  chromeCss: string,
  pageRail: typeof sharedPageRail,
) {
  const scope = globalThis as typeof globalThis & {
    kiteOfficeInteraction?: ReturnType<typeof controller>;
  };
  if (scope.kiteOfficeInteraction) return;
  if (kind === 'powerpoint') {
    // Remove eager converter thumbnails before budgets and source indexing. Its
    // resize handler only queries .thumb-inner, which this rail never creates.
    document.querySelectorAll('.sidebar,.sidebar-toggle,.toggle-zone').forEach((el) => {
      el.remove();
    });
  }
  // Identify only the exact locally generated notice shell, never authored details.
  // This is layout recognition, not a source of selection or host authority.
  const notice = [
    ...document.querySelectorAll<HTMLDetailsElement>('body > details[role="note"]'),
  ].find(
    (node) =>
      node.style.position === 'fixed' &&
      node.style.top === '8px' &&
      node.style.right === '8px' &&
      node.querySelector(':scope > summary')?.textContent === 'Kite 离线预览说明' &&
      node.textContent === 'Kite 离线预览说明排版可能与 Office 不同；复杂 3D 与动画不受支持。',
  );
  // The trusted host renders its own fixed copy. Never transfer document HTML.
  notice?.remove();
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
  const entries = new Map<Element, { path: string; text: string; formula?: string }>();
  let indexedText = 0;
  for (const element of document.querySelectorAll('[data-path]')) {
    if (element.closest('.sidebar')) continue;
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
      const formula = element.getAttribute('data-formula');
      entries.set(element, {
        path,
        text,
        ...(formula && formula.length <= 4096 ? { formula } : {}),
      });
    }
  }
  const slides = Array.from(
    document.querySelectorAll<HTMLElement>('.main > .slide-container'),
  ).slice(0, 1000);
  const speakerNotes = new Map<HTMLElement, Element>();
  if (kind === 'powerpoint') {
    for (const slide of slides) {
      const notes = slide.querySelector<HTMLElement>(':scope > .slide-notes');
      const label = notes?.children[0];
      const body = notes?.children[1];
      // Only the fixed converter's sibling chrome is duplicated by the trusted
      // host notes disclosure. Keep its text in place for read(), never alter the deck.
      if (
        notes?.children.length === 2 &&
        label?.className === 'slide-notes-label' &&
        label.textContent?.trim() === 'Notes' &&
        body?.className === 'slide-notes-body' &&
        !notes.matches('[data-path]') &&
        !notes.querySelector('[data-path]')
      ) {
        speakerNotes.set(slide, body);
        notes.style.setProperty('display', 'none', 'important');
        notes.setAttribute('aria-hidden', 'true');
      }
    }
  }
  let selected: OfficeSelection | null = null,
    anchor: Element | null = null,
    selectedSheet: Element | null = null;
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
  let contextNavigation: Element | number | null = null;
  let requestedSelection: OfficeSelection | undefined;
  let selectionRect = { x: 12, y: 12, width: 0, height: 0 };
  let pending = 0,
    serial = 0,
    presentation = false,
    page = 1;
  let highlighted: Element[] = [];
  let refreshThumbnails = () => {};
  let refreshExcel = () => {};
  let resetExcel = () => {};
  let excelSelection: OfficeExcelSelectionView | undefined;
  let selectionSerial = 0;
  let refreshObject = () => {};
  let excelRequestVisible = false;
  const button = document.createElement('button');
  button.textContent = '请求修改';
  button.title = 'Ctrl Shift X';
  button.className = 'kite-office-chrome kite-office-request-trigger';
  button.style.cssText = 'display:none;position:fixed;z-index:2147483647';
  document.body.append(button);
  const rangeStatus = document.createElement('span');
  rangeStatus.className = 'kite-office-chrome kite-office-range-status';
  rangeStatus.setAttribute('role', 'status');
  rangeStatus.style.cssText = 'display:none;position:fixed;z-index:2147483647;pointer-events:none';
  if (kind === 'excel') document.body.append(rangeStatus);
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
.kite-office-request-trigger,.kite-office-range-status{max-width:calc(100vw - 8px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--office-border);border-radius:8px;padding:6px 10px;background:var(--office-card);color:var(--office-foreground);box-shadow:0 1px 6px light-dark(rgb(0 0 0 / 6%),rgb(0 0 0 / 28%));cursor:pointer;font-weight:500}
.kite-office-request-trigger:hover{background:color-mix(in srgb,var(--office-foreground) 5%,var(--office-card))}.kite-office-request-trigger:active{background:color-mix(in srgb,var(--office-foreground) 9%,var(--office-card))}
.kite-office-request-trigger:focus-visible,.kite-thumbnail-button:focus-visible{outline:1px solid var(--office-foreground);outline-offset:-2px}
body{background:#fafafa!important}.sidebar{background:#f5f5f5!important}.slide-label{color:#666!important}
@media(prefers-color-scheme:dark){body{background:#181818!important}.sidebar{background:#242424!important}.slide-label{color:#c6c6c6!important}}
body .kite-office-chrome.kite-office-range-status,body .kite-office-chrome.kite-office-request-trigger,body .kite-office-chrome.kite-thumbnail-rail,body .kite-thumbnail-rail .kite-thumbnail-button,body .kite-thumbnail-rail .kite-thumbnail-number,body .kite-office-chrome.kite-word-rail,body .kite-word-rail .kite-word-page-button,body .kite-word-rail .kite-word-number{font-family:var(--office-font)!important}
body.kite-present .sidebar,body.kite-present .file-title{display:none!important}body.kite-present .main>.slide-container{display:none!important}body.kite-present .main>.slide-container.kite-current{display:flex!important}
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
  paintStyle.textContent = `:host{pointer-events:none}div{all:initial;display:block;box-sizing:border-box;pointer-events:none}.kite-excel-range-layer{position:fixed;overflow:hidden}.kite-excel-range-layer>div{position:absolute}.kite-excel-range-fill{background:rgb(115 115 115 / 16%)}.kite-excel-range-edge{background:#737373}.kite-office-object-selection{position:fixed;border:2px solid #737373;background:rgb(115 115 115 / 10%)}`;
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

  // Only fixed converter chrome is adapted. The trusted toolbar already names
  // the file; authored cells, slide titles and page formatting stay untouched.
  const titleSelector =
    kind === 'excel'
      ? 'body > .file-title'
      : kind === 'powerpoint'
        ? 'body > .main > h1.file-title'
        : '';
  if (titleSelector)
    document.querySelectorAll<HTMLElement>(titleSelector).forEach((title) => {
      title.style.setProperty('display', 'none', 'important');
      title.setAttribute('aria-hidden', 'true');
    });
  if (kind === 'excel') {
    const fitSheet = () => {
      if (zoom !== 'fit') return;
      const table = document.querySelector<HTMLElement>(
        '.sheet-content.active .table-wrapper > table, .sheet-content.active > table',
      );
      if (!table) return;
      const currentScale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const naturalWidth = table.getBoundingClientRect().width / currentScale;
      const available = document.documentElement.clientWidth || window.innerWidth;
      if (!(naturalWidth > 0 && available > 2)) return;
      // Fit the complete grid, including row headers, without rewriting author column widths.
      // Fixed chrome below counter-scales against this same root scale.
      const scale = Math.min(1, (available - 2) / naturalWidth);
      document.documentElement.style.zoom = String(scale);
    };
    window.addEventListener('resize', fitSheet);
    const refitSheet = () => {
      if (zoom === 'fit') window.dispatchEvent(new Event('resize'));
    };
    const sheets = document.querySelectorAll('.sheet-content');
    const fitObserver = new MutationObserver(refitSheet);
    for (const sheet of sheets)
      fitObserver.observe(sheet, { attributes: true, attributeFilter: ['class'] });
    void document.fonts?.ready.then(refitSheet);
    if (!document.documentElement.style.zoom) fitSheet();
    const sheetBars = Array.from(document.querySelectorAll<HTMLElement>('body > .sheet-tabs'));
    const sheetBody = document.body;
    const sheetSlider = sheetBody.querySelector(':scope > .sheet-slider');
    const bodyLayout = getComputedStyle(sheetBody);
    const fixedSheetShell =
      sheetBars.length === 1 &&
      sheetSlider &&
      bodyLayout.display === 'flex' &&
      bodyLayout.flexDirection === 'column' &&
      sheetSlider.children.length > 0 &&
      Array.from(sheetSlider.children).every((child) => child.classList.contains('sheet-content'));
    const sizeSheetBars = () => {
      const reportedScale = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
      const scale = Number.isFinite(reportedScale) && reportedScale > 0 ? reportedScale : 1;
      const viewportHeight = window.visualViewport?.height;
      const height =
        Number.isFinite(viewportHeight) && viewportHeight! > 0
          ? viewportHeight
          : Number.isFinite(window.innerHeight) && window.innerHeight > 0
            ? window.innerHeight
            : undefined;
      // The converter's 100vh body minimum otherwise grows with root zoom and
      // puts the scroll viewport behind its sticky tab bar. Only its original
      // flex shell receives the unzoomed viewport height, never the table/cells.
      if (
        fixedSheetShell &&
        height !== undefined &&
        document.body === sheetBody &&
        sheetSlider.isConnected &&
        sheetSlider.parentElement === sheetBody &&
        sheetBars[0]?.isConnected &&
        sheetBars[0].parentElement === sheetBody
      ) {
        sheetBody.style.height = `${height / scale}px`;
        sheetBody.style.minHeight = '0';
      }
      // CSS zoom participates in flex sizing and hit testing, unlike a visual transform.
      // Keep only these original chrome nodes at interface scale; the grid still zooms.
      for (const tabs of sheetBars)
        if (tabs.isConnected && tabs.parentElement === document.body)
          tabs.style.zoom = String(1 / scale);
    };
    sizeSheetBars();
    window.addEventListener('resize', sizeSheetBars);
    for (const tabs of sheetBars) {
      tabs.classList.add('kite-office-chrome', 'kite-office-sheet-tabs');
      for (const tab of tabs.querySelectorAll<HTMLElement>(':scope > .sheet-tab')) {
        // OfficeCLI emits this inline property only for an author's SheetProperties.TabColor.
        // Keep its identity and original value; represent it as a small accent, not UI fill.
        const color = tab.style.getPropertyValue('--tab-color').trim();
        if (/^#[0-9a-f]{6}$/i.test(color)) tab.style.setProperty('--kite-sheet-accent', color);
      }
    }
    const tabStyle = document.createElement('style');
    tabStyle.textContent =
      'body>.kite-office-chrome.kite-office-sheet-tabs{background:var(--office-background)!important;border-top:1px solid var(--office-border);padding:4px 6px;gap:4px;min-width:0;flex-shrink:0;font:12px/1.4 var(--office-font)!important}body>.kite-office-sheet-tabs>.sheet-tab{padding:4px 10px;min-height:28px;flex-shrink:0;border:0!important;border-radius:8px;background:transparent!important;color:var(--office-muted)!important;opacity:1!important;font:12px/1.4 var(--office-font)!important;box-shadow:inset 0 -2px var(--kite-sheet-accent,transparent);transition:background-color 100ms,color 100ms}body>.kite-office-sheet-tabs>.sheet-tab:hover{background:var(--office-hover)!important;color:var(--office-foreground)!important}body>.kite-office-sheet-tabs>.sheet-tab.active{background:var(--office-selected)!important;color:var(--office-foreground)!important;font-weight:600!important}body>.kite-office-sheet-tabs>.sheet-tab:active{background:var(--office-pressed)!important}body>.kite-office-sheet-tabs>.sheet-tab:focus-visible{outline:1px solid var(--office-foreground);outline-offset:-2px}';
    document.head.append(tabStyle);
  }
  const valid = (el: Element) => {
    const item = entries.get(el);
    return item &&
      el.isConnected &&
      el.getAttribute('data-path') === item.path &&
      el.textContent === item.text
      ? item
      : undefined;
  };
  function clear() {
    selected = null;
    excelSelection = undefined;
    refreshObject();
    excelRequestVisible = false;
    wordRange = null;
    anchor = null;
    selectedSheet = null;
    for (const el of highlighted) el.removeAttribute('data-kite-selected');
    highlighted = [];
    button.style.display = 'none';
    button.textContent = '请求修改';
    rangeStatus.style.display = 'none';
    resetExcel();
  }
  /** Fixed chrome receives viewport pixels; positions use its effective CSS zoom. */
  type PopupClip = { left: number; top: number; right: number; bottom: number };
  function placePopup(element: HTMLElement, x: number, y: number, clip?: PopupClip) {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    const rootScale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    // Counter-scale only this original Excel control, not document content or
    // lookalike nodes. CSS zoom keeps layout and hit testing at interface size.
    const interfaceScale = kind === 'excel' && element === button;
    if (interfaceScale) element.style.zoom = String(1 / rootScale);
    const scale = interfaceScale ? 1 : rootScale;
    // Root client dimensions exclude native scrollbars but remain viewport pixels under CSS zoom.
    const width = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
    const height = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
    // Excel chrome belongs inside the grid's client area, not over its scrollbars,
    // header rails or the fixed Sheet bar. Other formats retain viewport placement.
    const area =
      interfaceScale && clip
        ? {
            left: Math.max(0, clip.left),
            top: Math.max(0, clip.top),
            right: Math.min(width, clip.right),
            bottom: Math.min(height, clip.bottom),
          }
        : { left: 0, top: 0, right: width, bottom: height };
    element.style.boxSizing = 'border-box';
    element.style.maxWidth = `${Math.max(0, area.right - area.left - 8) / scale}px`;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(area.left + 4, Math.min(area.right - bounds.width - 4, Number.isFinite(x) ? x : area.left + 4)) / scale}px`;
    element.style.top = `${Math.max(area.top + 4, Math.min(area.bottom - bounds.height - 4, Number.isFinite(y) ? y : area.top + 4)) / scale}px`;
    return (
      !interfaceScale ||
      !clip ||
      (area.right - area.left >= bounds.width + 8 && area.bottom - area.top >= bounds.height + 8)
    );
  }
  function show(rect: DOMRect, clip?: PopupClip) {
    selectionRect = {
      x: rect.left,
      y: rect.top || 0,
      width: rect.width || 0,
      height: rect.height || rect.bottom - (rect.top || 0),
    };
    button.style.display = selected ? 'block' : 'none';
    const fits = placePopup(button, rect.left, rect.bottom + 5, clip);
    button.style.display = selected && fits ? 'block' : 'none';
    if (!fits) {
      button.style.left = '';
      button.style.top = '';
    }
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
      if (!el || !valid(el)) return null;
      const before = document.createRange();
      before.selectNodeContents(el);
      before.setEnd(n, offset);
      return { path: valid(el)!.path, offset: before.toString().length };
    };
    const start = endpoint(range.startContainer, range.startOffset),
      end = endpoint(range.endContainer, range.endOffset);
    const text = selection.toString();
    clear();
    if (start && end && text.length > 0 && text.length <= 8192) {
      wordRange = range.cloneRange();
      selected = { kind: 'word', start, end, text };
      show(range.getBoundingClientRect());
    }
  }
  type Cell = {
    element: Element;
    owner: Element;
    originalRow: Element | null;
    originalTable: Element | null;
    tableParent: Element | null;
    path: string;
    text: string;
    formula?: string;
    originalFormula: string | null;
    colSpan: number;
    rowSpan: number;
    sheet: string;
    address: string;
    col: number;
    row: number;
  };
  const cellIndex = new Map<Element, Map<string, Cell | null>>();
  const indexedCells = new Map<Element, Cell>();
  if (kind === 'excel') {
    for (const [element, data] of entries) {
      const owner = element.closest('.sheet-content');
      const match = data.path.match(/^\/(.+)\/([A-Z]{1,3})([1-9][0-9]{0,6})$/);
      if (
        element.tagName !== 'TD' ||
        !owner ||
        !match ||
        data.text.length > 4096 ||
        match[1]!.length > 128
      )
        continue;
      let col = 0;
      for (const c of match[2]!) col = col * 26 + c.charCodeAt(0) - 64;
      const row = Number(match[3]);
      if (col > 16384 || row > 1048576) continue;
      const originalFormula = element.getAttribute('data-formula');
      if (originalFormula && originalFormula.length > 4096) continue;
      const cell: Cell = {
        ...data,
        element,
        owner,
        originalRow: element.parentElement,
        originalTable: element.closest('table'),
        tableParent: element.closest('table')?.parentElement ?? null,
        originalFormula,
        colSpan: (element as HTMLTableCellElement).colSpan,
        rowSpan: (element as HTMLTableCellElement).rowSpan,
        sheet: match[1]!,
        address: match[2]! + match[3]!,
        col,
        row,
      };
      const index = cellIndex.get(owner) ?? new Map<string, Cell | null>();
      const key = `${row}:${col}`;
      index.set(key, index.has(key) ? null : cell);
      cellIndex.set(owner, index);
      indexedCells.set(element, cell);
    }
  }
  if (kind === 'excel') {
    const sheets = Array.from(document.querySelectorAll('.sheet-content'));
    const tabs = Array.from(document.querySelectorAll('.sheet-tabs > .sheet-tab'));
    const sheetsById = new Map<string | null, Element | null>();
    const tabIds = new Map<string | null, number>(),
      tabNames = new Map<string, number>();
    for (const sheet of sheets) {
      const id = sheet.getAttribute('data-sheet');
      sheetsById.set(id, sheetsById.has(id) ? null : sheet);
    }
    for (const tab of tabs) {
      const id = tab.getAttribute('data-sheet'),
        name = tab.textContent ?? '';
      tabIds.set(id, (tabIds.get(id) ?? 0) + 1);
      tabNames.set(name, (tabNames.get(name) ?? 0) + 1);
    }
    for (const tab of tabs) {
      const id = tab.getAttribute('data-sheet'),
        name = tab.textContent ?? '';
      const sheet = sheetsById.get(id);
      if (
        !id ||
        !/^\d+$/.test(id) ||
        !sheet ||
        !name ||
        name.length > 128 ||
        /[\r\n\0]/.test(name) ||
        tabIds.get(id) !== 1 ||
        tabNames.get(name) !== 1
      )
        continue;
      const parent = sheet.parentElement,
        tabParent = tab.parentElement;
      const cells = [...(cellIndex.get(sheet)?.values() ?? [])];
      if (cells.some((cell) => !cell || cell.sheet !== name)) continue;
      scopeTargets.set(tab, {
        element: tab,
        selection: { kind: 'excel', scope: 'sheet', sheet: name },
        valid: () =>
          tab.isConnected &&
          sheet.isConnected &&
          tab.parentElement === tabParent &&
          sheet.parentElement === parent &&
          tab.getAttribute('data-sheet') === id &&
          sheet.getAttribute('data-sheet') === id &&
          tab.textContent === name,
      });
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
    return kind === 'powerpoint' ? currentSlide() : document.querySelector('.sheet-content.active');
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
    cancelDrag();
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
      if (!event.isTrusted || pending || requestScopeSerial) return;
      closeMenu();
      let element = event.target instanceof Element ? event.target : null;
      while (element && !scopeTargets.has(element)) element = element.parentElement;
      const target = element && scopeTargets.get(element);
      if (!target?.valid() || !visible(target.element)) return;
      event.preventDefault();
      cancelDrag();
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
  function cellInfo(el: Element) {
    const cell = indexedCells.get(el);
    return cell &&
      valid(el) &&
      el.parentElement === cell.originalRow &&
      el.closest('table') === cell.originalTable &&
      cell.originalTable?.parentElement === cell.tableParent &&
      (el as HTMLTableCellElement).colSpan === cell.colSpan &&
      (el as HTMLTableCellElement).rowSpan === cell.rowSpan &&
      el.closest('.sheet-content') === cell.owner &&
      el.getAttribute('data-formula') === cell.originalFormula
      ? cell
      : null;
  }
  function activeExcelCell() {
    if (
      selected?.kind !== 'excel' ||
      'scope' in selected ||
      !anchor ||
      !selectedSheet ||
      !selectedSheet.isConnected ||
      !selectedSheet.classList.contains('active') ||
      highlighted.length !== selected.cells.length ||
      highlighted.some((element) => !cellInfo(element))
    )
      return null;
    const cell = cellInfo(anchor);
    return cell &&
      cell.owner === selectedSheet &&
      highlighted.includes(anchor) &&
      selected.cells.some((item) => item.address === cell.address && item.path === cell.path)
      ? cell
      : null;
  }
  function rangeError(message: string, end: Element) {
    clear();
    const rect = end.getBoundingClientRect();
    rangeStatus.textContent = message;
    rangeStatus.style.display = 'block';
    placePopup(rangeStatus, rect.left, rect.bottom + 5);
  }
  function selectCells(firstElement: Element, end: Element, sheet: Element) {
    const first = cellInfo(firstElement),
      last = cellInfo(end),
      index = cellIndex.get(sheet);
    if (
      !first ||
      !last ||
      !index ||
      !sheet.isConnected ||
      !sheet.classList.contains('active') ||
      first.owner !== sheet ||
      last.owner !== sheet ||
      first.sheet !== last.sheet
    ) {
      clear();
      return false;
    }
    const left = Math.min(first.col, last.col),
      right = Math.max(first.col, last.col);
    const top = Math.min(first.row, last.row),
      bottom = Math.max(first.row, last.row);
    if ((right - left + 1) * (bottom - top + 1) > 256) {
      rangeError('最多选择 256 个单元格', end);
      return false;
    }
    const cells: Extract<OfficeSelection, { kind: 'excel'; range: string }>['cells'] = [];
    const nodes: Element[] = [];
    for (let row = top; row <= bottom; row++)
      for (let col = left; col <= right; col++) {
        const item = index.get(`${row}:${col}`);
        if (
          !item ||
          !cellInfo(item.element) ||
          item.sheet !== first.sheet ||
          item.colSpan !== 1 ||
          item.rowSpan !== 1
        ) {
          rangeError('此区域不可用，请重新选择', end);
          return false;
        }
        nodes.push(item.element);
        cells.push({
          path: item.path,
          address: item.address,
          value: item.text,
          ...(item.formula ? { formula: item.formula } : {}),
        });
      }
    const low = cells[0]!.address,
      high = cells.at(-1)!.address;
    const result: OfficeSelection = {
      kind: 'excel',
      sheet: first.sheet,
      range: low === high ? low : `${low}:${high}`,
      cells,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32768) {
      rangeError('所选内容过多，请缩小范围', end);
      return false;
    }
    const previous = excelSelection;
    const unchanged =
      anchor === firstElement &&
      selectedSheet === sheet &&
      selected?.kind === 'excel' &&
      !('scope' in selected) &&
      selected.range === result.range;
    clear();
    anchor = firstElement;
    selectedSheet = sheet;
    selected = result;
    highlighted = nodes;
    if (unchanged && previous) excelSelection = previous;
    else if (selectionSerial < Number.MAX_SAFE_INTEGER)
      excelSelection = { selectionSerial: ++selectionSerial, activeAddress: first.address };
    for (const node of nodes) node.setAttribute('data-kite-selected', '');
    button.textContent = `请求修改 · ${result.range}`;
    excelRequestVisible = true;
    const startBounds = nodes[0]!.getBoundingClientRect(),
      endBounds = nodes.at(-1)!.getBoundingClientRect();
    const leftEdge = Math.min(startBounds.left, endBounds.left),
      topEdge = Math.min(startBounds.top, endBounds.top);
    show(
      new DOMRect(
        leftEdge,
        topEdge,
        Math.max(startBounds.right, endBounds.right) - leftEdge,
        Math.max(startBounds.bottom, endBounds.bottom) - topEdge,
      ),
    );
    refreshExcel();
    return true;
  }
  type Drag = {
    id: number;
    first: Element;
    sheet: Element;
    capture: Element;
    move?: { target: EventTarget | null; x: number; y: number };
    frame?: number;
  };
  let drag: Drag | undefined;
  function stopDrag() {
    const old = drag;
    drag = undefined;
    button.style.pointerEvents = '';
    if (!old) return;
    if (old.frame !== undefined) cancelAnimationFrame(old.frame);
    try {
      if (old.capture.hasPointerCapture?.(old.id)) old.capture.releasePointerCapture(old.id);
    } catch {
      /* retired native pointer */
    }
  }
  function cancelDrag() {
    stopDrag();
    clear();
  }
  function hitCell(target: EventTarget | null, x: number, y: number) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
      target = document.elementFromPoint(x, y);
    }
    const cell = (target as Element | null)?.closest?.('td[data-path]');
    if (!cell) return null;
    const rect = cell.getBoundingClientRect(),
      css = getComputedStyle(cell);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      css.display === 'none' ||
      css.visibility !== 'visible' ||
      css.opacity === '0' ||
      (cell.checkVisibility &&
        !cell.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    )
      return null;
    return cell;
  }
  function applyMove() {
    const active = drag;
    if (!active) return;
    if (active.frame !== undefined) cancelAnimationFrame(active.frame);
    active.frame = undefined;
    const move = active.move;
    active.move = undefined;
    if (!active.sheet.isConnected || !active.sheet.classList.contains('active')) {
      cancelDrag();
      return;
    }
    if (!move) return;
    const cell = hitCell(move.target, move.x, move.y);
    if (!cell || cell.closest('.sheet-content') !== active.sheet || !cellInfo(cell)) {
      cancelDrag();
      return;
    }
    selectCells(active.first, cell, active.sheet);
  }
  if (kind === 'excel') {
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !event.isTrusted ||
          event.button !== 0 ||
          event.isPrimary === false ||
          event.pointerType === 'touch' ||
          button.contains(event.target as Node) ||
          pending ||
          requestScopeSerial
        )
          return;
        const cell = hitCell(event.target, event.clientX, event.clientY),
          item = cell && cellInfo(cell);
        if (!cell || !item?.owner.classList.contains('active')) {
          cancelDrag();
          return;
        }
        const first = event.shiftKey && anchor && selectedSheet === item.owner ? anchor : cell;
        stopDrag();
        drag = { id: event.pointerId, first, sheet: item.owner, capture: cell };
        event.preventDefault();
        selectCells(first, cell, item.owner);
        button.style.pointerEvents = 'none';
        try {
          cell.setPointerCapture(event.pointerId);
        } catch {
          /* document events still handle this pointer */
        }
      },
      true,
    );
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!event.isTrusted || !drag || event.pointerId !== drag.id) return;
        if (!(event.buttons & 1)) {
          cancelDrag();
          return;
        }
        event.preventDefault();
        drag.move = { target: event.target, x: event.clientX, y: event.clientY };
        drag.frame ??= requestAnimationFrame(applyMove);
      },
      true,
    );
    for (const name of ['pointercancel', 'lostpointercapture'] as const)
      document.addEventListener(
        name,
        (event) => {
          if (event.isTrusted && drag && event.pointerId === drag.id) cancelDrag();
        },
        true,
      );
    window.addEventListener('blur', (event) => {
      if (event.isTrusted && drag) cancelDrag();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && drag) cancelDrag();
    });
  }
  document.addEventListener(
    'pointerup',
    (event) => {
      if (!event.isTrusted || button.contains(event.target as Node)) return;
      if (kind === 'word') {
        wordSelection();
        return;
      }
      const el = (event.target as Element)?.closest?.('[data-path]');
      if (kind === 'excel') {
        if (!drag || event.pointerId !== drag.id || event.button !== 0) return;
        drag.move = { target: event.target, x: event.clientX, y: event.clientY };
        applyMove();
        stopDrag();
      } else {
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
      }
    },
    true,
  );
  button.addEventListener('pointerdown', (e) => {
    if (e.isTrusted) e.preventDefault();
  });
  function requestSelection(allowPage = false) {
    if (pending || requestScopeSerial) return;
    if (kind === 'excel' && drag) {
      applyMove();
      stopDrag();
    }
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
    excelRequestVisible = false;
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
      if (kind === 'excel' && e.key === 'Escape' && (drag || selected)) {
        e.preventDefault();
        cancelDrag();
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyX' && selected && !e.repeat && !pending) {
        e.preventDefault();
        requestSelection();
      }
      if (kind === 'powerpoint' && (presentation || e.key.toLowerCase() === 'f')) {
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
    if (command.kind === 'locate-selection') {
      const cell = activeExcelCell();
      if (
        kind !== 'excel' ||
        pending ||
        requestScopeSerial ||
        drag ||
        !cell ||
        !excelSelection ||
        excelSelection.selectionSerial !== command.selectionSerial ||
        excelSelection.activeAddress !== cell.address
      )
        throw Error('preview_selection_replaced');
      cell.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      refreshExcel();
      return;
    }
    if (command.kind === 'zoom') {
      zoom = command.value;
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
        if (kind === 'excel' && drag && !drag.sheet.classList.contains('active')) cancelDrag();
        if (
          selectedSheet &&
          (!selectedSheet.isConnected || !selectedSheet.classList.contains('active'))
        )
          clear();
        if (highlighted.some((el) => (kind === 'excel' ? !cellInfo(el) : !valid(el)))) clear();
        const slide = kind === 'powerpoint' && slides.length ? currentSlide() : undefined;
        if (selected?.kind === 'powerpoint' && selected.slide !== slide) clear();
        refreshThumbnails();
        refreshExcel();
        refreshObject();
        if (excelSelection && !activeExcelCell()) clear();
        const request = pending;
        const result: OfficeInteraction = {
          selection: selected,
          ...(excelSelection ? { excelSelection: { ...excelSelection } } : {}),
          ...(invalidatedSerial ? { requestInvalidated: invalidatedSerial } : {}),
          zoom,
          ...(kind === 'powerpoint' ? { presentation } : {}),
          ...(slide
            ? {
                currentSlide: slide,
                slideCount: slides.length,
                notes: (speakerNotes.get(slides[slide - 1]!)?.textContent ?? '').slice(0, 8192),
              }
            : {}),
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
  if (kind === 'excel') installExcelChrome();

  /** Row-number chrome uses the same inset grid primitive as the original td,
   * not a collapsed border or a background stripe (fractional zoom rasterizes them differently). */
  /** Repair only the paint of original converter sticky cells, never their layout or data. */
  function installFrozenCellPaint(
    tables: HTMLTableElement[],
    panes: Map<HTMLTableElement, { row?: Element; col?: Element }>,
    schedule: () => void,
  ) {
    if (typeof IntersectionObserver === 'undefined') return () => {};
    type Paint = {
      element: HTMLTableCellElement;
      table: HTMLTableElement;
      row: HTMLTableRowElement;
      prefix: HTMLTableCellElement[];
      col: HTMLTableColElement;
      colParent: Element | null;
      colPrevious: Element | null;
      wrapper: HTMLElement;
      ancestors: { element: Element; style: string | null }[];
      paper?: string;
      borders?: { css: string; widths: number[] };
      measured?: boolean;
      retired?: boolean;
    };
    const records = new Map<Element, Paint>(),
      visible = new Set<Paint>();
    const sheet = document.createElement('style');
    document.head.append(sheet);
    const papers = new Map<string, string>();
    const layer = document.createElement('div');
    layer.className = 'kite-excel-frozen-borders';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:18';
    document.body.append(layer);
    const unpaint = (paint: Paint) => paint.element.removeAttribute('data-kite-frozen-paper');
    for (const table of tables) {
      const wrapper = table.parentElement!;
      const cols = [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')];
      if (!cols.length || cols.some((col) => col.span !== 1)) continue;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const paint = records.get(entry.target);
            if (!paint) continue;
            if (
              entry.isIntersecting &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height > 0
            )
              visible.add(paint);
            else {
              visible.delete(paint);
            }
          }
          schedule();
        },
        { root: wrapper, rootMargin: '128px' },
      );
      for (const cell of indexedCells.values()) {
        const element = cell.element;
        if (
          !(element instanceof HTMLTableCellElement) ||
          element.closest('table') !== table ||
          element.style.position !== 'sticky' ||
          (!element.style.top && !element.style.left) ||
          element.colSpan !== 1 ||
          element.rowSpan !== 1
        )
          continue;
        const row = element.parentElement;
        const col = cols[element.cellIndex];
        if (!(row instanceof HTMLTableRowElement) || !col || element.cellIndex !== cell.col)
          continue;
        // A later merged region must not discard an independently mapped leading
        // frozen cell. Never infer columns after a colspan/rowspan or paint the merge.
        const prefix = [...row.cells].slice(0, element.cellIndex + 1);
        if (
          prefix.some(
            (entry, index) =>
              entry.colSpan !== 1 ||
              entry.rowSpan !== 1 ||
              (index === 0
                ? !entry.matches('th.row-header')
                : indexedCells.get(entry)?.col !== index),
          )
        )
          continue;
        const ancestors: Paint['ancestors'] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          ancestors.push({ element: node, style: node.getAttribute('style') });
          if (node === wrapper) break;
        }
        const paint: Paint = {
          element,
          table,
          row,
          prefix,
          col,
          colParent: col.parentElement,
          colPrevious: col.previousElementSibling,
          wrapper,
          ancestors,
        };
        records.set(element, paint);
        // Prepare background groups once, before scrolling can expose a new row.
        // Chromium clips these inert pseudo-elements to the native scroll viewport.
        measure(paint);
        observer.observe(element);
      }
      // Mutations retire affected originals, including offscreen backgrounds. No
      // scan is performed for scroll/selection marks or per pointer movement.
      new MutationObserver((changes) => {
        for (const change of changes) {
          if (
            change.type === 'attributes' &&
            !['style', 'class', 'data-path', 'data-formula', 'colspan', 'rowspan'].includes(
              change.attributeName ?? '',
            )
          )
            continue;
          const target =
            change.target instanceof Element ? change.target : change.target.parentElement;
          if (!target) continue;
          const spanChange =
            change.type === 'attributes' &&
            ['colspan', 'rowspan'].includes(change.attributeName ?? '');
          const direct = !spanChange && records.get(target.closest('td') ?? target);
          const affected = direct
            ? [direct]
            : [...records.values()].filter(
                (paint) =>
                  paint.table === table &&
                  ((spanChange && target.parentElement === paint.row) ||
                    paint.ancestors.some((a) => a.element === target) ||
                    target === paint.col ||
                    target === paint.colParent),
              );
          for (const paint of affected) {
            paint.retired = true;
            unpaint(paint);
          }
          schedule();
        }
      }).observe(table, { attributes: true, characterData: true, childList: true, subtree: true });
    }
    // Finish all style reads before applying paper markers: per-cell read/write
    // interleaving repeatedly invalidates style for large frozen columns.
    for (const paint of records.values())
      if (paint.paper) paint.element.setAttribute('data-kite-frozen-paper', paint.paper);
    function measure(paint: Paint) {
      if (paint.measured) return;
      paint.measured = true;
      const style = getComputedStyle(paint.element);
      const colors: number[][] = [];
      const ancestry = paint.ancestors.map(({ element }) => getComputedStyle(element));
      if (
        style.position !== 'sticky' ||
        ancestry.some(
          (css) =>
            css.opacity !== '1' ||
            (css.transform && css.transform !== 'none') ||
            (css.filter && css.filter !== 'none'),
        )
      )
        return;
      for (const css of ancestry) {
        const match = css.backgroundColor.match(/^rgba?\(([^)]+)\)$/);
        if (!match || css.backgroundImage !== 'none' || css.opacity !== '1') return;
        const color = match[1]!.split(',').map(Number);
        if ((color.length !== 3 && color.length !== 4) || color.some((n) => !Number.isFinite(n)))
          return;
        colors.push(color);
        if ((color[3] ?? 1) === 1) break;
      }
      if (!colors.length || (colors.at(-1)![3] ?? 1) !== 1) return;
      // Opaque authored fills already occlude correctly. Composite translucent fills
      // over their actual row/table/paper, not an assumed white or client theme color.
      if ((colors[0]![3] ?? 1) < 1) {
        let color = colors.pop()!;
        for (const next of colors.reverse()) {
          const alpha = next[3] ?? 1;
          color = next.slice(0, 3).map((n, i) => Math.round(n * alpha + color[i]! * (1 - alpha)));
        }
        const css = `background:rgb(${color.slice(0, 3).join(',')});box-shadow:${style.boxShadow}`;
        let id = papers.get(css);
        if (!id && papers.size < 512) {
          id = String(papers.size + 1);
          papers.set(css, id);
          sheet.sheet?.insertRule(
            `td[data-kite-frozen-paper="${id}"]::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;${css}}`,
          );
        }
        paint.paper = id;
      }
      const sides = ['top', 'right', 'bottom', 'left'];
      const widths = sides.map((side) =>
        Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
      );
      if (widths.some((n) => !Number.isFinite(n) || n < 0 || n > 32)) return;
      if (
        sides.some(
          (side) =>
            !/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(
              style.getPropertyValue(`border-${side}-style`),
            ),
        )
      )
        return;
      if (widths.some((width) => width > 0))
        paint.borders = {
          widths,
          css: sides
            .map((side) => `border-${side}:${style.getPropertyValue(`border-${side}`)};`)
            .join(''),
        };
    }
    return () => {
      layer.replaceChildren();
      if (visible.size > 512) return;
      const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      for (const paint of visible) {
        const { element, table, row, col, wrapper } = paint;
        const cell = cellInfo(element);
        if (
          paint.retired ||
          !cell ||
          element.parentElement !== row ||
          paint.prefix.some(
            (entry, index) =>
              row.cells[index] !== entry || entry.colSpan !== 1 || entry.rowSpan !== 1,
          ) ||
          element.closest('table') !== table ||
          !col.isConnected ||
          col.parentElement !== paint.colParent ||
          col.previousElementSibling !== paint.colPrevious ||
          col.closest('table') !== table ||
          table.parentElement !== wrapper ||
          paint.ancestors.some(
            (a, i) =>
              a.element.getAttribute('style') !== a.style ||
              (i > 0 && paint.ancestors[i - 1]!.element.parentElement !== a.element),
          )
        ) {
          unpaint(paint);
          continue;
        }
        if (!cell.owner.classList.contains('active')) continue;
        if (!paint.borders) continue;
        const rect = element.getBoundingClientRect();
        const frozenTop = !!element.style.top,
          frozenLeft = !!element.style.left;
        // The unfrozen row and col tracks are live layout references, including when
        // installed after scrolling. At the original position the native border owns paint.
        if (
          !(frozenTop && Math.abs(rect.top - row.getBoundingClientRect().top) > 0.1) &&
          !(frozenLeft && Math.abs(rect.left - col.getBoundingClientRect().left) > 0.1)
        )
          continue;
        const area = wrapper.getBoundingClientRect(),
          pane = panes.get(table);
        const head = table.tHead?.querySelector('.col-header')?.getBoundingClientRect();
        const clip = {
          left: Math.max(
            0,
            area.left,
            frozenLeft ? 0 : (pane?.col?.getBoundingClientRect().right ?? area.left),
          ),
          top: Math.max(
            0,
            area.top,
            frozenTop ? 0 : (pane?.row?.getBoundingClientRect().bottom ?? head?.bottom ?? area.top),
          ),
          right: Math.min(innerWidth, area.left + wrapper.clientWidth * scale),
          bottom: Math.min(innerHeight, area.top + wrapper.clientHeight * scale),
        };
        if (
          clip.right <= clip.left ||
          clip.bottom <= clip.top ||
          rect.right < clip.left ||
          rect.left > clip.right ||
          rect.bottom < clip.top ||
          rect.top > clip.bottom
        )
          continue;
        const crop = document.createElement('div'),
          border = document.createElement('div');
        crop.style.cssText = `position:absolute;overflow:hidden;pointer-events:none;left:${clip.left / scale}px;top:${clip.top / scale}px;width:${(clip.right - clip.left) / scale}px;height:${(clip.bottom - clip.top) / scale}px`;
        const b = paint.borders.widths;
        // Collapsed cell rects run through stroke centres. Preserve the full authored
        // half-strokes at header intersections, but never outside the scroll viewport.
        border.style.cssText = `position:absolute;box-sizing:border-box;pointer-events:none;${paint.borders.css}left:${(rect.left - clip.left) / scale - b[3]! / 2}px;top:${(rect.top - clip.top) / scale - b[0]! / 2}px;width:${rect.width / scale + (b[1]! + b[3]!) / 2}px;height:${rect.height / scale + (b[0]! + b[2]!) / 2}px`;
        crop.append(border);
        layer.append(crop);
      }
    };
  }

  function installExcelChrome() {
    document.body.classList.add('kite-excel-preview');
    // Keep horizontal collapsed borders (including stronger authored cell borders).
    // Paint only converter header vertical edges inside, matching default cell grids.
    // Authored td borders/inline styles and no-grid sheets are never replaced.
    const tables = [
      ...document.querySelectorAll<HTMLTableElement>('.table-wrapper > table'),
    ].filter((table) => table.tHead?.querySelector('.col-header'));
    const panes = new Map<HTMLTableElement, { row?: Element; col?: Element }>();
    const headerPaperRules: string[] = [];
    for (const table of tables) {
      table.classList.add('kite-excel-grid');
      const paperId = String(headerPaperRules.length + 1);
      table.setAttribute('data-kite-header-paper', paperId);
      let stroke = 1;
      for (const cell of indexedCells.values()) {
        if (cell.element.closest('table') !== table) continue;
        const inline = (cell.element as HTMLElement).style;
        for (const side of ['top', 'bottom']) {
          const width = Number.parseFloat(inline.getPropertyValue(`border-${side}-width`));
          if (Number.isFinite(width) && width > 0 && width <= 8) stroke = Math.max(stroke, width);
        }
      }
      for (const header of table.querySelectorAll('tbody > tr > th.row-header'))
        header.classList.add('kite-excel-row-header');
      // Use the same inside-edge grid primitive as converter td, not a centered collapsed
      // stroke. Only row-number chrome changes; authored td styles and row heights stay intact.
      // Opaque displaced headers hide old flowing author strokes. The first header also
      // covers their upper half at the thead seam; interior headers have no border gaps.
      const grid = `.kite-excel-grid:not(.no-grid)[data-kite-header-paper="${paperId}"]`;
      const selector = `${grid}[data-kite-scrolled-x] .kite-excel-row-header`;
      headerPaperRules.push(
        `${grid}>tbody>tr>.kite-excel-row-header{border-top-width:0;border-bottom-width:0;box-shadow:inset 0 -1px 0 #e0e0e0}${selector}::before{content:"";position:absolute;inset:0 -1px;z-index:-1;background:inherit;box-shadow:inherit;pointer-events:none}${grid}[data-kite-scrolled-x]>tbody>tr:first-child>.kite-excel-row-header::before{top:-${(stroke + 1) / 2}px}`,
      );

      const frozenRows = table.querySelectorAll('tbody > tr[data-frozen]');
      const row = frozenRows[frozenRows.length - 1]?.querySelector('td');
      let col: Element | undefined;
      for (const cell of table.tBodies[0]?.rows[0]?.cells ?? [])
        if (cell.tagName === 'TD' && cell.style.position === 'sticky' && cell.style.left)
          col = cell;
      panes.set(table, { ...(row ? { row } : {}), ...(col ? { col } : {}) });
    }
    const css = document.createElement('style');
    css.textContent =
      headerPaperRules.join('\n') +
      `
body.kite-excel-preview .kite-excel-grid>thead>tr>th{border-left:0;border-right:0;box-shadow:inset -1px 0 0 #e0e0e0}
body.kite-excel-preview .kite-excel-grid:not(.no-grid)>tbody>tr:first-child>td{box-shadow:inset -1px -1px 0 #e0e0e0}
body.kite-excel-preview .kite-excel-grid:not(.no-grid)>tbody>tr:first-child>td:first-of-type{box-shadow:inset -1px -1px 0 #e0e0e0,inset 1px 0 0 #e0e0e0}
`;
    document.head.append(css);
    const overlay = document.createElement('div');
    overlay.className = 'kite-excel-range-layer';
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    paintRoot.append(overlay);
    let frame: number | undefined;
    let renderFrozen = () => {};
    resetExcel = () => {
      overlay.replaceChildren();
      overlay.style.display = 'none';
    };
    const render = () => {
      for (const table of tables)
        table.toggleAttribute('data-kite-scrolled-x', (table.parentElement?.scrollLeft ?? 0) > 0);
      renderFrozen();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      const active = activeExcelCell();
      if (!active || selected?.kind !== 'excel' || 'scope' in selected) {
        resetExcel();
        return;
      }
      const first = indexedCells.get(highlighted[0]!)!,
        last = indexedCells.get(highlighted.at(-1)!)!;
      overlay.replaceChildren();
      if (excelRequestVisible) button.style.display = 'none';
      const table = active.element.closest('table'),
        wrapper = table?.parentElement;
      if (!table || !wrapper?.classList.contains('table-wrapper')) {
        overlay.style.display = 'none';
        return;
      }
      if (excelRequestVisible) {
        button.style.left = '';
        button.style.top = '';
      }
      const area = wrapper.getBoundingClientRect(),
        head = table.tHead?.getBoundingClientRect();
      const rowHead = table.tBodies[0]?.rows[0]
        ?.querySelector('.row-header')
        ?.getBoundingClientRect();
      const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const paintClip = {
        left: Math.max(0, area.left),
        top: Math.max(0, area.top),
        right: Math.min(innerWidth, area.left + wrapper.clientWidth * scale),
        bottom: Math.min(innerHeight, area.top + wrapper.clientHeight * scale),
      };
      const clip = {
        left: Math.max(0, area.left, rowHead?.right ?? area.left),
        top: Math.max(0, area.top, head?.bottom ?? area.top),
        right: Math.min(innerWidth, area.left + wrapper.clientWidth * scale),
        bottom: Math.min(innerHeight, area.top + wrapper.clientHeight * scale),
      };
      if (clip.right <= clip.left || clip.bottom <= clip.top) {
        overlay.style.display = 'none';
        return;
      }
      overlay.style.cssText = `display:block;left:${paintClip.left / scale}px;top:${paintClip.top / scale}px;width:${(paintClip.right - paintClip.left) / scale}px;height:${(paintClip.bottom - paintClip.top) / scale}px`;
      const pane = panes.get(table);
      const frozenBottom = pane?.row?.getBoundingClientRect().bottom ?? clip.top;
      const frozenRight = pane?.col?.getBoundingClientRect().right ?? clip.left;
      const fragment = document.createDocumentFragment();
      const add = (
        className: string,
        left: number,
        top: number,
        right: number,
        bottom: number,
        edge?: string,
      ) => {
        if (right <= left || bottom <= top) return;
        const node = document.createElement('div');
        node.className = className;
        if (edge) node.setAttribute('data-edge', edge);
        node.style.cssText = `left:${(left - paintClip.left) / scale}px;top:${(top - paintClip.top) / scale}px;width:${(right - left) / scale}px;height:${(bottom - top) / scale}px`;
        fragment.append(node);
      };
      const widths = new Map<Element, number[]>();
      const borderWidths = (element: Element) => {
        let result = widths.get(element);
        if (!result) {
          const css = getComputedStyle(element);
          result = ['top', 'right', 'bottom', 'left'].map((side) => {
            const width = Number.parseFloat(css.getPropertyValue(`border-${side}-width`));
            return Number.isFinite(width) && width > 0 && width <= 32 ? width : 0;
          });
          widths.set(element, result);
        }
        return result;
      };
      const index = cellIndex.get(selectedSheet!);
      const extent = (cell: Cell, side: number) => {
        const delta = [
          [-1, 0],
          [0, 1],
          [1, 0],
          [0, -1],
        ][side]!;
        const neighbour = index?.get(`${cell.row + delta[0]!}:${cell.col + delta[1]!}`);
        const opposite =
          neighbour && cellInfo(neighbour.element)
            ? borderWidths(neighbour.element)[(side + 2) % 4]!
            : 0;
        return (Math.max(2, borderWidths(cell.element)[side]!, opposite) * scale) / 2;
      };
      let visibleBounds: { left: number; top: number; right: number; bottom: number } | undefined;
      for (const element of highlighted) {
        const cell = indexedCells.get(element)!,
          rect = element.getBoundingClientRect();
        const style = (element as HTMLElement).style;
        const top = Math.max(
          clip.top,
          rect.top,
          style.position === 'sticky' && style.top ? clip.top : frozenBottom,
        );
        const left = Math.max(
          clip.left,
          rect.left,
          style.position === 'sticky' && style.left ? clip.left : frozenRight,
        );
        const right = Math.min(clip.right, rect.right),
          bottom = Math.min(clip.bottom, rect.bottom);
        if (left >= right || top >= bottom) continue;
        visibleBounds = visibleBounds
          ? {
              left: Math.min(visibleBounds.left, left),
              top: Math.min(visibleBounds.top, top),
              right: Math.max(visibleBounds.right, right),
              bottom: Math.max(visibleBounds.bottom, bottom),
            }
          : { left, top, right, bottom };
        if (element !== active.element) add('kite-excel-range-fill', left, top, right, bottom);
        // One centered perimeter owns the full authored stroke at the selection edge.
        // Internal cell borders remain visible; cancellation simply removes this overlay.
        const outer = [
          cell.row === first.row ? extent(cell, 0) : 0,
          cell.col === last.col ? extent(cell, 1) : 0,
          cell.row === last.row ? extent(cell, 2) : 0,
          cell.col === first.col ? extent(cell, 3) : 0,
        ];
        const edgeLeft =
          (style.position === 'sticky' && style.left) ||
          (cell.col === 1 && wrapper.scrollLeft === 0)
            ? paintClip.left
            : Math.max(clip.left, frozenRight);
        const edgeTop =
          (style.position === 'sticky' && style.top) || (cell.row === 1 && wrapper.scrollTop === 0)
            ? paintClip.top
            : Math.max(clip.top, frozenBottom);
        const edge = (l: number, t: number, r: number, b: number, side: string) =>
          add(
            'kite-excel-range-edge',
            Math.max(edgeLeft, l),
            Math.max(edgeTop, t),
            Math.min(paintClip.right, r),
            Math.min(paintClip.bottom, b),
            side,
          );
        const l = rect.left - outer[3]!,
          r = rect.right + outer[1]!,
          t = rect.top - outer[0]!,
          b = rect.bottom + outer[2]!;
        if (outer[0]) edge(l, t, r, rect.top + outer[0], 'top');
        if (outer[2]) edge(l, rect.bottom - outer[2], r, b, 'bottom');
        if (outer[3]) edge(l, t, rect.left + outer[3], b, 'left');
        if (outer[1]) edge(rect.right - outer[1], t, r, b, 'right');
      }
      overlay.append(fragment);
      if (excelRequestVisible && visibleBounds)
        show(
          new DOMRect(
            visibleBounds.left,
            visibleBounds.top,
            visibleBounds.right - visibleBounds.left,
            visibleBounds.bottom - visibleBounds.top,
          ),
          clip,
        );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(render);
    };
    renderFrozen = installFrozenCellPaint(tables, panes, schedule);
    refreshExcel = render;
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    resetExcel();
  }

  /** Trusted navigation remains at interface scale; narrow previews use an overlay, not a smaller document. */
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
            // the converter's global pagination/resource watcher.
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
        if (!event.isTrusted) return;
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
    // The converter's narrow-screen sidebar disappears below 900px and eagerly clones
    // every page. Replace that presentation-only DOM with a bounded, lazy native rail.
    const rail = document.createElement('nav');
    rail.className = 'kite-office-chrome kite-thumbnail-rail';
    rail.setAttribute('aria-label', '幻灯片缩略图');
    rail.style.cssText =
      '--kite-thumb-scale:1;--kite-rail-width:104px;width:var(--kite-rail-width);min-width:var(--kite-rail-width);flex:0 0 var(--kite-rail-width);height:100vh;overflow-y:auto;overflow-x:hidden;padding:8px 4px;background:var(--office-background);box-sizing:border-box';
    main.style.minWidth = '0';
    main.before(rail);
    installPageRail(rail);
    // OfficeCLI maintains its own stale counter state after host navigation. Only
    // hide that known top-level badge; the trusted toolbar/rail own page status.
    document.querySelectorAll('body > .page-counter').forEach((el) => {
      el.setAttribute('aria-hidden', 'true');
    });
    const railStyle = document.createElement('style');
    railStyle.textContent =
      'body>.page-counter{display:none!important}.kite-thumbnail-button{display:block;position:relative;width:100%;height:calc(54px * var(--kite-thumb-scale) + 28px);margin:0;padding:4px 2px 18px;border:2px solid transparent;border-radius:8px;background:transparent;color:var(--office-muted);cursor:pointer;box-sizing:border-box}.kite-thumbnail-button:hover{background:var(--office-hover)}.kite-thumbnail-button:active{background:var(--office-pressed)}.kite-thumbnail-button[aria-current="true"]{border-color:var(--office-foreground);background:var(--office-selected);color:var(--office-foreground)}.kite-thumbnail-visual{position:relative;transform:scale(var(--kite-thumb-scale));transform-origin:left top;width:88px;height:54px;overflow:hidden;background:#eee;pointer-events:none}.kite-thumbnail-visual *{pointer-events:none!important}.kite-thumbnail-number{position:absolute;bottom:0;left:0;right:0;font:11px var(--office-font);text-align:center}body.kite-present .kite-thumbnail-rail{display:none!important}@media(max-width:480px){.kite-thumbnail-rail{--kite-rail-width:80px!important;--kite-thumb-scale:0.75!important}}@media(max-width:360px){.kite-thumbnail-rail{--kite-rail-width:64px!important;--kite-thumb-scale:0.55!important}}';
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
        if (!event.isTrusted) return;
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
export const officeInteractionInstallScript = (kind: 'word' | 'excel' | 'powerpoint') =>
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
