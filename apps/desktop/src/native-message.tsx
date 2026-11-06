import { Button } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './native-message.css';

export function humanReadableOperationError(code: string | undefined, operation?: string): string {
  switch (code) {
    case 'workspace_not_found':
      return '未找到所选项目，请重新选择。';
    case 'draft_storage_unavailable':
      return '本地数据暂时无法读取或保存，请先查看当前状态。';
    case 'service_unavailable':
      return '服务处理此操作时遇到问题，请先查看当前状态。';
    default:
      return `${operation ?? '此操作'}遇到问题，请先查看当前状态。`;
  }
}

export type NativeToastProps = {
  message?: { id: number; text: string };
  onDismiss: (id: number) => void;
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

  useEffect(() => {
    if (paused) return;
    let active = true;
    const deadline = Date.now() + remaining.current;
    const timer = setTimeout(() => {
      if (active) dismiss.current(message.id);
    }, remaining.current);
    return () => {
      active = false;
      clearTimeout(timer);
      remaining.current = Math.max(0, deadline - Date.now());
    };
  }, [message.id, paused]);

  return createPortal(
    <div className="native-toast">
      <div
        className="native-toast-card"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <p>{message.text}</p>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="native-toast-close"
          aria-label="关闭提示"
          onClick={() => dismiss.current(message.id)}
        >
          <span aria-hidden="true">×</span>
        </Button>
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
      onDismiss={(id) => {
        if (current.current.id === id) current.current.onDismiss(id);
      }}
    />
  );
}
