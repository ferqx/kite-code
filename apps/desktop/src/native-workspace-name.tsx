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
import { useId, useRef, useState } from 'react';
import { isWorkspaceDisplayName } from './native-workspace-name-policy';

export function NativeWorkspaceNameDialog({
  name,
  trigger,
  onClose,
  onSave,
}: {
  name: string;
  trigger: HTMLButtonElement;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const inputId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !saving.current && onClose()}>
      <DialogContent
        className="kite-client max-w-sm gap-3 border-border p-5"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>编辑项目名称</DialogTitle>
          <DialogDescription className="sr-only">更改本机显示的项目名称。</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving.current) return;
            const next = value.trim();
            if (!isWorkspaceDisplayName(next)) {
              setError(next ? '项目名称过长。' : '请输入项目名称。');
              input.current?.focus();
              return;
            }
            saving.current = true;
            setPending(true);
            setError('');
            try {
              if (next !== name) await onSave(next);
              onClose();
            } catch {
              setError('项目名称保存失败，请重试。');
            } finally {
              saving.current = false;
              setPending(false);
            }
          }}
        >
          <div className="grid gap-1.5">
            <label className="sr-only" htmlFor={inputId}>
              项目名称
            </label>
            <Input
              id={inputId}
              ref={input}
              value={value}
              readOnly={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setError('');
              }}
            />
            {error && (
              <p id={errorId} role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
