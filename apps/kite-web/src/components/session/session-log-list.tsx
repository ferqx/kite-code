import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import {
  Activity,
  ChevronRight,
  CircleAlert,
  FileJson2,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { WebSessionLogEntry } from '@/presentation/types';

export type WebLogState = 'idle' | 'loading' | 'content' | 'empty' | 'unavailable' | 'error';

export function SessionLogList({
  entries,
  status,
  reason,
  throughSequence,
  onRefresh,
  onViewModelContext,
}: {
  readonly entries: readonly WebSessionLogEntry[];
  readonly status: WebLogState;
  readonly reason: string | null;
  readonly throughSequence: number;
  readonly onRefresh: () => void;
  readonly onViewModelContext: (invocationId: string) => void;
}) {
  return (
    <section
      id="session-panel-logs"
      role="tabpanel"
      aria-labelledby="session-tab-logs"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-subtle/25 px-6">
        <div className="min-w-0">
          <span className="text-[11px] font-medium text-foreground">Durable runtime events</span>
          <span className="ml-2 text-[10px] text-muted-foreground">
            {status === 'loading'
              ? 'Loading snapshot…'
              : `${entries.length} event${entries.length === 1 ? '' : 's'} through #${throughSequence}`}
          </span>
        </div>
        <Button
          aria-label="Refresh session logs"
          className="h-7 shrink-0 px-2 text-[10px]"
          disabled={status === 'loading'}
          onClick={onRefresh}
        >
          <RefreshCw className={cn('size-3', status === 'loading' && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      {status === 'content' && entries.length > 0 ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-[980px] space-y-2 px-6 pb-20 pt-5 max-sm:px-4">
            {entries.map((entry) => (
              <LogEntry
                key={entry.sequence}
                entry={entry}
                onViewModelContext={onViewModelContext}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <LogStatePanel status={status} reason={reason} onRetry={onRefresh} />
      )}
    </section>
  );
}

function LogEntry({
  entry,
  onViewModelContext,
}: {
  readonly entry: WebSessionLogEntry;
  readonly onViewModelContext: (invocationId: string) => void;
}) {
  const invocationId =
    entry.eventType === 'model.invocation_prepared'
      ? entry.detail.fields.find((field) => field.name === 'invocation_id')?.value
      : undefined;
  return (
    <CollapsiblePrimitive.Root asChild>
      <article className="overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
        <CollapsiblePrimitive.Trigger className="group grid w-full grid-cols-[48px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-left max-sm:grid-cols-[40px_minmax(0,1fr)]">
          <span className="pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            #{entry.sequence}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="truncate font-mono text-[12px] font-semibold text-foreground">
                {entry.eventType}
              </code>
              <Badge className="capitalize">{entry.category}</Badge>
              <Badge className={statusClassName(entry.status)}>{entry.status}</Badge>
            </span>
            <span className="mt-1.5 block line-clamp-2 text-[11px] leading-5 text-muted-foreground">
              {entry.summary ?? humanizeEventType(entry.eventType)}
            </span>
          </span>
          <span className="flex items-center gap-2 pt-0.5 text-[10px] tabular-nums text-muted-foreground max-sm:col-start-2">
            <time dateTime={new Date(entry.occurredAt).toISOString()}>
              {formatLogTime(entry.occurredAt)}
            </time>
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          </span>
        </CollapsiblePrimitive.Trigger>
        <CollapsiblePrimitive.Content className="border-t border-border bg-terminal/35">
          <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-5 gap-y-3 px-4 py-4 text-[11px] max-sm:grid-cols-1 max-sm:gap-y-1">
            <DetailLabel>What happened</DetailLabel>
            <p className="leading-5 text-copy">{humanizeEventType(entry.eventType)}</p>
            <DetailLabel>Event identity</DetailLabel>
            <div className="flex flex-wrap gap-2">
              <code className="font-mono text-foreground">{entry.eventType}</code>
              <span className="text-muted-foreground">sequence #{entry.sequence}</span>
            </div>
            <DetailLabel>Classification</DetailLabel>
            <p className="text-copy">
              {entry.category} · {entry.status} · {entry.detail.kind} detail
            </p>
            <DetailLabel>Occurred at</DetailLabel>
            <time
              className="font-mono text-copy"
              dateTime={new Date(entry.occurredAt).toISOString()}
            >
              {new Date(entry.occurredAt).toLocaleString()}
            </time>
            {invocationId ? (
              <>
                <DetailLabel>Model context</DetailLabel>
                <div>
                  <Button
                    aria-label={`View model context for invocation ${invocationId}`}
                    className="h-8 px-2.5 text-[10px]"
                    onClick={() => onViewModelContext(invocationId)}
                  >
                    <ScanSearch className="size-3.5" />
                    View model context
                  </Button>
                </div>
              </>
            ) : null}
            {entry.detail.artifact ? (
              <>
                <DetailLabel>Artifact</DetailLabel>
                <p className="font-mono text-copy">
                  {entry.detail.artifact.kind} · {entry.detail.artifact.availability}
                </p>
              </>
            ) : null}
            {entry.detail.fields.map((field) => (
              <LogField key={field.name} name={field.name} value={field.value} />
            ))}
            {entry.detail.fields.length === 0 && !entry.detail.artifact ? (
              <>
                <DetailLabel>Event details</DetailLabel>
                <p className="text-muted-foreground">
                  This event has no additional browser-safe fields.
                </p>
              </>
            ) : null}
          </div>
        </CollapsiblePrimitive.Content>
      </article>
    </CollapsiblePrimitive.Root>
  );
}

function LogField({ name, value }: { readonly name: string; readonly value: string }) {
  return (
    <>
      <DetailLabel>
        <span>{humanizeFieldName(name)}</span>
        <code className="ml-1.5 font-mono text-[9px] font-normal text-muted-foreground/70">
          {name}
        </code>
      </DetailLabel>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-terminal px-3 py-2.5 font-mono text-[10px] leading-5 text-terminal-copy">
        {value}
      </pre>
    </>
  );
}

function DetailLabel({ children }: { readonly children: ReactNode }) {
  return <span className="font-medium text-muted-foreground">{children}</span>;
}

function LogStatePanel({
  status,
  reason,
  onRetry,
}: {
  readonly status: WebLogState;
  readonly reason: string | null;
  readonly onRetry: () => void;
}) {
  const loading = status === 'loading' || status === 'idle';
  const failed = status === 'error' || status === 'unavailable';
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-2xl border border-border bg-surface text-muted-foreground shadow-soft">
          {loading ? (
            <LoaderCircle className="size-5 animate-spin text-running" />
          ) : failed ? (
            <CircleAlert className="size-5 text-danger" />
          ) : status === 'empty' ? (
            <FileJson2 className="size-5" />
          ) : (
            <Activity className="size-5" />
          )}
        </div>
        <h2 className="text-sm font-semibold">
          {loading
            ? 'Loading runtime logs'
            : status === 'empty'
              ? 'No runtime events yet'
              : 'Runtime logs unavailable'}
        </h2>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          {loading
            ? 'Reading the durable, browser-safe event snapshot from the local server…'
            : status === 'empty'
              ? 'This Session has not recorded any durable Runtime events.'
              : reason === 'session_unavailable'
                ? 'This Session is not currently readable from its Workspace.'
                : 'The local server could not return a valid log snapshot.'}
        </p>
        {failed ? (
          <Button className="mt-5" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function humanizeEventType(value: string): string {
  return value
    .split(/[._]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeFieldName(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    content: 'Message content',
    label: 'Tool label',
    message_id: 'Message ID',
    reasoning_text: 'Model reasoning',
    request_id: 'Request ID',
    text: 'Model response',
    tool_call_id: 'Tool call ID',
  };
  return labels[value] ?? humanizeEventType(value);
}

function formatLogTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

function statusClassName(status: WebSessionLogEntry['status']): string {
  if (status === 'failed') return 'border-danger/25 bg-danger/10 text-danger';
  if (status === 'ok') return 'border-running/25 bg-running/10 text-running';
  if (status === 'running') return 'border-running/25 bg-running/10 text-running';
  if (status === 'waiting') return 'border-warning/25 bg-warning/10 text-warning';
  return '';
}
