import {
  ArrowDown01Icon,
  Edit02Icon,
  TerminalIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
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

function ApprovalTarget({
  text,
  tooltip,
  shell,
}: {
  text?: string;
  tooltip?: string;
  shell?: boolean;
}) {
  if (tooltip === undefined) return <code className="approval-command">{text}</code>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus exposes the full truncated tool text. */}
        <code className="approval-command" tabIndex={0}>
          {text}
        </code>
      </TooltipTrigger>
      <TooltipContent
        className="kite-client approval-command-tooltip"
        data-shell-command={shell ? '' : undefined}
        side="top"
        align="start"
      >
        <code>{tooltip}</code>
      </TooltipContent>
    </Tooltip>
  );
}

/** Renders only the grants offered by the host; selection directly submits that decision. */
export function Approval({
  command,
  summary,
  toolLabel,
  tooltipText,
  editRows,
  attachment,
  status,
  options,
  onceLabel,
  scopePresentation,
  disabled,
  onDecide,
  embedded = false,
}: {
  embedded?: boolean;
  command?: string;
  summary?: string;
  toolLabel?: string;
  tooltipText?: string;
  editRows?: readonly {
    callId: string;
    path: string;
    counts?: { added: number; removed: number };
  }[];
  attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
  status?: string;
  options: readonly ApprovalOptionView[];
  onceLabel?: string;
  scopePresentation?: ReadonlyMap<string, { label: string; description: string; title?: string }>;
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
      <TooltipProvider delayDuration={350}>
        {editRows ? (
          <ol className="approval-edit-list" aria-label="批量编辑列表">
            {editRows.map(({ callId, path, counts }) => (
              <li className="approval-tool-line" key={callId}>
                <HugeiconsIcon
                  icon={Edit02Icon}
                  className="approval-edit-icon"
                  aria-hidden="true"
                />
                <ApprovalTarget text={path.split(/[\\/]/).at(-1) || path} tooltip={path} />
                {counts && (
                  <>
                    <span className="approval-edit-line-counts" aria-hidden="true">
                      <span>+{counts.added}</span>
                      <span>−{counts.removed}</span>
                    </span>
                    <span className="approval-edit-count-description">{`新增 ${counts.added} 行，删除 ${counts.removed} 行`}</span>
                  </>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="approval-tool-line">
            <span className="approval-tool-label">
              <HugeiconsIcon icon={command ? TerminalIcon : Wrench01Icon} aria-hidden="true" />
              {toolLabel ?? (command ? 'Shell' : '工具')}
            </span>
            <ApprovalTarget
              text={command ?? summary}
              tooltip={tooltipText}
              shell={command !== undefined}
            />
            {attachment?.phase === 'failed' && attachment.retry && (
              <Button variant="ghost" size="xs" onClick={attachment.retry}>
                重试核对
              </Button>
            )}
          </div>
        )}
      </TooltipProvider>
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
            aria-description={onceLabel && once ? '仅批准此次' : undefined}
            onClick={() => once && onDecide(once.optionId)}
          >
            {once ? (onceLabel ?? once.presentation.label) : '仅此次'}
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
                  {subsequent.map((option) => {
                    const compact = scopePresentation?.get(option.optionId);
                    return (
                      <DropdownMenuItem
                        key={option.optionId}
                        disabled={disabled}
                        aria-description={compact?.description}
                        title={compact?.title ?? compact?.description}
                        onSelect={() => onDecide(option.optionId)}
                      >
                        {compact ? (
                          <span className="approval-scope-option">{compact.label}</span>
                        ) : (
                          <span className="approval-session-option">
                            <span>{option.presentation.label}</span>
                            {option.presentation.details.map((detail, index) => (
                              <small key={index}>{detail}</small>
                            ))}
                          </span>
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </section>
  );
}
