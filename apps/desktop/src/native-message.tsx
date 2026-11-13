import { Button } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './native-message.css';

export function humanReadableOperationError(code: string | undefined, operation?: string): string {
  switch (code) {
    case 'workspace_not_found':
      return '未找到所选项目，请重新选择。';
    case 'draft_storage_unavailable':
    case 'workspace_storage_unavailable':
      return '本地数据暂时无法读取或保存，请先查看当前状态。';
    case 'service_unavailable':
      return '服务处理此操作时遇到问题，请先查看当前状态。';
    default:
      return `${operation ?? '此操作'}遇到问题，请先查看当前状态。`;
  }
}

export type NativeToastProps = {
  message?: {
    id: number;
    text: string;
    role?: 'alert' | 'status';
    actions?: readonly { label: string; onClick: () => void; disabled?: boolean }[];
  };
  onDismiss?: (id: number) => void;
  container?: HTMLElement;
};

function MessageOccurrence({
  message,
  onDismiss,
  container,
}: {
  message: NonNullable<NativeToastProps['message']>;
  onDismiss: NativeToastProps['onDismiss'];
  container: HTMLElement;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(6000);
  const dismiss = useRef(onDismiss);
  const previousContainer = useRef(container);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useLayoutEffect(() => {
    if (previousContainer.current === container) return;
    previousContainer.current = container;
    setHovered(false);
    setFocused(false);
  }, [container]);
  const paused = hovered || focused;
  const dismissible = onDismiss !== undefined;

  useEffect(() => {
    if (paused || !dismissible) return;
    let active = true;
    const deadline = Date.now() + remaining.current;
    const timer = setTimeout(() => {
      if (active) dismiss.current?.(message.id);
    }, remaining.current);
    return () => {
      active = false;
      clearTimeout(timer);
      remaining.current = Math.max(0, deadline - Date.now());
    };
  }, [message.id, paused, dismissible]);

  return createPortal(
    <div className="native-toast">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Hover and focus only pause dismissal. Buttons handle all actions. */}
      <div
        className="native-toast-card"
        role={message.role ?? 'status'}
        aria-live={message.role === 'alert' ? 'assertive' : 'polite'}
        aria-atomic="true"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <p>{message.text}</p>
        {!!message.actions?.length && (
          <div className="native-toast-actions">
            {message.actions.map((action, index) => (
              <Button
                key={`${action.label}/${index}`}
                variant="outline"
                size="sm"
                type="button"
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
        {dismissible && (
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            className="native-toast-close"
            aria-label="关闭提示"
            onClick={() => dismiss.current?.(message.id)}
          >
            <span aria-hidden="true">×</span>
          </Button>
        )}
      </div>
    </div>,
    container,
  );
}

/** A viewport toast outside conversation layout; each occurrence owns its dismissal. */
export function NativeToast({ message, onDismiss, container = document.body }: NativeToastProps) {
  const current = useRef({ id: message?.id, onDismiss });
  useLayoutEffect(() => {
    current.current = { id: message?.id, onDismiss };
  }, [message?.id, onDismiss]);
  if (!message) return null;
  return (
    <MessageOccurrence
      key={message.id}
      message={message}
      container={container}
      onDismiss={
        onDismiss &&
        ((id) => {
          if (current.current.id === id) current.current.onDismiss?.(id);
        })
      }
    />
  );
}
