import { ArrowDown01Icon, Globe02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from './components/ui/trace';
import { cn } from './lib/utils';
import type { Message } from './types';
import { Button } from './ui';

export function ModelConnection({
  message,
  expanded = false,
  onToggle,
  restoredExpanded,
}: {
  message: Message;
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  restoredExpanded?: boolean;
}) {
  const failure = message.modelConnectionFailure;
  const running = !message.settled && message.status === 'running' && !message.executionUnconfirmed;
  const content = (
    <>
      <TraceIcon className="tool-activity-marker-icon">
        <HugeiconsIcon className="tool-activity-kind-icon" icon={Globe02Icon} />
      </TraceIcon>
      <TraceTitle className="tool-label">{message.title}</TraceTitle>
      <TraceDescription className="tool-step-preview">{message.text}</TraceDescription>
      {failure && (
        <HugeiconsIcon
          className="tool-activity-chevron"
          icon={ArrowDown01Icon}
          data-icon="inline-end"
          aria-hidden="true"
        />
      )}
    </>
  );
  return (
    <Collapsible asChild open={!!failure && expanded} onOpenChange={onToggle}>
      <article
        className={cn('message tool-activity model-connection', { 'is-running': running })}
        data-status={message.status}
        data-restored-expanded={restoredExpanded || undefined}
      >
        {failure ? (
          <CollapsibleTrigger asChild>
            <TraceLine asChild className="tool-activity-summary" status="error">
              <Button variant="ghost" aria-label={`${expanded ? '收起' : '展开'}重连失败详情`}>
                {content}
              </Button>
            </TraceLine>
          </CollapsibleTrigger>
        ) : (
          <TraceLine
            className="tool-activity-summary"
            role="status"
            status={running ? 'running' : undefined}
          >
            {content}
          </TraceLine>
        )}
        {failure && (
          <AnimatedCollapsibleContent className="tool-activity-content">
            <section className="turn-failure-details" aria-label="重连失败详情">
              <p>{failure.description}</p>
              <p>{failure.suggestion}</p>
            </section>
          </AnimatedCollapsibleContent>
        )}
      </article>
    </Collapsible>
  );
}
