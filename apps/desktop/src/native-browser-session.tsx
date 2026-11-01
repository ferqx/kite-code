import type { SessionBrowserPageProps, SessionPageProps } from '@kite-ai/ui/desktop';
import {
  isNativeBrowserDraftRestoreResult,
  isNativeBrowserRestoreResult,
  type NativeBrowserClosePreparation,
  type NativeBrowserRestoreScope,
  type NativeBrowserState,
  nativeBrowserWitnessColors,
  nativeBrowserWitnessPosition,
  nativeBrowserWitnessTileSize,
  nativeBrowserWitnessWidth,
} from './native-browser-bridge';
import { nativeBrowserChromeOwnerKey } from './native-browser-chrome-bridge';
import { NativeBrowserPane } from './native-browser-pane';

export function renderNativeBrowser(props: SessionBrowserPageProps) {
  return <NativeBrowserPane {...props} />;
}
const stores = new WeakMap<
  Window,
  {
    hints: Map<string, readonly NativeBrowserState[]>;
    preparing: Map<string, object>;
    closes: Map<
      string,
      {
        receipt: NativeBrowserClosePreparation;
        draft?: string;
        document: Document;
        canvas?: HTMLCanvasElement;
        cancelled: boolean;
      }
    >;
  }
>();
function displayStore() {
  let store = stores.get(window);
  if (!store) {
    store = { hints: new Map(), preparing: new Map(), closes: new Map() };
    stores.set(window, store);
  }
  return store;
}
function saveHints(key: string, pages: readonly NativeBrowserState[]) {
  const hints = displayStore().hints;
  hints.delete(key);
  hints.set(key, pages);
  while (hints.size > 16) hints.delete(hints.keys().next().value!);
}
export function nativeBrowserDisplayHint(
  id: string,
  scope?: NativeBrowserRestoreScope,
  draft?: string,
) {
  return displayStore()
    .hints.get(nativeBrowserChromeOwnerKey(draft ? { draft } : scope))
    ?.find((page) => page.id === id);
}
export function cancelNativeBrowserCloses() {
  const store = displayStore();
  store.preparing.clear();
  for (const entry of store.closes.values()) {
    entry.cancelled = true;
    entry.canvas?.remove();
    void window.kiteNative?.cancelBrowserClose?.(entry.receipt.key).catch(() => {});
  }
  store.closes.clear();
}
export async function prepareNativeBrowserClose(id: string, draft?: string) {
  const host = window.kiteNative;
  if (
    !host?.prepareBrowserClose ||
    !host.confirmBrowserClose ||
    !host.finishBrowserClose ||
    !host.cancelBrowserClose
  )
    return null;
  const store = displayStore(),
    reservation = {};
  store.preparing.set(id, reservation);
  const receipt = await host.prepareBrowserClose({ id, ...(draft ? { draft } : {}) });
  if (store.preparing.get(id) !== reservation) {
    if (receipt) void host.cancelBrowserClose(receipt.key).catch(() => {});
    return null;
  }
  store.preparing.delete(id);
  if (!receipt) return null;
  const entry = {
    receipt,
    draft,
    document,
    cancelled: false,
    canvas: undefined as HTMLCanvasElement | undefined,
  };
  store.closes.set(id, entry);
  return {
    cancel() {
      entry.cancelled = true;
      entry.canvas?.remove();
      if (store.closes.get(id) === entry) store.closes.delete(id);
      void host.cancelBrowserClose!(receipt.key).catch(() => {});
    },
  };
}
export async function closeNativeBrowserTab(id: string, draft?: string) {
  if (typeof window === 'undefined') return;
  const host = window.kiteNative,
    store = displayStore(),
    entry = store.closes.get(id);
  try {
    if (entry && entry.draft === draft) {
      if (entry.cancelled || entry.document !== document) throw Error('browser_close_cancelled');
      const canvas = document.createElement('canvas'),
        scale = window.devicePixelRatio || 1,
        position = nativeBrowserWitnessPosition(entry.receipt.bounds, scale),
        colors = nativeBrowserWitnessColors({ key: entry.receipt.witness, step: 1 });
      entry.canvas = canvas;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.dataset.nativeBrowserCloseWitness = '';
      canvas.width = colors.length * 3;
      canvas.height = 3;
      Object.assign(canvas.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483646',
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${nativeBrowserWitnessWidth(scale)}px`,
        height: `${nativeBrowserWitnessTileSize(scale)}px`,
      });
      const context = canvas.getContext('2d');
      if (!context) throw Error('browser_presentation_unavailable');
      colors.forEach((color, index) => {
        context.fillStyle = `rgb(${color.join(',')})`;
        context.fillRect(index * 3, 0, 3, 3);
      });
      document.body.append(canvas);
      await host!.confirmBrowserClose!(entry.receipt.key);
      canvas.remove();
      entry.canvas = undefined;
      if (entry.cancelled || entry.document !== document) throw Error('browser_close_cancelled');
      await host!.finishBrowserClose!(entry.receipt.key);
    } else {
      if (!host?.browserRequest) throw Error('browser_close_unavailable');
      await host.browserRequest({ action: 'close', id, ...(draft ? { draft } : {}) });
    }
  } catch {
    entry?.canvas?.remove();
    if (entry) void host?.cancelBrowserClose?.(entry.receipt.key).catch(() => {});
    try {
      const current = await host?.browserRequest?.({
        action: 'state',
        id,
        ...(draft ? { draft } : {}),
      });
      if (current === null) return;
      if (current)
        for (const [key, pages] of [...store.hints])
          if (pages.some((page) => page.id === id))
            saveHints(
              key,
              pages.map((page) => (page.id === id ? current : page)),
            );
    } catch {}
    const message = '未能确认网页已关闭，原页面已保留，请核对页面状态。';
    throw Error(message);
  } finally {
    entry?.canvas?.remove();
    if (store.closes.get(id) === entry) store.closes.delete(id);
  }
}
export const prepareNativeBrowserPresentation: NonNullable<
  SessionPageProps['prepareBrowser']
> = async (fromId, targetId) => {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  if (!host?.prepareBrowserPresentation || !host.cancelBrowserPreparation) return null;
  const receipt = await host.prepareBrowserPresentation({ fromId, targetId });
  if (!receipt) return null;
  let cancelled = false;
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      void host.cancelBrowserPreparation!(receipt.key).catch(() => {});
    },
  };
};
export async function restoreNativeBrowserTab(scope: NativeBrowserRestoreScope) {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  if (!host?.restoreBrowser) return null;
  const result = await host.restoreBrowser(scope);
  if (
    !isNativeBrowserRestoreResult(result) ||
    Object.keys(scope).some(
      (key) =>
        result.scope[key as keyof NativeBrowserRestoreScope] !==
        scope[key as keyof NativeBrowserRestoreScope],
    )
  )
    throw Error('browser_restore_scope_changed');
  const page = result.page;
  const pages = result.pages ?? (page ? [page] : []);
  if (pages.some((page) => page.control && page.control.sessionId !== scope.sessionId))
    throw Error('browser_restore_scope_changed');
  saveHints(nativeBrowserChromeOwnerKey(scope), pages);
  return page
    ? {
        id: page.id,
        title: page.title,
        ...(result.pages ? { pages: pages.map(({ id, title }) => ({ id, title })) } : {}),
        ...(result.activeId ? { activeId: result.activeId } : {}),
        ...(result.reveal ? { reveal: true as const } : {}),
      }
    : null;
}

export async function restoreNativeBrowserDraft(draft: string) {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  if (!host?.restoreBrowserDraft) return null;
  const result = await host.restoreBrowserDraft(draft);
  if (!isNativeBrowserDraftRestoreResult(result)) throw Error('browser_restore_scope_changed');
  saveHints(nativeBrowserChromeOwnerKey({ draft }), result.pages);
  const pages = result.pages.map(({ id, title }) => ({ id, title }));
  const active = pages.find((page) => page.id === result.activeId) ?? pages[0];
  return active
    ? {
        ...active,
        pages,
        ...(result.activeId ? { activeId: result.activeId, reveal: true as const } : {}),
      }
    : null;
}
