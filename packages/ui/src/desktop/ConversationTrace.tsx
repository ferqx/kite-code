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
import { completedToolActions, completedToolCategory, toolIcon } from './ToolActivity';
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
  summarizeTools,
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
  id: string;
  label: string;
  running: boolean;
  summarizeTools: boolean;
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
    summaryTitle?: string,
  ) => ReactNode;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
}) {
  const first = steps[0];
  const grouped = steps.length > 1;
  const firstReasoning = first?.role === 'thinking';
  const firstHasOwnDisclosure =
    first?.role === 'tool' &&
    (first.toolName === 'edit_file' || first.toolName === 'wait_agent_events');
  const useOwnDisclosure = !grouped && firstHasOwnDisclosure;
  const summarizedTool =
    summarizeTools && first?.role === 'tool' && label === completedToolCategory(first);
  const nested = grouped || firstReasoning || summarizedTool;
  const firstTool = steps.find((step) => step.role === 'tool');
  const summaryIcon = firstTool ? toolIcon(firstTool) : BulbIcon;
  const panelId = useId();
  const firstKey = first?.presentationKey ?? first?.id;
  // Tool and Reasoning details use the same step key in either layout.
  const hasDetails = grouped || first?.role === 'tool' || !!first?.reasoningSource;
  const open =
    hasDetails &&
    (expanded[id] ?? (firstHasOwnDisclosure && expanded[`activity:${firstKey}`])) === true;
  const detailsOpen = processOpen && open;
  // Older single-step reading state may only carry the outer disclosure.
  useEffect(() => {
    if (grouped || !open || !firstKey) return;
    const detailKey = first?.role === 'tool' ? `activity:${firstKey}` : firstKey;
    if (expanded[detailKey] === undefined) onToggle(detailKey, true);
  }, [grouped, open, firstKey, first?.role, expanded, onToggle]);
  function toggle(next: boolean) {
    onToggle(id, next);
    if (grouped || !firstKey) return;
    if (!summarizedTool && first?.role === 'tool') {
      onToggle(`activity:${firstKey}`, next);
    }
    if (next && firstReasoning && expanded[firstKey] === undefined) onToggle(firstKey, true);
  }
  const summary = (
    <TraceLine
      className="conversation-trace-line"
      data-reasoning={!firstTool || undefined}
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
      open={useOwnDisclosure || open}
      onOpenChange={toggle}
    >
      {!useOwnDisclosure && (
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
      )}
      {!useOwnDisclosure && notice}
      {hasDetails && (
        <DeferredProcessContent
          component={TraceCollapsibleContent}
          id={panelId}
          data-direct-step={useOwnDisclosure || !nested || undefined}
          open={useOwnDisclosure || open}
          render={() => (
            <Trace
              className={useOwnDisclosure ? undefined : 'conversation-trace-steps'}
              data-direct-trace-tool={useOwnDisclosure || undefined}
              data-grouped={nested || undefined}
            >
              {steps.map((step, index) => {
                const stepKey = step.presentationKey ?? step.id;
                const direct = index === 0 && !grouped && !summarizedTool;
                if (step.role === 'tool')
                  return (
                    <Fragment key={stepKey}>
                      {useOwnDisclosure
                        ? renderTool(
                            step,
                            false,
                            processOpen,
                            toggle,
                            (summarizeTools && completedToolActions([step])) || undefined,
                          )
                        : renderTool(step, direct, detailsOpen)}
                    </Fragment>
                  );
                const canRead = !!step.reasoningSource && !!renderReasoning;
                const stepOpen = expanded[stepKey];
                const reasoningOpen = canRead && (stepOpen ?? (!grouped && open));
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
                    data-restored-expanded={
                      restoredExpanded.has(stepKey) ||
                      (!grouped && stepOpen === undefined && restoredExpanded.has(id)) ||
                      undefined
                    }
                    open={reasoningOpen}
                    onOpenChange={(next) => onToggle(stepKey, next)}
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
      )}
      {useOwnDisclosure && notice}
    </TraceCollapsible>
  );
}
