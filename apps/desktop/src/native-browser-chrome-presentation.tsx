import {
  BrowserAnnotationIcon,
  BrowserOptionsIcon,
  Button,
  SessionBrowserToolbar,
} from '@kite-ai/ui/desktop';
import type { ReactNode } from 'react';
import type {
  NativeBrowserChromeRect,
  NativeBrowserControlPort,
  NativeBrowserToolbarPort,
} from './native-browser-chrome-types';

function menuAnchor(element: HTMLElement): NativeBrowserChromeRect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

/** Presentation only: no bridge, observer, browser state or permission owner. */
export function NativeBrowserChromeToolbar({
  data,
  dispatch,
  tools,
  annotationTools,
  interactionPending,
  addressReadOnly,
}: NativeBrowserToolbarPort & {
  tools?: ReactNode;
  annotationTools?: ReactNode;
  interactionPending?: boolean;
  addressReadOnly?: boolean;
}) {
  return (
    <SessionBrowserToolbar
      tools={
        <>
          {tools}
          {data.notesAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={data.notesOpen ? '返回网页' : '指向注释'}
              title={data.notesOpen ? '返回网页' : '指向注释'}
              aria-pressed={data.notesOpen}
              onClick={() => dispatch({ type: 'toggle-notes' })}
            >
              <BrowserAnnotationIcon returnToPage={data.notesOpen} />
            </Button>
          )}
          {annotationTools}
          {data.optionsAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={data.error || data.optionsIssue ? '页面状态与选项' : '页面选项'}
              title={data.optionsIssue || data.error || '页面选项'}
              data-status={data.error || data.optionsIssue ? 'error' : undefined}
              onClick={(event) =>
                dispatch({ type: 'show-options', anchor: menuAnchor(event.currentTarget) })
              }
            >
              <BrowserOptionsIcon />
            </Button>
          )}
        </>
      }
      address={data.address}
      loading={data.loading}
      hasPage={data.hasPage}
      canGoBack={data.canGoBack}
      canGoForward={data.canGoForward}
      canNavigate={data.canNavigate}
      interactionPending={interactionPending}
      addressReadOnly={addressReadOnly}
      onAddressChange={(value) => dispatch({ type: 'address-change', value })}
      onAddressFocus={(focused) => dispatch({ type: 'address-focus', focused })}
      onNavigate={() => dispatch({ type: 'navigate' })}
      onBack={() => dispatch({ type: 'back' })}
      onForward={() => dispatch({ type: 'forward' })}
      onReload={() => dispatch({ type: 'reload' })}
    />
  );
}

export function NativeBrowserChromeControl({ data, dispatch }: NativeBrowserControlPort) {
  return (
    <Button
      type="button"
      className="native-browser-control-trigger"
      size="sm"
      variant="ghost"
      aria-label="浏览器控制"
      title={data.issue ? `${data.detail}。${data.issue}` : data.detail}
      data-status={data.issue ? 'error' : undefined}
      onClick={(event) => dispatch({ type: 'show-menu', anchor: menuAnchor(event.currentTarget) })}
    >
      {data.label}
    </Button>
  );
}
