import {
  BrowserAnnotationIcon,
  BrowserOptionsIcon,
  Button,
  SessionBrowserToolbar,
} from '@kite-ai/ui/desktop';
import type { ReactNode } from 'react';
import type {
  NativeBrowserControlProps,
  NativeBrowserMenuRect,
  NativeBrowserToolbarProps,
} from './native-browser-toolbar-types';

function menuAnchor(element: HTMLElement): NativeBrowserMenuRect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

/** Presentation only: no bridge, observer, browser state or permission owner. */
export function NativeBrowserToolbar({
  data,
  dispatch,
  tools,
  annotationTools,
}: NativeBrowserToolbarProps & {
  tools?: ReactNode;
  annotationTools?: ReactNode;
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
      onAddressChange={(value) => dispatch({ type: 'address-change', value })}
      onAddressFocus={(focused) => dispatch({ type: 'address-focus', focused })}
      onNavigate={() => dispatch({ type: 'navigate' })}
      onBack={() => dispatch({ type: 'back' })}
      onForward={() => dispatch({ type: 'forward' })}
      onReload={() => dispatch({ type: 'reload' })}
    />
  );
}

export function NativeBrowserControl({ data, dispatch }: NativeBrowserControlProps) {
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
