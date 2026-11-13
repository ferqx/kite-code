import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BotIcon,
  Cancel01Icon,
  FileDiffIcon,
  Flowchart01Icon,
  Globe02Icon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PencilEdit02Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChildAgentIcon } from './ApprovalHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
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

export interface SessionTrajectoryPageProps {
  readonly visible: boolean;
}

export interface SessionTabsProps {
  readonly model: SessionTabsModel;
  readonly visible: boolean;
  readonly present?: boolean;
  readonly changes: ReactNode;
  readonly renderBrowser?: (props: SessionBrowserPageProps) => ReactNode;
  readonly renderChildSession?: (props: SessionChildPageProps) => ReactNode;
  readonly renderTrajectory?: (props: SessionTrajectoryPageProps) => ReactNode;
  readonly onChildSessionChange?: (target: SessionChildTarget | undefined) => void;
  readonly workspace?: {
    readonly render: (visible: boolean) => ReactNode;
    readonly onClose: () => void;
  };
  readonly onClose: (reason?: 'last-tab') => void;
}

type SessionTab =
  | {
      readonly id: string;
      readonly kind: 'browser' | 'changes' | 'workspace' | 'trajectory';
      readonly title: string;
    }
  | {
      readonly id: string;
      readonly kind: 'child';
      readonly title: string;
      readonly sessionId: string;
      readonly executionId?: string;
      readonly childAgentIdentity?: string;
    };
type SessionTabsAction =
  | { readonly type: 'select' | 'close'; readonly id: string }
  | { readonly type: 'add' | 'collapse' | 'retryRestore' | 'openChanges' };

const tabIcons = {
  browser: Globe02Icon,
  changes: FileDiffIcon,
  child: BotIcon,
  trajectory: Flowchart01Icon,
  workspace: Globe02Icon,
};

interface SessionTabsHeaderPresentation {
  readonly data: Pick<SessionTabsModel, 'tabs' | 'active' | 'restoring' | 'restoreIssue'>;
  readonly dispatch: (action: SessionTabsAction) => void;
}
export interface SessionTabsModel {
  readonly restoredBrowserId?: string;
  readonly revealBrowserId?: string;
  readonly restoring?: boolean;
  readonly restoreIssue?: boolean;
  readonly closeIssue?: string;
  readonly closeReveal?: number;
  readonly retryRestore?: () => void;
  readonly tabs: readonly SessionTab[];
  readonly active: string;
  readonly select: (id: string) => void;
  readonly title: (id: string, title: string) => void;
  readonly addBrowser: () => void;
  readonly openChanges: () => void;
  readonly openTrajectory: () => boolean;
  readonly openChild: (
    target: SessionChildTarget,
    title: string,
    childAgentIdentity?: string,
  ) => boolean;
  readonly openWorkspace: (title: string) => boolean;
  readonly closeTab: (id: string, committed?: () => void) => void;
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
  const composing = useRef(false);
  return (
    <form
      className="native-browser-toolbar"
      aria-label="浏览器工具栏"
      onSubmit={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        const address = event.currentTarget.querySelector('input.native-browser-address');
        if (
          !composing.current &&
          props.canNavigate !== false &&
          event.currentTarget.ownerDocument.activeElement === address
        )
          props.onNavigate();
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
        onChange={(event) => {
          if (event.currentTarget.ownerDocument.activeElement === event.currentTarget)
            props.onAddressChange(event.currentTarget.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current))
            event.preventDefault();
        }}
        onFocus={(event) => {
          props.onAddressFocus(true);
          event.currentTarget.select();
        }}
        onBlur={() => {
          composing.current = false;
          props.onAddressFocus(false);
        }}
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
    closeIssue: undefined as string | undefined,
    closeReveal: 0,
    restoredBrowserId: undefined as string | undefined,
    revealBrowserId: undefined as string | undefined,
  };
}
/** Lives above the responsive panel Group so resizing cannot discard tabs or browsing history. */
export function useSessionTabs(
  scope: string,
  closeBrowser?: ((id: string) => void) | ((id: string) => Promise<void>),
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
  const intent = useRef(0);
  const closing = useRef(new Map<string, object>());
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
    if (latest.current.scope !== scope) return;
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
  };
  const admission = JSON.stringify([scope, restoreKey]);
  const currentAdmission = useRef(admission);
  currentAdmission.current = admission;
  const owner = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    const currentOwner = { admission };
    owner.current = currentOwner;
    closing.current.clear();
    return () => {
      if (owner.current !== currentOwner) return;
      owner.current = undefined;
      intent.current++;
    };
  }, [admission]);
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
  // An unconfirmed close still owns a slot: failure must restore that exact page.
  const occupiedSlots = () =>
    latest.current.tabs.length +
    [...closing.current.keys()].filter((id) => !latest.current.tabs.some((tab) => tab.id === id))
      .length;
  const addBrowser = () => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return;
    if (occupiedSlots() >= maxTabs) return;
    intent.current++;
    const tab = newBrowserTab();
    update((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openChanges = () => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return;
    const tabs = latest.current.tabs;
    intent.current++;
    const existing = tabs.find((tab) => tab.kind === 'changes');
    if (existing) {
      update((value) => ({ ...value, selected: existing.id }));
      return;
    }
    if (occupiedSlots() >= maxTabs) return;
    const tab: SessionTab = { id: 'changes', kind: 'changes', title: '变更' };
    update((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openTrajectory = () => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return false;
    const existing = latest.current.tabs.find((tab) => tab.kind === 'trajectory');
    if (!existing && occupiedSlots() >= maxTabs) return false;
    intent.current++;
    update((value) => ({
      ...value,
      tabs: existing
        ? value.tabs
        : [...value.tabs, { id: 'trajectory', kind: 'trajectory', title: '执行轨迹' }],
      selected: 'trajectory',
    }));
    return true;
  };
  const openChild = (target: SessionChildTarget, title: string, childAgentIdentity?: string) => {
    if (pending.current || latest.current.restoring || latest.current.restoreIssue) return false;
    const tabs = latest.current.tabs;
    const id = `child-${JSON.stringify([target.sessionId, target.executionId ?? null])}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (!tabs.some((tab) => tab.id === id) && occupiedSlots() >= maxTabs) return false;
    intent.current++;
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
    if (!tabs.some((tab) => tab.kind === 'workspace') && occupiedSlots() >= maxTabs) return false;
    intent.current++;
    update((value) => ({
      ...value,
      tabs: value.tabs.some((tab) => tab.kind === 'workspace')
        ? value.tabs
        : [...value.tabs, { id: 'workspace', kind: 'workspace', title }],
      selected: 'workspace',
    }));
    return true;
  };
  const closeTab = (id: string, committed?: () => void) => {
    const before = latest.current;
    if (before.scope !== scope) return;
    const { tabs, selected } = before;
    const active = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? '');
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const remaining = tabs.filter((tab) => tab.id !== id);
    const successor = active === id ? remaining[Math.min(index, remaining.length - 1)] : undefined;
    const closeIntent = ++intent.current;
    const closeOwner = owner.current;
    const closedTab = tabs[index]!;
    const operation = {};
    const release = () => {
      if (closing.current.get(id) === operation) closing.current.delete(id);
    };
    const failed = () => {
      release();
      if (!closeOwner || owner.current !== closeOwner || currentAdmission.current !== admission)
        return;
      const value = latest.current;
      const unchangedIntent = intent.current === closeIntent;
      const restored = [...value.tabs];
      if (!restored.some((tab) => tab.id === id))
        restored.splice(Math.min(index, restored.length), 0, closedTab);
      const next = {
        ...value,
        tabs: restored,
        selected: unchangedIntent ? before.selected : value.selected,
        closeIssue: '未能确认网页已关闭，原页面已保留，请核对页面状态。',
        closeReveal: value.closeReveal + (unchangedIntent ? 1 : 0),
      };
      latest.current = next;
      setState(next);
    };
    let result: void | Promise<void>;
    try {
      // Capture and dispatch the exact Main page identity in the user's click
      // stack. No later DOM callback may look up a same-ID successor instead.
      result = tabs[index]?.kind === 'browser' ? close.current?.(id) : undefined;
    } catch {
      failed();
      return;
    }
    if (result) closing.current.set(id, operation);
    update((value) => ({
      ...value,
      tabs: remaining,
      selected: active === id ? (successor?.id ?? '') : value.selected,
    }));
    committed?.();
    if (result) void Promise.resolve(result).then(release, failed);
  };
  return {
    restoredBrowserId: current.restoredBrowserId,
    revealBrowserId: current.revealBrowserId,
    restoring: current.restoring || browserPending || restorePending,
    restoreIssue: current.restoreIssue,
    closeIssue: current.closeIssue,
    closeReveal: current.closeReveal,
    retryRestore: () => {
      if (!restore.current || latest.current.restoring) return;
      intent.current++;
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
    openTrajectory,
    openChild,
    openWorkspace,
    closeTab,
    select: (id) => {
      if (!latest.current.tabs.some((tab) => tab.id === id)) return;
      intent.current++;
      update((value) => ({ ...value, selected: id }));
    },
  };
}

function SessionTabsHeader({ data, dispatch }: SessionTabsHeaderPresentation) {
  return (
    <header className="right-sidebar-heading session-tabs-heading">
      <TabsList aria-label="右侧栏标签页" className="session-tabs-list">
        {data.tabs.map((tab) => (
          <div className="session-tab" data-active={tab.id === data.active} key={tab.id}>
            <TabsTrigger value={tab.id} title={tab.title}>
              {tab.kind === 'child' && tab.childAgentIdentity ? (
                <ChildAgentIcon identity={tab.childAgentIdentity} />
              ) : (
                <HugeiconsIcon icon={tabIcons[tab.kind]} aria-hidden="true" />
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

function SessionTabsRestoreStatus({ data, dispatch }: SessionTabsHeaderPresentation) {
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
  action: Parameters<SessionTabsHeaderPresentation['dispatch']>[0],
) {
  switch (action.type) {
    case 'select':
      if (owner.model.tabs.some((tab) => tab.id === action.id)) owner.model.select(action.id);
      break;
    case 'close': {
      const tab = owner.model.tabs.find((tab) => tab.id === action.id);
      if (!tab) return;
      owner.model.closeTab(tab.id, () => {
        if (tab.kind === 'workspace') owner.workspace?.onClose();
        if (owner.model.tabs.length === 1) owner.onClose('last-tab');
      });
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

/** Tool and child readers belong only to the active, visible tab. Browser lifetime belongs to the model. */
export function SessionTabs({
  model,
  visible,
  present = true,
  changes,
  renderBrowser,
  renderChildSession,
  renderTrajectory,
  onChildSessionChange,
  workspace,
  onClose,
}: SessionTabsProps) {
  const { tabs, active, title, openChanges } = model;
  const localChrome: SessionTabsHeaderPresentation = {
    data: model,
    dispatch: (action) => dispatchTabsAction({ model, onClose, workspace }, action),
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
      <div className="session-browser-tool-grid">
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
          <HugeiconsIcon icon={tabIcons.changes} aria-hidden="true" />
          <span>变更</span>
        </Button>
        {renderTrajectory && (
          <Button
            type="button"
            className="session-browser-tool"
            disabled={
              model.restoring ||
              model.restoreIssue ||
              (tabs.length >= maxTabs && !tabs.some((tab) => tab.kind === 'trajectory'))
            }
            onClick={() => model.openTrajectory()}
            aria-label="执行轨迹"
          >
            <HugeiconsIcon icon={tabIcons.trajectory} aria-hidden="true" />
            <span>执行轨迹</span>
          </Button>
        )}
      </div>
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
        <SessionTabsHeader {...localChrome} />
        <SessionTabsRestoreStatus {...localChrome} />
        {tabs.map((tab) => (
          <TabsContent className="session-tab-content" value={tab.id} key={tab.id} forceMount>
            {tab.kind === 'workspace' ? (
              <div className="session-tab-workspace">
                {workspace?.render(visible && active === tab.id)}
              </div>
            ) : tab.kind === 'trajectory' ? (
              visible && active === tab.id ? (
                <div className="session-tab-trajectory">
                  {renderTrajectory?.({ visible: true })}
                </div>
              ) : null
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
