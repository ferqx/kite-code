import { ScrollArea } from './components/ui/scroll-area';
import { sessionStatusLabel } from './status';
import type { SessionSummary, WorkspaceSummary } from './types';
import { Button } from './ui';

interface WorkbenchProps {
  workspaces: readonly WorkspaceSummary[];
  onOpen?: (id: string) => void;
}

type WorkbenchSession = SessionSummary & { workspaceLabel: string };

function Section({
  title,
  sessions,
  onOpen,
}: {
  title: string;
  sessions: readonly WorkbenchSession[];
  onOpen?: (id: string) => void;
}) {
  if (!sessions.length) return null;
  return (
    <section className="workbench-section">
      <header>
        <h2>{title}</h2>
        <span>{sessions.length}</span>
      </header>
      <div className="workbench-items">
        {sessions.map((session) => {
          const status = sessionStatusLabel(session.status);
          return (
            <Button
              key={session.sessionId}
              className="workbench-item"
              disabled={!onOpen}
              onClick={() => onOpen?.(session.sessionId)}
            >
              <span>
                <strong>{session.displayName}</strong>
                <small>
                  {session.workspaceLabel}
                  {status ? ` · ${status}` : ''}
                </small>
              </span>
              {session.pendingInteractions || session.status === 'running' ? (
                <span className="workbench-status-dot" role="img" aria-label="有新状态" />
              ) : null}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

export function Workbench({ workspaces, onOpen }: WorkbenchProps) {
  const sessions = workspaces
    .flatMap((workspace) =>
      workspace.sessions.map((session) => ({ ...session, workspaceLabel: workspace.label })),
    )
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  const progressing = sessions.filter((session) => ['queued', 'running'].includes(session.status));
  const recent = sessions.filter((session) => !progressing.includes(session));
  return (
    <ScrollArea className="workbench-scroll">
      <section className="workbench" aria-label="工作台">
        <Section title="正在推进" sessions={progressing} onOpen={onOpen} />
        <Section title="最近会话" sessions={recent} onOpen={onOpen} />
      </section>
    </ScrollArea>
  );
}
