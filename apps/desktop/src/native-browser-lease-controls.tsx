import { useEffect, useRef, useState } from 'react';
import {
  type AgentBrowserObservationOwner,
  createAgentBrowserObservationOwner,
} from './agent-browser-observation-owner';
import type { AgentBrowserObservation } from './agent-browser-observer';
import type { NativeExtensionScope } from './extensions-bridge';
import type { NativeBridge, NativeCallerMetadata } from './native-bridge';
import type { NativeBrowserState } from './native-browser-bridge';
import { useNativeBrowserPopup } from './native-browser-menu';
import { NativeBrowserControl } from './native-browser-toolbar';
import type { NativeBrowserControlAction } from './native-browser-toolbar-types';

/** Only explicit existing Extension Actions can change control; Main display state grants nothing. */
export function NativeBrowserLeaseControls({
  bridge,
  scope,
  page,
  visible,
  canRead,
  canInvoke,
  submissions = [],
}: {
  bridge: NativeBridge;
  scope: NativeExtensionScope;
  page: NativeBrowserState;
  visible: boolean;
  canRead: boolean;
  canInvoke: boolean;
  submissions?: readonly NativeCallerMetadata[];
}) {
  const [menuIssue, setMenuIssue] = useState<string>();
  const [observation, setObservation] = useState<AgentBrowserObservation & { scopeKey?: string }>({
    fresh: false,
    loading: true,
    available: false,
    pending: false,
  });
  const observer = useRef<AgentBrowserObservationOwner | undefined>(undefined);
  const key = JSON.stringify(scope);
  const current = useRef({ key, scope, visible, canInvoke, submissions });
  current.current = { key, scope, visible, canInvoke, submissions };
  useEffect(() => {
    setMenuIssue(undefined);
    setObservation({ fresh: false, loading: true, available: false, pending: false });
    if (!canRead || !page.control?.browserId) return;
    const reader = createAgentBrowserObservationOwner(
      bridge,
      current.current.scope,
      (value) => {
        if (current.current.key === key) setObservation({ ...value, scopeKey: key });
      },
      current.current.canInvoke,
      current.current.submissions,
    );
    observer.current = reader;
    reader.start(current.current.visible && document.visibilityState !== 'hidden');
    return () => {
      reader.stop();
      if (observer.current === reader) observer.current = undefined;
    };
  }, [bridge, key, canRead, page.control?.browserId]);
  useEffect(() => {
    observer.current?.setCanInvoke(canInvoke);
    const update = () =>
      observer.current?.setVisible(visible && document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [visible, canInvoke]);
  const view = observation.view;
  const exact =
    observation.scopeKey === key &&
    !!view &&
    view.browserId === page.control?.browserId &&
    page.control.sessionId === scope.sessionId;
  const actionable = exact && observation.fresh && !observation.pending && canInvoke && visible;
  const handoff =
    actionable &&
    !!view &&
    ['starting', 'agent'].includes(view.state) &&
    !!page.control &&
    ['acquiring', 'agent'].includes(page.control.phase);
  const close =
    actionable && !!view && ['starting', 'agent', 'human', 'outcome_unknown'].includes(view.state);
  const invoke = (action: 'handoff' | 'close') => {
    if (!view || !(action === 'handoff' ? handoff : close)) return;
    void observer.current?.invoke(action, {
      browserId: view.browserId,
      generation: view.generation,
    });
  };
  const phase = page.control?.phase ?? 'human';
  const label = {
    human: '人工',
    armed: '人工',
    acquiring: '接管中',
    agent: 'Agent',
    revoking: '交还中',
    unknown: '待核实',
  }[phase];
  const detail = {
    human: '由你控制',
    armed: '等待 Agent',
    acquiring: '正在接管',
    agent: 'Agent 正在操作',
    revoking: '正在交还',
    unknown: '控制状态待核实',
  }[phase];
  const details = [
    detail,
    exact ? view?.humanRequest : undefined,
    !observation.fresh || !exact || observation.pending ? '正在核对控制权' : undefined,
    observation.pending ? '正在核实原操作；不会重复提交。' : undefined,
    observation.error,
    menuIssue,
    phase === 'human' ? '网页由你控制；需要 Agent 再次操作时，请发送新指令。' : undefined,
  ].filter((value): value is string => !!value);
  const showMenu = useNativeBrowserPopup({
    identity: JSON.stringify([
      key,
      page.id,
      page.control?.incarnation,
      page.control?.navigation,
      phase,
      view?.generation,
      view?.state,
    ]),
    hostKey: 'root',
    visible,
    scope: {
      storeId: scope.storeId,
      sessionId: scope.sessionId,
      generation: scope.generation,
      viewSelection: scope.viewSelection,
    },
    page,
    items: [
      { action: 'handoff', enabled: handoff },
      { action: 'close', enabled: close },
      ...(observation.pending ? [{ action: 'checkOriginal' as const, enabled: true }] : []),
    ],
    details,
    onAction(action) {
      setMenuIssue(undefined);
      if (action === 'handoff' || action === 'close') invoke(action);
      if (action === 'checkOriginal') observer.current?.checkOriginal();
    },
    onError(cause) {
      setMenuIssue(
        cause instanceof Error && cause.message === 'browser_menu_state_changed'
          ? undefined
          : '控制菜单暂不可用，请重试。',
      );
    },
  });
  const data = { label, detail, issue: menuIssue };
  const handleControlAction = (action: NativeBrowserControlAction) => {
    if (action.type === 'show-menu' && page.control?.browserId) showMenu(action.anchor);
  };
  const trigger = useRef<HTMLSpanElement>(null);
  const previousKey = useRef(key);
  useEffect(() => {
    if (!visible || previousKey.current !== key) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && trigger.current?.contains(active)) active.blur();
    }
    previousKey.current = key;
  }, [visible, key]);
  if (!page.control?.browserId) return null;
  return (
    <span ref={trigger}>
      <NativeBrowserControl data={data} dispatch={handleControlAction} />
    </span>
  );
}
