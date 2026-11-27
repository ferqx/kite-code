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
import { completedToolSummary, toolIcon, toolTextFailed } from './ToolActivity';
import type { Message } from './types';
import { webFetchBatchDisplay } from './web-fetch-batch-display';

export const traceKey = (boundary: Message) =>
  `trace-after:${boundary.presentationKey ?? boundary.id}`;

const standaloneTools = new Set(['task', 'spawn_agent', 'planning.review', 'request_plan_review']);

export const isStandaloneTraceTool = (message: Message) =>
  message.role === 'tool' &&
  (message.presentation === 'standalone' || standaloneTools.has(message.toolName ?? ''));

export const isConversationTraceStep = (message: Message) =>
  message.role === 'thinking' || (message.role === 'tool' && !isStandaloneTraceTool(message));

export function traceInteractionTitle(steps: readonly Message[]) {
  let answer = false;
  let approval = false;
  let submitted = false;
  for (const step of steps) {
    if (step.role !== 'tool' || step.settled || step.executionUnconfirmed) continue;
    answer ||= step.questionState === 'pending';
    approval ||= step.approval?.state === 'awaiting_user' && step.dispatchCommitted !== true;
    submitted ||= step.questionState === 'submitted' || step.approval?.state === 'submitted';
  }
  if (answer && approval) return '等待回答 · 等待审批';
  if (answer) return '等待回答';
  if (approval) return '等待审批';
  return submitted ? '已提交，待确认' : undefined;
}

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

function TraceProgress() {
  return (
    <svg
      className="conversation-trace-progress shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="conversation-trace-star"
        d="M12 3.3 Q12.48 3.3 12.68 4.05 Q13.93 9.62 19.95 11.38 Q20.7 11.58 20.7 12 Q20.7 12.42 19.95 12.62 Q13.93 14.38 12.68 19.95 Q12.48 20.7 12 20.7 Q11.52 20.7 11.32 19.95 Q10.07 14.38 4.05 12.62 Q3.3 12.42 3.3 12 Q3.3 11.58 4.05 11.38 Q10.07 9.62 11.32 4.05 Q11.52 3.3 12 3.3Z"
      />
      <path
        className="conversation-trace-spark"
        d="M20.25 0.95 Q20.76 3.25 23.05 3.75 Q20.76 4.25 20.25 6.55 Q19.74 4.25 17.45 3.75 Q19.74 3.25 20.25 0.95Z"
        fill="currentColor"
        stroke="none"
      />
      <path
        className="conversation-trace-dot"
        d="M3.4 19.1 L4.7 20.4 3.4 21.7 2.1 20.4Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/** A closed trace owns only its summary. Each opened step keeps its own identity. */
export function ConversationTrace({
  steps,
  id,
  label,
  running,
  showProgress,
  activeReasoning,
  interactionTitle,
  summarizeTools,
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
  showProgress: boolean;
  activeReasoning?: Message;
  interactionTitle?: string;
  summarizeTools: boolean;
  notice?: ReactNode;
  processOpen: boolean;
  expanded: Readonly<Record<string, boolean>>;
  restoredExpanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  renderTool: (
    message: Message,
    parentOpen: boolean,
    summaryTitle?: string,
    directDetails?: boolean,
  ) => ReactNode;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
}) {
  const first = steps[0];
  const grouped = steps.length > 1;
  const singleTool = !grouped && first?.role === 'tool' ? first : undefined;
  const completedTitle =
    summarizeTools && singleTool ? completedToolSummary(singleTool) : undefined;
  // Keep a background launch in the same row when its later Job supplies a summary.
  // Other omitted actions still use the disclosure for their original row and result.
  const shell = singleTool?.shell;
  const acceptedLaunch = shell?.operation === 'launch' && shell.accepted && !!shell.jobExecutionId;
  const omittedTool =
    summarizeTools && singleTool && !completedTitle && !acceptedLaunch ? singleTool : undefined;
  const showSummary = grouped || !!omittedTool;
  const summaryLabel =
    (omittedTool?.status === 'failed' ? webFetchBatchDisplay(omittedTool)?.label : undefined) ??
    label;
  const firstTool = steps.find((step) => step.role === 'tool');
  const summaryIcon = firstTool ? toolIcon(firstTool) : BulbIcon;
  const panelId = useId();
  const firstKey = first?.presentationKey ?? first?.id;
  // A running singleton can acquire a group disclosure while its details are
  // being read. Keep that first step mounted until the reader closes the group.
  const firstDetailKey = first?.role === 'tool' ? `activity:${firstKey}` : firstKey;
  const open =
    (expanded[id] ??
      ((grouped || omittedTool) && firstDetailKey ? expanded[firstDetailKey] : undefined)) === true;
  const showSteps = !showSummary || open;
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
      status={
        running ? 'running' : omittedTool && toolTextFailed(omittedTool) ? 'error' : undefined
      }
    >
      <TraceIcon>
        {showProgress ? <TraceProgress /> : <HugeiconsIcon icon={summaryIcon} />}
      </TraceIcon>
      <TraceTitle title={summaryLabel} aria-live="polite" aria-atomic="true">
        {summaryLabel}
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
      {showSummary && (
        <button
          type="button"
          className="conversation-trace-trigger"
          aria-controls={panelId}
          aria-expanded={open}
          aria-description={showProgress ? '进行中' : undefined}
          onClick={() => onToggle(id, !open)}
        >
          {summary}
        </button>
      )}
      {showSummary && notice}
      <DeferredProcessContent
        component={TraceCollapsibleContent}
        id={panelId}
        data-direct-step={!grouped || undefined}
        open={showSummary ? open : 'inline'}
        render={() => (
          <Trace
            className={showSummary ? 'conversation-trace-steps' : undefined}
            data-direct-trace-tool={(!showSummary && first.role === 'tool') || undefined}
            data-grouped={grouped || undefined}
          >
            {steps.map((step) => {
              const stepKey = step.presentationKey ?? step.id;
              if (step.role === 'tool')
                return (
                  <Fragment key={stepKey}>
                    {renderTool(
                      step,
                      detailsOpen,
                      grouped
                        ? undefined
                        : omittedTool
                          ? summaryLabel
                          : (interactionTitle ?? completedTitle),
                      !!omittedTool,
                    )}
                  </Fragment>
                );
              const canRead = !!step.reasoningSource && !!renderReasoning;
              const stepOpen = expanded[stepKey];
              const reasoningOpen = canRead && (stepOpen ?? (!grouped && open));
              const thinking = step === activeReasoning;
              const heading = (
                <TraceLine
                  className="conversation-trace-line"
                  data-reasoning
                  status={thinking ? 'running' : undefined}
                >
                  <TraceIcon>
                    {!grouped && thinking && showProgress ? (
                      <TraceProgress />
                    ) : (
                      <HugeiconsIcon icon={BulbIcon} />
                    )}
                  </TraceIcon>
                  <TraceTitle aria-live={grouped ? undefined : 'polite'}>
                    {thinking ? '思考中' : '已思考'}
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
      {!showSummary && notice}
    </TraceCollapsible>
  );
}
