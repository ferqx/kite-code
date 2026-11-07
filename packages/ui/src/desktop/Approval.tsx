import { ArrowDown01Icon, TerminalIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ApprovalOptionView } from '@kite-ai/client';
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
  options,
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
  options: readonly ApprovalOptionView[];
  disabled: boolean;
  onDecide: (optionId: string | null) => void;
}) {
  const once = options.find((option) => option.kind === 'once');
  const subsequent = options.filter((option) => option.kind === 'scope');
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
          <Button variant="ghost" disabled={disabled} onClick={() => onDecide(null)}>
            拒绝
          </Button>
        )}
        <div className={subsequent.length ? 'approval-split' : undefined}>
          <Button
            className="primary"
            disabled={disabled || !once}
            onClick={() => once && onDecide(once.optionId)}
          >
            {once?.presentation.label ?? '仅此次'}
          </Button>
          {subsequent.length > 0 && (
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
                  {subsequent.map((option) => (
                    <DropdownMenuItem
                      key={option.optionId}
                      disabled={disabled}
                      onSelect={() => onDecide(option.optionId)}
                    >
                      <span className="approval-session-option">
                        <span>{option.presentation.label}</span>
                        {option.presentation.details.map((detail, index) => (
                          <small key={index}>{detail}</small>
                        ))}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </section>
  );
}
