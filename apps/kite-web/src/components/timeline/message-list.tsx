import type { WebPresentationBlock, WebPresentationMessage } from '@kite-ai/kite-app-contract/web';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudOff,
  LoaderCircle,
  MessageSquareText,
  Terminal,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { WebHistoryState } from '@/presentation/reducer';

function Block({ block }: { readonly block: WebPresentationBlock }) {
  switch (block.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap text-[14px] leading-7 text-copy">{block.text}</p>;
    case 'thinking':
      return (
        <CollapsiblePrimitive.Root className="rounded-xl border border-border bg-surface/70">
          <CollapsiblePrimitive.Trigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-muted-foreground">
            {block.complete ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <LoaderCircle className="size-3.5 animate-spin" />
            )}
            <span className="font-medium text-foreground/80">Thinking</span>
            <span className="min-w-0 flex-1 truncate">{block.text}</span>
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsiblePrimitive.Trigger>
          <CollapsiblePrimitive.Content className="border-t border-border px-3 py-3 text-xs leading-6 text-muted-foreground">
            {block.text}
          </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
      );
    case 'tool_activity':
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
          <LoaderCircle className="size-3.5 animate-spin text-running" />
          <span className="font-medium">{block.label}</span>
          {block.summary ? (
            <span className="min-w-0 truncate text-muted-foreground">{block.summary}</span>
          ) : null}
        </div>
      );
    case 'tool_result':
      return (
        <CollapsiblePrimitive.Root className="overflow-hidden rounded-xl border border-border bg-terminal">
          <CollapsiblePrimitive.Trigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs">
            <Terminal className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{block.label}</span>
            <span className="flex-1 text-muted-foreground">
              {block.ok ? 'completed' : 'failed'}
            </span>
            {block.exitCode === undefined ? null : (
              <span className="font-mono text-[10px] text-muted-foreground">
                exit {block.exitCode}
              </span>
            )}
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsiblePrimitive.Trigger>
          <CollapsiblePrimitive.Content>
            <pre className="max-h-56 overflow-auto border-t border-border px-3 py-3 font-mono text-[11px] leading-5 text-terminal-copy">
              {[block.stdout, block.stderr].filter(Boolean).join('\n') || 'No output'}
            </pre>
          </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
      );
    case 'error':
      return (
        <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <CircleAlert className="size-4" />
          {block.text}
        </div>
      );
    case 'status':
      return <p className="text-xs text-muted-foreground">{block.text ?? block.status}</p>;
  }
}

function Message({ message }: { readonly message: WebPresentationMessage }) {
  const user = message.role === 'user';
  return (
    <article className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 py-5">
      <span className="grid size-8 place-items-center rounded-xl border border-border bg-surface text-muted-foreground">
        {user ? <User className="size-4" /> : <Bot className="size-4" />}
      </span>
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-xs font-semibold">
            {user ? 'You' : message.role === 'system' ? 'Kite status' : 'Kite'}
          </h2>
          <span className="font-mono text-[9px] text-muted-foreground">#{message.sequence}</span>
        </div>
        <div className="space-y-2.5">
          {message.blocks.map((block, index) => (
            <Block key={`${message.messageId}-${block.kind}-${index}`} block={block} />
          ))}
        </div>
      </div>
    </article>
  );
}

export function MessageList({
  messages,
  status,
  reason,
  sessionName,
  onRetry,
}: {
  readonly messages: readonly WebPresentationMessage[];
  readonly status: WebHistoryState;
  readonly reason: string | null;
  readonly sessionName?: string;
  readonly onRetry?: () => void;
}) {
  if (status !== 'content' || messages.length === 0) {
    return (
      <HistoryStatePanel
        status={status}
        reason={reason}
        sessionName={sessionName}
        onRetry={onRetry}
      />
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-5">
        {messages.map((message) => (
          <Message key={message.messageId} message={message} />
        ))}
      </div>
    </ScrollArea>
  );
}

function HistoryStatePanel({
  status,
  reason,
  sessionName,
  onRetry,
}: {
  readonly status: WebHistoryState;
  readonly reason: string | null;
  readonly sessionName?: string;
  readonly onRetry?: () => void;
}) {
  const copy = historyStateCopy(status, reason, sessionName);
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-2xl border border-border bg-surface text-muted-foreground">
          <copy.Icon className={copy.iconClassName} />
        </div>
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">{copy.description}</p>
        {copy.canRetry && onRetry ? (
          <Button className="mt-5" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function historyStateCopy(
  status: WebHistoryState,
  reason: string | null,
  sessionName: string | undefined,
): {
  readonly Icon: LucideIcon;
  readonly iconClassName: string;
  readonly title: string;
  readonly description: string;
  readonly canRetry: boolean;
} {
  switch (status) {
    case 'loading':
      return {
        Icon: LoaderCircle,
        iconClassName: 'size-5 animate-spin text-running',
        title: sessionName ? `Loading ${sessionName}` : 'Loading session History',
        description: 'Fetching the read-only conversation from the local server…',
        canRetry: false,
      };
    case 'empty':
      return {
        Icon: MessageSquareText,
        iconClassName: 'size-5',
        title: 'No messages yet',
        description: 'This Session has no recorded messages to display.',
        canRetry: false,
      };
    case 'unavailable':
      return {
        Icon: CloudOff,
        iconClassName: 'size-5',
        title: 'History unavailable',
        description:
          reason === 'session_unavailable'
            ? 'This Session is not currently available from its Workspace Worker.'
            : 'The local server could not read this Session right now.',
        canRetry: true,
      };
    case 'error':
      return {
        Icon: CircleAlert,
        iconClassName: 'size-5 text-danger',
        title: 'Could not load History',
        description:
          reason === 'resync_required'
            ? 'The History changed while it was being read. Reload to request a consistent snapshot.'
            : 'The local server returned an invalid or incomplete History response.',
        canRetry: true,
      };
    case 'idle':
      return {
        Icon: MessageSquareText,
        iconClassName: 'size-5',
        title: 'Select a session',
        description: 'Choose an existing Session from the Workspace list to view its History.',
        canRetry: false,
      };
    case 'content':
      return {
        Icon: MessageSquareText,
        iconClassName: 'size-5',
        title: 'No messages to display',
        description: 'This Session has no displayable messages in the current snapshot.',
        canRetry: false,
      };
  }
}
