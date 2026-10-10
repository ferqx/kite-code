import { type BrowserSessionList, type BrowserWorkspaceList, ClientError } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { ConnectionNotice, ModelOutputMessage, SafeMessageMarkdown } from '@kite-ai/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WebController, type WebUpdate } from './controller';
import { Diagnostics } from './diagnostics';
import { FileCheckpoints } from './file-checkpoints';
import { ModelInputs } from './model-input';
import { navigationCSS, useNavigation } from './navigation';
import { RuntimeLogs } from './runtime-logs';

function selectedPath(path: string): string | undefined {
  const match = /^\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
  return match?.[1];
}
function code(error: unknown): string {
  return error instanceof ClientError ? error.code : 'browser_read_unavailable';
}
export interface WebPageOptions {
  readonly client: BrowserClient;
  readonly window: Window;
  readonly pollIntervalMs?: number;
  readonly suspended?: boolean;
}

/** Read-only presentation. Execution facts come only from the one selected controller. */
export function WebPage({
  client,
  window: browser,
  pollIntervalMs,
  suspended = false,
}: WebPageOptions) {
  const navigation = useNavigation(browser, suspended);
  const [pageVisible, setPageVisible] = useState(browser.document.visibilityState !== 'hidden');
  const visibleOutput = useRef(new Map<string, string>());
  const outputTarget = useRef('');
  const paused = useRef(suspended);
  paused.current = suspended;
  const wasPaused = useRef(false);
  const [workspaces, setWorkspaces] = useState<BrowserWorkspaceList>();
  const [sessions, setSessions] = useState<Record<string, BrowserSessionList>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const [directoryError, setDirectoryError] = useState<string>();
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});
  const [update, setUpdate] = useState<WebUpdate>();
  const [logModel, setLogModel] = useState<{
    sessionId: string;
    storeId: string;
    executionId: string;
    revision: number;
  }>();
  const viewport = useRef<HTMLElement | null>(null);
  const reading = useRef(
    new Map<string, { top: number; latest: boolean; expanded: Set<string> }>(),
  );
  const currentReading = useRef<string | undefined>(undefined);
  const [toolExpanded, setToolExpanded] = useState<Set<string>>(new Set());
  const [atLatest, setAtLatest] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');
  const saveReading = useCallback(() => {
    const id = currentReading.current;
    const element = viewport.current;
    if (!id || !element) return;
    const prior = reading.current.get(id);
    reading.current.delete(id);
    reading.current.set(id, {
      top: element.scrollTop,
      latest: element.scrollHeight - element.clientHeight - element.scrollTop <= 24,
      expanded: prior?.expanded ?? new Set(),
    });
    while (reading.current.size > 32) reading.current.delete(reading.current.keys().next().value!);
  }, []);
  const [dark, setDark] = useState(true);
  const directoryRead = useRef<AbortController | undefined>(undefined);
  const sessionReads = useRef(new Map<string, AbortController>());
  const mounted = useRef(false);
  const controller = useMemo(
    () =>
      new WebController({
        admittedClient: client,
        onUpdate: setUpdate,
        initiallyVisible: browser.document.visibilityState !== 'hidden',
        pollIntervalMs,
      }),
    [client, browser, pollIntervalMs],
  );

  const loadDirectory = useCallback(async () => {
    if (paused.current) return;
    directoryRead.current?.abort();
    const read = new AbortController();
    directoryRead.current = read;
    setDirectoryLoading(true);
    try {
      const items = await client.listAllWorkspaces({ signal: read.signal });
      if (!read.signal.aborted && mounted.current) {
        setWorkspaces(items);
        setDirectoryError(undefined);
      }
    } catch (error) {
      if (!read.signal.aborted && mounted.current) setDirectoryError(code(error));
    } finally {
      if (!read.signal.aborted && mounted.current) setDirectoryLoading(false);
    }
  }, [client]);
  async function loadSessions(workspaceId: string) {
    if (paused.current) return;
    sessionReads.current.get(workspaceId)?.abort();
    const read = new AbortController();
    sessionReads.current.set(workspaceId, read);
    setLoadingSessions((previous) => ({ ...previous, [workspaceId]: true }));
    try {
      const list = await client.listAllSessions({ workspaceId, signal: read.signal });
      if (!read.signal.aborted && mounted.current) {
        setSessions((previous) => ({
          ...previous,
          [workspaceId]: list.filter(
            (session) => session.parentSessionId === null && session.workspaceId === workspaceId,
          ),
        }));
        setSessionErrors((previous) => ({ ...previous, [workspaceId]: '' }));
      }
    } catch (error) {
      if (!read.signal.aborted && mounted.current)
        setSessionErrors((previous) => ({ ...previous, [workspaceId]: code(error) }));
    } finally {
      if (sessionReads.current.get(workspaceId) === read) sessionReads.current.delete(workspaceId);
      if (!read.signal.aborted && mounted.current)
        setLoadingSessions((previous) => ({ ...previous, [workspaceId]: false }));
    }
  }
  const choose = useCallback(
    (sessionId: string | undefined, navigate = true) => {
      if (paused.current) return;
      setLogModel(undefined);
      saveReading();
      if (navigate)
        browser.history.pushState(
          null,
          '',
          sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : '/',
        );
      if (sessionId) void controller.selectSession(sessionId).catch(() => {});
      else {
        controller.clearSelection();
        setUpdate(undefined);
      }
    },
    [browser, controller, saveReading],
  );
  useEffect(() => {
    mounted.current = true;
    void loadDirectory();
    choose(selectedPath(browser.location.pathname), false);
    const visibility = () => {
      const visible = browser.document.visibilityState !== 'hidden';
      setPageVisible(visible);
      controller.setVisible(!paused.current && visible);
    };
    const navigation = () => choose(selectedPath(browser.location.pathname), false);
    browser.document.addEventListener('visibilitychange', visibility);
    browser.addEventListener('popstate', navigation);
    return () => {
      mounted.current = false;
      controller.disposeObserver();
      directoryRead.current?.abort();
      for (const read of sessionReads.current.values()) read.abort();
      sessionReads.current.clear();
      browser.document.removeEventListener('visibilitychange', visibility);
      browser.removeEventListener('popstate', navigation);
    };
  }, [controller, browser, choose, loadDirectory]);
  useEffect(() => {
    if (suspended) {
      saveReading();
      controller.setVisible(false);
      directoryRead.current?.abort();
      for (const read of sessionReads.current.values()) read.abort();
      sessionReads.current.clear();
    } else if (wasPaused.current) {
      void loadDirectory();
      controller.setVisible(browser.document.visibilityState !== 'hidden');
      if (browser.document.visibilityState !== 'hidden') void controller.refresh().catch(() => {});
    }
    wasPaused.current = suspended;
  }, [suspended, browser, controller, loadDirectory, saveReading]);
  const snapshot = update?.snapshot;
  const outputIdentity = JSON.stringify([client.serverInfo?.storeId, update?.sessionId]);
  if (outputTarget.current !== outputIdentity) {
    visibleOutput.current.clear();
    outputTarget.current = outputIdentity;
  }
  // The Cookie/Core reader proves the original Execution chain under the current
  // admitted Store. A restored origin remains read-only and keeps its original IDs.
  const readModelOutput = useCallback(
    ({
      sessionId,
      executionId,
      signal,
    }: {
      sessionId: string;
      executionId: string;
      signal: AbortSignal;
    }) => client.getModelOutput(sessionId, executionId, { signal }),
    [client],
  );
  useLayoutEffect(() => {
    if (!snapshot || !update) return;
    const id = update.sessionId;
    const element = viewport.current;
    if (!element) return;
    const changed = currentReading.current !== id;
    const saved = reading.current.get(id);
    if (changed) {
      currentReading.current = id;
      const restored = new Set(saved?.expanded ?? []);
      if (restored.size !== toolExpanded.size || [...restored].some((id) => !toolExpanded.has(id)))
        setToolExpanded(restored);
    }
    const latest = saved?.latest ?? true;
    element.scrollTop = latest ? element.scrollHeight : (saved?.top ?? 0);
    setAtLatest(latest);
  }, [snapshot, update, toolExpanded]);
  useEffect(() => {
    const selectConversation = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const history = viewport.current;
      if (!history || !currentReading.current) return;
      event.preventDefault();
      const selection = browser.getSelection();
      const range = browser.document.createRange();
      range.selectNodeContents(history);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    browser.document.addEventListener('keydown', selectConversation);
    return () => browser.document.removeEventListener('keydown', selectConversation);
  }, [browser]);
  async function copyConversation() {
    if (!snapshot) return;
    const content = snapshot.messages
      .filter((message) => message.role !== 'tool' || toolExpanded.has(message.id))
      .map((message) => visibleOutput.current.get(message.id) ?? message.content)
      .join('\n\n');
    try {
      await browser.navigator.clipboard.writeText(content);
      setCopyStatus('Copied visible messages');
    } catch {
      setCopyStatus('Copy unavailable; select message text to copy.');
    }
  }
  const readUnavailable =
    !!directoryError ||
    Object.values(sessionErrors).some(Boolean) ||
    update?.phase === 'error' ||
    update?.phase === 'stale';
  return (
    <div className="web-page" data-theme={dark ? 'dark' : 'light'} inert={suspended}>
      <style>{navigationCSS}</style>
      <header>
        <button
          type="button"
          ref={navigation.toggle}
          aria-controls="web-navigation"
          aria-expanded={navigation.open}
          aria-label={navigation.open ? 'Close directory' : 'Open directory'}
          onClick={navigation.toggleOpen}
        >
          {navigation.open ? 'Close directory' : 'Open directory'}
        </button>
        <a
          href="/"
          onClick={(event) => {
            event.preventDefault();
            choose(undefined);
          }}
        >
          Kite · Read-only
        </a>
        <a href="/api-docs">API Docs</a>
        <button type="button" onClick={() => setDark(!dark)} aria-label="Toggle theme">
          {dark ? 'Light' : 'Dark'}
        </button>
      </header>
      <ConnectionNotice
        state={{
          kind: readUnavailable ? 'error' : 'ready',
          message: readUnavailable
            ? 'Current read unavailable; saved page identity is unchanged.'
            : 'Same-origin cookie session · page identity verified · read-only',
        }}
      />
      <div
        className="web-layout"
        data-navigation={navigation.narrow ? 'narrow' : 'wide'}
        data-dragging={navigation.dragging}
        style={{
          gridTemplateColumns:
            navigation.narrow || !navigation.open
              ? 'minmax(0,1fr)'
              : `${navigation.width}px 8px minmax(360px,1fr)`,
        }}
      >
        <nav
          id="web-navigation"
          className="web-navigation"
          hidden={!navigation.open}
          inert={!navigation.open}
          aria-label="Workspaces and sessions"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && navigation.narrow) {
              event.preventDefault();
              navigation.close();
            }
          }}
        >
          <h2>Workspaces</h2>
          <button type="button" onClick={() => void loadDirectory()}>
            Refresh directory
          </button>
          {directoryLoading && <p role="status">Loading directory</p>}
          {directoryError && (
            <ConnectionNotice
              state={{
                kind: 'error',
                message: `Directory unavailable: ${directoryError}. Previously read entries remain visible.`,
              }}
            />
          )}
          {workspaces?.length === 0 && <p>No workspaces</p>}
          {workspaces?.map((workspace) => (
            <section key={workspace.id}>
              <button
                type="button"
                aria-expanded={!!expanded[workspace.id]}
                onClick={() => {
                  const opening = !expanded[workspace.id];
                  setExpanded((previous) => ({ ...previous, [workspace.id]: opening }));
                  setShown((previous) => ({ ...previous, [workspace.id]: 5 }));
                  if (opening) void loadSessions(workspace.id);
                }}
              >
                {workspace.name}
              </button>
              {expanded[workspace.id] && (
                <div>
                  {loadingSessions[workspace.id] && <p role="status">Loading sessions</p>}
                  {sessionErrors[workspace.id] && (
                    <p role="alert">Sessions unavailable: {sessionErrors[workspace.id]}</p>
                  )}
                  {sessions[workspace.id]?.length === 0 && <p>No sessions</p>}
                  <ul>
                    {sessions[workspace.id]?.slice(0, shown[workspace.id] ?? 5).map((session) => (
                      <li key={session.id}>
                        <a
                          href={`/sessions/${encodeURIComponent(session.id)}`}
                          aria-current={update?.sessionId === session.id ? 'page' : undefined}
                          onClick={(event) => {
                            event.preventDefault();
                            choose(session.id);
                            if (navigation.narrow) navigation.close();
                          }}
                        >
                          {session.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                  {(sessions[workspace.id]?.length ?? 0) > (shown[workspace.id] ?? 5) && (
                    <button
                      type="button"
                      onClick={() =>
                        setShown((previous) => ({
                          ...previous,
                          [workspace.id]: (previous[workspace.id] ?? 5) + 10,
                        }))
                      }
                    >
                      Show more
                    </button>
                  )}
                </div>
              )}
            </section>
          ))}
        </nav>
        {!navigation.narrow && navigation.open && (
          <hr
            tabIndex={0}
            className="navigation-resize"
            aria-label="Resize directory"
            aria-orientation="vertical"
            aria-controls="web-navigation"
            aria-valuemin={200}
            aria-valuemax={420}
            aria-valuenow={navigation.width}
            onPointerDown={navigation.onPointerDown}
            onKeyDown={navigation.onKeyDown}
          />
        )}
        <main aria-label="Conversation">
          {!update && <p>Select a session to read its history.</p>}
          {update && (
            <>
              <div className="conversation-header">
                <h1>{snapshot?.view.session.title ?? update.sessionId}</h1>
                <button type="button" onClick={() => void copyConversation()}>
                  Copy conversation
                </button>
                <button type="button" onClick={() => void controller.refresh().catch(() => {})}>
                  Refresh history
                </button>
              </div>
              {copyStatus && <p role="status">{copyStatus}</p>}
              <p role={update.phase === 'error' || update.phase === 'stale' ? 'alert' : 'status'}>
                {update.phase === 'loading'
                  ? 'Loading history'
                  : update.phase === 'stale'
                    ? `Stale · Last known history · ${update.error}`
                    : update.phase === 'error'
                      ? `History unavailable · ${update.error}`
                      : 'History synchronized'}
              </p>
              {snapshot && (
                <>
                  <section aria-label="Run status">
                    <h2>Runs</h2>
                    {snapshot.view.runs.length === 0 && <p>No Runs</p>}
                    {snapshot.view.runs.map((run) => (
                      <p key={run.id}>
                        {run.id} · {run.status}
                        {run.isActive ? ' · active' : ''}
                      </p>
                    ))}
                  </section>
                  <section aria-label="Execution status">
                    <h2>Executions</h2>
                    {snapshot.view.executions.length === 0 && <p>No executions</p>}
                    {snapshot.view.executions.map((execution) => (
                      <p key={execution.id}>
                        {execution.definitionId} · {execution.status} · {execution.id}
                      </p>
                    ))}
                  </section>
                  <ModelInputs
                    key={`${snapshot.view.storeId}:${snapshot.sessionId}:${logModel?.storeId === snapshot.view.storeId && logModel.sessionId === snapshot.sessionId ? logModel.revision : 0}`}
                    client={client}
                    sessionId={snapshot.sessionId}
                    storeId={snapshot.view.storeId}
                    window={browser}
                    suspended={suspended}
                    initialExecutionId={
                      logModel?.storeId === snapshot.view.storeId &&
                      logModel.sessionId === snapshot.sessionId
                        ? logModel.executionId
                        : undefined
                    }
                  />
                  <FileCheckpoints
                    key={`${snapshot.view.storeId}:${snapshot.sessionId}:${snapshot.view.session.workspaceId}:${snapshot.view.session.contextSelectionId}:${snapshot.view.session.controlRevision}`}
                    client={client}
                    scope={{
                      storeId: snapshot.view.storeId,
                      sessionId: snapshot.sessionId,
                      workspaceId: snapshot.view.session.workspaceId,
                      contextSelectionId: snapshot.view.session.contextSelectionId,
                      revision: snapshot.view.session.controlRevision,
                    }}
                    window={browser}
                    suspended={suspended}
                  />
                  <RuntimeLogs
                    key={`${snapshot.view.storeId}:${snapshot.sessionId}`}
                    client={client}
                    sessionId={snapshot.sessionId}
                    storeId={snapshot.view.storeId}
                    window={browser}
                    suspended={suspended}
                    onModel={(executionId) =>
                      setLogModel((prior) => ({
                        sessionId: snapshot.sessionId,
                        storeId: snapshot.view.storeId,
                        executionId,
                        revision: (prior?.revision ?? 0) + 1,
                      }))
                    }
                  />
                  <Diagnostics
                    key={`${snapshot.view.storeId}:${snapshot.sessionId}:${snapshot.view.session.contextSelectionId}`}
                    client={client}
                    view={snapshot.view}
                    suspended={suspended}
                    window={browser}
                  />
                  {!atLatest && (
                    <button
                      type="button"
                      onClick={() => {
                        const element = viewport.current;
                        if (element) element.scrollTop = element.scrollHeight;
                        saveReading();
                        setAtLatest(true);
                      }}
                    >
                      Back to latest messages
                    </button>
                  )}
                  <section
                    aria-label="History"
                    className="history"
                    ref={viewport}
                    onScroll={() => {
                      saveReading();
                      setAtLatest(
                        reading.current.get(currentReading.current ?? '')?.latest ?? true,
                      );
                    }}
                  >
                    {snapshot.messages.length === 0 && <p>No messages</p>}
                    {snapshot.messages.map((message) => (
                      <article key={message.id} data-message-id={message.id}>
                        {message.role === 'tool' ? (
                          <details
                            open={toolExpanded.has(message.id)}
                            onToggle={(event) => {
                              const id = update.sessionId;
                              if (currentReading.current !== id) return;
                              const open = event.currentTarget.open;
                              setToolExpanded((previous) => {
                                const next = new Set(previous);
                                if (open) next.add(message.id);
                                else next.delete(message.id);
                                // Only retain bounded expansion identities, never message bodies.
                                if (next.size > 256) next.delete(next.values().next().value!);
                                const saved = reading.current.get(id) ?? {
                                  top: 0,
                                  latest: true,
                                  expanded: new Set<string>(),
                                };
                                reading.current.set(id, { ...saved, expanded: next });
                                return next;
                              });
                            }}
                          >
                            <summary>
                              Tool · {message.status} · {message.seq}
                            </summary>
                            <SafeMessageMarkdown content={message.content} />
                          </details>
                        ) : (
                          <>
                            {message.status !== 'complete' && <small>{message.status}</small>}
                            <ModelOutputMessage
                              message={message}
                              storeId={snapshot.view.storeId}
                              suspended={suspended || !pageVisible}
                              canReadRestoredOrigin={client.serverInfo?.capabilities?.includes(
                                'model_outputs',
                              )}
                              onRead={
                                client.serverInfo?.capabilities?.includes('model_outputs')
                                  ? readModelOutput
                                  : undefined
                              }
                              onContent={(content) => {
                                if (outputTarget.current !== outputIdentity) return;
                                if (content === undefined) visibleOutput.current.delete(message.id);
                                else visibleOutput.current.set(message.id, content);
                              }}
                            />
                          </>
                        )}
                      </article>
                    ))}
                  </section>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
