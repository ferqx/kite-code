import { ArrowDown01Icon, TerminalIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { Button } from './ui';

/** Renders only the grants offered by the host; selection directly submits that decision. */
export function Approval({
  command,
  summary,
  toolLabel,
  fullText,
  attachment,
  status,
  grants,
  disabled,
  onDecide,
  embedded = false,
}: {
  embedded?: boolean;
  command?: string;
  summary?: string;
  toolLabel?: string;
  fullText?: string;
  attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
  status?: string;
  grants: readonly ('approve_once' | 'same_command')[];
  disabled: boolean;
  onDecide: (decision: 'approve_once' | 'same_command' | 'reject') => void;
}) {
  const subsequent = grants.includes('same_command');
  return (
    <section
      className={embedded ? 'tool-approval-form' : 'notice tool-approval-form'}
      aria-label="工具审批"
    >
      {!embedded && <strong>需要人工审批</strong>}
      <div className="approval-tool-line">
        <span className="approval-tool-label">
          <HugeiconsIcon icon={command ? TerminalIcon : Wrench01Icon} aria-hidden="true" />
          {toolLabel ?? (command ? 'Shell' : '工具')}
        </span>
        <TooltipProvider delayDuration={350}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Read-only full text must also be reachable with the keyboard. */}
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus exposes the full truncated tool text. */}
              <code className="approval-command" tabIndex={0}>
                {command ?? summary}
              </code>
            </TooltipTrigger>
            <TooltipContent
              className="kite-client approval-command-tooltip"
              side="top"
              align="start"
            >
              <code>{fullText ?? command ?? summary}</code>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {attachment?.phase === 'failed' && attachment.retry && (
          <Button variant="ghost" size="xs" onClick={attachment.retry}>
            重试核对
          </Button>
        )}
      </div>
      <div className="approval-actions">
        {status ? (
          <span className="approval-submission" role="status" title={status}>
            {status}
          </span>
        ) : (
          <Button variant="ghost" disabled={disabled} onClick={() => onDecide('reject')}>
            拒绝
          </Button>
        )}
        <div className={subsequent ? 'approval-split' : undefined}>
          <Button
            className="primary"
            disabled={disabled || !grants.includes('approve_once')}
            onClick={() => onDecide('approve_once')}
          >
            批准一次
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
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={disabled} onSelect={() => onDecide('same_command')}>
                    <span className="approval-session-option">
                      <span>本次会话批准</span>
                      <small>本次及本会话内的相同命令</small>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </section>
  );
}
