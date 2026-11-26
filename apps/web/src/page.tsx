import { type BrowserWorkspaceList, ClientError, type Message } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import {
  completeRunReplies,
  MessageCopyButton,
  ModelOutputMessage,
  modelOutputTerminalObserved,
  SafeMessageMarkdown,
  TooltipProvider,
} from '@kite-ai/ui/browser';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessError } from './access-error';
import { BackgroundExecutions } from './background';
import { WebController, type WebUpdate } from './controller';
import { Diagnostics } from './diagnostics';
import {
  DirectoryActivity,
  DirectoryItem,
  type DirectorySession,
  directoryCSS,
  rootSessionDirectory,
  SessionDetails,
} from './directory';
import { FileCheckpoints } from './file-checkpoints';
import { ModelInputs } from './model-input';
import { navigationCSS, separatorWidth, useNavigation } from './navigation';
import { useRunFacts } from './run-facts';
import { RuntimeLogs } from './runtime-logs';

const noExpandedTools: ReadonlySet<string> = new Set();

function outputKey(scope: string, message: Message) {
  return JSON.stringify([
    scope,
    message.id,
    message.sessionId,
    message.runId,
    message.seq,
    message.status,
    message.contentFormat,
    message.originMessage,
    message.outputBody,
    message.content,
  ]);
}

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
  readonly resumeError?: string;
}

/** Read-only presentation. Directory and selected history have separate owned readers. */
export function WebPage({
  client,
  window: browser,
  pollIntervalMs,
  suspended = false,
  resumeError,
}: WebPageOptions) {
  const [pageVisible, setPageVisible] = useState(browser.document.visibilityState !== 'hidden');
  const visibleOutput = useRef(new Map<string, { key: string; text: string }>());
  const currentOutputs = useRef(new Map<string, string>());
  const [outputRevision, outputChanged] = useState(0);
  const outputTarget = useRef('');
  const paused = useRef(suspended);
  paused.current = suspended;
  const wasPaused = useRef(false);
  const [workspaces, setWorkspaces] = useState<BrowserWorkspaceList>();
  const [sessions, setSessions] = useState<Record<string, DirectorySession[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const [directoryError, setDirectoryError] = useState<string>();
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});
  const [update, setUpdate] = useState<WebUpdate>();
  const accessError =
    resumeError ??
    (/(?:identity_mismatch|store_changed|connection_not_admitted)$/.test(update?.error ?? '')
      ? update?.error
      : undefined);
  const blocked = suspended || !!accessError;
  const navigation = useNavigation(browser, blocked);
  const [logModel, setLogModel] = useState<{
    sessionId: string;
    storeId: string;
    executionId: string;
    revision: number;
  }>();
  const viewport = useRef<HTMLElement | null>(null);
  const historyContent = useRef<HTMLDivElement>(null);
  const currentReading = useRef<string | undefined>(undefined);
  const scrollWrite = useRef<{ sessionId?: string; top: number; following: boolean } | undefined>(
    undefined,
  );
  const positionHistory = useCallback((element: HTMLElement, top: number, following: boolean) => {
    element.scrollTop = top;
    scrollWrite.current = { sessionId: currentReading.current, top: element.scrollTop, following };
  }, []);
  const reading = useRef(
    new Map<string, { top: number; latest: boolean; expanded: Set<string> }>(),
  );
  const [, expansionChanged] = useState(0);
  const toolExpanded =
    (update && reading.current.get(update.sessionId)?.expanded) ?? noExpandedTools;
  const [atLatest, setAtLatest] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');
  const saveReading = useCallback(() => {
    const id = currentReading.current;
    const element = viewport.current;
    if (!id || !element) return;
    const prior = reading.current.get(id);
    const written = scrollWrite.current;
    const sameWrite = written?.sessionId === id && Math.abs(written.top - element.scrollTop) < 1;
    const latest = sameWrite
      ? written.following
      : element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    if (!sameWrite) scrollWrite.current = undefined;
    reading.current.delete(id);
    reading.current.set(id, {
      top: element.scrollTop,
      latest,
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

  const canPublishDirectory = useCallback(
    (read: AbortController) =>
      !read.signal.aborted &&
      mounted.current &&
      !paused.current &&
      browser.document.visibilityState !== 'hidden',
    [browser],
  );
  const loadDirectory = useCallback(async () => {
    if (paused.current || browser.document.visibilityState === 'hidden') return;
    directoryRead.current?.abort();
    const read = new AbortController();
    directoryRead.current = read;
    setDirectoryLoading(true);
    try {
      const items = await client.listAllWorkspaces({ signal: read.signal });
      if (canPublishDirectory(read)) {
        setWorkspaces(items);
        setDirectoryError(undefined);
      }
    } catch (error) {
      if (canPublishDirectory(read)) setDirectoryError(code(error));
    } finally {
      if (canPublishDirectory(read)) setDirectoryLoading(false);
    }
  }, [client, browser, canPublishDirectory]);
  const loadSessions = useCallback(
    async (workspaceId: string) => {
      if (paused.current || browser.document.visibilityState === 'hidden') return;
      sessionReads.current.get(workspaceId)?.abort();
      const read = new AbortController();
      sessionReads.current.set(workspaceId, read);
      setLoadingSessions((previous) => ({ ...previous, [workspaceId]: true }));
      try {
        const list = await client.listAllSessionDirectory({ workspaceId, signal: read.signal });
        if (canPublishDirectory(read)) {
          const complete = rootSessionDirectory(list, workspaceId);
          setSessions((previous) => ({
            ...previous,
            [workspaceId]: complete,
          }));
          setSessionErrors((previous) => ({ ...previous, [workspaceId]: '' }));
        }
      } catch (error) {
        if (canPublishDirectory(read))
          setSessionErrors((previous) => ({ ...previous, [workspaceId]: code(error) }));
      } finally {
        if (sessionReads.current.get(workspaceId) === read)
          sessionReads.current.delete(workspaceId);
        if (canPublishDirectory(read))
          setLoadingSessions((previous) => ({ ...previous, [workspaceId]: false }));
      }
    },
    [client, browser, canPublishDirectory],
  );
  const expandedDirectory = useRef(expanded);
  expandedDirectory.current = expanded;
  const refreshDirectory = useCallback(() => {
    void loadDirectory();
    for (const [workspaceId, open] of Object.entries(expandedDirectory.current))
      if (open) void loadSessions(workspaceId);
  }, [loadDirectory, loadSessions]);
  const directoryRetry = useRef(0);
  useEffect(() => {
    if (
      suspended ||
      !pageVisible ||
      directoryLoading ||
      Object.values(loadingSessions).some(Boolean)
    )
      return;
    const failed = Object.entries(sessionErrors).filter(([, error]) => error);
    if (!directoryError && failed.length === 0) {
      directoryRetry.current = 0;
      return;
    }
    const timer = setTimeout(
      () => {
        if (directoryError) void loadDirectory();
        for (const [workspaceId] of failed) void loadSessions(workspaceId);
      },
      Math.min(30000, 500 * 2 ** Math.min(directoryRetry.current++, 6)),
    );
    return () => clearTimeout(timer);
  }, [
    directoryError,
    sessionErrors,
    directoryLoading,
    loadingSessions,
    suspended,
    pageVisible,
    loadDirectory,
    loadSessions,
  ]);
  const abortDirectory = useCallback(() => {
    directoryRead.current?.abort();
    for (const read of sessionReads.current.values()) read.abort();
    sessionReads.current.clear();
    setDirectoryLoading(false);
    setLoadingSessions({});
  }, []);
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
      if (!visible) abortDirectory();
      else if (!paused.current) refreshDirectory();
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
  }, [controller, browser, choose, loadDirectory, abortDirectory, refreshDirectory]);
  useEffect(() => {
    if (suspended) {
      saveReading();
      controller.setVisible(false);
      abortDirectory();
    } else if (wasPaused.current) {
      refreshDirectory();
      controller.setVisible(browser.document.visibilityState !== 'hidden');
      if (browser.document.visibilityState !== 'hidden') void controller.refresh().catch(() => {});
    }
    wasPaused.current = suspended;
  }, [suspended, browser, controller, refreshDirectory, abortDirectory, saveReading]);
  const snapshot = update?.snapshot;
  const outputIdentity = JSON.stringify([
    snapshot?.view.storeId,
    update?.sessionId,
    update?.generation,
  ]);
  if (outputTarget.current !== outputIdentity) {
    visibleOutput.current.clear();
    outputTarget.current = outputIdentity;
  }
  const outputKeys = useMemo(() => {
    const keys = new Map<string, string>();
    for (const message of snapshot?.messages ?? [])
      if (message.outputBody && message.role !== 'tool')
        keys.set(message.id, outputKey(outputIdentity, message));
    return keys;
  }, [snapshot?.messages, outputIdentity]);
  currentOutputs.current = outputKeys;
  const runFacts = useRunFacts(
    client,
    snapshot,
    update?.phase === 'ready' && !suspended && pageVisible,
  );
  const fullContent = useCallback(
    (message: Message) => {
      const entry = visibleOutput.current.get(message.id);
      return entry && entry.key === outputKeys.get(message.id) ? entry.text : undefined;
    },
    [outputKeys],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A verified body update changes the contents behind fullContent.
  const replies = useMemo(
    () =>
      completeRunReplies({
        messages: snapshot?.messages ?? [],
        runs: runFacts.runs,
        sessionId: update?.sessionId ?? '',
        fullContent,
        copyScope: 'run',
      }),
    [snapshot?.messages, runFacts.runs, update?.sessionId, fullContent, outputRevision],
  );
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Expanding a tool changes the height of the reading viewport.
  useLayoutEffect(() => {
    if (!snapshot || !update) return;
    const id = update.sessionId;
    const element = viewport.current;
    if (!element) return;
    currentReading.current = id;
    const saved = reading.current.get(id);
    const latest = saved?.latest ?? true;
    positionHistory(element, latest ? element.scrollHeight : (saved?.top ?? 0), latest);
    setAtLatest(latest);
  }, [snapshot, update, toolExpanded, positionHistory]);
  const readingSession = snapshot?.sessionId;
  useLayoutEffect(() => {
    const element = viewport.current,
      content = historyContent.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!readingSession || !element || !content || !Observer) return;
    // Model bodies and the surrounding panels can change size after the history commit.
    const observer = new Observer(() => {
      if (
        currentReading.current !== readingSession ||
        viewport.current !== element ||
        reading.current.get(readingSession)?.latest === false
      )
        return;
      if (element.scrollHeight - element.clientHeight - element.scrollTop > 1)
        positionHistory(element, element.scrollHeight, true);
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, [readingSession, positionHistory]);
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
      .map((message) => fullContent(message) ?? message.content)
      .join('\n\n');
    try {
      await browser.navigator.clipboard.writeText(content);
      setCopyStatus('Copied visible messages');
    } catch {
      setCopyStatus('Copy unavailable; select message text to copy.');
    }
  }
  const connectionError =
    update?.error === 'browser_read_unavailable' || update?.error === 'browser_session_unavailable';
  return (
    <div className="web-page" data-theme={dark ? 'dark' : 'light'}>
      <style>{navigationCSS + directoryCSS}</style>
      {accessError ? (
        <AccessError browser={browser} code={accessError} />
      ) : suspended ? (
        <p role="status" className="web-access">
          Read-only observation paused; original page identity must be verified before resuming.
        </p>
      ) : null}
      <header inert={blocked}>
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
      <div
        className="web-layout"
        inert={blocked}
        data-navigation={navigation.narrow ? 'narrow' : 'wide'}
        data-dragging={navigation.dragging}
        style={{
          gridTemplateColumns:
            navigation.narrow || !navigation.open
              ? 'minmax(0,1fr)'
              : `${navigation.width}px ${separatorWidth}px minmax(0,1fr)`,
        }}
      >
        <nav
          id="web-navigation"
          className="web-navigation"
          ref={navigation.panel}
          tabIndex={navigation.narrow ? -1 : undefined}
          hidden={!navigation.open}
          inert={!navigation.open}
          aria-label="Workspaces and sessions"
          onKeyDown={(event) => {
            if (event.defaultPrevented || suspended) return;
            if (event.key === 'Escape' && navigation.narrow) {
              event.preventDefault();
              navigation.close();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const rows = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>('[data-directory-row]'),
            );
            const index = rows.indexOf(browser.document.activeElement as HTMLElement);
            if (index < 0) return;
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                    );
            event.preventDefault();
            rows[next]?.focus();
          }}
        >
          <h2>Workspaces</h2>
          <button type="button" onClick={refreshDirectory}>
            Refresh directory
          </button>
          {directoryLoading && <p role="status">Loading directory</p>}
          {workspaces?.length === 0 && <p>No workspaces</p>}
          <TooltipProvider delayDuration={500} skipDelayDuration={300}>
            {workspaces?.map((workspace) => (
              <section key={workspace.id}>
                <DirectoryItem
                  available={!suspended && pageVisible && navigation.open}
                  dark={dark}
                  details={
                    <>
                      <strong>{workspace.name}</strong>
                      <dl>
                        <dt>Sessions</dt>
                        <dd>{sessions[workspace.id]?.length ?? 'Not loaded'}</dd>
                      </dl>
                      {loadingSessions[workspace.id] && <p>Loading sessions</p>}
                    </>
                  }
                >
                  <button
                    type="button"
                    data-directory-row=""
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
                </DirectoryItem>
                {expanded[workspace.id] && (
                  <div>
                    {loadingSessions[workspace.id] && <p role="status">Loading sessions</p>}

                    {sessions[workspace.id]?.length === 0 && <p>No sessions</p>}
                    <ul>
                      {sessions[workspace.id]?.slice(0, shown[workspace.id] ?? 5).map((item) => {
                        const { session } = item;
                        return (
                          <li key={session.id}>
                            <DirectoryItem
                              available={!suspended && pageVisible && navigation.open}
                              dark={dark}
                              details={
                                <>
                                  <SessionDetails item={item} />
                                  {sessionErrors[workspace.id] && (
                                    <p>
                                      Previously read entry; current sessions unavailable:{' '}
                                      {sessionErrors[workspace.id]}
                                    </p>
                                  )}
                                </>
                              }
                            >
                              <a
                                data-directory-row=""
                                href={`/sessions/${encodeURIComponent(session.id)}`}
                                aria-current={update?.sessionId === session.id ? 'page' : undefined}
                                onClick={(event) => {
                                  event.preventDefault();
                                  choose(session.id);
                                  if (navigation.narrow) navigation.close();
                                }}
                              >
                                {session.title}
                                <DirectoryActivity
                                  activity={item.activity}
                                  stale={
                                    !!sessionErrors[workspace.id] ||
                                    !!directoryError ||
                                    !pageVisible ||
                                    suspended
                                  }
                                />
                              </a>
                            </DirectoryItem>
                          </li>
                        );
                      })}
                    </ul>
                    {(sessions[workspace.id]?.length ?? 0) > (shown[workspace.id] ?? 5) && (
                      <button
                        type="button"
                        data-directory-row=""
                        className="directory-more"
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
          </TooltipProvider>
        </nav>
        {!navigation.narrow && navigation.open && (
          <hr
            ref={navigation.separator}
            tabIndex={0}
            className="navigation-resize"
            aria-label="Resize directory"
            aria-orientation="vertical"
            aria-controls="web-navigation"
            aria-valuemin={200}
            aria-valuemax={navigation.limit}
            aria-valuenow={navigation.width}
            onPointerDown={navigation.onPointerDown}
            onKeyDown={navigation.onKeyDown}
          />
        )}
        <main aria-label="Conversation" inert={navigation.overlayOpen}>
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
              {update.phase === 'loading' && <p role="status">Loading history</p>}
              {connectionError && (
                <p role="status">
                  Cannot reach the local Kite service.
                  {snapshot && ' Showing the last saved view.'} Try Refresh history. If Kite
                  restarted at a new address, run <code>kite web</code> to open it.
                </p>
              )}
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
                  <BackgroundExecutions
                    key={`background:${snapshot.view.storeId}:${snapshot.sessionId}`}
                    client={client}
                    view={snapshot.view}
                    window={browser}
                    suspended={suspended || !pageVisible}
                    stale={update.phase !== 'ready'}
                    onOpen={(sessionId) => {
                      choose(sessionId);
                      if (navigation.narrow) navigation.close();
                    }}
                  />
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
                        if (element) positionHistory(element, element.scrollHeight, true);
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
                    <div ref={historyContent}>
                      {snapshot.messages.length === 0 && <p>No messages</p>}
                      {snapshot.messages.map((message, index) => (
                        <article
                          key={JSON.stringify([
                            snapshot.view.storeId,
                            update.sessionId,
                            message.id,
                          ])}
                          data-message-id={message.id}
                          data-message-role={message.role}
                          data-final-reply={replies.has(message.id) || undefined}
                          data-message-gap={
                            message.role === 'user' || replies.has(message.id)
                              ? 'turn'
                              : message.role === 'tool' &&
                                  replies.has(snapshot.messages[index + 1]?.id ?? '')
                                ? 'final'
                                : 'process'
                          }
                        >
                          {message.role === 'tool' ? (
                            <details
                              open={toolExpanded.has(message.id)}
                              onToggle={(event) => {
                                const id = update.sessionId;
                                if (currentReading.current !== id) return;
                                const open = event.currentTarget.open;
                                const saved = reading.current.get(id);
                                const previous = saved?.expanded ?? noExpandedTools;
                                if (previous.has(message.id) === open) return;
                                const expanded = new Set(previous);
                                if (open) expanded.add(message.id);
                                else expanded.delete(message.id);
                                if (expanded.size > 256)
                                  expanded.delete(expanded.values().next().value!);
                                reading.current.set(id, {
                                  top: 0,
                                  latest: true,
                                  ...saved,
                                  expanded,
                                });
                                expansionChanged((version) => version + 1);
                              }}
                            >
                              <summary>
                                Tool · {message.status} · {message.seq}
                              </summary>
                              {toolExpanded.has(message.id) && (
                                <SafeMessageMarkdown content={message.content} />
                              )}
                            </details>
                          ) : (
                            <>
                              {message.status !== 'complete' && <small>{message.status}</small>}
                              <ModelOutputMessage
                                autoRead
                                autoReadRetry
                                message={message}
                                terminalObserved={modelOutputTerminalObserved(
                                  message,
                                  snapshot.view.executions,
                                  runFacts.runs,
                                )}
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
                                  const key = outputKeys.get(message.id);
                                  if (
                                    key === undefined ||
                                    currentOutputs.current.get(message.id) !== key
                                  )
                                    return;
                                  const previous = visibleOutput.current.get(message.id);
                                  if (content === undefined) {
                                    if (previous?.key !== key) return;
                                    visibleOutput.current.delete(message.id);
                                  } else {
                                    if (previous?.key === key && previous.text === content) return;
                                    visibleOutput.current.set(message.id, { key, text: content });
                                  }
                                  outputChanged((revision) => revision + 1);
                                }}
                              />
                              {message.role === 'user' &&
                                message.status === 'complete' &&
                                message.content && (
                                  <MessageCopyButton
                                    text={message.content}
                                    copyRole="user"
                                    disabled={suspended || !pageVisible}
                                    writeClipboardText={(text) =>
                                      browser.navigator.clipboard.writeText(text)
                                    }
                                  />
                                )}
                              {message.role === 'assistant' && replies.get(message.id)?.text && (
                                <MessageCopyButton
                                  text={replies.get(message.id)!.text!}
                                  copyRole="assistant"
                                  disabled={suspended || !pageVisible || update.phase !== 'ready'}
                                  writeClipboardText={(text) =>
                                    browser.navigator.clipboard.writeText(text)
                                  }
                                />
                              )}
                            </>
                          )}
                        </article>
                      ))}
                    </div>
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
