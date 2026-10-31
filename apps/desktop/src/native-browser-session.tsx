import type { SessionBrowserPageProps } from '@kite-ai/ui/desktop';
import {
  isNativeBrowserRestoreResult,
  type NativeBrowserRestoreScope,
} from './native-browser-bridge';
import { NativeBrowserPane } from './native-browser-pane';

export function renderNativeBrowser(props: SessionBrowserPageProps) {
  return <NativeBrowserPane {...props} />;
}
export function closeNativeBrowserTab(id: string) {
  if (typeof window !== 'undefined')
    void window.kiteNative?.browserRequest?.({ action: 'close', id }).catch(() => {});
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
