import type { WebWorkspaceSummary } from '@kite-ai/kite-app-contract/web';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronDown, CircleDot, FolderKanban, Radio } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface SessionSidebarProps {
  readonly workspaces: readonly WebWorkspaceSummary[];
  readonly selectedSessionId: string | null;
  readonly onSelect: (sessionId: string) => void;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function SessionSidebar({ workspaces, selectedSessionId, onSelect }: SessionSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-sidebar">
      <header className="flex h-16 shrink-0 items-center justify-between px-5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-xl bg-accent text-accent-foreground shadow-glow">
            <Radio className="size-4" strokeWidth={2.4} />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">Kite Observer</p>
            <p className="text-[11px] text-muted-foreground">Local · read only</p>
          </div>
        </div>
        <Badge>V1</Badge>
      </header>
      <div className="px-5 pb-3 pt-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Workspaces
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-3 pb-5">
        {workspaces.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
            No Workspace sessions are available.
          </div>
        ) : (
          <nav aria-label="Workspace sessions" className="space-y-2">
            {workspaces.map((workspace) => (
              <CollapsiblePrimitive.Root key={workspace.workspaceId} defaultOpen>
                <CollapsiblePrimitive.Trigger className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-surface">
                  <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                  <FolderKanban className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
                  <span className="text-[10px] tabular-nums">{workspace.sessions.length}</span>
                </CollapsiblePrimitive.Trigger>
                <CollapsiblePrimitive.Content className="mt-1 space-y-1">
                  {workspace.sessions.map((session) => {
                    const selected = session.sessionId === selectedSessionId;
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        onClick={() => onSelect(session.sessionId)}
                        aria-current={selected ? 'page' : undefined}
                        aria-label={`View ${session.displayName}`}
                        className={cn(
                          'group relative w-full rounded-xl border px-3 py-3 text-left transition-colors',
                          selected
                            ? 'border-border-strong bg-surface-raised shadow-soft'
                            : 'border-transparent hover:border-border hover:bg-surface',
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <CircleDot
                            className={cn(
                              'mt-0.5 size-3.5 shrink-0',
                              session.status === 'running'
                                ? 'text-running'
                                : 'text-muted-foreground/60',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                'truncate text-xs font-medium',
                                selected && 'text-foreground',
                              )}
                            >
                              {session.displayName}
                            </p>
                            <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
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
