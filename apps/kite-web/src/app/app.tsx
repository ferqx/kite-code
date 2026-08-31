import { BookOpen, Circle, History, Menu, PlugZap, Radio, Unplug } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { SessionSidebar } from '@/components/session/session-sidebar';
import { MessageList } from '@/components/timeline/message-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  initialWebPresentationState,
  selectedSession,
  type WebHistoryState,
  webPresentationReducer,
} from '@/presentation/reducer';
import type { WebCheckpointSummary } from '@/presentation/types';
import type { WebRestTransport } from '@/transport/client';
import { createWebRestTransport, WebRestTransportError } from '@/transport/client';

export interface AppProps {
  /** Test/composition seam; production creates the closed browser transport. */
  readonly transport?: WebRestTransport;
}

export function App(props: AppProps = {}) {
  const [state, dispatch] = useReducer(webPresentationReducer, initialWebPresentationState);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const transport = useMemo(() => props.transport ?? createWebRestTransport(), [props.transport]);
  const lifecycle = useRef(0);
  const observedSequence = useRef(0);
  const deferredDisconnect = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = selectedSession(state);

  const expandWorkspace = async (workspaceId: string) => {
    const workspace = state.workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace || workspace.sessionState === 'loading' || workspace.sessionState === 'loaded') {
      return;
    }
    const generation = state.generation;
    dispatch({ type: 'workspace_sessions_loading', workspaceId, generation });
    try {
      const sessions = await transport.listWorkspaceSessions(workspaceId);
      dispatch({ type: 'workspace_sessions_loaded', workspaceId, sessions, generation });
    } catch {
      dispatch({ type: 'workspace_sessions_failed', workspaceId, generation });
    }
  };

  useEffect(() => {
    const lifecycleId = ++lifecycle.current;
    if (deferredDisconnect.current !== undefined) {
      clearTimeout(deferredDisconnect.current);
      deferredDisconnect.current = undefined;
    }
    let active = true;
    const load = async () => {
      try {
        const connection = await transport.connect();
        if (!active) return;
        dispatch({ type: 'transport_connected', generation: connection.generation });
        const directory = await transport.listDirectory();
        if (active) {
          dispatch({
            type: 'directory_loaded',
            directory,
            generation: connection.generation,
          });
        }
      } catch (error) {
        if (active) {
          dispatch({
            type: 'connection',
            connection: { status: 'unavailable', reason: failureReason(error) },
          });
        }
      }
    };
    void load();
    return () => {
      active = false;
      deferredDisconnect.current = setTimeout(() => {
        deferredDisconnect.current = undefined;
        if (lifecycle.current === lifecycleId) void transport.disconnect().catch(() => undefined);
      }, 0);
    };
  }, [transport]);

  useEffect(() => {
    const sessionId = state.selectedSessionId;
    const generation = state.generation;
    if (!sessionId || generation === 0) {
      return;
    }
    let active = true;
    observedSequence.current = 0;
    dispatch({ type: 'connection', connection: { status: 'loading' }, generation });
    dispatch({
      type: 'history_loading',
      generation,
      requestToken: state.historyReloadToken,
    });
    const loadHistory = async () => {
      try {
        const history = await transport.loadHistory(sessionId);
        if (!active) return;
        observedSequence.current = history.observedLastSequence;
        dispatch({ type: 'history_loaded', history, generation });
      } catch (error) {
        if (!active) return;
        dispatch({
          type: 'history_failed',
          status: historyFailureStatus(error),
          reason: historyFailureReason(error),
          generation,
        });
        dispatch({
          type: 'connection',
          connection: { status: 'unavailable', reason: failureReason(error) },
          generation,
        });
      }
    };
    const loadCheckpoints = async () => {
      try {
        const snapshot = await transport.loadCheckpoints(sessionId);
        if (active) {
          dispatch({
            type: 'checkpoints_loaded',
            sessionId,
            checkpoints: snapshot.checkpoints,
            generation,
          });
        }
      } catch {
        if (active) dispatch({ type: 'checkpoints_failed', sessionId, generation });
      }
    };
    void loadHistory();
    void loadCheckpoints();
    return () => {
      active = false;
    };
  }, [state.generation, state.historyReloadToken, state.selectedSessionId, transport]);

  useEffect(() => {
    const sessionId = state.selectedSessionId;
    const generation = state.generation;
    if (
      !sessionId ||
      generation === 0 ||
      state.connection.status !== 'connected' ||
      (state.historyState !== 'content' && state.historyState !== 'empty') ||
      (session?.status !== 'running' && session?.status !== 'waiting')
    ) {
      return;
    }
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling || document.visibilityState !== 'visible') return;
      polling = true;
      try {
        const [history, refreshedSession] = await Promise.all([
          transport.loadHistory(sessionId, observedSequence.current),
          transport.getSession(sessionId),
        ]);
        if (!active) return;
        observedSequence.current = history.observedLastSequence;
        dispatch({ type: 'history_increment_loaded', history, generation });
        dispatch({ type: 'session_refreshed', session: refreshedSession, generation });
      } catch (error) {
        if (active) {
          dispatch({
            type: 'connection',
            connection: { status: 'unavailable', reason: failureReason(error) },
            generation,
          });
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    session?.status,
    state.connection.status,
    state.generation,
    state.historyState,
    state.selectedSessionId,
    transport,
  ]);

  const disconnect = async () => {
    try {
      await transport.disconnect();
    } catch {
      // The browser is already leaving the Observer surface; do not expose a
      // transport diagnostic or invent a Runtime failure for this action.
    } finally {
      dispatch({ type: 'disconnect' });
    }
  };

  return (
    <main className="grid h-dvh grid-cols-[320px_minmax(0,1fr)] overflow-hidden max-lg:grid-cols-[280px_minmax(0,1fr)] max-md:grid-cols-1">
      <div className="h-full max-md:hidden">
        <SessionSidebar
          workspaces={state.workspaces}
          selectedSessionId={state.selectedSessionId}
          onSelect={(sessionId) => dispatch({ type: 'select_session', sessionId })}
          onExpandWorkspace={(workspaceId) => void expandWorkspace(workspaceId)}
        />
      </div>
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 grid grid-cols-[min(86vw,320px)_1fr] md:hidden">
          <SessionSidebar
            workspaces={state.workspaces}
            selectedSessionId={state.selectedSessionId}
            onSelect={(sessionId) => {
              dispatch({ type: 'select_session', sessionId });
              setMobileSidebarOpen(false);
            }}
            onExpandWorkspace={(workspaceId) => void expandWorkspace(workspaceId)}
          />
          <button
            type="button"
            aria-label="Close workspace list"
            className="bg-black/55 backdrop-blur-sm"
            onClick={() => setMobileSidebarOpen(false)}
          />
        </div>
      ) : null}
      <section className="flex min-h-0 flex-col bg-canvas">
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-canvas/90 px-5 backdrop-blur">
          <Button
            aria-label="Open workspace list"
            aria-expanded={mobileSidebarOpen}
            className="size-9 px-0 md:hidden"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight">
                {session?.displayName ?? 'Select a session'}
              </h1>
              {session ? <Badge className="capitalize">{session.status}</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              Read-only presentation · no Runtime controls
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Circle
              className={
                state.connection.status === 'connected'
                  ? 'size-2.5 fill-running text-running'
                  : 'size-2.5 fill-muted text-muted'
              }
            />
            <span className="hidden sm:inline">{state.connection.status.replace('_', ' ')}</span>
          </div>
          <a
            href="/api-docs"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <BookOpen className="size-3.5" />
            <span className="max-sm:hidden">API docs</span>
          </a>
          <Separator className="h-6 w-px" />
          <Button
            onClick={() => void disconnect()}
            disabled={state.connection.status === 'disconnected'}
          >
            {state.connection.status === 'disconnected' ? (
              <PlugZap className="size-3.5" />
            ) : (
              <Unplug className="size-3.5" />
            )}
            <span className="max-sm:hidden">Disconnect</span>
          </Button>
        </header>
        {state.connection.status === 'unavailable' &&
        (state.historyState === 'content' || state.historyState === 'empty') ? (
          <div
            role="status"
            className="mx-6 mt-4 flex shrink-0 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted-foreground"
          >
            <Radio className="size-4 shrink-0 text-muted-foreground" />
            <span>Automatic refresh is unavailable. Showing the latest REST snapshot.</span>
          </div>
        ) : null}
        {state.selectedSessionId ? (
          <CheckpointStrip checkpoints={state.checkpoints} status={state.checkpointState} />
        ) : null}
        {state.selectedSessionId === null ? (
          <DirectoryState
            sessionCount={state.workspaces.reduce(
              (total, workspace) => total + workspace.sessions.length,
              0,
            )}
            connection={state.connection.status}
          />
        ) : (
          <MessageList
            messages={state.messages}
            status={state.historyState}
            reason={state.historyReason}
            sessionName={session?.displayName}
            onRetry={() => dispatch({ type: 'history_retry', generation: state.generation })}
          />
        )}
      </section>
    </main>
  );
}

function CheckpointStrip({
  checkpoints,
  status,
}: {
  readonly checkpoints: readonly WebCheckpointSummary[];
  readonly status: 'idle' | 'loading' | 'loaded' | 'unavailable';
}) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-6 text-[11px] text-muted-foreground">
      <History className="size-3.5" />
      <span>
        {status === 'loading'
          ? 'Loading checkpoints…'
          : status === 'unavailable'
            ? 'Checkpoints unavailable'
            : `${checkpoints.length} checkpoint${checkpoints.length === 1 ? '' : 's'}`}
      </span>
      {status === 'loaded'
        ? checkpoints.slice(-3).map((checkpoint) => (
            <Badge key={checkpoint.checkpointId} className="font-mono text-[9px]">
              {checkpoint.label ?? `r${checkpoint.revision}`}
            </Badge>
          ))
        : null}
    </div>
  );
}

function DirectoryState({
  sessionCount,
  connection,
}: {
  readonly sessionCount: number;
  readonly connection: string;
}) {
  const unavailable = connection === 'unavailable';
  const loading = connection === 'loading' || connection === 'reconnecting';
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <Radio className="mx-auto mb-4 size-8 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {loading
            ? 'Connecting to Kite Observer'
            : unavailable
              ? 'Observer unavailable'
              : sessionCount === 0
                ? 'No sessions available'
                : 'Select a session'}
        </h2>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          {loading
            ? 'Loading the read-only Workspace directory…'
            : unavailable
              ? 'Start the local Kite Service, then reopen its Web URL.'
              : sessionCount === 0
                ? 'Existing Workspace sessions will appear here when the server publishes them.'
                : 'Choose an existing Session from the Workspace list to view its History.'}
        </p>
      </div>
    </div>
  );
}

function failureReason(error: unknown): string {
  return error instanceof WebRestTransportError ? error.reason : 'service_unavailable';
}

function historyFailureStatus(error: unknown): Extract<WebHistoryState, 'unavailable' | 'error'> {
  if (!(error instanceof WebRestTransportError)) return 'error';
  return error.reason === 'protocol_error' ? 'error' : 'unavailable';
}

function historyFailureReason(error: unknown): string {
  return error instanceof WebRestTransportError ? error.reason : 'history_error';
}
