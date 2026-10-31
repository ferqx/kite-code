import {
  isNativeBrowserDisplayIntent,
  type NativeBrowserBridge,
  type NativeBrowserDisplayIntent,
} from '../src/native-browser-bridge';

/** Runs in the preload before the app tree can paint; it never changes layout dimensions. */
export function createBrowserDisplayBootstrap(options: {
  document: Document;
  insertCSS(css: string): string;
  removeCSS(key: string): void;
  request(input: unknown): unknown;
  subscribe(receive: (value: unknown) => void): () => void;
}): Pick<
  NativeBrowserBridge,
  'browserDisplayIntent' | 'claimBrowserDisplay' | 'cancelBrowserDisplay'
> {
  let intent: NativeBrowserDisplayIntent | null = null;
  let css: string | undefined;
  let loading: HTMLElement | undefined;
  let acquired = false;
  let stagedRoot: { node: HTMLElement; ariaHidden: string | null } | undefined;
  let rootObserver: MutationObserver | undefined;
  const stageRoot = () => {
    if (!intent || stagedRoot) return;
    const node = options.document.getElementById('root');
    if (!node) return;
    stagedRoot = { node, ariaHidden: node.getAttribute('aria-hidden') };
    node.setAttribute('aria-hidden', 'true');
    rootObserver?.disconnect();
  };
  const reveal = () => {
    if (css !== undefined) {
      options.removeCSS(css);
      const node = stagedRoot?.node ?? options.document.getElementById('root');
      if (node?.isConnected && options.document.defaultView) {
        const style = options.document.defaultView.getComputedStyle(node);
        if (style.opacity === '0' || style.pointerEvents === 'none')
          throw Error('browser_display_reveal_failed');
      }
    }
    css = undefined;
    loading?.remove();
    rootObserver?.disconnect();
    if (stagedRoot) {
      if (stagedRoot.ariaHidden === null) stagedRoot.node.removeAttribute('aria-hidden');
      else stagedRoot.node.setAttribute('aria-hidden', stagedRoot.ariaHidden);
      stagedRoot = undefined;
    }
    intent = null;
  };
  const cancel = () => {
    if (!intent) return;
    // A lost/failed cancellation may not expose an unreserved full-width tree.
    if (options.request({ action: 'cancel', token: intent.token }) !== true)
      throw Error('browser_display_cancel_unconfirmed');
    reveal();
  };
  const unwatch = options.subscribe((value) => {
    if (
      intent &&
      value &&
      typeof value === 'object' &&
      'token' in value &&
      value.token === intent.token
    )
      reveal();
  });
  const showLoading = () => {
    if (!intent || !options.document.body || loading) return;
    loading = options.document.createElement('section');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    loading.textContent = '界面正在重新载入，网页已保留。';
    Object.assign(loading.style, {
      position: 'fixed',
      inset: '0 auto 0 0',
      width: `${intent.bounds.x}px`,
      display: 'grid',
      placeContent: 'center',
      boxSizing: 'border-box',
      padding: '24px',
      pointerEvents: 'none',
      color: 'CanvasText',
    });
    options.document.body.append(loading);
  };
  try {
    const value = options.request({ action: 'get' });
    if (value !== null && value !== undefined) {
      if (!isNativeBrowserDisplayIntent(value)) throw Error('invalid_browser_display_intent');
      intent = value;
      acquired = true;
      css = options.insertCSS(
        '#root { opacity: 0 !important; } #root, #root * { pointer-events: none !important; }',
      );
      stageRoot();
      if (!stagedRoot && options.document.defaultView) {
        rootObserver = new options.document.defaultView.MutationObserver(stageRoot);
        rootObserver.observe(options.document, { childList: true, subtree: true });
      }
      if (!css || options.request({ action: 'ready', token: intent.token }) !== true)
        throw Error('browser_display_bootstrap_unconfirmed');
      showLoading();
      options.document.addEventListener('DOMContentLoaded', showLoading, { once: true });
    }
  } catch (cause) {
    if (intent) cancel();
    if (!acquired) throw cause;
  }
  options.document.defaultView?.addEventListener('unload', unwatch, { once: true });
  return {
    browserDisplayIntent: () => {
      stageRoot();
      return intent && structuredClone(intent);
    },
    claimBrowserDisplay(request) {
      if (!intent) return false;
      if (options.request({ action: 'claim', token: intent.token, request }) !== true) {
        cancel();
        return false;
      }
      // Main checked the actual same slot. Reveal this committed tree before its witnesses.
      try {
        reveal();
      } catch (cause) {
        // Do not leave an unproved visible Native behind a mask that failed to
        // clear, or publish a false "not pending" state. Keep the original error.
        if (intent && options.request({ action: 'cancel', token: intent.token }) !== true)
          throw Error('browser_display_cancel_unconfirmed');
        throw cause;
      }
      return true;
    },
    cancelBrowserDisplay: cancel,
  };
}
