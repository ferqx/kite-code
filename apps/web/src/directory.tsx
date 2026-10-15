import {
  ClientError,
  type SessionDirectoryActivity,
  type SessionDirectoryPage,
} from '@kite-ai/client';
import { Badge, Spinner, Tooltip, TooltipContent, TooltipTrigger } from '@kite-ai/ui/desktop';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

export type DirectorySession = SessionDirectoryPage['items'][number] & {
  activity: SessionDirectoryActivity;
};

/** The SDK proves the complete snapshot; presentation never substitutes a reading clock. */
export function rootSessionDirectory(items: SessionDirectoryPage['items'], workspaceId: string) {
  const complete: DirectorySession[] = items.map((item) => {
    if (!item.activity) throw new ClientError('directory_activity_unavailable');
    return { ...item, activity: item.activity };
  });
  return complete
    .filter(
      ({ session }) => session.parentSessionId === null && session.workspaceId === workspaceId,
    )
    .sort((a, b) => {
      const left = a.activity.updatedAt,
        right = b.activity.updatedAt;
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    });
}

const runLabels: Record<NonNullable<SessionDirectoryActivity['run']>['status'], string> = {
  running: 'Running',
  waiting_interaction: 'Waiting for interaction',
  waiting_execution: 'Waiting for execution',
  cancelling: 'Cancelling',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function SessionDetails({ item }: { item: DirectorySession }) {
  const { session, activity } = item;
  return (
    <>
      <strong>{session.title}</strong>
      <dl>
        <dt>Run</dt>
        <dd>{activity.run ? runLabels[activity.run.status] : 'No runs'}</dd>
        <dt>Activity</dt>
        <dd>{activity.run?.isActive ? 'Active' : 'Inactive'}</dd>
        <dt>Required results</dt>
        <dd>{activity.run?.waitingForResults ? 'Waiting' : 'None'}</dd>
        <dt>Queued work</dt>
        <dd>{activity.queued ? 'Yes' : 'No'}</dd>
        <dt>Pending interactions</dt>
        <dd>{activity.pendingInteractions}</dd>
        <dt>Updated</dt>
        <dd>
          {activity.updatedAt === null ? (
            'Unknown'
          ) : (
            <time dateTime={new Date(activity.updatedAt).toISOString()}>
              {new Date(activity.updatedAt).toLocaleString(undefined, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                fractionalSecondDigits: 3,
                timeZoneName: 'short',
              })}
            </time>
          )}
        </dd>
      </dl>
    </>
  );
}

/** Tooltip owns only presentation; inactive navigation cannot retain an open detail. */
export function DirectoryItem({
  children,
  details,
  available,
  dark,
}: {
  children: ReactElement;
  details: ReactNode;
  available: boolean;
  dark: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);
  return (
    <Tooltip open={available && open} onOpenChange={(next) => setOpen(available && next)}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        className="web-directory-tooltip"
        data-theme={dark ? 'dark' : 'light'}
        side="right"
        sideOffset={8}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        {details}
      </TooltipContent>
    </Tooltip>
  );
}

export const directoryCSS = `[data-directory-row][href]{display:flex;align-items:center;gap:.5rem}.directory-activity{margin-left:auto;font-size:.8em;white-space:nowrap}.directory-waiting{display:inline-flex;flex-shrink:0;align-items:center;border:1px solid transparent;border-radius:999px;padding:2px 8px;background:var(--attention-background,Mark);color:var(--attention-foreground,MarkText);font-weight:500}.directory-running{display:inline-block;width:12px;height:12px;animation:directory-spin 1s linear infinite}@keyframes directory-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.directory-running{animation:none}}.web-directory-tooltip{background:Canvas;color:CanvasText;border:1px solid #8886;border-radius:5px;padding:.65rem;max-width:min(420px,calc(100vw - 16px));overflow-wrap:anywhere;z-index:20}.web-directory-tooltip[data-theme=dark]{color-scheme:dark}.web-directory-tooltip[data-theme=light]{color-scheme:light}.web-directory-tooltip dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.25rem .75rem;margin:.5rem 0 0}.web-directory-tooltip dd{margin:0}.directory-more{border:0;opacity:.7}`;

/** Waiting takes priority; an old observation never presents itself as live activity. */
export function DirectoryActivity({
  activity,
  stale,
}: {
  activity: SessionDirectoryActivity;
  stale: boolean;
}) {
  if (stale)
    return (
      <span className="directory-activity" role="status" aria-label="Last read activity">
        上次读取
      </span>
    );
  if (activity.pendingInteractions > 0)
    return <Badge className="directory-activity directory-waiting">待用户输入</Badge>;
  if (activity.run?.isActive)
    return <Spinner className="directory-activity directory-running" aria-label="正在运行" />;
  return null;
}
