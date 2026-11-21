import { ArrowDown01Icon, BulbIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, type ReactNode, useEffect, useId } from 'react';
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
  id,
  label,
  running,
  notice,
  processOpen,
  expanded,
  restoredExpanded,
  onToggle,
  renderTool,
  renderReasoning,
}: {
  steps: readonly Message[];
  id: string;
  label: string;
  running: boolean;
  notice?: ReactNode;
  processOpen: boolean;
  expanded: Readonly<Record<string, boolean>>;
  restoredExpanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  renderTool: (message: Message, parentOpen: boolean) => ReactNode;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
}) {
  const first = steps[0];
  const grouped = steps.length > 1;
  const firstTool = steps.find((step) => step.role === 'tool');
  const summaryIcon = firstTool ? toolIcon(firstTool) : BulbIcon;
  const panelId = useId();
  const firstKey = first?.presentationKey ?? first?.id;
  const open = expanded[id] === true;
  const showSteps = !grouped || open;
  const detailsOpen = processOpen && showSteps;
  // Older singleton layouts could save only their outer disclosure.
  useEffect(() => {
    if (grouped || !open || !firstKey) return;
    const detailKey = first?.role === 'tool' ? `activity:${firstKey}` : firstKey;
    if (expanded[detailKey] === undefined) onToggle(detailKey, true);
  }, [grouped, open, firstKey, first?.role, expanded, onToggle]);
  if (!first) return null;
  const summary = (
    <TraceLine
      className="conversation-trace-line"
      data-reasoning={!firstTool || undefined}
      status={running ? 'running' : undefined}
    >
      <TraceIcon>
        <HugeiconsIcon icon={summaryIcon} />
      </TraceIcon>
      <TraceTitle title={label} aria-live="polite" aria-atomic="true">
        {label}
      </TraceTitle>
      <TraceIcon className="conversation-trace-chevron">
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </TraceIcon>
    </TraceLine>
  );
  return (
    <TraceCollapsible
      className="conversation-trace"
      data-restored-expanded={restoredExpanded.has(id) || undefined}
      open={showSteps}
      onOpenChange={(next) => onToggle(id, next)}
    >
      {grouped && (
        <button
          type="button"
          className="conversation-trace-trigger"
          aria-controls={panelId}
          aria-expanded={open}
          onClick={() => onToggle(id, !open)}
        >
          {summary}
        </button>
      )}
      {grouped && notice}
      <DeferredProcessContent
        component={TraceCollapsibleContent}
        id={panelId}
        data-direct-step={!grouped || undefined}
        open={grouped ? open : 'inline'}
        render={() => (
          <Trace
            className={grouped ? 'conversation-trace-steps' : undefined}
            data-direct-trace-tool={(!grouped && first.role === 'tool') || undefined}
            data-grouped={grouped || undefined}
          >
            {steps.map((step) => {
              const stepKey = step.presentationKey ?? step.id;
              if (step.role === 'tool')
                return <Fragment key={stepKey}>{renderTool(step, detailsOpen)}</Fragment>;
              const canRead = !!step.reasoningSource && !!renderReasoning;
              const stepOpen = expanded[stepKey];
              const reasoningOpen = canRead && (stepOpen ?? (!grouped && open));
              const heading = (
                <TraceLine
                  className="conversation-trace-line"
                  data-reasoning
                  status={!grouped && running ? 'running' : undefined}
                >
                  <TraceIcon>
                    <HugeiconsIcon icon={BulbIcon} />
                  </TraceIcon>
                  <TraceTitle aria-live={grouped ? undefined : 'polite'}>
                    {grouped ? (step.settled ? '已思考' : '思考') : label}
                  </TraceTitle>
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
                  data-restored-expanded={
                    restoredExpanded.has(stepKey) ||
                    (!grouped && stepOpen === undefined && restoredExpanded.has(id)) ||
                    undefined
                  }
                  open={reasoningOpen}
                  onOpenChange={(next) => {
                    onToggle(stepKey, next);
                    // Keep visible reasoning readable when a tool joins the segment.
                    if (!grouped) onToggle(id, next);
                  }}
                >
                  {canRead ? (
                    <TraceCollapsibleTrigger asChild>
                      <button type="button" className="conversation-trace-trigger">
                        {heading}
                      </button>
                    </TraceCollapsibleTrigger>
                  ) : (
                    heading
                  )}
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
      {!grouped && notice}
    </TraceCollapsible>
  );
}
