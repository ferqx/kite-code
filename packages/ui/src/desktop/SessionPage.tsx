import {
  BrowserIcon,
  InformationCircleIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps, ReactNode, SyntheticEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { Composer, type ComposerProps } from './Composer';
import type { ToolActivityState } from './Conversation';
import { Conversation } from './Conversation';
import { ConversationCache, type ConversationCacheScope } from './ConversationCache';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { FileChanges } from './FileChanges';
import {
  NewConversationContext,
  type NewConversationProps,
  NewConversationWelcome,
} from './NewConversation';
import type { PromptEditorHandle } from './PromptEditor';
import { RightSidebar } from './RightSidebar';
import { ReadingStateCache } from './reading-state';
import {
  ScheduledTaskEditor,
  type ScheduledTaskSummary,
  ScheduledTasks,
  type ScheduledTasksProps,
} from './ScheduledTasks';
import {
  type SessionBrowserPageProps,
  type SessionChildPageProps,
  type SessionChildTabRequest,
  type SessionChildTarget,
  SessionTabs,
  useSessionTabs,
} from './SessionTabs';
import { type PageActions, Sidebar } from './Sidebar';
import type { Message, TurnActivity, WorkspaceSummary } from './types';
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

function NavigationPanel({ defaultSize, ...props }: ComponentProps<typeof ResizablePanel>) {
  // Do not replace the initial default when a drag updates the saved width.
  const initialSize = useRef(defaultSize);
  return <ResizablePanel {...props} defaultSize={initialSize.current} />;
}

export interface SessionPageProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  sessionLabel: string;
  readingKey: string;
  /** Optional bounded retention; hosts still own fresh read and operation admission. */
  conversationCache?: ConversationCacheScope;
  messages: readonly Message[];
  renderMessage?: (message: Message) => ReactNode;
  renderMessageContent?: (message: Message) => ReactNode;
  renderMessageAttachments?: (message: Message) => ReactNode;
  renderToolActivity?: (messages: readonly Message[], state: ToolActivityState) => ReactNode;
  /** Host-confirmed current Turn; omitted when the message source has no Turn identity. */
  turnActivity?: TurnActivity;
  loading: boolean;
  /** Cold history waits for its initial grouping without pausing an existing reading. */
  initialPresentationPending?: boolean;
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
  /** Child interactions may remain actionable beside the parent input. Defaults to true. */
  interactionHidesPrompt?: boolean;
  statusNotice?: ReactNode;
  /** Ephemeral parent-run wait indicator supplied by a host; never a transcript message. */
  requiredSubagentWait?: boolean;
  beforeConversation?: ReactNode;
  environmentInformation?: ReactNode;
  detailPanel?: { label: string; content: ReactNode; onClose: () => void };
  diagnosticView?: ReactNode;
  historyPanel?: { id: string; labelledBy: string };
  historyError?: { title: string; detail: string; retry: () => void };
  /** Retain the page's layout and readers while a host view replaces its painted surface. */
  covered?: boolean;
  overlays?: ReactNode;
  fileChanges?: readonly Message[];
  /** Host receipt reader rendered within the retained FileChanges sidebar. */
  fileChangesContent?: ReactNode;
  renderBrowser?: (props: SessionBrowserPageProps) => ReactNode;
  closeBrowser?: (id: string) => void;
  childTabRequest?: SessionChildTabRequest;
  renderChildSession?: (props: SessionChildPageProps) => ReactNode;
  onChildSessionChange?: (target: SessionChildTarget | undefined) => void;
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
  const composerInput = useRef<PromptEditorHandle>(null);
  const headerElement = useRef<HTMLElement>(null);
  const footerElement = useRef<HTMLElement>(null);
  const focusComposerAfterCommit = useCallback(() => {
    const focus = () => {
      composerInput.current?.focus();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else queueMicrotask(focus);
  }, []);
  const [sidebarOpen, setSidebarOpenIntent] = useState(true);
  const [panelsAnimating, setPanelsAnimating] = useState(false);
  const navigationWidth = useRef(savedNavigationWidth());
  const navigationPanel = useRef<PanelImperativeHandle>(null);
  const detailsPanel = useRef<PanelImperativeHandle>(null);
  const panelGroupElement = useRef<HTMLDivElement>(null);
  const contentGroupElement = useRef<HTMLDivElement>(null);
  const navigationPanelFrame = useRef<number | undefined>(undefined);
  const panelAnimationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detailsPanelFrame = useRef<number | undefined>(undefined);
  const retainedRightSidebarPanel = useRef<ReactNode>(null);
  const [tabsKey, setTabsKey] = useState<string>();
  const [detailsCollapsed, setDetailsCollapsed] = useState<boolean>();
  const presentedTabsKey = useRef<string | undefined>(undefined);
  const hasTabs =
    !props.workbench &&
    !props.scheduledTasks &&
    (props.renderBrowser !== undefined ||
      fileChanges !== undefined ||
      props.fileChangesContent !== undefined ||
      props.renderChildSession !== undefined);
  const tabModel = useSessionTabs(hasTabs ? props.readingKey : 'inactive', props.closeBrowser);
  const childTabOpener = useRef(tabModel.openChild);
  childTabOpener.current = tabModel.openChild;
  const [tabLimitKey, setTabLimitKey] = useState<string>();
  const tabsOpen = tabsKey === props.readingKey && hasTabs;
  const scheduledEditorGeneration = useRef(0);
  const [scheduledEditor, setScheduledEditor] = useState<{
    generation: number;
    task?: ScheduledTaskSummary;
  }>();
  const [sessionViewElement, setSessionViewElement] = useState<HTMLDivElement | null>(null);
  const [environmentPreference, setEnvironmentPreference] = useState<'default' | 'open' | 'closed'>(
    'default',
  );
  const [environmentFits, setEnvironmentFits] = useState(false);
  const environmentMeasured = useRef(false);
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
  const hostDetailsOpen = !!props.detailPanel;
  useLayoutEffect(() => {
    if (hostDetailsOpen) setTabsKey(undefined);
  }, [hostDetailsOpen]);
  const detailClose = useRef(props.detailPanel?.onClose);
  detailClose.current = props.detailPanel?.onClose;
  const rightSidebarOpen =
    hostDetailsOpen || tabsOpen || (!!scheduledEditor && !!props.scheduledTasks);
  const tabsVisible = tabsOpen && detailsCollapsed !== true;
  const tabsPresent =
    tabsVisible ||
    (!rightSidebarOpen && panelsAnimating && presentedTabsKey.current === props.readingKey);
  useLayoutEffect(() => {
    if (tabsVisible) presentedTabsKey.current = props.readingKey;
    else if (!panelsAnimating || hostDetailsOpen || props.covered)
      presentedTabsKey.current = undefined;
  }, [tabsVisible, panelsAnimating, hostDetailsOpen, props.covered, props.readingKey]);
  const tabsToggle = useRef<HTMLButtonElement>(null);
  const scheduledEditorToggle = useRef<HTMLButtonElement | null>(null);
  const focusControlAfterCommit = useCallback((control: { current: HTMLButtonElement | null }) => {
    queueMicrotask(() => control.current?.focus());
  }, []);
  const schedulePanelChange = useCallback(
    (
      frame: { current: number | undefined },
      panel: { current: PanelImperativeHandle | null },
      open: boolean,
      commit?: () => void,
    ) => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      const groupElement = panel === detailsPanel ? contentGroupElement : panelGroupElement;
      const currentGroup = groupElement.current;
      if (
        commit &&
        (!currentGroup ||
          currentGroup.offsetWidth <= 0 ||
          currentGroup.getBoundingClientRect().width <= 0)
      ) {
        commit();
        return;
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        // The header affordance and the panel layout must start in one commit.
        commit?.();
        const group = groupElement.current;
        if (!group || group.offsetWidth <= 0 || group.getBoundingClientRect().width <= 0) return;
        const target = panel.current;
        if (!target || (panel !== navigationPanel && target.isCollapsed() !== open)) return;
        setPanelsAnimating(true);
        if (panelAnimationTimer.current !== undefined) clearTimeout(panelAnimationTimer.current);
        panelAnimationTimer.current = setTimeout(() => {
          panelAnimationTimer.current = undefined;
          setPanelsAnimating(false);
        }, 240);
        // Navigation uses explicit size constraints; only its button changes them.
        if (panel === navigationPanel) return;
        if (open) target.expand();
        else target.collapse();
      });
    },
    [],
  );
  const setSidebarOpen = useCallback(
    (open: boolean) => {
      schedulePanelChange(navigationPanelFrame, navigationPanel, open, () => {
        setSidebarOpenIntent(open);
      });
    },
    [schedulePanelChange],
  );
  useLayoutEffect(() => {
    const group = panelGroupElement.current;
    if (sidebarOpen && group && group.getBoundingClientRect().width > 0)
      navigationPanel.current?.resize(`${navigationWidth.current}px`);
  }, [sidebarOpen]);
  const stopPanelAnimationOnResize = useCallback((event: SyntheticEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest('[data-slot="resizable-handle"]')
    )
      return;
    if (panelAnimationTimer.current !== undefined) clearTimeout(panelAnimationTimer.current);
    panelAnimationTimer.current = undefined;
    setPanelsAnimating(false);
  }, []);
  const expandDetails = useCallback(
    () => schedulePanelChange(detailsPanelFrame, detailsPanel, true),
    [schedulePanelChange],
  );
  const collapseDetails = useCallback(
    () => schedulePanelChange(detailsPanelFrame, detailsPanel, false),
    [schedulePanelChange],
  );
  const changeTabsOpen = useCallback(
    (open: boolean) => {
      // Closing a host panel can replace its pending layout frame, not this intent.
      setTabsKey(open ? props.readingKey : undefined);
      schedulePanelChange(detailsPanelFrame, detailsPanel, open);
    },
    [schedulePanelChange, props.readingKey],
  );
  const handledChildRequest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const request = props.childTabRequest;
    if (!hasTabs || !request) return;
    const key = JSON.stringify([props.readingKey, request.requestId]);
    if (handledChildRequest.current === key) return;
    handledChildRequest.current = key;
    const opened = childTabOpener.current(
      { sessionId: request.sessionId, executionId: request.executionId },
      request.title,
    );
    setTabLimitKey(opened ? undefined : props.readingKey);
    detailClose.current?.();
    changeTabsOpen(true);
  }, [props.childTabRequest, hasTabs, props.readingKey, changeTabsOpen]);
  const closeScheduledEditor = useCallback(
    (generation: number) => {
      if (scheduledEditorGeneration.current !== generation) return;
      scheduledEditorGeneration.current++;
      collapseDetails();
      setScheduledEditor(undefined);
      focusControlAfterCommit(scheduledEditorToggle);
    },
    [collapseDetails, focusControlAfterCommit],
  );
  useEffect(
    () => () => {
      scheduledEditorGeneration.current++;
      if (navigationPanelFrame.current !== undefined)
        cancelAnimationFrame(navigationPanelFrame.current);
      if (panelAnimationTimer.current !== undefined) clearTimeout(panelAnimationTimer.current);
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
    if (tabsKey !== undefined && tabsKey !== props.readingKey) {
      collapseDetails();
      setTabsKey(undefined);
    }
  }, [tabsKey, props.readingKey, collapseDetails]);
  useEffect(() => {
    if (!props.scheduledTasks) {
      collapseDetails();
      scheduledEditorGeneration.current++;
      setScheduledEditor(undefined);
    }
  }, [props.scheduledTasks, collapseDetails]);
  useEffect(() => {
    if (!rightSidebarOpen) {
      collapseDetails();
      return;
    }
    expandDetails();
    const group = contentGroupElement.current;
    if (!group || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(expandDetails);
    observer.observe(group);
    return () => observer.disconnect();
  }, [rightSidebarOpen, expandDetails, collapseDetails]);
  useEffect(() => {
    const group = panelGroupElement.current;
    if (!sidebarOpen || !group || typeof ResizeObserver === 'undefined') return;
    let previousWidth = group.getBoundingClientRect().width;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      const width = group.getBoundingClientRect().width;
      if (width > previousWidth) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        // Restore the saved width after the library has applied the new constraints.
        frame = requestAnimationFrame(() => {
          frame = undefined;
          const panel = navigationPanel.current;
          if (panel && panel.getSize().inPixels < navigationWidth.current - 1)
            panel.resize(`${navigationWidth.current}px`);
        });
      }
      previousWidth = width;
    });
    observer.observe(group);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [sidebarOpen]);
  useLayoutEffect(() => {
    const element = sessionViewElement;
    if (!element) return;
    const update = (width: number) => {
      if (width <= 0) return;
      const fits = width >= ENVIRONMENT_INFORMATION_MIN_WIDTH;
      // The first painted layout uses its final docking space. Later width
      // changes retain the normal transition for navigation and window resizing.
      if (environmentMeasured.current && fits !== previousEnvironmentFits.current)
        startEnvironmentAnimation();
      environmentMeasured.current = true;
      setEnvironmentFits(fits);
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
    // Restore automatic docking when enough space becomes available again.
    setEnvironmentPreference('default');
  }, [environmentFits, environmentMode]);
  const readings = useRef(new ReadingStateCache());
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
        detailClose.current?.();
        if (tabsOpen) changeTabsOpen(false);
        else collapseDetails();
        scheduledEditorGeneration.current++;
        setScheduledEditor(undefined);
        focusControlAfterCommit(tabsOpen ? tabsToggle : scheduledEditorToggle);
        return;
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [tabsOpen, rightSidebarOpen, focusControlAfterCommit, collapseDetails, changeTabsOpen]);
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
    <div className="client-sidebar-panel">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
      <header className="sidebar-header" onMouseDown={handleHeaderMouseDown}>
        <strong className="brand">Kite</strong>
      </header>
      <aside className="sidebar" aria-label="空间与会话">
        <Sidebar
          workspaces={props.workspaces}
          selectedWorkspace={
            !props.workbench && !props.scheduledTasks
              ? props.workspaces.find(
                  (workspace) => workspace.id === props.newConversation?.workspace,
                )?.id
              : undefined
          }
          selected={
            props.newConversation || props.workbench || props.scheduledTasks
              ? undefined
              : props.selected
          }
          busy={props.busy}
          mutationBusy={props.mutationBusy}
          actions={{
            ...props.actions,
            newWorkspaceSession: props.actions.newWorkspaceSession
              ? (id) => {
                  props.actions.newWorkspaceSession?.(id);
                  focusComposerAfterCommit();
                }
              : undefined,
            newSession: props.actions.newSession
              ? () => {
                  props.actions.newSession?.();
                  focusComposerAfterCommit();
                }
              : undefined,
          }}
          connectionLabel={props.connectionLabel}
          activePage={
            props.scheduledTasks
              ? 'scheduledTasks'
              : props.workbench
                ? 'workbench'
                : props.newConversation
                  ? 'newConversation'
                  : 'conversation'
          }
          onExpand={props.onExpand}
          defaultExpanded={props.defaultExpanded}
          onOpen={props.onOpen}
        />
      </aside>
    </div>
  );
  const closeRightSidebar = () => {
    if (props.detailPanel) {
      collapseDetails();
      props.detailPanel.onClose();
    } else if (tabsOpen) {
      changeTabsOpen(false);
      focusControlAfterCommit(tabsToggle);
    } else if (scheduledEditor && props.scheduledTasks) {
      closeScheduledEditor(scheduledEditor.generation);
    }
  };
  const rightSidebarPanel = props.detailPanel ? (
    <RightSidebar
      key="host-details"
      label={props.detailPanel.label}
      tabs={[
        { value: 'details', label: props.detailPanel.label, content: props.detailPanel.content },
      ]}
      onClose={closeRightSidebar}
    />
  ) : scheduledEditor && props.scheduledTasks ? (
    <RightSidebar
      key="scheduled-editor"
      label={scheduledEditor.task ? '编辑安排任务' : '新建安排任务'}
      title={scheduledEditor.task ? '编辑' : '新建'}
      onClose={closeRightSidebar}
    >
      <ScheduledTaskEditor
        key={scheduledEditor.generation}
        task={scheduledEditor.task}
        props={props.scheduledTasks}
        onClose={() => closeScheduledEditor(scheduledEditor.generation)}
      />
    </RightSidebar>
  ) : null;
  // Host panels may own active readers: closing must unmount them, not retain hidden I/O.
  if (rightSidebarPanel && !props.detailPanel && !props.fileChangesContent)
    retainedRightSidebarPanel.current = rightSidebarPanel;
  else if (props.detailPanel || props.fileChangesContent) retainedRightSidebarPanel.current = null;
  const historyVisible = !props.scheduledTasks && !props.workbench && !props.diagnosticView;
  const welcoming = !!(props.newConversation && props.composer && !messages.length);
  const headerOverlay =
    historyVisible && !welcoming && !props.historyError && !props.beforeConversation;
  useLayoutEffect(() => {
    const header = headerElement.current;
    const panel = header?.parentElement;
    const footer = historyVisible ? footerElement.current : null;
    if (!header || !panel) return;
    const measure = () => {
      const height = header.getBoundingClientRect().height;
      if (height > 0) panel.style.setProperty('--session-header-height', `${height}px`);
      panel.style.setProperty(
        '--conversation-footer-height',
        `${footer?.getBoundingClientRect().height ?? 0}px`,
      );
      const viewport = panel.querySelector<HTMLElement>('.conversation-viewport');
      if (viewport)
        panel.style.setProperty(
          '--conversation-scrollbar-gutter',
          `${viewport.offsetWidth - viewport.clientWidth}px`,
        );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header, { box: 'border-box' });
    if (footer) observer.observe(footer, { box: 'border-box' });
    return () => observer.disconnect();
  }, [historyVisible]);
  const keepAlive = !!props.conversationCache && typeof document !== 'undefined';
  const conversation = (
    <Conversation
      key={props.readingKey}
      messages={messages}
      renderMessage={props.renderMessage}
      renderMessageContent={props.renderMessageContent}
      renderMessageAttachments={props.renderMessageAttachments}
      renderToolActivity={props.renderToolActivity}
      turnActivity={props.turnActivity}
      loading={props.loading}
      initialPresentationPending={props.initialPresentationPending}
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
      initialReading={readings.current.get(props.readingKey)}
      saveReading={(state) => {
        readings.current.save(props.readingKey, state);
      }}
      openFile={props.actions.openFile}
      writeClipboardText={props.writeClipboardText}
      childSessionIdsByTaskId={props.childSessionIdsByTaskId}
      onOpenChildSession={props.onOpenChildSession}
    />
  );
  return (
    <div className={`kite-client shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <ResizablePanelGroup
        id="client-layout"
        orientation="horizontal"
        elementRef={panelGroupElement}
        className="client-panels"
        data-animate-width={panelsAnimating ? 'true' : undefined}
        onPointerDownCapture={stopPanelAnimationOnResize}
        onKeyDownCapture={stopPanelAnimationOnResize}
        aria-hidden={props.covered || undefined}
        inert={props.covered}
        style={props.covered ? { opacity: 0, pointerEvents: 'none' } : undefined}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction || !sidebarOpen) return;
          const groupWidth = Array.from(
            panelGroupElement.current?.querySelectorAll<HTMLElement>(':scope > [data-panel]') ?? [],
          ).reduce((width, panel) => width + panel.offsetWidth, 0);
          const width = Math.round(((layout.navigation ?? 0) / 100) * groupWidth);
          if (width < NAVIGATION_MIN_WIDTH || width > NAVIGATION_MAX_WIDTH) return;
          navigationWidth.current = width;
          try {
            window.localStorage.setItem(NAVIGATION_WIDTH_STORAGE_KEY, String(width));
          } catch {
            // Resizing remains available when preference storage is unavailable.
          }
        }}
      >
        <NavigationPanel
          id="navigation"
          className="collapsible-sidebar-viewport"
          style={{ overflow: 'hidden' }}
          panelRef={navigationPanel}
          defaultSize={`${navigationWidth.current}px`}
          groupResizeBehavior="preserve-pixel-size"
          minSize={sidebarOpen ? `${NAVIGATION_MIN_WIDTH}px` : '0px'}
          maxSize={sidebarOpen ? `${NAVIGATION_MAX_WIDTH}px` : '0px'}
        >
          <div
            className="collapsible-sidebar-content"
            style={{ minWidth: '200px' }}
            aria-hidden={!sidebarOpen}
            inert={!sidebarOpen}
          >
            {sidebarPanel}
          </div>
        </NavigationPanel>
        <ResizableHandle
          key={sidebarOpen ? 'navigation-open' : 'navigation-closed'}
          id="navigation-resize"
          disabled={!sidebarOpen}
          className="collapsible-sidebar-handle"
          data-open={sidebarOpen ? 'true' : 'false'}
          withHandle
        />
        {/* Follow the panel boundary without clipping or replacing the focused control. */}
        <div className="desktop-sidebar-toggle" data-open={sidebarOpen ? 'true' : undefined}>
          <Button
            ref={toggle}
            className="ghost sidebar-toggle"
            size="icon"
            aria-controls="navigation"
            aria-expanded={sidebarOpen}
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <HugeiconsIcon icon={sidebarOpen ? PanelLeftCloseIcon : PanelLeftOpenIcon} />
          </Button>
        </div>
        <ResizablePanel id="workspace" minSize="200px" style={{ overflow: 'visible' }}>
          <div className="client-content-frame">
            <ResizablePanelGroup
              id="content-layout"
              orientation="horizontal"
              elementRef={contentGroupElement}
              className="client-content-panels"
              data-animate-width={panelsAnimating ? 'true' : undefined}
              onLayoutChanged={(layout, meta) => {
                const group = contentGroupElement.current;
                if (group && group.offsetWidth > 0 && group.getBoundingClientRect().width > 0)
                  setDetailsCollapsed((layout.details ?? 0) === 0);
                if (
                  meta.isUserInteraction &&
                  rightSidebarOpen &&
                  detailsPanel.current?.isCollapsed()
                )
                  closeRightSidebar();
              }}
            >
              <ResizablePanel id="content" minSize="360px" style={{ overflow: 'hidden' }}>
                <div className="client-main-panel" data-header-overlay={headerOverlay || undefined}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
                  <header
                    ref={headerElement}
                    className="session-header"
                    onMouseDown={handleHeaderMouseDown}
                  >
                    <div className="session-heading">
                      <div
                        className="session-sidebar-toggle"
                        data-open={!sidebarOpen ? 'true' : undefined}
                      />
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
                    {hasTabs && (
                      <Button
                        ref={tabsToggle}
                        className="ghost"
                        aria-expanded={tabsOpen}
                        size="icon-sm"
                        aria-label="标签页"
                        title="标签页"
                        aria-controls="session-tabs"
                        onClick={() => {
                          if (!tabsOpen) props.detailPanel?.onClose();
                          changeTabsOpen(!tabsOpen);
                        }}
                      >
                        <HugeiconsIcon icon={BrowserIcon} />
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
                    {tabLimitKey === props.readingKey && tabModel.tabs.length >= 8 && (
                      <p role="status">标签页已满，请关闭一个标签页后重试。</p>
                    )}
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
                            onEditTask={(task, trigger) => {
                              scheduledEditorToggle.current = trigger;
                              setScheduledEditor({
                                generation: ++scheduledEditorGeneration.current,
                                task,
                              });
                              expandDetails();
                            }}
                            onNewTask={(trigger) => {
                              scheduledEditorToggle.current = trigger;
                              setScheduledEditor({
                                generation: ++scheduledEditorGeneration.current,
                              });
                              expandDetails();
                            }}
                          />
                        ) : props.workbench ? (
                          <Workbench workspaces={props.workspaces} onOpen={props.onOpen} />
                        ) : (
                          props.diagnosticView
                        )}
                        <section
                          className="history-panel"
                          style={historyVisible ? undefined : { display: 'none' }}
                          role={props.historyPanel ? 'tabpanel' : undefined}
                          id={props.historyPanel?.id}
                          aria-labelledby={props.historyPanel?.labelledBy}
                        >
                          {historyVisible &&
                            (welcoming ? (
                              <NewConversationWelcome />
                            ) : props.historyError ? (
                              <section className="notice error" role="alert">
                                <strong>{props.historyError.title}</strong>
                                <p>{props.historyError.detail}</p>
                                <Button onClick={props.historyError.retry}>重试</Button>
                              </section>
                            ) : keepAlive ? null : (
                              conversation
                            ))}
                          {keepAlive && (
                            <ConversationCache
                              identity={props.readingKey}
                              loading={props.loading}
                              visible={historyVisible && !welcoming && !props.historyError}
                              cache={props.conversationCache!}
                            >
                              {conversation}
                            </ConversationCache>
                          )}
                        </section>
                        {!props.workbench && !props.scheduledTasks && (
                          <footer ref={footerElement} className="conversation-footer">
                            <div className="bottom-controls">
                              {props.statusNotice}
                              {props.interaction && (
                                <div className="interaction-area">{props.interaction}</div>
                              )}
                              {props.composer ? (
                                <Composer
                                  {...props.composer}
                                  scopeKey={props.composer.scopeKey ?? props.readingKey}
                                  promptHidden={
                                    !!props.interaction && props.interactionHidesPrompt !== false
                                  }
                                  inputRef={composerInput}
                                  context={
                                    <>
                                      {props.composer.context}
                                      {props.newConversation && (
                                        <NewConversationContext {...props.newConversation} />
                                      )}
                                    </>
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
              {/* Re-register neighboring panels when resize availability changes. */}
              <ResizableHandle
                key={rightSidebarOpen ? 'details-open' : 'details-closed'}
                id="details-resize"
                className="collapsible-sidebar-handle"
                data-open={rightSidebarOpen ? 'true' : 'false'}
                disabled={!rightSidebarOpen}
                withHandle
              />
              <ResizablePanel
                id="details"
                className="collapsible-sidebar-viewport"
                style={{ overflow: 'hidden' }}
                panelRef={detailsPanel}
                disabled={!rightSidebarOpen}
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
                  {hasTabs && (
                    <SessionTabs
                      key={props.readingKey}
                      model={tabModel}
                      visible={tabsVisible && !props.covered && !props.detailPanel}
                      present={tabsPresent && !props.covered && !props.detailPanel}
                      renderBrowser={props.renderBrowser}
                      renderChildSession={props.renderChildSession}
                      onChildSessionChange={props.onChildSessionChange}
                      changes={
                        props.fileChangesContent ?? (
                          <FileChanges
                            messages={fileChanges ?? []}
                            openFile={props.actions.openFile}
                          />
                        )
                      }
                      onClose={closeRightSidebar}
                    />
                  )}
                  {rightSidebarPanel ?? retainedRightSidebarPanel.current}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {props.overlays}
    </div>
  );
}
