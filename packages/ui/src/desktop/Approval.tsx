import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Button } from './ui';

/** Renders only the grants offered by the host; selection directly submits that decision. */
export function Approval({
  command,
  summary,
  grants,
  disabled,
  onDecide,
}: {
  command?: string;
  summary?: string;
  grants: readonly ('approve_once' | 'same_command')[];
  disabled: boolean;
  onDecide: (decision: 'approve_once' | 'same_command' | 'reject') => void;
}) {
  const subsequent = grants.includes('same_command');
  return (
    <section className="notice tool-approval-form" aria-label="工具审批">
      <strong>需要人工审批</strong>
      {command ? (
        <p>
          是否允许执行 <code className="approval-command">{command}</code>？
        </p>
      ) : (
        summary && <p>{summary}</p>
      )}
      <div className="approval-actions">
        <Button variant="ghost" disabled={disabled} onClick={() => onDecide('reject')}>
          拒绝
        </Button>
        <div className={subsequent ? 'approval-split' : undefined}>
          <Button
            className="primary"
            disabled={disabled || !grants.includes('approve_once')}
            onClick={() => onDecide('approve_once')}
          >
            仅批准这一次
          </Button>
          {subsequent && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="primary" disabled={disabled} aria-label="更多批准方式">
                  <HugeiconsIcon icon={ArrowDown01Icon} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="kite-client approval-menu"
                side="top"
                align="end"
                sideOffset={8}
              >
                <DropdownMenuItem disabled={disabled} onSelect={() => onDecide('same_command')}>
                  批准本次及本会话相同命令
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </section>
  );
}
