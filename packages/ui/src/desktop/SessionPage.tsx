import {
  BrowserIcon,
  InformationCircleIcon,
  KiteIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps, CSSProperties, ReactNode, SyntheticEvent } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { Composer, type ComposerProps } from './Composer';
import type { ToolActivityState } from './Conversation';
import { Conversation } from './Conversation';
import { ConversationCache, type ConversationCacheScope } from './ConversationCache';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { NativeScrollbars } from './components/ui/scroll-area';
import { FileChanges } from './FileChanges';
import {
  NewConversationContext,
  type NewConversationProps,
  NewConversationWelcome,
} from './NewConversation';
import type { PromptEditorHandle } from './PromptEditor';
import { RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH, RightSidebar } from './RightSidebar';
import { ReadingStateCache } from './reading-state';
import {
  ScheduledTaskEditor,
  type ScheduledTaskSummary,
  ScheduledTasks,
  type ScheduledTasksProps,
} from './ScheduledTasks';
import {
  type SessionBrowserPageProps,
  type SessionBrowserRestorePage,
  type SessionChildPageProps,
  type SessionChildTabRequest,
  type SessionChildTarget,
  SessionTabs,
  type SessionTabsModel,
  type SessionTrajectoryPageProps,
  useSessionTabs,
} from './SessionTabs';
import { type PageActions, Sidebar } from './Sidebar';
import type { Message, TurnActivity, WorkspaceSummary } from './types';
import { Button } from './ui';
import { Workbench } from './Workbench';

const SESSION_HEADER_LABEL_LIMIT = 10;
export const NAVIGATION_MIN_WIDTH = 200;
const NAVIGATION_MAX_WIDTH = 420;
const NAVIGATION_WIDTH_STORAGE_KEY = 'kite.client.navigationWidth';
// Match the centered column and gutters in the docked safe-area CSS. Automatic
// opening must fit in the right gutter without narrowing or shifting the input.
const ENVIRONMENT_INFORMATION_MIN_WIDTH = 844 + 2 * 344 + 28;
const MemoizedSidebar = memo(Sidebar);

/** Overlay and classic native scrollbars reserve different amounts of space. */
function syncConversationScrollbarGutter(element: HTMLElement) {
  if (!element.getBoundingClientRect().width) return;
  const probe = element.ownerDocument.createElement('div');
  probe.className = 'conversation-viewport';
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;contain:strict;width:100px;height:100px;overflow:scroll;border:0;padding:0';
  element.append(probe);
  const width = probe.offsetWidth;
  const gutter = Math.max(0, width - probe.clientWidth);
  probe.remove();
  // A hidden or unmeasurable tree cannot distinguish an overlay track from no layout.
  if (!width) return;
  const value = `${gutter}px`;
  if (element.style.getPropertyValue('--conversation-scrollbar-width') !== value)
    element.style.setProperty('--conversation-scrollbar-width', value);
}

/** Stable event delegates use only the latest committed host operations. */
function useNavigationCallbacks(
  props: Pick<SessionPageProps, 'actions' | 'onOpen' | 'onExpand'>,
  focusComposer: () => void,
) {
  const committed = useRef({ props, focusComposer });
  useLayoutEffect(() => {
    committed.current = { props, focusComposer };
  });
  const callbacks = useMemo(
    () => ({
      open: (id: string) => committed.current.props.onOpen?.(id),
      expand: (id: string) => committed.current.props.onExpand?.(id),
      newSession: () => {
        const actions = committed.current.props.actions;
        (actions.resumeNewConversation ?? actions.newSession)?.();
        committed.current.focusComposer();
      },
      newWorkspaceSession: (id: string) => {
        committed.current.props.actions.newWorkspaceSession?.(id);
        committed.current.focusComposer();
      },
      addWorkspace: () => committed.current.props.actions.addWorkspace?.(),
      removeWorkspace: (id: string) => committed.current.props.actions.removeWorkspace?.(id),
      lookupWorkspaceRemoval: (id: string) =>
        committed.current.props.actions.lookupWorkspaceRemoval?.(id),
      manageSession: (...args: Parameters<NonNullable<PageActions['manageSession']>>) =>
        committed.current.props.actions.manageSession?.(...args),
      lookupSessionMutation: (id: string) =>
        committed.current.props.actions.lookupSessionMutation?.(id),
      workbench: () => committed.current.props.actions.workbench?.(),
      scheduledTasks: () => committed.current.props.actions.scheduledTasks?.(),
      settings: () => committed.current.props.actions.settings?.(),
      theme: (value: 'light' | 'dark' | 'system') =>
        committed.current.props.actions.theme?.onChange(value),
      connection: () => committed.current.props.actions.connection?.run(),
      openFile: (path: string) => committed.current.props.actions.openFile?.(path),
    }),
    [],
  );
  const newSession = !!props.actions.newSession;
  const resumeNewConversation = !!props.actions.resumeNewConversation;
  const newWorkspaceSession = !!props.actions.newWorkspaceSession;
  const addWorkspace = !!props.actions.addWorkspace;
  const removeWorkspace = !!props.actions.removeWorkspace;
  const workspaceRemovalResults = props.actions.workspaceRemovalResults;
  const lookupWorkspaceRemoval = !!props.actions.lookupWorkspaceRemoval;
  const manageSession = !!props.actions.manageSession;
  const lookupSessionMutation = !!props.actions.lookupSessionMutation;
  const { sessionMutationBusy, sessionLookupBusy, sessionMutationResults } = props.actions;
  const workbench = !!props.actions.workbench;
  const scheduledTasks = !!props.actions.scheduledTasks;
  const settings = !!props.actions.settings;
  const openFile = !!props.actions.openFile;
  const theme = props.actions.theme?.value;
  const connection = props.actions.connection?.label;
  const actions = useMemo<PageActions>(
    () => ({
      newSession: newSession ? callbacks.newSession : undefined,
      resumeNewConversation: resumeNewConversation ? callbacks.newSession : undefined,
      newWorkspaceSession: newWorkspaceSession ? callbacks.newWorkspaceSession : undefined,
      addWorkspace: addWorkspace ? callbacks.addWorkspace : undefined,
      removeWorkspace: removeWorkspace ? callbacks.removeWorkspace : undefined,
      workspaceRemovalResults,
      lookupWorkspaceRemoval: lookupWorkspaceRemoval ? callbacks.lookupWorkspaceRemoval : undefined,
      manageSession: manageSession ? callbacks.manageSession : undefined,
      lookupSessionMutation: lookupSessionMutation ? callbacks.lookupSessionMutation : undefined,
      sessionMutationBusy,
      sessionLookupBusy,
      sessionMutationResults,
      workbench: workbench ? callbacks.workbench : undefined,
      scheduledTasks: scheduledTasks ? callbacks.scheduledTasks : undefined,
      settings: settings ? callbacks.settings : undefined,
      openFile: openFile ? callbacks.openFile : undefined,
      theme: theme === undefined ? undefined : { value: theme, onChange: callbacks.theme },
      connection:
        connection === undefined ? undefined : { label: connection, run: callbacks.connection },
    }),
    [
      newSession,
      resumeNewConversation,
      newWorkspaceSession,
      addWorkspace,
      removeWorkspace,
      workspaceRemovalResults,
      lookupWorkspaceRemoval,
      manageSession,
      lookupSessionMutation,
      sessionMutationBusy,
      sessionLookupBusy,
      sessionMutationResults,
      workbench,
      scheduledTasks,
      settings,
      openFile,
      theme,
      connection,
      callbacks,
    ],
  );
  return {
    actions,
    onOpen: props.onOpen ? callbacks.open : undefined,
    onExpand: props.onExpand ? callbacks.expand : undefined,
  };
}

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

/** This sibling prepares footer geometry before cached message effects restore scrolling. */
function PrepareConversationLayout({ prepare }: { prepare: () => void }) {
  useLayoutEffect(prepare, [prepare]);
  return null;
}

export interface SessionPageProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  /** Confirmed navigation row while its conversation frame is still preparing. */
  sidebarSelected?: string;
  sessionLabel: string;
  readingKey: string;
  /** Stable conversation identity for tab display; fresh reads keep their own readingKey. */
  tabsScopeKey?: string;
  /** Optional bounded retention; hosts still own fresh read and operation admission. */
  conversationCache?: ConversationCacheScope;
  messages: readonly Message[];
  renderMessage?: (message: Message) => ReactNode;
  renderMessageContent?: (message: Message) => ReactNode;
  renderMessageAttachments?: (message: Message) => ReactNode;
  renderToolActivity?: (messages: readonly Message[], state: ToolActivityState) => ReactNode;
  traceTurns?: boolean;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
  /** Host-confirmed current Turn; omitted when the message source has no Turn identity. */
  turnActivity?: TurnActivity;
  loading: boolean;
  /** Cold history waits for its initial grouping without pausing an existing reading. */
  initialPresentationPending?: boolean;
  /** Reveal the first message tree and footer together after host data and layout preparation. */
  synchronizePresentation?: boolean;
  /** A same-scope readonly footer can accompany an existing retained message tree immediately. */
  retainedPresentation?: boolean;
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

  beforeConversation?: ReactNode;
  environmentInformation?: ReactNode;
  detailPanel?: { label: string; content: ReactNode; onClose: () => void };
  /** A host-owned workspace tab uses the existing tab strip and bounded tab model. */
  workspaceTab?: {
    label: string;
    requestId: number;
    render: (visible: boolean) => ReactNode;
    onClose: () => void;
  };
  /** Reveal the ordinary browser, using a verified retained page when present. */
  browserTabRequest?: { requestId: number; createIfMissing: boolean };
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
  closeBrowser?: ((id: string) => void) | ((id: string) => Promise<void>);
  restoreBrowser?: () => Promise<SessionBrowserRestorePage | null>;
  browserRestoreKey?: string;
  browserPending?: boolean;
  childTabRequest?: SessionChildTabRequest;
  trajectoryTabRequest?: { requestId: number };
  renderTrajectory?: (props: SessionTrajectoryPageProps) => ReactNode;
  renderChildSession?: (props: SessionChildPageProps) => ReactNode;
  onChildSessionChange?: (target: SessionChildTarget | undefined) => void;
  newConversation?: NewConversationProps;
  workbench?: boolean;
  scheduledTasks?: ScheduledTasksProps;
  writeClipboardText?: (text: string) => Promise<void>;
  childSessionIdsByTaskId?: ReadonlyMap<string, string>;
  onOpenChildSession?: (childSessionId: string) => void;
}

/** Keep tab-scope reconciliation outside the retained page's expensive render. */
export function SessionPage(props: SessionPageProps) {
  const hasTabs =
    !props.workbench &&
    !props.scheduledTasks &&
    (props.workspaceTab !== undefined ||
      props.renderBrowser !== undefined ||
      props.fileChanges !== undefined ||
      props.fileChangesContent !== undefined ||
      props.renderChildSession !== undefined ||
      props.renderTrajectory !== undefined);
  const tabModel = useSessionTabs(
    hasTabs ? (props.tabsScopeKey ?? props.readingKey) : 'inactive',
    props.closeBrowser,
    hasTabs ? props.restoreBrowser : undefined,
    props.browserRestoreKey,
    props.browserPending,
  );
  return (
    <NativeScrollbars enabled={!props.workbench && !props.scheduledTasks}>
      <SessionPageContent {...props} hasTabs={hasTabs} tabModel={tabModel} />
    </NativeScrollbars>
  );
}

/** The single production conversation page for both hosts. No host/protocol imports. */
function SessionPageContent({
  messages,
  fileChanges,
  hasTabs,
  tabModel,
  ...props
}: SessionPageProps & { hasTabs: boolean; tabModel: SessionTabsModel }) {
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
  const [navigationAnimating, setNavigationAnimating] = useState(false);
  const [detailsAnimation, setDetailsAnimation] = useState<{ scope?: string }>();
  const navigationWidth = useRef(savedNavigationWidth());
  const navigationPanel = useRef<PanelImperativeHandle>(null);
  const detailsPanel = useRef<PanelImperativeHandle>(null);
  const panelGroupElement = useRef<HTMLDivElement>(null);
  const contentGroupElement = useRef<HTMLDivElement>(null);
  const navigationPanelFrame = useRef<number | undefined>(undefined);
  const navigationAnimationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detailsAnimationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detailsPanelFrame = useRef<number | undefined>(undefined);
  const [pendingTabsClose, setPendingTabsClose] = useState<{ scope?: string; id: string }>();
  const directDetails = useRef(false);
  const retainedRightSidebarPanel = useRef<ReactNode>(null);
  const tabsScopeKey = props.tabsScopeKey ?? props.readingKey;
  const committedDetailsIntent = useRef({ scope: tabsScopeKey, open: false });
  const tabsIntent = useRef<{ scope?: string; key?: string }>({});
  const detailsScope = useRef({ scope: tabsScopeKey, settling: false });
  if (tabsIntent.current.scope !== tabsScopeKey) {
    tabsIntent.current = { scope: tabsScopeKey };
  }
  const [, tabsChanged] = useState(0);
  const setTabsKey = useCallback((key: string | undefined) => {
    if (tabsIntent.current.key === key) return;
    tabsIntent.current.key = key;
    tabsChanged((value) => value + 1);
  }, []);
  const tabsKey = tabsIntent.current.key;
  const [detailsCollapsed, setDetailsCollapsed] = useState<boolean>();
  const presentedTabsKey = useRef<string | undefined>(undefined);
  const childTabOpener = useRef(tabModel.openChild);
  childTabOpener.current = tabModel.openChild;
  const [tabLimitKey, setTabLimitKey] = useState<string>();
  const tabsOpen = tabsKey === tabsScopeKey && hasTabs;
  const scheduledEditorGeneration = useRef(0);
  const detailsOpeningWidth = useRef<number | undefined>(undefined);
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
  }, [hostDetailsOpen, setTabsKey]);
  const detailClose = useRef(props.detailPanel?.onClose);
  detailClose.current = props.detailPanel?.onClose;
  const workspaceDetails = !!props.workspaceTab || !!props.fileChangesContent;
  // Native child views use the same actual Panel constraints during window resize.
  const navigationSizing = {
    minSize: sidebarOpen ? `${NAVIGATION_MIN_WIDTH}px` : '0px',
    maxSize: sidebarOpen ? `${NAVIGATION_MAX_WIDTH}px` : '0px',
    groupResizeBehavior: 'preserve-pixel-size' as const,
    collapsible: false,
  };
  const workspaceSizing = {
    minSize: '200px',
    maxSize: '100%',
    groupResizeBehavior: 'preserve-relative-size' as const,
    collapsible: false,
  };
  const contentSizing = {
    minSize: '360px',
    maxSize: '100%',
    groupResizeBehavior: 'preserve-relative-size' as const,
    collapsible: false,
  };
  const detailsSizing = {
    minSize: workspaceDetails ? '240px' : '300px',
    maxSize:
      workspaceDetails ||
      tabModel.tabs.some((tab) => tab.id === tabModel.active && tab.kind === 'trajectory')
        ? '85%'
        : '640px',
    groupResizeBehavior: props.scheduledTasks
      ? ('preserve-pixel-size' as const)
      : ('preserve-relative-size' as const),
    collapsible: true,
  };
  const rightSidebarOpen =
    hostDetailsOpen || tabsOpen || (!!scheduledEditor && !!props.scheduledTasks);
  const rightSidebarFormOpen = !!scheduledEditor && !!props.scheduledTasks && !hostDetailsOpen;
  const startDetailsAnimation = useCallback((scope: string | undefined) => {
    setDetailsAnimation({ scope });
    if (detailsAnimationTimer.current !== undefined) clearTimeout(detailsAnimationTimer.current);
    detailsAnimationTimer.current = setTimeout(() => {
      detailsAnimationTimer.current = undefined;
      setDetailsAnimation(undefined);
    }, 240);
  }, []);
  // Re-registering the enabled separator can expand the Group before our RAF.
  // Put the transition on that first commit, then retain it for the full motion.
  const openingDetails =
    rightSidebarOpen &&
    !committedDetailsIntent.current.open &&
    committedDetailsIntent.current.scope === tabsScopeKey &&
    detailsScope.current.scope === tabsScopeKey &&
    !detailsScope.current.settling &&
    !directDetails.current &&
    detailsPanel.current?.isCollapsed() === true &&
    !!contentGroupElement.current &&
    contentGroupElement.current.offsetWidth > 0 &&
    contentGroupElement.current.getBoundingClientRect().width > 0;
  const detailsAnimating =
    openingDetails || (!!detailsAnimation && detailsAnimation.scope === tabsScopeKey);
  useLayoutEffect(() => {
    committedDetailsIntent.current = { scope: tabsScopeKey, open: rightSidebarOpen };
    if (openingDetails) startDetailsAnimation(tabsScopeKey);
  }, [tabsScopeKey, rightSidebarOpen, openingDetails, startDetailsAnimation]);
  const detailsPending = !!(props.loading || props.browserPending || tabModel.restoring);
  const closingTabsVisible =
    !!pendingTabsClose &&
    pendingTabsClose.scope === tabsScopeKey &&
    pendingTabsClose.id === tabModel.active &&
    presentedTabsKey.current === tabsScopeKey &&
    hasTabs &&
    !rightSidebarOpen &&
    !props.covered;
  const tabsVisible = (tabsOpen || closingTabsVisible) && detailsCollapsed !== true;
  const tabsPresent =
    tabsVisible ||
    (!rightSidebarOpen && detailsAnimating && presentedTabsKey.current === tabsScopeKey);
  useLayoutEffect(() => {
    if (tabsVisible) presentedTabsKey.current = tabsScopeKey;
    else if (!detailsAnimating || hostDetailsOpen || props.covered)
      presentedTabsKey.current = undefined;
  }, [tabsVisible, detailsAnimating, hostDetailsOpen, props.covered, tabsScopeKey]);
  const tabsToggle = useRef<HTMLButtonElement>(null);
  const scheduledEditorToggle = useRef<HTMLButtonElement | null>(null);
  const focusControlAfterCommit = useCallback((control: { current: HTMLButtonElement | null }) => {
    queueMicrotask(() => control.current?.focus());
  }, []);
  const finishTabsClose = useCallback(() => setPendingTabsClose(undefined), []);
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
      const scope = tabsIntent.current.scope;
      const scheduled = requestAnimationFrame(() => {
        if (frame.current !== scheduled) return;
        frame.current = undefined;
        if (panel === detailsPanel && tabsIntent.current.scope !== scope) return;
        // The header affordance and the panel layout must start in one commit.
        commit?.();
        const group = groupElement.current;
        if (!group || group.offsetWidth <= 0 || group.getBoundingClientRect().width <= 0) return;
        const target = panel.current;
        if (!target) return;
        const openingWidth =
          open && panel === detailsPanel ? detailsOpeningWidth.current : undefined;
        if (
          panel !== navigationPanel &&
          target.isCollapsed() !== open &&
          openingWidth === undefined
        )
          return;
        // Navigation uses explicit size constraints; only its button changes them.
        if (panel === navigationPanel) {
          setNavigationAnimating(true);
          if (navigationAnimationTimer.current !== undefined)
            clearTimeout(navigationAnimationTimer.current);
          navigationAnimationTimer.current = setTimeout(() => {
            navigationAnimationTimer.current = undefined;
            setNavigationAnimating(false);
          }, 240);
          return;
        }
        startDetailsAnimation(scope);
        // Keep the form's requested default while it is a narrow overlay, then
        // acquire the same docked width once the main pane can also fit.
        if (openingWidth !== undefined && group.getBoundingClientRect().width >= 800) {
          detailsOpeningWidth.current = undefined;
          target.resize(`${openingWidth}px`);
        } else if (open) target.expand();
        else target.collapse();
      });
      frame.current = scheduled;
    },
    [startDetailsAnimation],
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
    if (navigationAnimationTimer.current !== undefined)
      clearTimeout(navigationAnimationTimer.current);
    navigationAnimationTimer.current = undefined;
    if (detailsAnimationTimer.current !== undefined) clearTimeout(detailsAnimationTimer.current);
    detailsAnimationTimer.current = undefined;
    setNavigationAnimating(false);
    setDetailsAnimation(undefined);
  }, []);
  const expandDetails = useCallback(
    () => schedulePanelChange(detailsPanelFrame, detailsPanel, true),
    [schedulePanelChange],
  );
  const collapseDetails = useCallback(() => {
    detailsOpeningWidth.current = undefined;
    schedulePanelChange(detailsPanelFrame, detailsPanel, false, finishTabsClose);
  }, [schedulePanelChange, finishTabsClose]);
  useLayoutEffect(() => {
    if (!scheduledEditor || !props.scheduledTasks) return;
    const group = contentGroupElement.current;
    if (!group || typeof ResizeObserver === 'undefined') return;
    // The narrow scheduled rail overlays the list without remounting its draft.
    // If it could not acquire a docked allocation, expand when room returns.
    const observer = new ResizeObserver(() => {
      if (
        group.getBoundingClientRect().width >= 800 &&
        (detailsOpeningWidth.current !== undefined || detailsPanel.current?.isCollapsed())
      )
        expandDetails();
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, [scheduledEditor, props.scheduledTasks, expandDetails]);
  const dismissedBrowserReveals = useRef(new Set<string>());
  const stopDetailsAnimation = useCallback(() => {
    if (detailsPanelFrame.current !== undefined) cancelAnimationFrame(detailsPanelFrame.current);
    detailsPanelFrame.current = undefined;
    if (detailsAnimationTimer.current !== undefined) clearTimeout(detailsAnimationTimer.current);
    detailsAnimationTimer.current = undefined;
    setDetailsAnimation(undefined);
    setPendingTabsClose(undefined);
  }, []);
  const settleDetails = useCallback(
    (open: boolean) => {
      directDetails.current = true;
      stopDetailsAnimation();
      if (open) detailsPanel.current?.expand();
      else detailsPanel.current?.collapse();
    },
    [stopDetailsAnimation],
  );
  const changeTabsOpen = useCallback(
    (open: boolean, animate = true) => {
      // Closing a host panel can replace its pending layout frame, not this intent.
      if (open) dismissedBrowserReveals.current.delete(tabsScopeKey);
      else dismissedBrowserReveals.current.add(tabsScopeKey);
      const group = contentGroupElement.current;
      const keepPage =
        !open &&
        animate &&
        tabsIntent.current.key === tabsScopeKey &&
        presentedTabsKey.current === tabsScopeKey &&
        !props.covered &&
        !hostDetailsOpen &&
        !scheduledEditor &&
        tabModel.tabs.some((tab) => tab.kind === 'browser' && tab.id === tabModel.active) &&
        detailsPanel.current &&
        !detailsPanel.current.isCollapsed() &&
        group &&
        group.offsetWidth > 0 &&
        group.getBoundingClientRect().width > 0;
      // The library re-registers panels when this intent changes. Keep the
      // original page until the queued layout can actually start collapsing.
      setPendingTabsClose(keepPage ? { scope: tabsScopeKey, id: tabModel.active } : undefined);
      setTabsKey(open ? tabsScopeKey : undefined);
      if (animate)
        schedulePanelChange(
          detailsPanelFrame,
          detailsPanel,
          open,
          open ? undefined : finishTabsClose,
        );
      else settleDetails(open);
    },
    [
      schedulePanelChange,
      tabsScopeKey,
      setTabsKey,
      settleDetails,
      finishTabsClose,
      props.covered,
      hostDetailsOpen,
      scheduledEditor,
      tabModel.tabs,
      tabModel.active,
    ],
  );
  useLayoutEffect(() => {
    if (!pendingTabsClose || (closingTabsVisible && detailsCollapsed !== true)) return;
    // Coverage withdraws the page immediately but still lets its current close
    // finish. A replacement must also retire the old panel action.
    if (
      pendingTabsClose.scope !== tabsScopeKey ||
      pendingTabsClose.id !== tabModel.active ||
      !hasTabs ||
      rightSidebarOpen
    ) {
      if (detailsPanelFrame.current !== undefined) cancelAnimationFrame(detailsPanelFrame.current);
      detailsPanelFrame.current = undefined;
    }
    finishTabsClose();
  }, [
    pendingTabsClose,
    closingTabsVisible,
    detailsCollapsed,
    finishTabsClose,
    tabsScopeKey,
    tabModel.active,
    hasTabs,
    rightSidebarOpen,
  ]);
  const handledBrowserReveals = useRef({ scope: tabsScopeKey, ids: new Set<string>() });
  if (handledBrowserReveals.current.scope !== tabsScopeKey)
    handledBrowserReveals.current = { scope: tabsScopeKey, ids: new Set<string>() };
  useLayoutEffect(() => {
    const id = tabModel.revealBrowserId;
    if (
      !id ||
      !hasTabs ||
      props.loading ||
      props.covered ||
      hostDetailsOpen ||
      dismissedBrowserReveals.current.has(tabsScopeKey) ||
      tabModel.restoring ||
      tabModel.restoreIssue ||
      !tabModel.tabs.some((tab) => tab.kind === 'browser' && tab.id === id)
    )
      return;
    if (handledBrowserReveals.current.ids.has(id)) return;
    handledBrowserReveals.current.ids.add(id);
    tabModel.select(id);
    changeTabsOpen(true, false);
  }, [
    tabModel.revealBrowserId,
    tabModel.restoring,
    tabModel.restoreIssue,
    tabModel.select,
    tabModel.tabs,
    hasTabs,
    tabsScopeKey,
    props.loading,
    props.covered,
    hostDetailsOpen,
    changeTabsOpen,
  ]);
  useEffect(() => {
    if (tabModel.closeReveal) changeTabsOpen(true, false);
  }, [tabModel.closeReveal, changeTabsOpen]);
  const workspaceOperations = useRef(tabModel);
  workspaceOperations.current = tabModel;
  const workspaceRequest = useRef<string | undefined>(undefined);
  const workspaceContent = useRef(props.workspaceTab);
  workspaceContent.current = props.workspaceTab;
  const workspaceRequestId = props.workspaceTab?.requestId;
  const browserRequest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const request = props.browserTabRequest;
    if (
      !request ||
      !hasTabs ||
      !tabsScopeKey ||
      props.loading ||
      tabModel.restoring ||
      tabModel.restoreIssue
    )
      return;
    const key = JSON.stringify([tabsScopeKey, request.requestId]);
    if (browserRequest.current === key) return;
    const page =
      tabModel.tabs.find(
        (tab) => tab.kind === 'browser' && tab.id === tabModel.restoredBrowserId,
      ) ?? tabModel.tabs.find((tab) => tab.kind === 'browser');
    if (!page && !request.createIfMissing) return;
    browserRequest.current = key;
    if (page) tabModel.select(page.id);
    else tabModel.addBrowser();
    detailClose.current?.();
    changeTabsOpen(true);
  }, [
    props.browserTabRequest,
    hasTabs,
    tabsScopeKey,
    props.loading,
    tabModel.restoring,
    tabModel.restoreIssue,
    tabModel.tabs,
    tabModel.restoredBrowserId,
    changeTabsOpen,
    tabModel.select,
    tabModel.addBrowser,
  ]);
  useEffect(() => {
    const request = workspaceContent.current;
    if (!request) {
      workspaceRequest.current = undefined;
      if (workspaceOperations.current.tabs.some((tab) => tab.kind === 'workspace'))
        workspaceOperations.current.closeTab('workspace');
      return;
    }
    if (!hasTabs || !tabsScopeKey || props.loading || tabModel.restoring || tabModel.restoreIssue)
      return;
    const key = JSON.stringify([tabsScopeKey, workspaceRequestId]);
    if (workspaceRequest.current === key) return;
    workspaceRequest.current = key;
    const opened = workspaceOperations.current.openWorkspace(request.label);
    setTabLimitKey(opened ? undefined : tabsScopeKey);
    if (!opened) {
      request.onClose();
      return;
    }
    detailClose.current?.();
    changeTabsOpen(true);
    const frame = requestAnimationFrame(() => detailsPanel.current?.resize('62%'));
    return () => cancelAnimationFrame(frame);
  }, [
    workspaceRequestId,
    hasTabs,
    tabsScopeKey,
    props.loading,
    changeTabsOpen,
    tabModel.restoring,
    tabModel.restoreIssue,
  ]);
  const changesLayout = useRef({ scope: tabsScopeKey, prepared: false });
  if (changesLayout.current.scope !== tabsScopeKey)
    changesLayout.current = { scope: tabsScopeKey, prepared: false };
  const activeChanges = tabModel.tabs.some(
    (tab) => tab.id === tabModel.active && tab.kind === 'changes',
  );
  const hasChangesWorkspace = !!props.fileChangesContent;
  useEffect(() => {
    if (
      !hasChangesWorkspace ||
      !activeChanges ||
      !tabsOpen ||
      detailsCollapsed === true ||
      !tabsScopeKey ||
      props.loading ||
      props.covered ||
      hostDetailsOpen ||
      tabModel.restoring ||
      tabModel.restoreIssue ||
      changesLayout.current.prepared
    )
      return;
    const frame = requestAnimationFrame(() => {
      const panel = detailsPanel.current;
      if (
        !panel ||
        panel.isCollapsed() ||
        changesLayout.current.scope !== tabsScopeKey ||
        changesLayout.current.prepared
      )
        return;
      // Prepare the first review only. Later selection and refresh retain user sizing.
      panel.resize('62%');
      changesLayout.current = { scope: tabsScopeKey, prepared: true };
    });
    return () => cancelAnimationFrame(frame);
  }, [
    hasChangesWorkspace,
    activeChanges,
    tabsOpen,
    detailsCollapsed,
    tabsScopeKey,
    props.loading,
    props.covered,
    hostDetailsOpen,
    tabModel.restoring,
    tabModel.restoreIssue,
  ]);
  const trajectoryOpener = useRef(tabModel.openTrajectory);
  trajectoryOpener.current = tabModel.openTrajectory;
  const handledTrajectoryRequest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const request = props.trajectoryTabRequest;
    if (
      !hasTabs ||
      !request ||
      !props.renderTrajectory ||
      props.loading ||
      tabModel.restoring ||
      tabModel.restoreIssue
    )
      return;
    const key = JSON.stringify([tabsScopeKey, request.requestId]);
    if (handledTrajectoryRequest.current === key) return;
    handledTrajectoryRequest.current = key;
    const opened = trajectoryOpener.current();
    setTabLimitKey(opened ? undefined : tabsScopeKey);
    detailClose.current?.();
    changeTabsOpen(true);
  }, [
    props.trajectoryTabRequest,
    props.renderTrajectory,
    props.loading,
    hasTabs,
    tabsScopeKey,
    tabModel.restoring,
    tabModel.restoreIssue,
    changeTabsOpen,
  ]);
  const handledChildRequest = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const request = props.childTabRequest;
    if (
      !hasTabs ||
      !request ||
      !tabsScopeKey ||
      props.loading ||
      tabModel.restoring ||
      tabModel.restoreIssue
    )
      return;
    // A retained request is one navigation intent. Temporary selection scopes
    // and returning to its parent must not reopen it or close the current panel.
    const key = request.requestId;
    if (handledChildRequest.current !== undefined && key <= handledChildRequest.current) return;
    const opened = childTabOpener.current(
      { sessionId: request.sessionId, executionId: request.executionId },
      request.title,
      request.childAgentIdentity,
    );
    handledChildRequest.current = key;
    setTabLimitKey(opened ? undefined : tabsScopeKey);
    detailClose.current?.();
    changeTabsOpen(true);
  }, [
    props.childTabRequest,
    hasTabs,
    tabsScopeKey,
    props.loading,
    changeTabsOpen,
    tabModel.restoring,
    tabModel.restoreIssue,
  ]);
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
      if (navigationAnimationTimer.current !== undefined)
        clearTimeout(navigationAnimationTimer.current);
      if (detailsAnimationTimer.current !== undefined) clearTimeout(detailsAnimationTimer.current);
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
    if (environmentAnimationKey !== undefined) setEnvironmentAnimationKey(undefined);
  }, [props.readingKey, environmentAnimationKey]);
  useLayoutEffect(() => {
    if (detailsScope.current.scope !== tabsScopeKey) {
      detailsScope.current = { scope: tabsScopeKey, settling: true };
      stopDetailsAnimation();
    }
    if (!detailsScope.current.settling) return;
    // The old owner's queued panel action must never run on the new owner.
    // Pending selection/restore is not an empty target or a user-close intent.
    const open = rightSidebarOpen || (tabsIntent.current.key === tabsScopeKey && hasTabs);
    if (!open && detailsPending) return;
    settleDetails(open);
    detailsScope.current.settling = false;
  }, [
    tabsScopeKey,
    rightSidebarOpen,
    hasTabs,
    detailsPending,
    stopDetailsAnimation,
    settleDetails,
  ]);
  useEffect(() => {
    if (!props.scheduledTasks) {
      scheduledEditorGeneration.current++;
      setScheduledEditor(undefined);
    }
  }, [props.scheduledTasks]);
  useEffect(() => {
    if (
      detailsScope.current.scope !== tabsScopeKey ||
      (detailsScope.current.settling && detailsPending)
    )
      return;
    const direct = directDetails.current;
    directDetails.current = false;
    if (!rightSidebarOpen) {
      if (!direct) collapseDetails();
      return;
    }
    if (!direct) expandDetails();
    const group = contentGroupElement.current;
    if (!group || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(expandDetails);
    observer.observe(group);
    return () => observer.disconnect();
  }, [tabsScopeKey, rightSidebarOpen, detailsPending, expandDetails, collapseDetails]);
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
    const measure = () => {
      syncConversationScrollbarGutter(element);
      update(element.getBoundingClientRect().width);
    };
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
            if (entry?.contentRect.width) {
              if (!element.style.getPropertyValue('--conversation-scrollbar-width'))
                syncConversationScrollbarGutter(element);
              update(entry.contentRect.width);
            } else measureAfterLayout();
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
        event.defaultPrevented ||
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
  const navigation = useNavigationCallbacks(props, focusComposerAfterCommit);
  const sidebarPanel = (
    <div className="client-sidebar-panel">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
      <header className="sidebar-header" onMouseDown={handleHeaderMouseDown}>
        <strong className="brand">Kite</strong>
      </header>
      <aside className="sidebar" aria-label="空间与会话">
        <MemoizedSidebar
          workspaces={props.workspaces}
          selectedWorkspace={
            !props.workbench && !props.scheduledTasks && !props.sidebarSelected
              ? props.workspaces.find(
                  (workspace) => workspace.id === props.newConversation?.workspace,
                )?.id
              : undefined
          }
          selected={
            props.workbench || props.scheduledTasks
              ? undefined
              : (props.sidebarSelected ?? (props.newConversation ? undefined : props.selected))
          }
          busy={props.busy}
          mutationBusy={props.mutationBusy}
          actions={navigation.actions}
          connectionLabel={props.connectionLabel}
          activePage={
            props.scheduledTasks
              ? 'scheduledTasks'
              : props.workbench
                ? 'workbench'
                : props.newConversation && !props.sidebarSelected
                  ? 'newConversation'
                  : 'conversation'
          }
          onExpand={navigation.onExpand}
          defaultExpanded={props.defaultExpanded}
          onOpen={navigation.onOpen}
        />
      </aside>
    </div>
  );
  const closeRightSidebar = (reason?: 'last-tab') => {
    if (props.detailPanel) {
      collapseDetails();
      props.detailPanel.onClose();
    } else if (tabsOpen) {
      changeTabsOpen(false, reason !== 'last-tab');
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
      label={scheduledEditor.task ? '编辑定时任务' : '新建定时任务'}
      title={scheduledEditor.task ? '编辑定时任务' : '新建定时任务'}
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
  const visiblePresentationIdentity = historyVisible
    ? JSON.stringify([props.conversationCache?.scope, props.readingKey])
    : undefined;
  const bypassedPresentation = useRef<string | undefined>(undefined);
  if (!props.synchronizePresentation) bypassedPresentation.current = visiblePresentationIdentity;
  else if (bypassedPresentation.current !== visiblePresentationIdentity)
    bypassedPresentation.current = undefined;
  const presentationIdentity = props.synchronizePresentation
    ? visiblePresentationIdentity
    : undefined;
  const [presentation, setPresentation] = useState({
    identity: presentationIdentity,
    ready: !props.synchronizePresentation || welcoming,
  });
  if (presentation.identity !== presentationIdentity)
    setPresentation({
      identity: presentationIdentity,
      // The first input was already visible before saved history enabled the gate.
      ready:
        !props.synchronizePresentation ||
        welcoming ||
        bypassedPresentation.current === presentationIdentity,
    });
  const presentationGuard = useRef({ identity: presentationIdentity, ready: false });
  presentationGuard.current = {
    identity: presentationIdentity,
    ready: !!props.retainedPresentation || (!props.loading && !props.initialPresentationPending),
  };
  const finishPresentation = useCallback((identity: string | undefined) => {
    if (presentationGuard.current.identity !== identity || !presentationGuard.current.ready) return;
    setPresentation((previous) =>
      previous.identity === identity && !previous.ready ? { ...previous, ready: true } : previous,
    );
  }, []);
  const presentationPending = !!(
    props.synchronizePresentation &&
    historyVisible &&
    !welcoming &&
    !props.historyError &&
    (presentation.identity !== presentationIdentity || !presentation.ready)
  );
  // Descendant transitions can keep inherited visibility painted after hiding.
  // Composite the whole prepared subtree away without changing its measured layout.
  const presentationStyle: CSSProperties | undefined = presentationPending
    ? { visibility: 'hidden', opacity: 0 }
    : undefined;
  const hasComposer = !!props.composer;
  const headerOverlay =
    historyVisible && !welcoming && !props.historyError && !props.beforeConversation;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope and composer mounting change geometry before message layout effects resume.
  const prepareConversationLayout = useCallback(() => {
    const header = headerElement.current;
    const panel = header?.parentElement;
    const footer = historyVisible ? footerElement.current : null;
    if (!header || !panel) return;
    const height = header.getBoundingClientRect().height;
    if (height > 0) panel.style.setProperty('--session-header-height', `${height}px`);
    panel.style.setProperty(
      '--conversation-footer-height',
      `${footer?.getBoundingClientRect().height ?? 0}px`,
    );
  }, [historyVisible, props.readingKey, hasComposer]);
  useLayoutEffect(() => {
    const header = headerElement.current;
    if (!header) return;
    const footer = historyVisible ? footerElement.current : null;
    prepareConversationLayout();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(prepareConversationLayout);
    observer.observe(header, { box: 'border-box' });
    if (footer) observer.observe(footer, { box: 'border-box' });
    return () => observer.disconnect();
  }, [historyVisible, prepareConversationLayout]);
  const keepAlive = !!props.conversationCache && typeof document !== 'undefined';
  const conversation = (
    <Conversation
      key={props.readingKey}
      messages={messages}
      renderMessage={props.renderMessage}
      renderMessageContent={props.renderMessageContent}
      renderMessageAttachments={props.renderMessageAttachments}
      renderToolActivity={props.renderToolActivity}
      traceTurns={props.traceTurns}
      renderReasoning={props.renderReasoning}
      turnActivity={props.turnActivity}
      lazyHistory={keepAlive}
      messageNavigation
      loading={props.loading}
      initialPresentationPending={props.initialPresentationPending}
      onPresentationReady={() => finishPresentation(presentationIdentity)}
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
    <div
      className={`kite-client shell ${sidebarOpen ? 'sidebar-visible' : ''}`}
      data-native-scrollbars={!props.workbench && !props.scheduledTasks ? 'true' : undefined}
      style={
        { '--right-sidebar-form-width': `${RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH}px` } as CSSProperties
      }
    >
      <ResizablePanelGroup
        id="client-layout"
        orientation="horizontal"
        elementRef={panelGroupElement}
        className="client-panels"
        data-animate-width={navigationAnimating ? 'true' : undefined}
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
          {...navigationSizing}
          data-native-browser-layout={JSON.stringify(navigationSizing)}
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
        <ResizablePanel
          id="workspace"
          {...workspaceSizing}
          data-native-browser-layout={JSON.stringify(workspaceSizing)}
          style={{ overflow: 'visible' }}
        >
          <div
            className="client-content-frame"
            data-scheduled-editor={scheduledEditor && props.scheduledTasks ? 'true' : undefined}
          >
            <ResizablePanelGroup
              id="content-layout"
              orientation="horizontal"
              elementRef={contentGroupElement}
              className="client-content-panels"
              data-animate-width={detailsAnimating ? 'true' : undefined}
              onLayoutChange={(layout) => {
                const collapsed = (layout.details ?? 0) === 0;
                if (collapsed === detailsCollapsed) return;
                const group = contentGroupElement.current;
                if (group && group.offsetWidth > 0 && group.getBoundingClientRect().width > 0)
                  setDetailsCollapsed(collapsed);
              }}
              onLayoutChanged={(layout, meta) => {
                if (meta.isUserInteraction && hasChangesWorkspace && activeChanges && tabsOpen)
                  changesLayout.current = { scope: tabsScopeKey, prepared: true };
                if (meta.isUserInteraction && rightSidebarOpen && (layout.details ?? 0) === 0)
                  closeRightSidebar();
              }}
            >
              <ResizablePanel
                id="content"
                {...contentSizing}
                data-native-browser-layout={JSON.stringify(contentSizing)}
                style={{ overflow: 'hidden' }}
              >
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
                          <strong>定时任务</strong>
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
                          if (!tabsOpen) {
                            if (tabModel.tabs.length === 0) tabModel.addBrowser();
                            props.detailPanel?.onClose();
                          }
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
                    {tabModel.closeIssue && (
                      <p role="alert" className="notice error">
                        {tabModel.closeIssue}
                      </p>
                    )}
                    {tabLimitKey === tabsScopeKey && tabModel.tabs.length >= 8 && (
                      <p role="status">标签页已满，请关闭一个标签页后重试。</p>
                    )}
                    <div className="session-body">
                      <div
                        className={`session-view environment-information-${environmentMode}${animateEnvironment ? ' environment-information-animated' : ''}`}
                        ref={setSessionViewElement}
                        data-presentation-pending={presentationPending || undefined}
                        aria-busy={presentationPending || undefined}
                      >
                        {props.environmentInformation}
                        {props.beforeConversation}
                        {props.scheduledTasks ? (
                          <ScheduledTasks
                            {...props.scheduledTasks}
                            onEditTask={(task, trigger) => {
                              scheduledEditorToggle.current = trigger;
                              detailsOpeningWidth.current = RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH;
                              setScheduledEditor({
                                generation: ++scheduledEditorGeneration.current,
                                task,
                              });
                              expandDetails();
                            }}
                            onNewTask={(trigger) => {
                              if (scheduledEditor && !scheduledEditor.task) return;
                              scheduledEditorToggle.current = trigger;
                              detailsOpeningWidth.current = RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH;
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
                        <PrepareConversationLayout prepare={prepareConversationLayout} />
                        <section
                          className="history-panel"
                          style={{
                            display: historyVisible ? undefined : 'none',
                            ...presentationStyle,
                          }}
                          inert={presentationPending || undefined}
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
                          <footer
                            ref={footerElement}
                            className="conversation-footer"
                            style={presentationStyle}
                            inert={presentationPending || undefined}
                          >
                            <div className="bottom-controls">
                              {props.statusNotice}
                              {props.interaction && (
                                <div className="interaction-area">{props.interaction}</div>
                              )}
                              {props.composer ? (
                                <Composer
                                  {...props.composer}
                                  hideContextWhenUnavailable={!!props.newConversation}
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
                        {presentationPending && (
                          <div
                            className="conversation-loading"
                            role="status"
                            aria-label="正在加载聊天"
                          >
                            <HugeiconsIcon
                              aria-hidden="true"
                              data-icon="kite-loading"
                              icon={KiteIcon}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </main>
                </div>
              </ResizablePanel>
              {rightSidebarFormOpen ? (
                <div
                  id="details-resize"
                  className="relative collapsible-sidebar-handle"
                  data-slot="right-sidebar-form-divider"
                  data-open="true"
                  aria-hidden="true"
                />
              ) : (
                <ResizableHandle
                  key={rightSidebarOpen ? 'details-open' : 'details-closed'}
                  id="details-resize"
                  className="collapsible-sidebar-handle"
                  data-open={rightSidebarOpen ? 'true' : 'false'}
                  disabled={!rightSidebarOpen}
                  withHandle
                />
              )}
              <ResizablePanel
                id="details"
                className="collapsible-sidebar-viewport"
                style={{ overflow: 'hidden' }}
                panelRef={detailsPanel}
                disabled={!rightSidebarOpen || rightSidebarFormOpen}
                {...detailsSizing}
                data-native-browser-layout={JSON.stringify(detailsSizing)}
                collapsedSize="0px"
                defaultSize="0px"
              >
                <div
                  className="collapsible-sidebar-content"
                  style={{
                    minWidth:
                      scheduledEditor && props.scheduledTasks
                        ? 'min(300px, 100cqi)'
                        : workspaceDetails
                          ? '240px'
                          : '300px',
                  }}
                  aria-hidden={!rightSidebarOpen && !closingTabsVisible}
                  inert={!rightSidebarOpen && !closingTabsVisible}
                >
                  {hasTabs && (
                    <SessionTabs
                      key={tabsScopeKey}
                      model={tabModel}
                      workspace={
                        props.workspaceTab
                          ? {
                              render: props.workspaceTab.render,
                              onClose: props.workspaceTab.onClose,
                            }
                          : undefined
                      }
                      visible={tabsVisible && !props.covered && !props.detailPanel}
                      present={tabsPresent && !props.covered && !props.detailPanel}
                      renderBrowser={props.renderBrowser}
                      renderChildSession={props.renderChildSession}
                      renderTrajectory={props.renderTrajectory}
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
