import type { SessionBrowserPageProps } from '@kite-ai/ui/desktop';
import {
  isNativeBrowserDraftRestoreResult,
  isNativeBrowserRestoreResult,
  type NativeBrowserRestoreScope,
} from './native-browser-bridge';
import {
  nativeBrowserDisplayHint,
  rememberNativeBrowserState,
  saveNativeBrowserDisplayHints,
} from './native-browser-display-state';
import { NativeBrowserPane } from './native-browser-pane';

export function renderNativeBrowser(props: SessionBrowserPageProps) {
  return <NativeBrowserPane {...props} />;
}

export { nativeBrowserDisplayHint } from './native-browser-display-state';

export async function closeNativeBrowserTab(
  id: string,
  draft?: string,
  scope?: NativeBrowserRestoreScope,
) {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  if (!host?.browserRequest) throw Error('browser_close_unavailable');
  // This function is called in the X click stack, before the tab model changes.
  const pageToken = nativeBrowserDisplayHint(id, scope, draft)?.pageToken;
  const message = '未能确认网页已关闭，原页面已保留，请核对页面状态。';
  if (!pageToken) {
    try {
      const current = await host.browserRequest({
        action: 'state',
        id,
        ...(draft ? { draft } : {}),
      });
      if (current === null) return;
    } catch {}
    throw Error(message);
  }
  try {
    await host.browserRequest({ action: 'close', id, pageToken, ...(draft ? { draft } : {}) });
  } catch {
    try {
      const current = await host.browserRequest({
        action: 'state',
        id,
        ...(draft ? { draft } : {}),
      });
      if (current === null) return;
      // A same-ID successor does not confirm or stand in for the captured page.
      if (current?.pageToken === pageToken) rememberNativeBrowserState(current, scope, draft);
    } catch {}
    throw Error(message);
  }
}
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
  saveNativeBrowserDisplayHints(pages, scope);
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
  saveNativeBrowserDisplayHints(result.pages, undefined, draft);
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
