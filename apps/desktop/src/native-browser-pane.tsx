import { Button, type SessionBrowserPageProps, SessionBrowserToolbar } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NativeBrowserBounds,
  NativeBrowserRequest,
  NativeBrowserState,
} from './native-browser-bridge';

const errors = {
  load_failed: '网页未能打开，请检查地址或网络后重试。',
  unsupported_navigation: '暂不支持打开这种地址，请使用 HTTP 或 HTTPS 网址。',
  download_unsupported: '简易浏览器暂不支持下载文件。',
  process_gone: '浏览页面已停止，请刷新后重试。',
};
function requestError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : '';
  if (code === 'unsupported_browser_protocol') return errors.unsupported_navigation;
  if (code === 'invalid_browser_address') return '请输入有效的网址或搜索内容。';
  if (code === 'browser_tab_limit') return '最多打开8个浏览标签页，请先关闭一些标签。';
  return '浏览器暂不可用，请完全退出并重新启动应用后重试。';
}

export function NativeBrowserPane({ id, visible, tools, onTitleChange }: SessionBrowserPageProps) {
  const host = typeof window === 'undefined' ? undefined : window.kiteNative;
  const [state, setState] = useState<NativeBrowserState>({
    id,
    url: '',
    title: '新标签页',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const [address, setAddress] = useState('');
  const [issue, setIssue] = useState<string>();
  const mounted = useRef(false);
  const focused = useRef(false);
  const title = useRef(onTitleChange);
  title.current = onTitleChange;
  const viewport = useRef<HTMLElement>(null);
  const apply = useCallback(
    (next: NativeBrowserState | null) => {
      if (mounted.current && next?.id === id) setState(next);
    },
    [id],
  );
  useEffect(() => {
    mounted.current = true;
    const unwatch = host?.watchBrowser?.(apply);
    void host
      ?.browserRequest?.({ action: 'state', id })
      .then(apply)
      .catch(() => {});
    return () => {
      mounted.current = false;
      unwatch?.();
      void host?.browserRequest?.({ action: 'present', id, bounds: null }).catch(() => {});
    };
  }, [id, host, apply]);
  useEffect(() => {
    title.current(state.title || '新标签页');
  }, [state.title]);
  useEffect(() => {
    if (!focused.current) setAddress(state.url);
  }, [state.url]);
  const request = async (input: NativeBrowserRequest) => {
    setIssue(undefined);
    if (!host?.browserRequest) {
      setIssue(requestError(null));
      return;
    }
    try {
      const next = await host.browserRequest(input);
      apply(next);
      if (mounted.current && input.action === 'navigate' && next) setAddress(next.url);
    } catch (cause) {
      if (mounted.current) setIssue(requestError(cause));
    }
  };
  const external = !!state.url;
  const blocked = !!state.error || !!issue;
  useEffect(() => {
    if (!host?.browserRequest) return;
    let frame: number | undefined;
    let last = '';
    const publish = () => {
      frame = undefined;
      const node = viewport.current;
      let bounds: NativeBrowserBounds | null = null;
      if (
        visible &&
        external &&
        !blocked &&
        node &&
        !document.hidden &&
        !node.closest('[inert], [hidden]')
      ) {
        const rect = node.getBoundingClientRect();
        const panel = node.closest('[data-panel]')?.getBoundingClientRect() ?? rect;
        const covered = [
          ...document.querySelectorAll(
            '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [role="menu"], [data-slot="popover-content"], [data-slot="sheet-overlay"]',
          ),
        ].some((overlay) => {
          const box = overlay.getBoundingClientRect();
          const style = getComputedStyle(overlay);
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            box.width > 0 &&
            box.height > 0 &&
            box.left < rect.right &&
            box.right > rect.left &&
            box.top < rect.bottom &&
            box.bottom > rect.top
          );
        });
        if (!covered && rect.width > 0 && rect.height > 0) {
          const x = Math.max(0, rect.left, panel.left),
            y = Math.max(0, rect.top, panel.top);
          const width = Math.max(0, Math.min(window.innerWidth, rect.right, panel.right) - x);
          const height = Math.max(0, Math.min(window.innerHeight, rect.bottom, panel.bottom) - y);
          if (width > 0 && height > 0)
            bounds = {
              x,
              y,
              width,
              height,
              radius: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0,
            };
        }
      }
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      void host.browserRequest!({ action: 'present', id, bounds }).catch(() => {});
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(publish);
    };
    const force = () => {
      last = '';
      schedule();
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    if (viewport.current) {
      resize?.observe(viewport.current);
      const panel = viewport.current.closest('[data-panel]');
      if (panel) resize?.observe(panel);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-state', 'aria-hidden', 'hidden', 'inert'],
    });
    window.addEventListener('resize', force);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', force);
    publish();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', force);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', force);
      void host.browserRequest!({ action: 'present', id, bounds: null }).catch(() => {});
    };
  }, [id, host, visible, external, blocked]);
  const error = issue || (state.error && errors[state.error]);
  return (
    <section className="native-browser-page" aria-label="浏览器">
      <SessionBrowserToolbar
        address={address}
        loading={state.loading}
        hasPage={!!state.url}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onAddressChange={setAddress}
        onAddressFocus={(value) => {
          focused.current = value;
        }}
        onNavigate={() => void request({ action: 'navigate', id, input: address })}
        onBack={() => void request({ action: 'back', id })}
        onForward={() => void request({ action: 'forward', id })}
        onReload={() => void request({ action: state.loading ? 'stop' : 'reload', id })}
      />
      {!state.url && !error ? (
        <div className="session-browser-start">{tools}</div>
      ) : (
        <div className="native-browser-surface">
          {error ? (
            <div className="native-browser-error" role="alert">
              <p className="native-browser-error-message">{error}</p>
              {state.url && (
                <Button onClick={() => void request({ action: 'reload', id })}>重试</Button>
              )}
            </div>
          ) : (
            <section className="native-browser-viewport" ref={viewport} aria-label="网页内容" />
          )}
        </div>
      )}
    </section>
  );
}

export function renderNativeBrowser(props: SessionBrowserPageProps) {
  return <NativeBrowserPane {...props} />;
}
export function closeNativeBrowserTab(id: string) {
  if (typeof window !== 'undefined')
    void window.kiteNative?.browserRequest?.({ action: 'close', id }).catch(() => {});
}
