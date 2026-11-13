import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@kite-ai/ui/desktop';
import { useRef, useState } from 'react';
import type { NativeSessionFacts } from './native-bridge';

export type DirectorySessionDialog = {
  kind: 'rename' | 'delete';
  label: string;
  facts?: NativeSessionFacts;
  error?: string;
};

export function NativeDirectorySessionDialog({
  dialog,
  pending,
  onClose,
  onObserve,
  returnFocus,
  onSubmit,
  observeAvailable,
}: {
  dialog: DirectorySessionDialog;
  pending: boolean;
  onClose: () => void;
  onObserve: () => void;
  returnFocus: () => void;
  onSubmit: (title: string) => void;
  observeAvailable: boolean;
}) {
  const [editedTitle, setEditedTitle] = useState<string>();
  const rename = dialog.kind === 'rename';
  const title = editedTitle ?? dialog.facts?.session.title ?? '';
  const bytes = new TextEncoder().encode(title.trim()).length;
  const valid =
    observeAvailable &&
    !!dialog.facts &&
    !dialog.error &&
    (!rename || (bytes > 0 && bytes <= 4096 && title.trim() !== dialog.facts.session.title));
  const cancel = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        className="kite-client session-management-dialog max-w-sm gap-3 border-border p-5"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (rename ? input.current : cancel.current)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{rename ? '重命名会话' : '删除会话？'}</DialogTitle>
          <DialogDescription className={rename ? 'sr-only' : 'break-words'}>
            {rename
              ? '输入新的会话名称。'
              : `「${dialog.facts?.session.title || dialog.label}」将从列表移除。正在执行的任务会收到停止请求，工作区文件会保留。`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && valid) onSubmit(title.trim());
          }}
        >
          {rename && (
            <Input
              ref={input}
              aria-label="会话名称"
              placeholder="新对话"
              value={title}
              readOnly={pending}
              onChange={(event) => setEditedTitle(event.target.value)}
            />
          )}
          {dialog.error && <p role="alert">{dialog.error}</p>}
          {rename && bytes > 4096 && <p role="alert">会话名称过长。</p>}
          {!observeAvailable && <p role="status">会话暂不可用，等待连接恢复。</p>}
          {observeAvailable && !dialog.facts && !dialog.error && <p role="status">正在核对会话…</p>}
          <DialogFooter>
            <Button ref={cancel} variant="outline" disabled={pending} onClick={onClose}>
              取消
            </Button>
            {dialog.error ? (
              <Button
                key="observe"
                disabled={pending || !observeAvailable}
                onClick={(event) => {
                  event.preventDefault();
                  onObserve();
                }}
              >
                重新核对
              </Button>
            ) : (
              <Button
                key="submit"
                type="submit"
                variant={rename ? 'default' : 'destructive'}
                disabled={pending || !valid}
              >
                {pending ? (rename ? '保存中…' : '删除中…') : rename ? '保存' : '删除'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
