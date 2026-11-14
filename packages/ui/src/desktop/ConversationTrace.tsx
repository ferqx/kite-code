import {
  ArrowRight01Icon,
  BrainIcon,
  ListTreeIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
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
  message.role === 'tool' || message.role === 'thinking';

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
  summaryStep,
  id,
  label,
  running,
  failed,
  notice,
  expanded,
  restoredExpanded,
  onToggle,
  renderTool,
  renderReasoning,
}: {
  steps: readonly Message[];
  summaryStep?: Message;
  id: string;
  label: string;
  running: boolean;
  failed: boolean;
  notice?: ReactNode;
  expanded: Readonly<Record<string, boolean>>;
  restoredExpanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  renderTool: (message: Message, initialOpen?: boolean) => ReactNode;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
}) {
  const first = steps[0];
  const grouped = steps.length > 1;
  const summaryIcon =
    summaryStep?.role === 'tool'
      ? toolIcon(summaryStep)
      : summaryStep?.tracePending === 'tool'
        ? Wrench01Icon
        : summaryStep || steps.every((step) => step.role === 'thinking')
          ? BrainIcon
          : ListTreeIcon;
  const panelId = useId();
  const firstKey = first?.presentationKey ?? first?.id;
  // Tool and Reasoning details use the same step key in either layout.
  const hasDetails = grouped || first?.role === 'tool' || !!first?.reasoningSource;
  const open = hasDetails && expanded[id] === true;
  function toggle(next: boolean) {
    onToggle(id, next);
    if (!grouped && firstKey) {
      onToggle(first?.role === 'tool' ? `activity:${firstKey}` : firstKey, next);
    }
  }
  const summary = (
    <TraceLine
      className="conversation-trace-line"
      status={running ? 'running' : failed ? 'error' : undefined}
    >
      <TraceIcon>
        <HugeiconsIcon icon={summaryIcon} />
      </TraceIcon>
      <TraceTitle
        title={label}
        aria-live="polite"
        aria-atomic="true"
        className={
          running
            ? 'shimmer shimmer-color-foreground shimmer-spread-[16px] shimmer-duration-1500'
            : undefined
        }
      >
        {label}
      </TraceTitle>
      {hasDetails && (
        <TraceIcon className="conversation-trace-chevron">
          <HugeiconsIcon icon={ArrowRight01Icon} />
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
          open={open}
          render={() => (
            <Trace className="conversation-trace-steps" data-grouped={grouped || undefined}>
              {steps.map((step, index) => {
                const stepKey = step.presentationKey ?? step.id;
                const direct = !grouped && index === 0;
                if (step.role === 'tool')
                  return (
                    <Fragment key={stepKey}>{renderTool(step, direct ? true : undefined)}</Fragment>
                  );
                const canRead = !!step.reasoningSource && !!renderReasoning;
                const reasoningOpen = canRead && (direct || expanded[stepKey] === true);
                const heading = (
                  <TraceLine className="conversation-trace-line">
                    <TraceIcon>
                      <HugeiconsIcon icon={BrainIcon} />
                    </TraceIcon>
                    <TraceTitle>{step.settled ? '思考完成' : '思考'}</TraceTitle>
                    {canRead && (
                      <TraceIcon className="conversation-trace-chevron">
                        <HugeiconsIcon icon={ArrowRight01Icon} />
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
                        render={() => renderReasoning(step, open && reasoningOpen)}
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
