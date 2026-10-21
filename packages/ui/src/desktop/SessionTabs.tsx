import {
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Globe02Icon,
  PanelRightCloseIcon,
  RefreshIcon,
  SourceCodeIcon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Button } from './ui';

export interface SessionBrowserPageProps {
  readonly id: string;
  readonly visible: boolean;
  readonly tools: ReactNode;
  readonly onTitleChange: (title: string) => void;
}

export interface SessionChildTarget {
  readonly sessionId: string;
  readonly executionId?: string;
}

export interface SessionChildTabRequest extends SessionChildTarget {
  readonly requestId: number;
  readonly title: string;
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
  readonly onClose: () => void;
}

type SessionTab =
  | { id: string; kind: 'browser' | 'changes'; title: string }
  | ({ id: string; kind: 'child'; title: string } & SessionChildTarget);
export interface SessionTabsModel {
  readonly tabs: readonly SessionTab[];
  readonly active: string;
  readonly select: (id: string) => void;
  readonly title: (id: string, title: string) => void;
  readonly addBrowser: () => void;
  readonly openChanges: () => void;
  readonly openChild: (target: SessionChildTarget, title: string) => boolean;
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
  readonly address: string;
  readonly loading: boolean;
  readonly hasPage: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onAddressChange: (value: string) => void;
  readonly onAddressFocus: (focused: boolean) => void;
  readonly onNavigate: () => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
}
export function SessionBrowserToolbar(props: SessionBrowserToolbarProps) {
  return (
    <form
      className="native-browser-toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        props.onNavigate();
      }}
    >
      <Button
        type="button"
        className="ghost"
        size="icon-sm"
        aria-label="后退"
        title="后退"
        disabled={!props.canGoBack}
        onClick={props.onBack}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} />
      </Button>
      <Button
        type="button"
        className="ghost"
        size="icon-sm"
        aria-label="前进"
        title="前进"
        disabled={!props.canGoForward}
        onClick={props.onForward}
      >
        <HugeiconsIcon icon={ArrowRight01Icon} />
      </Button>
      <Button
        type="button"
        className="ghost"
        size="icon-sm"
        aria-label={props.loading ? '停止加载' : '刷新网页'}
        title={props.loading ? '停止加载' : '刷新网页'}
        disabled={!props.hasPage}
        onClick={props.onReload}
      >
        <HugeiconsIcon icon={props.loading ? Cancel01Icon : RefreshIcon} />
      </Button>
      <input
        className="native-browser-address"
        aria-label="搜索或输入网址"
        placeholder="搜索或输入网址"
        value={props.address}
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
    </form>
  );
}

function initialTabs(scope: string) {
  const tab = newBrowserTab();
  return { scope, tabs: [tab], selected: tab.id };
}
/** Lives above the responsive panel Group so resizing cannot discard tabs or browsing history. */
export function useSessionTabs(
  scope: string,
  closeBrowser?: (id: string) => void,
): SessionTabsModel {
  const [state, setState] = useState(() => initialTabs(scope));
  let current = state;
  if (current.scope !== scope) {
    current = initialTabs(scope);
    setState(current);
  }
  const previous = useRef(current);
  const latest = useRef(current);
  latest.current = current;
  const close = useRef(closeBrowser);
  close.current = closeBrowser;
  useEffect(() => {
    for (const tab of previous.current.tabs) {
      if (tab.kind === 'browser' && !state.tabs.some((next) => next.id === tab.id))
        close.current?.(tab.id);
    }
    previous.current = state;
  }, [state]);
  useEffect(
    () => () => {
      const ids = new Set(
        [...previous.current.tabs, ...latest.current.tabs]
          .filter((tab) => tab.kind === 'browser')
          .map((tab) => tab.id),
      );
      for (const id of ids) close.current?.(id);
    },
    [],
  );
  const { tabs, selected } = current;
  const active = tabs.some((tab) => tab.id === selected) ? selected : tabs[0]!.id;
  const title = (id: string, value: string) => {
    const name = value.trim().slice(0, 80) || '新标签页';
    setState((value) => {
      if (!value.tabs.some((tab) => tab.id === id && tab.title !== name)) return value;
      return {
        ...value,
        tabs: value.tabs.map((tab) => (tab.id === id ? { ...tab, title: name } : tab)),
      };
    });
  };
  const addBrowser = () => {
    if (tabs.length >= maxTabs) return;
    const tab = newBrowserTab();
    setState((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openChanges = () => {
    const existing = tabs.find((tab) => tab.kind === 'changes');
    if (existing) {
      setState((value) => ({ ...value, selected: existing.id }));
      return;
    }
    if (tabs.length >= maxTabs) return;
    const tab: SessionTab = { id: 'changes', kind: 'changes', title: '变更' };
    setState((value) => ({ ...value, tabs: [...value.tabs, tab], selected: tab.id }));
  };
  const openChild = (target: SessionChildTarget, title: string) => {
    const id = `child-${JSON.stringify([target.sessionId, target.executionId ?? null])}`;
    if (!tabs.some((tab) => tab.id === id) && tabs.length >= maxTabs) return false;
    const tab: SessionTab = {
      ...target,
      id,
      kind: 'child',
      title: title.trim().slice(0, 80) || '子 Agent',
    };
    setState((value) => ({
      ...value,
      tabs: value.tabs.some((entry) => entry.id === id)
        ? value.tabs.map((entry) => (entry.id === id ? tab : entry))
        : [...value.tabs, tab],
      selected: id,
    }));
    return true;
  };
  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    let remaining = tabs.filter((tab) => tab.id !== id);
    if (!remaining.length) remaining = [newBrowserTab()];
    setState((value) => ({
      ...value,
      tabs: remaining,
      selected: active === id ? remaining[Math.min(index, remaining.length - 1)]!.id : active,
    }));
  };
  return {
    tabs,
    active,
    title,
    addBrowser,
    openChanges,
    openChild,
    closeTab,
    select: (id) => setState((value) => ({ ...value, selected: id })),
  };
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
  onClose,
}: SessionTabsProps) {
  const { tabs, active, title, addBrowser, openChanges, closeTab } = model;
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
        className="session-browser-tool"
        disabled={tabs.length >= maxTabs && !tabs.some((tab) => tab.kind === 'changes')}
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
        <header className="right-sidebar-heading session-tabs-heading">
          <TabsList aria-label="右侧栏标签页" className="session-tabs-list">
            {tabs.map((tab) => (
              <div className="session-tab" data-active={tab.id === active} key={tab.id}>
                <TabsTrigger value={tab.id} title={tab.title}>
                  <HugeiconsIcon
                    icon={
                      tab.kind === 'browser'
                        ? Globe02Icon
                        : tab.kind === 'child'
                          ? UserGroupIcon
                          : SourceCodeIcon
                    }
                  />
                  <span>{tab.title}</span>
                </TabsTrigger>
                <Button
                  className="ghost session-tab-close"
                  size="icon-sm"
                  aria-label={`关闭标签页：${tab.title}`}
                  title={`关闭标签页：${tab.title}`}
                  onClick={() => closeTab(tab.id)}
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
            title={tabs.length >= maxTabs ? '最多打开8个标签页' : '新建标签页'}
            disabled={tabs.length >= maxTabs}
            onClick={addBrowser}
          >
            <HugeiconsIcon icon={Add01Icon} />
          </Button>
          <Button
            className="ghost right-sidebar-close"
            size="icon-sm"
            aria-label="收起标签栏"
            title="收起标签栏"
            onClick={onClose}
          >
            <HugeiconsIcon icon={PanelRightCloseIcon} />
          </Button>
        </header>
        {tabs.map((tab) => (
          <TabsContent className="session-tab-content" value={tab.id} key={tab.id} forceMount>
            {tab.kind === 'changes' ? (
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
