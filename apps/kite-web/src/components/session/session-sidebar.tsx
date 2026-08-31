import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronDown, CircleDot, FolderKanban, Radio, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { WebWorkspaceSummary } from '@/presentation/types';

interface SessionSidebarProps {
  readonly workspaces: readonly WebWorkspaceSummary[];
  readonly selectedSessionId: string | null;
  readonly onSelect: (sessionId: string) => void;
  readonly onExpandWorkspace: (workspaceId: string) => void;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function SessionSidebar({
  workspaces,
  selectedSessionId,
  onSelect,
  onExpandWorkspace,
}: SessionSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-sidebar">
      <header className="flex h-16 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-[10px] bg-foreground text-canvas shadow-soft">
            <Radio className="size-[15px]" strokeWidth={2.3} />
          </span>
          <div>
            <p className="text-[13px] font-semibold tracking-[-0.01em]">Kite</p>
            <p className="text-[10px] text-muted-foreground">Observer</p>
          </div>
        </div>
        <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <ShieldCheck className="size-3" />
          Local
        </span>
      </header>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Workspaces
        </p>
        <Badge>{workspaces.length}</Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2.5 pb-5">
        {workspaces.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
            No Workspace sessions are available.
          </div>
        ) : (
          <nav aria-label="Workspace sessions" className="min-w-0 max-w-full space-y-1.5">
            {workspaces.map((workspace) => (
              <CollapsiblePrimitive.Root
                key={workspace.workspaceId}
                className="min-w-0 max-w-full"
                defaultOpen={workspace.sessionState === 'loaded'}
                onOpenChange={(open) => {
                  if (open && workspace.sessionState === 'idle') {
                    onExpandWorkspace(workspace.workspaceId);
                  }
                }}
              >
                <CollapsiblePrimitive.Trigger className="group flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground">
                  <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                  <FolderKanban className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
                  <span className="text-[10px] tabular-nums">{workspace.sessionCount}</span>
                </CollapsiblePrimitive.Trigger>
                <CollapsiblePrimitive.Content className="mt-0.5 min-w-0 max-w-full space-y-0.5 overflow-hidden">
                  {workspace.sessionState === 'loading' ? (
                    <p className="px-3 py-2 text-[10px] text-muted-foreground">Loading sessions…</p>
                  ) : null}
                  {workspace.sessionState === 'unavailable' ? (
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-[10px] text-muted-foreground hover:bg-surface"
                      onClick={() => onExpandWorkspace(workspace.workspaceId)}
                    >
                      Sessions unavailable · retry
                    </button>
                  ) : null}
                  {workspace.sessionState === 'loaded' && workspace.sessions.length === 0 ? (
                    <p className="px-3 py-2 text-[10px] text-muted-foreground">No sessions</p>
                  ) : null}
                  {workspace.sessions.map((session) => {
                    const selected = session.sessionId === selectedSessionId;
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        onClick={() => onSelect(session.sessionId)}
                        aria-current={selected ? 'page' : undefined}
                        aria-label={`View ${session.displayName}`}
                        title={session.displayName}
                        className={cn(
                          'group relative w-full min-w-0 max-w-full overflow-hidden rounded-[10px] border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow]',
                          selected
                            ? 'border-border-strong bg-surface-selected shadow-[inset_3px_0_0_var(--accent)]'
                            : 'border-transparent hover:border-border hover:bg-surface-subtle',
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <CircleDot
                            className={cn(
                              'mt-0.5 size-3 shrink-0',
                              session.status === 'running'
                                ? 'text-running'
                                : 'text-muted-foreground/60',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                'line-clamp-2 max-w-full break-all text-[12px] font-medium tracking-[-0.005em]',
                                selected && 'text-foreground',
                              )}
                              title={session.displayName}
                            >
                              {session.displayName}
                            </p>
                            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                              <span className="capitalize">{session.status}</span>
                              <time>{relativeTime(session.updatedAt)}</time>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </CollapsiblePrimitive.Content>
              </CollapsiblePrimitive.Root>
            ))}
          </nav>
        )}
      </ScrollArea>
    </aside>
  );
}
