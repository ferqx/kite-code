import { SessionPage } from '@kite-ai/kite-client-ui';
import { History, ListTree, MessageSquareText, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { ModelContextInspector } from '@/components/session/model-context-inspector';
import { SessionLogList, type WebLogState } from '@/components/session/session-log-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pageMessages, pageWorkspaces } from '@/presentation/page';
import {
  initialWebPresentationState,
  selectedSession,
  type WebHistoryState,
  webPresentationReducer,
} from '@/presentation/reducer';
import type {
  WebCheckpointSummary,
  WebModelContextSnapshot,
  WebSessionLogEntry,
} from '@/presentation/types';
import type { WebRestTransport } from '@/transport/client';
import { createWebRestTransport, WebRestTransportError } from '@/transport/client';

export interface AppProps {
  /** Test/composition seam; the SPA root injects the shared production transport. */
  readonly transport?: WebRestTransport;
}

export function App(props: AppProps = {}) {
  const navigate = useNavigate();
  const sessionRoute = useMatch('/sessions/:sessionId');
  const routeSessionId = sessionRoute?.params.sessionId ?? null;
  const [state, dispatch] = useReducer(webPresentationReducer, initialWebPresentationState);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [activeSessionView, setActiveSessionView] = useState<'history' | 'logs'>('history');
  const [logState, setLogState] = useState<WebLogState>('idle');
  const [logEntries, setLogEntries] = useState<readonly WebSessionLogEntry[]>([]);
  const [logThroughSequence, setLogThroughSequence] = useState(0);
  const [logReason, setLogReason] = useState<string | null>(null);
  const [modelContextView, setModelContextView] = useState<{
    readonly invocationId: string;
    readonly status: 'loading' | 'loaded' | 'error';
    readonly context?: WebModelContextSnapshot;
    readonly reason: string | null;
  } | null>(null);
  const transport = useMemo(() => props.transport ?? createWebRestTransport(), [props.transport]);
  const initialSessionRoute = useRef(routeSessionId);
  const logLifecycle = useRef(0);
  const modelContextLifecycle = useRef(0);
  const diagnosticScope = useRef<{
    readonly generation: number;
    readonly sessionId: string | null;
  }>({ generation: 0, sessionId: null });
  const currentDiagnosticScope = useRef(diagnosticScope.current);
  currentDiagnosticScope.current = {
    generation: state.generation,
    sessionId: state.selectedSessionId,
  };
  const observedSequence = useRef(0);
  const session = selectedSession(state);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    dispatch({ type: 'select_session', sessionId: routeSessionId });
  }, [routeSessionId]);

  useEffect(() => {
    if (
      diagnosticScope.current.generation === state.generation &&
      diagnosticScope.current.sessionId === state.selectedSessionId
    ) {
      return;
    }
    diagnosticScope.current = {
      generation: state.generation,
      sessionId: state.selectedSessionId,
    };
    logLifecycle.current += 1;
    modelContextLifecycle.current += 1;
    setModelContextView(null);
    setActiveSessionView('history');
    setLogState('idle');
    setLogEntries([]);
    setLogThroughSequence(0);
    setLogReason(null);
  }, [state.generation, state.selectedSessionId]);

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
    let active = true;
    const load = async () => {
      try {
        const connection = await transport.connect();
        if (!active) return;
        dispatch({ type: 'transport_connected', generation: connection.generation });
        const directory = await transport.listDirectory();
        let routeSession: Awaited<ReturnType<WebRestTransport['getSession']>> | undefined;
        if (initialSessionRoute.current) {
          try {
            routeSession = await transport.getSession(initialSessionRoute.current);
          } catch (error) {
            if (error instanceof WebRestTransportError && error.status === 404) {
              if (active) navigate('/', { replace: true });
            } else {
              throw error;
            }
          }
        }
        if (active) {
          dispatch({
            type: 'directory_loaded',
            directory,
            generation: connection.generation,
          });
          if (routeSession) {
            dispatch({
              type: 'route_session_loaded',
              session: routeSession,
              generation: connection.generation,
            });
          }
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
    };
  }, [navigate, transport]);

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

  const loadSessionLogs = async () => {
    const sessionId = state.selectedSessionId;
    const generation = state.generation;
    if (!sessionId || generation === 0) return;
    const requestId = ++logLifecycle.current;
    setLogState('loading');
    setLogReason(null);
    try {
      const snapshot = await transport.loadLogs(sessionId);
      if (
        requestId !== logLifecycle.current ||
        snapshot.sessionId !== sessionId ||
        currentDiagnosticScope.current.generation !== generation ||
        currentDiagnosticScope.current.sessionId !== sessionId
      ) {
        return;
      }
      setLogEntries(snapshot.entries);
      setLogThroughSequence(snapshot.observedLastSequence);
      setLogState(snapshot.entries.length > 0 ? 'content' : 'empty');
    } catch (error) {
      if (
        requestId !== logLifecycle.current ||
        currentDiagnosticScope.current.generation !== generation ||
        currentDiagnosticScope.current.sessionId !== sessionId
      ) {
        return;
      }
      const reason = failureReason(error);
      setLogReason(reason);
      setLogState(reason === 'protocol_error' ? 'error' : 'unavailable');
    }
  };

  const selectSessionView = (view: 'history' | 'logs') => {
    setActiveSessionView(view);
    if (view === 'logs') void loadSessionLogs();
  };

  const openModelContext = useCallback(
    async (invocationId: string) => {
      const sessionId = state.selectedSessionId;
      const generation = state.generation;
      if (!sessionId || generation === 0) return;
      const requestId = ++modelContextLifecycle.current;
      setModelContextView({ invocationId, status: 'loading', reason: null });
      try {
        const context = await transport.loadModelContext(sessionId, invocationId);
        if (
          requestId !== modelContextLifecycle.current ||
          currentDiagnosticScope.current.generation !== generation ||
          currentDiagnosticScope.current.sessionId !== sessionId
        ) {
          return;
        }
        setModelContextView({ invocationId, status: 'loaded', context, reason: null });
      } catch (error) {
        if (
          requestId !== modelContextLifecycle.current ||
          currentDiagnosticScope.current.generation !== generation ||
          currentDiagnosticScope.current.sessionId !== sessionId
        ) {
          return;
        }
        setModelContextView({
          invocationId,
          status: 'error',
          reason: failureReason(error),
        });
      }
    },
    [state.generation, state.selectedSessionId, transport],
  );

  const closeModelContext = useCallback(() => {
    modelContextLifecycle.current += 1;
    setModelContextView(null);
  }, []);

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

  const openSession = (sessionId: string) => {
    navigate(`/sessions/${encodeURIComponent(sessionId)}`);
  };

  const historyFailed = state.historyState === 'error' || state.historyState === 'unavailable';
  const workspaceLabel =
    state.workspaces.find((workspace) =>
      workspace.sessions.some((item) => item.sessionId === state.selectedSessionId),
    )?.label ?? '工作空间';
  return (
    <SessionPage
      workspaces={pageWorkspaces(state.workspaces)}
      selected={state.selectedSessionId ?? undefined}
      workspaceLabel={workspaceLabel}
      sessionLabel={session?.displayName ?? '选择会话'}
      readingKey={state.selectedSessionId ?? 'directory'}
      messages={pageMessages(state.messages)}
      loading={state.historyState === 'loading' || state.connection.status === 'loading'}
      connected={state.connection.status === 'connected'}
      connectionLabel={`Local · ${state.connection.status.replace('_', ' ')} · read only`}
      actions={{}}
      readOnlyReason="只读访问 · 发送任务和处理交互请使用桌面端或 TUI"
      onOpen={openSession}
      onExpand={(id) => void expandWorkspace(id)}
      headerActions={
        <>
          <Button
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </Button>
          <Link to="/api-docs" aria-label="Open API documentation">
            API docs
          </Link>
        </>
      }
      notices={
        state.connection.status === 'unavailable' && (
          <div role="status" className="notice">
            Automatic refresh is unavailable. Showing the latest REST snapshot.
          </div>
        )
      }
      beforeConversation={
        state.selectedSessionId && (
          <>
            <SessionViewTabs value={activeSessionView} onChange={selectSessionView} />
            {activeSessionView === 'history' && (
              <CheckpointStrip checkpoints={state.checkpoints} status={state.checkpointState} />
            )}
          </>
        )
      }
      historyPanel={
        state.selectedSessionId
          ? { id: 'session-panel-history', labelledBy: 'session-tab-history' }
          : undefined
      }
      historyError={
        historyFailed
          ? {
              title:
                state.historyState === 'error' ? 'Could not load History' : 'History unavailable',
              detail: state.historyReason ?? '无法读取会话，请重试。',
              retry: () => dispatch({ type: 'history_retry', generation: state.generation }),
            }
          : undefined
      }
      diagnosticView={
        state.selectedSessionId && activeSessionView === 'logs' ? (
          <SessionLogList
            entries={logEntries}
            status={logState}
            reason={logReason}
            throughSequence={logThroughSequence}
            onRefresh={() => void loadSessionLogs()}
            onViewModelContext={(id) => void openModelContext(id)}
          />
        ) : undefined
      }
      overlays={
        modelContextView && (
          <ModelContextInspector
            key={modelContextView.invocationId}
            invocationId={modelContextView.invocationId}
            context={modelContextView.context}
            status={modelContextView.status}
            reason={modelContextView.reason}
            onClose={closeModelContext}
            onRetry={() => void openModelContext(modelContextView.invocationId)}
          />
        )
      }
    />
  );
}

function SessionViewTabs({
  value,
  onChange,
}: {
  readonly value: 'history' | 'logs';
  readonly onChange: (value: 'history' | 'logs') => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-end border-b border-border bg-canvas px-6">
      <div role="tablist" aria-label="Session detail views" className="flex h-full items-end gap-5">
        <button
          id="session-tab-history"
          type="button"
          role="tab"
          aria-selected={value === 'history'}
          aria-controls="session-panel-history"
          className={sessionTabClassName(value === 'history')}
          onClick={() => onChange('history')}
        >
          <MessageSquareText className="size-3.5" />
          Conversation history
        </button>
        <button
          id="session-tab-logs"
          type="button"
          role="tab"
          aria-selected={value === 'logs'}
          aria-controls="session-panel-logs"
          className={sessionTabClassName(value === 'logs')}
          onClick={() => onChange('logs')}
        >
          <ListTree className="size-3.5" />
          Runtime logs
        </button>
      </div>
    </div>
  );
}

function sessionTabClassName(active: boolean): string {
  return [
    'relative flex h-full items-center gap-2 border-b-2 px-0.5 text-[11px] font-medium transition-colors',
    active
      ? 'border-accent text-foreground'
      : 'border-transparent text-muted-foreground hover:text-foreground',
  ].join(' ');
}

function CheckpointStrip({
  checkpoints,
  status,
}: {
  readonly checkpoints: readonly WebCheckpointSummary[];
  readonly status: 'idle' | 'loading' | 'loaded' | 'unavailable';
}) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-subtle/35 px-6 text-[11px] text-muted-foreground">
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
