import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BotIcon,
  Cancel01Icon,
  Globe02Icon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PencilEdit02Icon,
  RefreshIcon,
  SourceCodeIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChildAgentIcon } from './ApprovalHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import type {
  SessionTabsChromeData,
  SessionTabsChromePresentation,
  SessionTabsChromeTab,
} from './types';
import { Button } from './ui';

export interface SessionBrowserPageProps {
  readonly id: string;
  readonly visible: boolean;
  readonly tools: ReactNode;
  readonly onTitleChange: (title: string) => void;
}

export interface SessionBrowserRestorePage {
  readonly id: string;
  readonly title: string;
  readonly pages?: readonly { id: string; title: string }[];
  readonly activeId?: string;
  /** Host-confirmed page that was visible before this Renderer was replaced. */
  readonly reveal?: true;
}

export interface SessionChildTarget {
  readonly sessionId: string;
  readonly executionId?: string;
}

export interface SessionChildTabRequest extends SessionChildTarget {
  /** Increases for each explicit navigation within the mounted page's lifetime. */
  readonly requestId: number;
  readonly title: string;
  readonly childAgentIdentity?: string;
}

export interface SessionChildPageProps extends SessionChildTarget {
  readonly onTitleChange: (title: string) => void;
}

export interface SessionTabsProps {
  readonly model: SessionTabsModel;
  readonly visible: boolean;
  readonly present?: boolean;
  readonly changes: ReactNode;
  readonly renderBrowser?: (props: SessionBrowserPageProps) => ReactNode;
  readonly renderChildSession?: (props: SessionChildPageProps) => ReactNode;
  readonly onChildSessionChange?: (target: SessionChildTarget | undefined) => void;
  readonly workspace?: {
    readonly render: (visible: boolean) => ReactNode;
    readonly onClose: () => void;
  };
  readonly onClose: () => void;
  readonly scopeKey?: string;
  /** Keep the original header's geometry while another host paints its controls. */
  readonly chromeHosted?: boolean;
  readonly onChromePresentation?: (presentation: SessionTabsChromePresentation | null) => void;
}

type SessionTab = SessionTabsChromeTab;
export interface SessionTabsModel {
  readonly restoredBrowserId?: string;
  readonly revealBrowserId?: string;
  readonly restoring?: boolean;
  readonly restoreIssue?: boolean;
  readonly retryRestore?: () => void;
  readonly tabs: readonly SessionTab[];
  readonly active: string;
  readonly select: (id: string) => void;
  readonly title: (id: string, title: string) => void;
  readonly addBrowser: () => void;
  readonly openChanges: () => void;
  readonly openChild: (
    target: SessionChildTarget,
    title: string,
    childAgentIdentity?: string,
  ) => boolean;
  readonly openWorkspace: (title: string) => boolean;
  readonly closeTab: (id: string) => void;
}
const maxTabs = 8;
let nextTab = 0;
function newBrowserTab(): SessionTab {
  return {
    id: `browser-${Date.now().toString(36)}-${++nextTab}`,
    kind: 'browser',
    title: '新标签页',
  };
}

export interface SessionBrowserToolbarProps {
  readonly tools?: ReactNode;
  readonly address: string;
  readonly loading: boolean;
  readonly hasPage: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canNavigate?: boolean;
  readonly onAddressChange: (value: string) => void;
  readonly onAddressFocus: (focused: boolean) => void;
  readonly onNavigate: () => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
}
export function BrowserAnnotationIcon({ returnToPage = false }: { returnToPage?: boolean }) {
  return <HugeiconsIcon icon={returnToPage ? Globe02Icon : PencilEdit02Icon} />;
}
export function BrowserOptionsIcon() {
  return <HugeiconsIcon icon={MoreHorizontalIcon} />;
}
export function SessionBrowserToolbar(props: SessionBrowserToolbarProps) {
  return (
    <form
      className="native-browser-toolbar"
      aria-label="浏览器工具栏"
      onSubmit={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (props.canNavigate !== false) props.onNavigate();
      }}
    >
      <Button
        type="button"
        className="ghost native-browser-nav-history"
        size="icon-sm"
        aria-label="后退"
        title="后退"
        disabled={!props.canGoBack || props.canNavigate === false}
        onClick={props.onBack}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} />
      </Button>
      <Button
        type="button"
        className="ghost native-browser-nav-history"
        size="icon-sm"
        aria-label="前进"
        title="前进"
        disabled={!props.canGoForward || props.canNavigate === false}
        onClick={props.onForward}
      >
        <HugeiconsIcon icon={ArrowRight01Icon} />
      </Button>
      <Button
        type="button"
        className="ghost native-browser-nav-reload"
        size="icon-sm"
        aria-label={props.loading ? '停止加载' : '刷新网页'}
        title={props.loading ? '停止加载' : '刷新网页'}
        disabled={!props.hasPage || props.canNavigate === false}
        onClick={props.onReload}
      >
        <HugeiconsIcon icon={props.loading ? Cancel01Icon : RefreshIcon} />
      </Button>
      <input
        className="native-browser-address"
        aria-label="搜索或输入网址"
        placeholder="搜索或输入网址"
        value={props.address}
        readOnly={props.canNavigate === false}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        maxLength={2048}
        onChange={(event) => props.onAddressChange(event.currentTarget.value)}
        onFocus={(event) => {
          props.onAddressFocus(true);
          event.currentTarget.select();
        }}
        onBlur={() => props.onAddressFocus(false)}
      />
      <div className="native-browser-tools">{props.tools}</div>
    </form>
  );
}

function initialTabs(scope: string, restoring = false) {
  return {
    scope,
    tabs: [] as SessionTab[],
    selected: '',
    restoring,
    restoreIssue: false,
    restoredBrowserId: undefined as string | undefined,
    revealBrowserId: undefined as string | undefined,
  };
}
/** Lives above the responsive panel Group so resizing cannot discard tabs or browsing history. */
export function useSessionTabs(
  scope: string,
  closeBrowser?: (id: string) => void,
  restoreBrowser?: () => Promise<SessionBrowserRestorePage | null>,
  restoreKey?: string,
  browserPending = false,
): SessionTabsModel {
  const [state, setState] = useState(() => initialTabs(scope, !!restoreBrowser));
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const restoreEpoch = useRef(restoreAttempt);
  restoreEpoch.current = restoreAttempt;
  const pending = useRef(browserPending);
  const restoreEnabled = !!restoreBrowser;
  const restoreAdmission = useRef('');
  restoreAdmission.current = JSON.stringify([scope, restoreKey, restoreEnabled]);
  const settledRestore = useRef('');
  if (!restoreEnabled) settledRestore.current = '';
  const restorePending = restoreEnabled && settledRestore.current !== restoreAdmission.current;
  pending.current = browserPending || restorePending;
  let current = state;
  if (current.scope !== scope) {
    current = initialTabs(scope, !!restoreBrowser);
    setState(current);
  }
  const latest = useRef(current);
  latest.current = current;
  const close = useRef(closeBrowser);
  close.current = closeBrowser;
  const restore = useRef(restoreBrowser);
  restore.current = restoreBrowser;
  useEffect(() => {
    let cancelled = false;
    if (!restore.current) return;
    const read = restore.current;
    const readScope = scope;
    const admission = JSON.stringify([scope, restoreKey, restoreEnabled]);
    const attempt = restoreAttempt;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = Promise.race([
      Promise.resolve().then(() => (cancelled ? null : read())),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error('browser_restore_timeout')), 3000);
      }),
    ]);
    void result
      .then((page) => {
        if (
          cancelled ||
          latest.current.scope !== readScope ||
          restoreEpoch.current !== attempt ||
          restoreAdmission.current !== admission
        )
          return;
        const value = latest.current;
        const pages = page?.pages ?? (page ? [page] : []);
        const additions = pages.filter((page) => !value.tabs.some((tab) => tab.id === page.id));
        if (value.tabs.length + additions.length > maxTabs) throw Error('browser_restore_capacity');
        const activeId = page?.activeId ?? page?.id;
        settledRestore.current = admission;
        const next = {
          ...value,
          restoring: false,
          restoreIssue: false,
          restoredBrowserId: page?.id,
          revealBrowserId:
            page?.reveal && pages.some((page) => page.id === activeId) ? activeId : undefined,
          ...(page
            ? {
                tabs: [
                  ...value.tabs.map((tab) => {
                    const restored = pages.find((page) => page.id === tab.id);
                    return restored ? { ...tab, title: restored.title } : tab;
                  }),
                  ...additions.map((page) => ({ ...page, kind: 'browser' as const })),
                ],
                selected: value.tabs.some((tab) => tab.id === value.selected)
                  ? value.selected
                  : (activeId ?? ''),
              }
            : {}),
        };
        latest.current = next;
        setState(next);
      })
      .catch(() => {
        if (
          cancelled ||
          latest.current.scope !== readScope ||
          restoreEpoch.current !== attempt ||
          restoreAdmission.current !== admission
        )
          return;
        settledRestore.current = admission;
        const next = { ...latest.current, restoring: false, restoreIssue: true };
        latest.current = next;
        setState(next);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [scope, restoreAttempt, restoreKey, restoreEnabled]);
  const { tabs, selected } = current;
  const active = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? '');
  // Reserve each UI mutation immediately: two requests in one commit share the same eight slots.
  const update = (
    change: (value: ReturnType<typeof initialTabs>) => ReturnType<typeof initialTabs>,
  ) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
  };
  const title = (id: string, value: string) => {
    const name = value.trim().slice(0, 80) || '新标签页';
    update((value) => {
      if (!value.tabs.some((tab) => tab.id === id && tab.title !== name)) return value;
      return {
        ...value,
        tabs: value.tabs.map((tab) => (tab.id === id ? { ...tab, title: name } : tab)),
      };
    });
  };
  const addBrowser = () => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return;
    const tabs = latest.current.tabs;
    if (tabs.length >= maxTabs) return;
    const tab = newBrowserTab();
    update((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openChanges = () => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return;
    const tabs = latest.current.tabs;
    const existing = tabs.find((tab) => tab.kind === 'changes');
    if (existing) {
      update((value) => ({ ...value, selected: existing.id }));
      return;
    }
    if (tabs.length >= maxTabs) return;
    const tab: SessionTab = { id: 'changes', kind: 'changes', title: '变更' };
    update((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openChild = (target: SessionChildTarget, title: string, childAgentIdentity?: string) => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return false;
    const tabs = latest.current.tabs;
    const id = `child-${JSON.stringify([target.sessionId, target.executionId ?? null])}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (!tabs.some((tab) => tab.id === id) && tabs.length >= maxTabs) return false;
    const tab: SessionTab = {
      ...target,
      id,
      kind: 'child',
      title: title.trim().slice(0, 80) || '子 Agent',
      childAgentIdentity:
        childAgentIdentity ??
        (existing?.kind === 'child' ? existing.childAgentIdentity : undefined),
    };
    update((value) => ({
      ...value,
      tabs: value.tabs.some((entry) => entry.id === id)
        ? value.tabs.map((entry) => (entry.id === id ? tab : entry))
        : [...value.tabs, tab],
      selected: id,
    }));
    return true;
  };
  const openWorkspace = (title: string) => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return false;
    const tabs = latest.current.tabs;
    if (!tabs.some((tab) => tab.kind === 'workspace') && tabs.length >= maxTabs) return false;
    update((value) => ({
      ...value,
      tabs: value.tabs.some((tab) => tab.kind === 'workspace')
        ? value.tabs
        : [...value.tabs, { id: 'workspace', kind: 'workspace', title }],
      selected: 'workspace',
    }));
    return true;
  };
  const closeTab = (id: string) => {
    const { tabs, selected } = latest.current;
    const active = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? '');
    const index = tabs.findIndex((tab) => tab.id === id);
    if (tabs[index]?.kind === 'browser') close.current?.(id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    update((value) => ({
      ...value,
      tabs: remaining,
      selected:
        active === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? '') : active,
    }));
  };
  return {
    restoredBrowserId: current.restoredBrowserId,
    revealBrowserId: current.revealBrowserId,
    restoring: current.restoring || browserPending || restorePending,
    restoreIssue: current.restoreIssue,
    retryRestore: () => {
      if (!restore.current || latest.current.restoring) return;
      const next = { ...latest.current, restoring: true, restoreIssue: false };
      latest.current = next;
      setState(next);
      setRestoreAttempt((value) => value + 1);
    },
    tabs,
    active,
    title,
    addBrowser,
    openChanges,
    openChild,
    openWorkspace,
    closeTab,
    select: (id) => update((value) => ({ ...value, selected: id })),
  };
}

function SessionTabsHeader({
  data,
  dispatch,
  hosted = false,
  contentMode = 'document',
}: SessionTabsChromePresentation & {
  hosted?: boolean;
  contentMode?: 'document' | 'external';
}) {
  return (
    <header
      className="right-sidebar-heading session-tabs-heading"
      inert={hosted || undefined}
      aria-hidden={hosted || undefined}
    >
      <TabsList aria-label="右侧栏标签页" className="session-tabs-list">
        {data.tabs.map((tab) => (
          <div className="session-tab" data-active={tab.id === data.active} key={tab.id}>
            <TabsTrigger
              value={tab.id}
              title={tab.title}
              {...(contentMode === 'external' ? { 'aria-controls': undefined } : {})}
            >
              {tab.kind === 'child' && tab.childAgentIdentity ? (
                <ChildAgentIcon identity={tab.childAgentIdentity} />
              ) : (
                <HugeiconsIcon
                  icon={
                    tab.kind === 'browser'
                      ? Globe02Icon
                      : tab.kind === 'child'
                        ? BotIcon
                        : tab.kind === 'workspace'
                          ? Globe02Icon
                          : SourceCodeIcon
                  }
                />
              )}
              <span>{tab.title}</span>
            </TabsTrigger>
            <Button
              className="ghost session-tab-close"
              size="icon-xs"
              aria-label={`关闭标签页：${tab.title}`}
              title={`关闭标签页：${tab.title}`}
              onClick={() => {
                dispatch({ type: 'close', id: tab.id });
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </div>
        ))}
      </TabsList>
      <Button
        className="ghost session-tab-add"
        size="icon-sm"
        aria-label="新建标签页"
        title={data.tabs.length >= maxTabs ? '最多打开8个标签页' : '新建标签页'}
        disabled={data.restoring || data.restoreIssue || data.tabs.length >= maxTabs}
        onClick={() => dispatch({ type: 'add' })}
      >
        <HugeiconsIcon icon={Add01Icon} />
      </Button>
      <Button
        className="ghost right-sidebar-close"
        size="icon-sm"
        aria-label="收起标签栏"
        title="收起标签栏"
        onClick={() => dispatch({ type: 'collapse' })}
      >
        <HugeiconsIcon icon={PanelRightCloseIcon} />
      </Button>
    </header>
  );
}

function SessionTabsRestoreStatus({ data, dispatch }: SessionTabsChromePresentation) {
  return (
    <>
      {data.restoring && data.tabs.length === 0 && <p role="status">正在核对保留页面…</p>}
      {data.restoreIssue && (
        <div role="alert">
          保留页面尚未核实。
          <Button type="button" variant="ghost" onClick={() => dispatch({ type: 'retryRestore' })}>
            重查保留页面
          </Button>
        </div>
      )}
    </>
  );
}

function dispatchTabsAction(
  owner: Pick<SessionTabsProps, 'model' | 'onClose' | 'workspace'>,
  action: Parameters<SessionTabsChromePresentation['dispatch']>[0],
) {
  switch (action.type) {
    case 'select':
      if (owner.model.tabs.some((tab) => tab.id === action.id)) owner.model.select(action.id);
      break;
    case 'close': {
      const tab = owner.model.tabs.find((tab) => tab.id === action.id);
      if (!tab) return;
      owner.model.closeTab(tab.id);
      if (tab.kind === 'workspace') owner.workspace?.onClose();
      if (owner.model.tabs.length === 1) owner.onClose();
      break;
    }
    case 'add':
      owner.model.addBrowser();
      break;
    case 'collapse':
      owner.onClose();
      break;
    case 'retryRestore':
      owner.model.retryRestore?.();
      break;
    case 'openChanges':
      owner.model.openChanges();
      break;
  }
}

/** Controlled display only: this component creates no tab model or content readers. */
export function SessionTabsChrome(presentation: SessionTabsChromePresentation) {
  const { data, dispatch } = presentation;
  return (
    <Tabs
      className="session-tabs-root"
      value={data.active}
      onValueChange={(id) => dispatch({ type: 'select', id })}
      hidden={!data.present}
      aria-hidden={!data.visible || undefined}
      inert={!data.visible}
    >
      <SessionTabsHeader {...presentation} contentMode="external" />
      <SessionTabsRestoreStatus {...presentation} />
    </Tabs>
  );
}

function useChromePresentation({
  model,
  visible,
  present,
  scopeKey,
  onClose,
  workspace,
  onChromePresentation,
}: Pick<
  SessionTabsProps,
  'model' | 'visible' | 'onClose' | 'workspace' | 'onChromePresentation'
> & {
  present: boolean;
  scopeKey: string;
}): SessionTabsChromePresentation {
  const current = useRef<
    | {
        scopeKey: string;
        model: SessionTabsModel;
        visible: boolean;
        onClose: () => void;
        workspace: SessionTabsProps['workspace'];
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    current.current = { scopeKey, model, visible, onClose, workspace };
  });
  useLayoutEffect(
    () => () => {
      current.current = undefined;
    },
    [],
  );
  const dispatch = useCallback<SessionTabsChromePresentation['dispatch']>(
    (action) => {
      const owner = current.current;
      if (!owner || owner.scopeKey !== scopeKey || !owner.visible) return;
      dispatchTabsAction(owner, action);
    },
    [scopeKey],
  );
  const data = useMemo<SessionTabsChromeData>(
    () => ({
      scopeKey,
      tabs: model.tabs,
      active: model.active,
      visible,
      present,
      restoring: model.restoring === true,
      restoreIssue: model.restoreIssue === true,
    }),
    [scopeKey, model.tabs, model.active, visible, present, model.restoring, model.restoreIssue],
  );
  const presentation = useMemo(() => ({ data, dispatch }), [data, dispatch]);
  const published = useRef<SessionTabsProps['onChromePresentation']>(undefined);
  useLayoutEffect(() => {
    if (!onChromePresentation) published.current?.(null);
    published.current = onChromePresentation;
    onChromePresentation?.(presentation);
  }, [onChromePresentation, presentation]);
  useLayoutEffect(
    () => () => {
      published.current?.(null);
    },
    [],
  );
  return presentation;
}

/** Tool and child readers belong only to the active, visible tab. Browser lifetime belongs to the model. */
export function SessionTabs({
  model,
  visible,
  present = true,
  changes,
  renderBrowser,
  renderChildSession,
  onChildSessionChange,
  workspace,
  onClose,
  scopeKey = '',
  chromeHosted = false,
  onChromePresentation,
}: SessionTabsProps) {
  const { tabs, active, title, openChanges } = model;
  const chrome = useChromePresentation({
    model,
    visible,
    present,
    scopeKey,
    onClose,
    workspace,
    onChromePresentation,
  });
  const localChrome = {
    data: chrome.data,
    dispatch: (action: Parameters<SessionTabsChromePresentation['dispatch']>[0]) =>
      dispatchTabsAction({ model, onClose, workspace }, action),
  };
  const child = visible ? tabs.find((tab) => tab.id === active && tab.kind === 'child') : undefined;
  const childSessionId = child?.kind === 'child' ? child.sessionId : undefined;
  const childExecutionId = child?.kind === 'child' ? child.executionId : undefined;
  const childChange = useRef(onChildSessionChange);
  childChange.current = onChildSessionChange;
  useEffect(() => {
    childChange.current?.(
      childSessionId ? { sessionId: childSessionId, executionId: childExecutionId } : undefined,
    );
    return () => childChange.current?.(undefined);
  }, [childSessionId, childExecutionId]);
  const tools = (
    <section className="session-browser-tools" aria-label="工具">
      <h2>工具</h2>
      <Button
        type="button"
        className="session-browser-tool"
        disabled={
          model.restoring ||
          model.restoreIssue ||
          (tabs.length >= maxTabs && !tabs.some((tab) => tab.kind === 'changes'))
        }
        onClick={openChanges}
      >
        <HugeiconsIcon icon={SourceCodeIcon} />
        <span>变更</span>
      </Button>
    </section>
  );
  return (
    <aside
      className={`session-tabs${present ? ' right-sidebar' : ''}`}
      id="session-tabs"
      aria-label="标签页"
      hidden={!present}
      aria-hidden={!visible}
      inert={!visible}
    >
      <Tabs className="session-tabs-root" value={active} onValueChange={model.select}>
        <SessionTabsHeader {...localChrome} hosted={chromeHosted} />
        <SessionTabsRestoreStatus {...localChrome} />
        {tabs.map((tab) => (
          <TabsContent className="session-tab-content" value={tab.id} key={tab.id} forceMount>
            {tab.kind === 'workspace' ? (
              <div className="session-tab-workspace">
                {workspace?.render(visible && active === tab.id)}
              </div>
            ) : tab.kind === 'changes' ? (
              visible && active === tab.id ? (
                <div className="session-tab-changes">{changes}</div>
              ) : null
            ) : tab.kind === 'child' ? (
              visible && active === tab.id ? (
                <div className="session-tab-child">
                  {renderChildSession?.({
                    sessionId: tab.sessionId,
                    executionId: tab.executionId,
                    onTitleChange: (value) => title(tab.id, value),
                  })}
                </div>
              ) : null
            ) : renderBrowser ? (
              renderBrowser({
                id: tab.id,
                visible: visible && active === tab.id,
                tools,
                onTitleChange: (value) => title(tab.id, value),
              })
            ) : (
              <div className="session-browser-start">{tools}</div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );
}
