import {
  InformationCircleIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { Composer, type ComposerProps } from './Composer';
import { Conversation, type ReadingState } from './Conversation';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './components/ui/sheet';
import { FileChanges } from './FileChanges';
import {
  NewConversationContext,
  type NewConversationProps,
  NewConversationWelcome,
} from './NewConversation';
import { RightSidebar } from './RightSidebar';
import { ScheduledTaskEditor, ScheduledTasks, type ScheduledTasksProps } from './ScheduledTasks';
import { type PageActions, Sidebar } from './Sidebar';
import type { Message, WorkspaceSummary } from './types';
import { Button } from './ui';
import { Workbench } from './Workbench';

const SESSION_HEADER_LABEL_LIMIT = 10;
const NAVIGATION_MIN_WIDTH = 200;
const NAVIGATION_MAX_WIDTH = 420;
const NAVIGATION_WIDTH_STORAGE_KEY = 'kite.client.navigationWidth';
const ENVIRONMENT_INFORMATION_MIN_WIDTH = 720 + 344 + 28;

function savedNavigationWidth(): number {
  try {
    const width = Number(window.localStorage.getItem(NAVIGATION_WIDTH_STORAGE_KEY));
    if (Number.isFinite(width) && width >= NAVIGATION_MIN_WIDTH && width <= NAVIGATION_MAX_WIDTH)
      return width;
  } catch {
    // A storage failure must not prevent the page from opening.
  }
  return NAVIGATION_MIN_WIDTH;
}

function sessionHeaderLabel(label: string): string {
  const characters = Array.from(label);
  if (characters.length <= SESSION_HEADER_LABEL_LIMIT) return label;
  return `${characters.slice(0, SESSION_HEADER_LABEL_LIMIT - 1).join('')}…`;
}

export interface SessionPageProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  sessionLabel: string;
  readingKey: string;
  messages: readonly Message[];
  loading: boolean;
  connected: boolean;
  connectionLabel: string;
  busy?: boolean;
  mutationBusy?: boolean;
  actions: PageActions;
  onOpen?: (id: string) => void;
  onExpand?: (id: string) => void;
  defaultExpanded?: boolean;
  composer?: ComposerProps;
  readOnlyReason?: string;
  notices?: ReactNode;
  headerActions?: ReactNode;
  onHeaderMouseDown?: (clickCount: 1 | 2) => void;
  interaction?: ReactNode;
  statusNotice?: ReactNode;
  /** Ephemeral parent-run wait indicator supplied by a host; never a transcript message. */
  requiredSubagentWait?: boolean;
  beforeConversation?: ReactNode;
  environmentInformation?: ReactNode;
  diagnosticView?: ReactNode;
  historyPanel?: { id: string; labelledBy: string };
  historyError?: { title: string; detail: string; retry: () => void };
  overlays?: ReactNode;
  fileChanges?: readonly Message[];
  newConversation?: NewConversationProps;
  workbench?: boolean;
  scheduledTasks?: ScheduledTasksProps;
  writeClipboardText?: (text: string) => Promise<void>;
  childSessionIdsByTaskId?: ReadonlyMap<string, string>;
  onOpenChildSession?: (childSessionId: string) => void;
}

/** The single production conversation page for both hosts. No host/protocol imports. */
export function SessionPage({ messages, fileChanges, ...props }: SessionPageProps) {
  // Keep evictable history outside props captured by persistent window listeners.
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const focusComposerAfterCommit = useCallback((moveCaretToEnd = false) => {
    const focus = () => {
      const input = composerInput.current;
      input?.focus();
      if (moveCaretToEnd && input) input.setSelectionRange(input.value.length, input.value.length);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else queueMicrotask(focus);
  }, []);
  const focusComposerOnClose = useRef(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 600px)').matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [navigationWidth] = useState(savedNavigationWidth);
  const navigationPanel = useRef<PanelImperativeHandle>(null);
  const detailsPanel = useRef<PanelImperativeHandle>(null);
  const panelGroupElement = useRef<HTMLDivElement>(null);
  const navigationPanelFrame = useRef<number | undefined>(undefined);
  const detailsPanelFrame = useRef<number | undefined>(undefined);
  const retainedRightSidebarPanel = useRef<ReactNode>(null);
  const [changesKey, setChangesKey] = useState<string>();
  const changesOpen = changesKey === props.readingKey && fileChanges !== undefined;
  const [scheduledEditorOpen, setScheduledEditorOpen] = useState(false);
  const [sessionViewElement, setSessionViewElement] = useState<HTMLDivElement | null>(null);
  const [environmentPreference, setEnvironmentPreference] = useState<'default' | 'open' | 'closed'>(
    'default',
  );
  const [environmentFits, setEnvironmentFits] = useState(false);
  const [environmentAnimationKey, setEnvironmentAnimationKey] = useState<string>();
  const lastAnimationReadingKey = useRef(props.readingKey);
  const environmentAnimationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startEnvironmentAnimation = useCallback(() => {
    if (environmentAnimationTimer.current !== undefined)
      clearTimeout(environmentAnimationTimer.current);
    setEnvironmentAnimationKey(props.readingKey);
    environmentAnimationTimer.current = setTimeout(() => {
      environmentAnimationTimer.current = undefined;
      setEnvironmentAnimationKey(undefined);
    }, 200);
  }, [props.readingKey]);
  const environmentMode = !props.environmentInformation
    ? 'closed'
    : environmentFits
      ? environmentPreference === 'closed'
        ? 'closed'
        : 'docked'
      : environmentPreference === 'open'
        ? 'overlay'
        : 'closed';
  const environmentVisible = environmentMode !== 'closed';
  const animateEnvironment = environmentAnimationKey === props.readingKey;
  const previousEnvironmentFits = useRef(environmentFits);
  const previousEnvironmentMode = useRef(environmentMode);
  const rightSidebarOpen = changesOpen || (scheduledEditorOpen && !!props.scheduledTasks);
  const changesToggle = useRef<HTMLButtonElement>(null);
  const scheduledEditorToggle = useRef<HTMLButtonElement | null>(null);
  const focusControlAfterCommit = useCallback((control: { current: HTMLButtonElement | null }) => {
    queueMicrotask(() => control.current?.focus());
  }, []);
  const schedulePanelChange = useCallback(
    (
      frame: { current: number | undefined },
      panel: { current: PanelImperativeHandle | null },
      open: boolean,
    ) => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        const group = panelGroupElement.current;
        if (!group || group.offsetWidth <= 0 || group.getBoundingClientRect().width <= 0) return;
        if (open) panel.current?.expand();
        else panel.current?.collapse();
      });
    },
    [],
  );
  const setDesktopSidebarOpen = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      if (!narrow) schedulePanelChange(navigationPanelFrame, navigationPanel, open);
    },
    [narrow, schedulePanelChange],
  );
  const expandDetails = useCallback(
    () => schedulePanelChange(detailsPanelFrame, detailsPanel, true),
    [schedulePanelChange],
  );
  const collapseDetails = useCallback(
    () => schedulePanelChange(detailsPanelFrame, detailsPanel, false),
    [schedulePanelChange],
  );
  useEffect(
    () => () => {
      if (navigationPanelFrame.current !== undefined)
        cancelAnimationFrame(navigationPanelFrame.current);
      if (detailsPanelFrame.current !== undefined) cancelAnimationFrame(detailsPanelFrame.current);
      if (environmentAnimationTimer.current !== undefined)
        clearTimeout(environmentAnimationTimer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (lastAnimationReadingKey.current === props.readingKey) return;
    lastAnimationReadingKey.current = props.readingKey;
    if (environmentAnimationTimer.current !== undefined)
      clearTimeout(environmentAnimationTimer.current);
    environmentAnimationTimer.current = undefined;
    setEnvironmentAnimationKey(undefined);
  }, [props.readingKey]);
  useLayoutEffect(() => {
    if (changesKey !== undefined && changesKey !== props.readingKey) {
      collapseDetails();
      setChangesKey(undefined);
    }
  }, [changesKey, props.readingKey, collapseDetails]);
  useEffect(() => {
    if (!props.scheduledTasks) {
      collapseDetails();
      setScheduledEditorOpen(false);
    }
  }, [props.scheduledTasks, collapseDetails]);
  useEffect(() => {
    const element = sessionViewElement;
    if (!element) return;
    const update = (width: number) => {
      if (width <= 0) return;
      if (
        width < ENVIRONMENT_INFORMATION_MIN_WIDTH &&
        previousEnvironmentFits.current &&
        previousEnvironmentMode.current === 'docked'
      )
        startEnvironmentAnimation();
      setEnvironmentFits(width >= ENVIRONMENT_INFORMATION_MIN_WIDTH);
    };
    const measure = () => update(element.getBoundingClientRect().width);
    let frame: number | undefined;
    const measureAfterLayout = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry?.contentRect.width) update(entry.contentRect.width);
            else measureAfterLayout();
          });
    observer?.observe(element);
    window.addEventListener('resize', measureAfterLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureAfterLayout);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [sessionViewElement, startEnvironmentAnimation]);
  useLayoutEffect(() => {
    const previouslyFit = previousEnvironmentFits.current;
    const previousMode = previousEnvironmentMode.current;
    previousEnvironmentFits.current = environmentFits;
    previousEnvironmentMode.current = environmentMode;
    if (!previouslyFit || environmentFits || previousMode !== 'docked') return;
    setEnvironmentPreference('closed');
  }, [environmentFits, environmentMode]);
  const readings = useRef<Record<string, ReadingState>>({});
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open]') ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (rightSidebarOpen) {
        collapseDetails();
        setChangesKey(undefined);
        setScheduledEditorOpen(false);
        focusControlAfterCommit(changesOpen ? changesToggle : scheduledEditorToggle);
        return;
      }
      if (narrow) {
        setDesktopSidebarOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [
    narrow,
    changesOpen,
    rightSidebarOpen,
    focusControlAfterCommit,
    collapseDetails,
    setDesktopSidebarOpen,
  ]);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia('(max-width: 600px)');
    const resize = () => {
      setNarrow(media.matches);
      if (media.matches) setDesktopSidebarOpen(false);
    };
    resize();
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [setDesktopSidebarOpen]);
  const open = (id: string) => {
    if (!props.onOpen) return;
    props.onOpen(id);
    if (narrow) setDesktopSidebarOpen(false);
  };
  const handleHeaderMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.detail !== 1 && event.detail !== 2) ||
      (event.target as HTMLElement).closest(
        'button, a, input, select, textarea, label, summary, [role="button"], [role="link"]',
      )
    )
      return;
    event.preventDefault();
    props.onHeaderMouseDown?.(event.detail);
  };
  const sidebarPanel = (
    <div className={`client-sidebar-panel ${narrow ? 'narrow' : ''}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
      <header className="sidebar-header" onMouseDown={handleHeaderMouseDown}>
        <strong className="brand">kite</strong>
        <Button
          ref={toggle}
          className="ghost sidebar-toggle"
          size="icon-sm"
          aria-expanded={sidebarOpen}
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={() => setDesktopSidebarOpen(false)}
        >
          <HugeiconsIcon icon={PanelLeftCloseIcon} />
        </Button>
      </header>
      <aside className="sidebar" aria-label="空间与会话">
        <Sidebar
          workspaces={props.workspaces}
          selected={props.selected}
          busy={props.busy}
          mutationBusy={props.mutationBusy}
          actions={{
            ...props.actions,
            newWorkspaceSession: props.actions.newWorkspaceSession
              ? (id) => {
                  props.actions.newWorkspaceSession?.(id);
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setDesktopSidebarOpen(false);
                  }
                  focusComposerAfterCommit();
                }
              : undefined,
            newSession: props.actions.newSession
              ? () => {
                  props.actions.newSession?.();
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setDesktopSidebarOpen(false);
                  }
                  focusComposerAfterCommit();
                }
              : undefined,
          }}
          connectionLabel={props.connectionLabel}
          activePage={
            props.scheduledTasks ? 'scheduledTasks' : props.workbench ? 'workbench' : 'conversation'
          }
          onExpand={props.onExpand}
          defaultExpanded={props.defaultExpanded}
          onOpen={props.onOpen ? open : undefined}
        />
      </aside>
    </div>
  );
  const rightSidebarPanel = changesOpen ? (
    <RightSidebar
      id="session-file-changes"
      label="文件变更"
      tabs={[
        {
          value: 'changes',
          label: '文件变更',
          content: <FileChanges messages={fileChanges!} openFile={props.actions.openFile} />,
        },
      ]}
      onClose={() => {
        collapseDetails();
        setChangesKey(undefined);
        focusControlAfterCommit(changesToggle);
      }}
    />
  ) : scheduledEditorOpen && props.scheduledTasks ? (
    <RightSidebar
      label="新建安排任务"
      title="新建"
      onClose={() => {
        collapseDetails();
        setScheduledEditorOpen(false);
        focusControlAfterCommit(scheduledEditorToggle);
      }}
    >
      <ScheduledTaskEditor
        props={props.scheduledTasks}
        onClose={() => {
          collapseDetails();
          setScheduledEditorOpen(false);
          focusControlAfterCommit(scheduledEditorToggle);
        }}
      />
    </RightSidebar>
  ) : null;
  if (rightSidebarPanel) retainedRightSidebarPanel.current = rightSidebarPanel;
  return (
    <div className={`kite-client shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <ResizablePanelGroup
        key={narrow ? 'narrow' : 'wide'}
        id="client-layout"
        orientation="horizontal"
        elementRef={panelGroupElement}
        className="client-panels"
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction || narrow) return;
          const groupWidth = Array.from(
            panelGroupElement.current?.querySelectorAll<HTMLElement>(':scope > [data-panel]') ?? [],
          ).reduce((width, panel) => width + panel.offsetWidth, 0);
          const width = Math.round(((layout.navigation ?? 0) / 100) * groupWidth);
          if (width < NAVIGATION_MIN_WIDTH || width > NAVIGATION_MAX_WIDTH) return;
          try {
            window.localStorage.setItem(NAVIGATION_WIDTH_STORAGE_KEY, String(width));
          } catch {
            // Resizing remains available when preference storage is unavailable.
          }
        }}
      >
        {!narrow && (
          <>
            <ResizablePanel
              id="navigation"
              className="collapsible-sidebar-viewport"
              panelRef={navigationPanel}
              collapsible
              collapsedSize="0px"
              defaultSize={`${navigationWidth}px`}
              minSize={`${NAVIGATION_MIN_WIDTH}px`}
              maxSize={`${NAVIGATION_MAX_WIDTH}px`}
            >
              <div
                className="collapsible-sidebar-content"
                style={{ minWidth: '200px' }}
                aria-hidden={!sidebarOpen}
                inert={!sidebarOpen}
              >
                {sidebarPanel}
              </div>
            </ResizablePanel>
            <ResizableHandle
              id="navigation-resize"
              className="collapsible-sidebar-handle"
              data-open={sidebarOpen ? 'true' : 'false'}
              withHandle
            />
          </>
        )}
        <ResizablePanel id="content" minSize="360px">
          <div className="client-main-panel" inert={narrow && sidebarOpen}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
            <header className="session-header" onMouseDown={handleHeaderMouseDown}>
              {!sidebarOpen && (
                <Button
                  ref={toggle}
                  className="ghost sidebar-toggle"
                  size="icon-sm"
                  aria-expanded={sidebarOpen}
                  aria-label="展开侧栏"
                  title="展开侧栏"
                  onClick={() => setDesktopSidebarOpen(true)}
                >
                  <HugeiconsIcon icon={PanelLeftOpenIcon} />
                </Button>
              )}
              <div className="breadcrumb">
                {props.scheduledTasks ? (
                  <strong>安排任务</strong>
                ) : props.workbench ? (
                  <strong>工作台</strong>
                ) : props.newConversation ? (
                  <strong>新对话</strong>
                ) : (
                  <strong title={props.sessionLabel}>
                    {sessionHeaderLabel(props.sessionLabel)}
                  </strong>
                )}
              </div>
              {props.headerActions}
              {props.environmentInformation && (
                <Button
                  className="ghost environment-information-toggle"
                  size="icon-sm"
                  aria-expanded={environmentVisible}
                  aria-controls="session-environment-information"
                  aria-label={environmentVisible ? '隐藏环境信息' : '显示环境信息'}
                  title={environmentVisible ? '隐藏环境信息' : '显示环境信息'}
                  onClick={() => {
                    startEnvironmentAnimation();
                    setEnvironmentPreference(environmentVisible ? 'closed' : 'open');
                  }}
                >
                  <HugeiconsIcon icon={InformationCircleIcon} />
                </Button>
              )}
              {fileChanges !== undefined && (
                <Button
                  ref={changesToggle}
                  className="ghost"
                  aria-expanded={changesOpen}
                  aria-controls="session-file-changes"
                  onClick={() => {
                    if (changesOpen) collapseDetails();
                    else expandDetails();
                    setChangesKey(changesOpen ? undefined : props.readingKey);
                  }}
                >
                  {changesOpen ? '收起变更' : '文件变更'}
                </Button>
              )}
            </header>
            <main
              className={
                props.newConversation
                  ? 'new-conversation-page'
                  : props.scheduledTasks
                    ? 'scheduled-tasks-page'
                    : props.workbench
                      ? 'workbench-page'
                      : undefined
              }
            >
              {props.notices}
              <div className="session-body">
                <div
                  className={`session-view environment-information-${environmentMode}${animateEnvironment ? ' environment-information-animated' : ''}`}
                  ref={setSessionViewElement}
                >
                  {props.environmentInformation}
                  {props.beforeConversation}
                  {props.scheduledTasks ? (
                    <ScheduledTasks
                      {...props.scheduledTasks}
                      onNewTask={(trigger) => {
                        scheduledEditorToggle.current = trigger;
                        expandDetails();
                        setScheduledEditorOpen(true);
                      }}
                    />
                  ) : props.workbench ? (
                    <Workbench
                      workspaces={props.workspaces}
                      onOpen={props.onOpen ? open : undefined}
                    />
                  ) : (
                    (props.diagnosticView ?? (
                      <section
                        className="history-panel"
                        role={props.historyPanel ? 'tabpanel' : undefined}
                        id={props.historyPanel?.id}
                        aria-labelledby={props.historyPanel?.labelledBy}
                      >
                        {props.newConversation && props.composer && !messages.length ? (
                          <NewConversationWelcome
                            onSuggest={(value) => {
                              props.composer!.onChange(
                                props.composer!.draft
                                  ? `${props.composer!.draft}\n${value}`
                                  : value,
                              );
                              focusComposerAfterCommit(true);
                            }}
                          />
                        ) : props.historyError ? (
                          <section className="notice error" role="alert">
                            <strong>{props.historyError.title}</strong>
                            <p>{props.historyError.detail}</p>
                            <Button onClick={props.historyError.retry}>重试</Button>
                          </section>
                        ) : (
                          <Conversation
                            key={props.readingKey}
                            messages={messages}
                            loading={props.loading}
                            requiredSubagentWait={props.requiredSubagentWait}
                            selected={!!props.selected}
                            emptyState={
                              !props.composer
                                ? {
                                    title: props.selected
                                      ? '暂无消息'
                                      : props.workspaces.length
                                        ? '选择会话'
                                        : '暂无可查看的会话',
                                    detail: props.selected
                                      ? '当前会话没有可展示的历史消息。'
                                      : '从左侧空间中点击会话即可加载消息。',
                                  }
                                : undefined
                            }
                            connected={props.connected}
                            initialReading={readings.current[props.readingKey]}
                            saveReading={(state) => {
                              readings.current[props.readingKey] = state;
                            }}
                            openFile={props.actions.openFile}
                            writeClipboardText={props.writeClipboardText}
                            childSessionIdsByTaskId={props.childSessionIdsByTaskId}
                            onOpenChildSession={props.onOpenChildSession}
                          />
                        )}
                      </section>
                    ))
                  )}
                  {!props.workbench && !props.scheduledTasks && (
                    <footer className="conversation-footer">
                      <div className="bottom-controls">
                        {props.statusNotice}
                        {props.interaction && (
                          <div className="interaction-area">{props.interaction}</div>
                        )}
                        {props.composer ? (
                          <Composer
                            {...props.composer}
                            promptHidden={!!props.interaction}
                            inputRef={composerInput}
                            context={
                              props.newConversation && (
                                <NewConversationContext {...props.newConversation} />
                              )
                            }
                          />
                        ) : (
                          props.readOnlyReason && (
                            <p className="hint" role="status">
                              {props.readOnlyReason}
                            </p>
                          )
                        )}
                      </div>
                    </footer>
                  )}
                </div>
              </div>
            </main>
          </div>
        </ResizablePanel>
        <ResizableHandle
          id="details-resize"
          className="collapsible-sidebar-handle"
          data-open={rightSidebarOpen ? 'true' : 'false'}
          withHandle
        />
        <ResizablePanel
          id="details"
          className="collapsible-sidebar-viewport"
          panelRef={detailsPanel}
          collapsible
          collapsedSize="0px"
          defaultSize="0px"
          minSize="300px"
          maxSize="640px"
        >
          <div
            className="collapsible-sidebar-content"
            style={{ minWidth: '300px' }}
            aria-hidden={!rightSidebarOpen}
            inert={!rightSidebarOpen}
          >
            {rightSidebarPanel ?? retainedRightSidebarPanel.current}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {narrow && (
        <Sheet
          open={sidebarOpen}
          onOpenChange={(open) => {
            setDesktopSidebarOpen(open);
            if (open) return;
            if (focusComposerOnClose.current) {
              focusComposerOnClose.current = false;
              focusComposerAfterCommit();
            } else toggle.current?.focus();
          }}
        >
          <SheetContent side="left" portalled={false} showCloseButton={false}>
            <SheetTitle className="sr-only">空间与会话</SheetTitle>
            <SheetDescription className="sr-only">选择空间或会话</SheetDescription>
            {sidebarPanel}
          </SheetContent>
        </Sheet>
      )}
      {props.overlays}
    </div>
  );
}
