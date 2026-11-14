import { ArrowDown01Icon, BulbIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, type ReactNode, useId } from 'react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './components/ui/trace';
import { DeferredProcessContent } from './DeferredProcessContent';
import { toolIcon } from './ToolActivity';
import type { Message } from './types';

export const traceKey = (boundary: Message) =>
  `trace-after:${boundary.presentationKey ?? boundary.id}`;

export const isConversationTraceStep = (message: Message) =>
  message.role === 'thinking' || (message.role === 'tool' && message.toolName !== 'spawn_agent');

export function latestRunningTraceTool(steps: readonly Message[]) {
  let tool: Message | undefined;
  for (const step of steps) {
    if (
      step.role === 'tool' &&
      !step.settled &&
      step.status === 'running' &&
      !step.executionUnconfirmed &&
      step.dispatchCommitted !== false &&
      step.approval?.state !== 'checking' &&
      step.approval?.state !== 'reviewing' &&
      step.approval?.state !== 'awaiting_user' &&
      (!tool || (step.toolStartOrder ?? 0) >= (tool.toolStartOrder ?? 0))
    )
      tool = step;
  }
  return tool;
}

/** A closed trace owns only its summary. Each opened step keeps its own identity. */
export function ConversationTrace({
  steps,
  waitingForTool,
  id,
  label,
  running,
  failed,
  notice,
  processOpen,
  expanded,
  restoredExpanded,
  onToggle,
  renderTool,
  renderReasoning,
}: {
  steps: readonly Message[];
  waitingForTool: boolean;
  id: string;
  label: string;
  running: boolean;
  failed: boolean;
  notice?: ReactNode;
  processOpen: boolean;
  expanded: Readonly<Record<string, boolean>>;
  restoredExpanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  renderTool: (
    message: Message,
    direct: boolean,
    traceOpen: boolean,
    onToggle?: (open: boolean) => void,
  ) => ReactNode;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
}) {
  const first = steps[0];
  const grouped = steps.length > 1;
  const firstTool = steps.find((step) => step.role === 'tool');
  const summaryIcon = firstTool ? toolIcon(firstTool) : waitingForTool ? Wrench01Icon : BulbIcon;
  const panelId = useId();
  const firstKey = first?.presentationKey ?? first?.id;
  // Tool and Reasoning details use the same step key in either layout.
  const hasDetails = grouped || first?.role === 'tool' || !!first?.reasoningSource;
  const open = hasDetails && expanded[id] === true;
  const detailsOpen = processOpen && open;
  function toggle(next: boolean) {
    onToggle(id, next);
    if (!grouped && firstKey) {
      onToggle(first?.role === 'tool' ? `activity:${firstKey}` : firstKey, next);
    }
  }
  if (
    !grouped &&
    first?.role === 'tool' &&
    (first.toolName === 'edit_file' || first.toolName === 'wait_agent_events')
  )
    return (
      <div className="conversation-trace">
        {renderTool(first, false, processOpen, toggle)}
        {notice}
      </div>
    );
  const summary = (
    <TraceLine
      className="conversation-trace-line"
      data-reasoning={(!firstTool && !waitingForTool) || undefined}
      status={running ? 'running' : failed ? 'error' : undefined}
    >
      <TraceIcon>
        <HugeiconsIcon icon={summaryIcon} />
      </TraceIcon>
      <TraceTitle title={label} aria-live="polite" aria-atomic="true">
        {label}
      </TraceTitle>
      {hasDetails && (
        <TraceIcon className="conversation-trace-chevron">
          <HugeiconsIcon icon={ArrowDown01Icon} />
        </TraceIcon>
      )}
    </TraceLine>
  );
  return (
    <TraceCollapsible
      className="conversation-trace"
      data-restored-expanded={restoredExpanded.has(id) || undefined}
      open={open}
      onOpenChange={toggle}
    >
      <button
        type="button"
        className="conversation-trace-trigger"
        disabled={!hasDetails}
        aria-controls={hasDetails ? panelId : undefined}
        aria-expanded={hasDetails ? open : undefined}
        onClick={() => toggle(!open)}
      >
        {summary}
      </button>
      {notice}
      {hasDetails && (
        <DeferredProcessContent
          component={TraceCollapsibleContent}
          id={panelId}
          data-direct-step={!grouped || undefined}
          open={open}
          render={() => (
            <Trace className="conversation-trace-steps" data-grouped={grouped || undefined}>
              {steps.map((step, index) => {
                const stepKey = step.presentationKey ?? step.id;
                const direct = !grouped && index === 0;
                if (step.role === 'tool')
                  return <Fragment key={stepKey}>{renderTool(step, direct, detailsOpen)}</Fragment>;
                const canRead = !!step.reasoningSource && !!renderReasoning;
                const reasoningOpen = canRead && (direct || expanded[stepKey] === true);
                const heading = (
                  <TraceLine className="conversation-trace-line" data-reasoning>
                    <TraceIcon>
                      <HugeiconsIcon icon={BulbIcon} />
                    </TraceIcon>
                    <TraceTitle>{step.settled ? '已思考' : '思考'}</TraceTitle>
                    {canRead && (
                      <TraceIcon className="conversation-trace-chevron">
                        <HugeiconsIcon icon={ArrowDown01Icon} />
                      </TraceIcon>
                    )}
                  </TraceLine>
                );
                return (
                  <TraceCollapsible
                    key={stepKey}
                    className="conversation-reasoning"
                    open={reasoningOpen}
                    onOpenChange={(next) => onToggle(stepKey, next)}
                  >
                    {!direct &&
                      (canRead ? (
                        <TraceCollapsibleTrigger asChild>
                          <button type="button" className="conversation-trace-trigger">
                            {heading}
                          </button>
                        </TraceCollapsibleTrigger>
                      ) : (
                        heading
                      ))}
                    {canRead && (
                      <DeferredProcessContent
                        component={TraceCollapsibleContent}
                        open={reasoningOpen}
                        className="conversation-reasoning-body"
                        render={() => renderReasoning(step, detailsOpen && reasoningOpen)}
                      />
                    )}
                  </TraceCollapsible>
                );
              })}
            </Trace>
          )}
        />
      )}
    </TraceCollapsible>
  );
}
