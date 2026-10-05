import { ClientError } from '@kite-ai/client';
import { type BrowserClient, createBrowserClient } from '@kite-ai/client/browser';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { WebPage } from './page';

/** The document supplies only its same-origin page identity, never a Native credential. */
export async function mountWebPage(input: {
  readonly window: Window;
  readonly element: HTMLElement;
  readonly client?: BrowserClient;
  readonly pollIntervalMs?: number;
}) {
  const browser = input.window;
  const root = createRoot(input.element);
  let disposed = false,
    suspended = false,
    admitted = false,
    generation = 0;
  let connection = new AbortController();
  let resumeGeneration: number | undefined;
  let client: BrowserClient | undefined;
  let resumeError: string | undefined;
  root.render(<p role="status">Connecting to read-only browser session</p>);
  function renderPage() {
    if (disposed || !admitted || !client) return;
    root.render(
      <>
        {suspended && (
          <p role={resumeError ? 'alert' : 'status'}>
            {resumeError
              ? `Read-only identity unavailable · ${resumeError}. Reload this document to select its current identity.`
              : 'Read-only observation paused; original page identity must be verified before resuming.'}
          </p>
        )}
        <WebPage
          client={client}
          window={browser}
          pollIntervalMs={input.pollIntervalMs}
          suspended={suspended}
        />
      </>,
    );
  }
  const pagehide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      suspended = true;
      generation++;
      connection.abort();
      resumeError = undefined;
      // Commit owned observer suspension before the browser freezes the retained document.
      flushSync(renderPage);
      return;
    }
    dispose();
    void client?.closeBrowserSession().catch(() => {});
  };
  const pageshow = (event: PageTransitionEvent) => {
    if (!event.persisted || disposed || !suspended || !client || resumeGeneration === generation)
      return;
    connection = new AbortController();
    const current = ++generation;
    const signal = connection.signal;
    resumeGeneration = current;
    void (async () => {
      try {
        // BrowserClient retains its original page/Store/instance/build identity. connect cannot
        // adopt a replacement backend and no business reads resume before this check succeeds.
        await client!.connect({ signal });
        if (disposed || signal.aborted || generation !== current) return;
        admitted = true;
        suspended = false;
        resumeError = undefined;
        renderPage();
      } catch (error) {
        if (disposed || signal.aborted || generation !== current) return;
        resumeError = error instanceof ClientError ? error.code : 'browser_read_unavailable';
        renderPage();
      } finally {
        if (resumeGeneration === current) resumeGeneration = undefined;
      }
    })();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    connection.abort();
    root.unmount();
    browser.removeEventListener('pagehide', pagehide);
    browser.removeEventListener('pageshow', pageshow);
  }
  browser.addEventListener('pagehide', pagehide);
  browser.addEventListener('pageshow', pageshow);
  try {
    client =
      input.client ??
      createBrowserClient({
        origin: browser.location.origin,
        pageIdentity:
          browser.document
            .querySelector('meta[name="kite-web-identity"]')
            ?.getAttribute('content') ?? '',
      });
    const current = generation;
    await client.connect({ signal: connection.signal });
    if (!disposed && current === generation) {
      admitted = true;
      renderPage();
    }
  } catch (error) {
    if (!disposed && !suspended)
      root.render(
        <p role="alert">
          Read-only connection unavailable ·{' '}
          {error instanceof ClientError ? error.code : 'browser_read_unavailable'}. Reload this
          document to select its current identity.
        </p>,
      );
  }
  return { dispose };
}
