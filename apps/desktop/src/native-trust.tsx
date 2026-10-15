import type { PermissionFacts } from '@kite-ai/ui';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';

/** A business prerequisite, independent of the optional diagnostic sidebar. */
export function NativeTrustConfirmation({
  facts,
  workspace,
  busy,
  onTrust,
}: {
  facts: PermissionFacts;
  workspace: string;
  busy: boolean;
  onTrust: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function trust() {
    if (!confirmed || busy || sending.current) return;
    sending.current = true;
    setPending(true);
    try {
      await onTrust();
      if (alive.current) setOpen(false);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setPending(false);
      sending.current = false;
    }
  }
  return (
    <section aria-label="项目读取授权">
      <p>需要确认项目及读取范围后才能继续。原会话与未发送内容保留。</p>
      <Button
        onClick={() => {
          setConfirmed(false);
          setError(false);
          setOpen(true);
        }}
        disabled={busy || pending}
      >
        确认项目读取范围
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setConfirmed(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认项目读取范围</DialogTitle>
            <DialogDescription>
              仅授权下列项目与读取范围，不改变权限模式。确认后请明确发送原会话的内容；不会自动重发任务。
            </DialogDescription>
          </DialogHeader>
          <p>{workspace}</p>
          <ul>
            {facts.trust.readScopes.map((scope, index) => (
              <li key={index}>{scope.description}</li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对所显示的项目及读取范围
          </label>
          {pending && <p role="status">正在保存授权申请；关闭不会取消已提交的申请。</p>}
          {error && (
            <p role="alert">
              授权结果待核实，原内容保留。若显示原权限申请，请查询该申请；不自动重试。
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setConfirmed(false);
              }}
            >
              {pending ? '关闭' : '暂不授权'}
            </Button>
            <Button disabled={!confirmed || busy || pending || error} onClick={() => void trust()}>
              允许读取所显示的范围
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
