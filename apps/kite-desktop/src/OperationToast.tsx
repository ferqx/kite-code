import { useEffect, useId, useRef } from 'react';
import { Toaster, toast } from 'sonner';

/** Operation feedback stays inside the conversation and never takes focus. */
export function OperationToast(props: {
  message?: string;
  pendingMessage?: string;
  recovery: boolean;
  busy: boolean;
  onDismiss: () => void;
  onRecover: () => void;
}) {
  const id = useId();
  const pendingId = useId();
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    if (!props.message) return;
    const show = props.recovery ? toast.warning : toast.error;
    show(props.recovery ? '警告 · 会话需要处理' : '错误 · 操作未完成', {
      id,
      toasterId: id,
      description: props.message,
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      onDismiss: () => callbacks.current.onDismiss(),
      action: props.recovery
        ? {
            label: props.busy ? '正在检查…' : '检查恢复',
            onClick: (event) => {
              event.preventDefault();
              if (!callbacks.current.busy) callbacks.current.onRecover();
            },
          }
        : undefined,
    });
    return () => {
      toast.dismiss(id);
    };
  }, [id, props.message, props.recovery, props.busy]);
  useEffect(() => {
    if (!props.pendingMessage) return;
    toast.loading('正在移除空间', {
      id: pendingId,
      toasterId: id,
      description: props.pendingMessage,
      duration: Number.POSITIVE_INFINITY,
    });
    return () => {
      toast.dismiss(pendingId);
    };
  }, [id, pendingId, props.pendingMessage]);
  return (
    <div className="operation-toast-anchor">
      <Toaster
        id={id}
        position="top-center"
        richColors
        closeButton
        containerAriaLabel="操作通知"
        toastOptions={{ closeButtonAriaLabel: '关闭通知' }}
      />
    </div>
  );
}
