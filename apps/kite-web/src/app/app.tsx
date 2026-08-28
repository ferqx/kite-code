import { Circle, Menu, PlugZap, Radio, Unplug } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { SessionSidebar } from '@/components/session/session-sidebar';
import { MessageList } from '@/components/timeline/message-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  initialWebPresentationState,
  selectedSession,
  webPresentationReducer,
} from '@/presentation/reducer';
import type { WebObserverTransport } from '@/transport/client';
import { createWebObserverTransport, WebObserverTransportError } from '@/transport/client';

export interface AppProps {
  /** Test/composition seam; production creates the closed browser transport. */
  readonly transport?: WebObserverTransport;
}

export function App(props: AppProps = {}) {
  const [state, dispatch] = useReducer(webPresentationReducer, initialWebPresentationState);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const transport = useMemo(
    () => props.transport ?? createWebObserverTransport(),
    [props.transport],
  );
  const lifecycle = useRef(0);
  const deferredDisconnect = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = selectedSession(state);

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
    const selectedStatus = session?.status;
    if (!sessionId || generation === 0) {
      return;
    }
    let active = true;
    let subscription: Awaited<ReturnType<typeof transport.subscribe>> | undefined;
    dispatch({ type: 'connection', connection: { status: 'loading' }, generation });
    const load = async () => {
      try {
        const history = await transport.loadHistory(sessionId, undefined, 200);
        if (!active) return;
        dispatch({ type: 'history_loaded', history, reset: true, generation });
        if (selectedStatus !== 'running') return;
        const nextSubscription = await transport.subscribe({
          sessionId,
          afterSequence: history.observedLastSequence,
          onEvent: (event, eventGeneration) => {
            if (active) dispatch({ type: 'live_event', event, generation: eventGeneration });
          },
          onState: (connection, eventGeneration) => {
            if (active) {
              dispatch({
                type: 'connection',
                connection:
                  connection === 'unavailable'
                    ? { status: 'unavailable', reason: 'gateway_unavailable' }
                    : { status: connection },
                generation: eventGeneration,
              });
            }
          },
        });
        if (!active) {
          await nextSubscription.unsubscribe();
          return;
        }
        subscription = nextSubscription;
      } catch (error) {
        if (active) {
          dispatch({
            type: 'connection',
            connection: { status: 'unavailable', reason: failureReason(error) },
            generation,
          });
        }
      }
    };
    void load();
    return () => {
      active = false;
      void subscription?.unsubscribe().catch(() => undefined);
    };
  }, [session?.status, state.generation, state.selectedSessionId, transport]);

  useEffect(() => {
    const terminalStream =
      state.connection.status === 'resync_required' ||
      (state.connection.status === 'unavailable' && state.historyResetRequired);
    if (!terminalStream || state.generation === 0) {
      return;
    }
    let active = true;
    const reconnect = async () => {
      try {
        const connection = await transport.connect();
        if (!active) return;
        dispatch({ type: 'transport_connected', generation: connection.generation });
        const directory = await transport.listDirectory();
        if (active) {
          dispatch({ type: 'directory_loaded', directory, generation: connection.generation });
        }
      } catch (error) {
        if (active) {
          dispatch({
            type: 'connection',
            connection: { status: 'unavailable', reason: failureReason(error) },
            generation: state.generation,
          });
        }
      }
    };
    void reconnect();
    return () => {
      active = false;
    };
  }, [state.connection.status, state.generation, state.historyResetRequired, transport]);

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
        {state.connection.status === 'unavailable' && state.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div>
              <Radio className="mx-auto mb-4 size-8 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Observer unavailable</h2>
              <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">
                Start the local Kite Web Gateway, then reopen its one-shot launch URL.
              </p>
            </div>
          </div>
        ) : (
          <MessageList messages={state.messages} />
        )}
      </section>
    </main>
  );
}

function failureReason(error: unknown): string {
  return error instanceof WebObserverTransportError ? error.reason : 'gateway_unavailable';
}
