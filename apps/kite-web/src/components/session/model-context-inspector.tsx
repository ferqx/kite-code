import {
  Bot,
  CircleAlert,
  FileText,
  Info,
  LoaderCircle,
  MessageSquareText,
  Settings2,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { WebModelContextPart, WebModelContextSnapshot } from '@/presentation/types';

type InspectorTab = 'overview' | 'system' | 'messages' | 'tools' | 'settings';

const INSPECTOR_TABS: readonly {
  readonly id: InspectorTab;
  readonly label: string;
  readonly Icon: typeof Info;
}[] = [
  { id: 'overview', label: 'Overview', Icon: Info },
  { id: 'system', label: 'System prompt', Icon: FileText },
  { id: 'messages', label: 'Messages', Icon: MessageSquareText },
  { id: 'tools', label: 'Tools', Icon: Wrench },
  { id: 'settings', label: 'Request settings', Icon: Settings2 },
];

export function ModelContextInspector({
  invocationId,
  context,
  status,
  reason,
  onClose,
  onRetry,
}: {
  readonly invocationId: string;
  readonly context?: WebModelContextSnapshot;
  readonly status: 'loading' | 'loaded' | 'error';
  readonly reason: string | null;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('overview');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <button
        type="button"
        aria-label="Dismiss model context inspector"
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-context-title"
        className="relative flex h-full w-[min(760px,92vw)] flex-col border-l border-border bg-canvas shadow-[-18px_0_48px_rgb(0_0_0/0.18)] max-sm:w-full"
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border/70 bg-surface-subtle/70 text-muted-foreground">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="model-context-title" className="text-sm font-semibold">
                Model context
              </h2>
              <Badge>Local diagnostic</Badge>
            </div>
            <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
              {invocationId}
            </p>
          </div>
          <Button
            autoFocus
            aria-label="Close model context inspector"
            className="size-8 px-0"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        {status === 'loaded' && context ? (
          <>
            <div
              role="tablist"
              aria-label="Model context sections"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pt-2"
            >
              {INSPECTOR_TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  id={`model-context-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={`model-context-panel-${id}`}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[10px] font-medium transition-colors',
                    tab === id
                      ? 'border-accent text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setTab(id)}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div
                id={`model-context-panel-${tab}`}
                role="tabpanel"
                aria-labelledby={`model-context-tab-${tab}`}
                className="px-5 pb-16 pt-5"
              >
                <InspectorContent tab={tab} context={context} />
              </div>
            </ScrollArea>
          </>
        ) : (
          <InspectorState status={status} reason={reason} onRetry={onRetry} />
        )}
      </section>
    </div>
  );
}

function InspectorContent({
  tab,
  context,
}: {
  readonly tab: InspectorTab;
  readonly context: WebModelContextSnapshot;
}) {
  switch (tab) {
    case 'overview':
      return <Overview context={context} />;
    case 'system':
      return (
        <PromptSection
          title="Exact system prompt"
          description="The provider-neutral system text frozen for this invocation."
          text={context.systemPrompt.text}
          truncated={context.systemPrompt.truncated}
        />
      );
    case 'messages':
      return <Messages context={context} />;
    case 'tools':
      return <Tools context={context} />;
    case 'settings':
      return <RequestSettings context={context} />;
  }
}

function Overview({ context }: { readonly context: WebModelContextSnapshot }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-warning/25 bg-warning/8 p-4">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          <ShieldCheck className="size-4 text-warning" />
          Sensitive local diagnostic
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          This snapshot contains the exact prompt and conversation context sent to the model. It is
          read-only and remains on the local Service origin.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Fact label="Provider" value={context.model.provider} />
        <Fact label="Model" value={context.model.name} />
        <Fact label="Purpose" value={humanize(context.purpose)} />
        <Fact label="Runtime sequence" value={`#${context.sequence}`} />
        <Fact label="Messages" value={String(context.requestSettings.messageCount)} />
        <Fact label="Tools" value={String(context.requestSettings.toolCount)} />
      </div>
      <div className="rounded-xl border border-border bg-surface-subtle/50 p-4">
        <h3 className="text-[11px] font-semibold">What is included</h3>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          The system prompt, canonical conversation messages, provider-facing tool declarations, and
          safe request settings for this exact invocation. Credentials, endpoint URLs, Provider
          options and Artifact identifiers are excluded.
        </p>
      </div>
    </div>
  );
}

function PromptSection({
  title,
  description,
  text,
  truncated,
}: {
  readonly title: string;
  readonly description: string;
  readonly text: string;
  readonly truncated: boolean;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold">{title}</h3>
      <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{description}</p>
      {truncated ? <TruncatedNotice /> : null}
      <pre className="mt-4 whitespace-pre-wrap break-words rounded-xl border border-border bg-terminal p-4 font-mono text-[10px] leading-5 text-terminal-copy">
        {text || 'No content'}
      </pre>
    </div>
  );
}

function Messages({ context }: { readonly context: WebModelContextSnapshot }) {
  return (
    <div>
      <h3 className="text-xs font-semibold">Canonical messages</h3>
      <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
        Provider-neutral messages after Runtime projection and before transport serialization.
      </p>
      {context.messagesTruncated ? <TruncatedNotice /> : null}
      <div className="mt-4 space-y-3">
        {context.messages.map((message) => (
          <article key={message.index} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <Badge className="capitalize">{message.role}</Badge>
              <span className="font-mono text-[9px] text-muted-foreground">
                message {message.index + 1}
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {message.parts.map((part, index) => (
                <MessagePart key={`${message.index}:${index}`} part={part} />
              ))}
            </div>
          </article>
        ))}
        {context.messages.length === 0 ? <EmptyCopy>No messages were sent.</EmptyCopy> : null}
      </div>
    </div>
  );
}

function MessagePart({ part }: { readonly part: WebModelContextPart }) {
  if (part.type === 'text' || part.type === 'reasoning') {
    return (
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {part.type}
          {part.truncated ? <Badge>truncated</Badge> : null}
        </div>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-terminal px-3 py-2.5 font-mono text-[10px] leading-5 text-terminal-copy">
          {part.text || 'No content'}
        </pre>
      </div>
    );
  }
  const body = part.type === 'tool_call' ? part.inputJson : part.output;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[9px] text-muted-foreground">
        <Badge>{humanize(part.type)}</Badge>
        <code>{part.toolName}</code>
        <code>{part.toolCallId}</code>
        {part.truncated ? <Badge>truncated</Badge> : null}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-terminal px-3 py-2.5 font-mono text-[10px] leading-5 text-terminal-copy">
        {body || 'No content'}
      </pre>
    </div>
  );
}

function Tools({ context }: { readonly context: WebModelContextSnapshot }) {
  return (
    <div>
      <h3 className="text-xs font-semibold">Provider-facing tools</h3>
      <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
        Exact names, descriptions and JSON Schemas disclosed to this invocation.
      </p>
      {context.toolsTruncated ? <TruncatedNotice /> : null}
      <div className="mt-4 space-y-2">
        {context.tools.map((tool) => (
          <details key={tool.name} className="group rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer list-none px-4 py-3 text-[11px] font-medium">
              <span className="flex items-center gap-2">
                <Wrench className="size-3.5 text-muted-foreground" />
                <code>{tool.name}</code>
                {tool.truncated ? <Badge>truncated</Badge> : null}
              </span>
              {tool.description ? (
                <span className="mt-1.5 block text-[10px] font-normal leading-5 text-muted-foreground">
                  {tool.description}
                </span>
              ) : null}
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-terminal px-4 py-3 font-mono text-[10px] leading-5 text-terminal-copy">
              {tool.inputSchemaJson}
            </pre>
          </details>
        ))}
        {context.tools.length === 0 ? <EmptyCopy>No tools were disclosed.</EmptyCopy> : null}
      </div>
    </div>
  );
}

function RequestSettings({ context }: { readonly context: WebModelContextSnapshot }) {
  return (
    <div>
      <h3 className="text-xs font-semibold">Safe request settings</h3>
      <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
        Credentials, endpoint details and Provider-native options are intentionally excluded.
      </p>
      <dl className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface">
        <Setting label="Transport" value={context.requestSettings.transport} />
        <Setting label="Temperature" value={String(context.requestSettings.temperature)} />
        <Setting
          label="Max output tokens"
          value={context.requestSettings.maxOutputTokens?.toLocaleString() ?? 'Provider default'}
        />
        <Setting label="Stop policy" value="Single step" />
        <Setting label="Canonical messages" value={String(context.requestSettings.messageCount)} />
        <Setting label="Disclosed tools" value={String(context.requestSettings.toolCount)} />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 truncate text-[11px] font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}

function Setting({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-right text-foreground">{value}</dd>
    </div>
  );
}

function TruncatedNotice() {
  return (
    <p className="mt-3 rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-[10px] leading-5 text-muted-foreground">
      This section exceeded the bounded Browser diagnostic response and was truncated.
    </p>
  );
}

function EmptyCopy({ children }: { readonly children: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border p-5 text-center text-[10px] text-muted-foreground">
      {children}
    </p>
  );
}

function InspectorState({
  status,
  reason,
  onRetry,
}: {
  readonly status: 'loading' | 'loaded' | 'error';
  readonly reason: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-10 place-items-center rounded-xl border border-border/70 bg-surface/75 text-muted-foreground">
          {status === 'loading' ? (
            <LoaderCircle className="size-5 animate-spin text-running" />
          ) : (
            <CircleAlert className="size-5 text-danger" />
          )}
        </div>
        <h3 className="text-sm font-semibold">
          {status === 'loading' ? 'Loading model context' : 'Model context unavailable'}
        </h3>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          {status === 'loading'
            ? 'Reading and validating the immutable Model Surface Artifact…'
            : reason === 'session_unavailable'
              ? 'This Session or invocation is no longer available.'
              : 'The local Service could not return a valid bounded Model Context snapshot.'}
        </p>
        {status === 'error' ? (
          <Button className="mt-5" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function humanize(value: string): string {
  return value
    .split(/[._]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
