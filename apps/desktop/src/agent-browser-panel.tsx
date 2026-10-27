import type { Json } from '@kite-ai/client';
import { Button } from '@kite-ai/ui/desktop';
import { useEffect, useId, useRef, useState } from 'react';
import {
  type AgentBrowserAction,
  type AgentBrowserObservation,
  AgentBrowserObserver,
} from './agent-browser-observer';
import {
  type AgentBrowserView,
  agentBrowserErrorMessage,
  agentBrowserHit,
  agentBrowserPoint,
} from './agent-browser-view';
import { type BrowserNoteInput, browserNoteInput } from './browser-annotation-drafts';
import type { NativeExtensionScope } from './extensions-bridge';
import type { NativeBridge, NativeCallerMetadata } from './native-bridge';
import './agent-browser-panel.css';

const labels: Record<AgentBrowserView['state'], string> = {
  starting: '正在启动',
  agent: 'Agent 正在操作',
  pausing: '正在暂停 Agent，等待当前操作结束',
  human: '由你控制',
  closing: '正在关闭',
  closed: '已关闭',
  outcome_unknown: '操作结果待核实',
  unavailable: '浏览器不可用',
};

export function AgentBrowserPanel({
  bridge,
  scope,
  canRead,
  canInvoke,
  visible = true,
  submissions = [],
  onAnnotate,
}: {
  bridge: NativeBridge;
  scope: NativeExtensionScope;
  canRead: boolean;
  canInvoke: boolean;
  visible?: boolean;
  submissions?: readonly NativeCallerMetadata[];
  onAnnotate: (capture: BrowserNoteInput) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const fillNoticeId = useId();
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const observer = useRef<AgentBrowserObserver | undefined>(undefined);
  const [state, setState] = useState<AgentBrowserObservation>({
    fresh: false,
    loading: true,
    available: false,
    pending: false,
  });
  const [note, setNote] = useState('');
  const [frozenState, setFrozenState] = useState<{ identity: string; view: AgentBrowserView }>();
  const setFrozen = (view: AgentBrowserView | undefined) =>
    setFrozenState(view ? { identity, view } : undefined);
  const frozen = frozenState?.identity === JSON.stringify(scope) ? frozenState.view : undefined;
  const [hoverRef, setHoverRef] = useState('');
  const [noteRef, setNoteRef] = useState('');
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const updateVisibility = useRef<((visible?: boolean) => void) | undefined>(undefined);
  const [decoded, setDecoded] = useState('');
  const identity = JSON.stringify(scope);
  const current = useRef({ identity, visible, canInvoke, scope, submissions });
  current.current = { identity, visible, canInvoke, scope, submissions };
  useEffect(() => {
    setNote('');
    setFrozenState(undefined);
    setHoverRef('');
    setNoteRef('');
    setText('');
    setMessage('');
    setDecoded('');
    if (!canRead) {
      setState({ fresh: false, loading: false, available: false, pending: false });
      return;
    }
    const owner = new AgentBrowserObserver(
      bridge,
      current.current.scope,
      (value) => {
        if (current.current.identity === identity) setState(value);
      },
      current.current.canInvoke,
      current.current.submissions,
    );
    observer.current = owner;
    let intersects = typeof IntersectionObserver === 'undefined';
    const update = (visible = current.current.visible) =>
      owner.setVisible(visible && intersects && document.visibilityState !== 'hidden');
    updateVisibility.current = update;
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            intersects = entries.some((entry) => entry.isIntersecting);
            update();
          });
    owner.start(current.current.visible && intersects && document.visibilityState !== 'hidden');
    if (host.current) intersection?.observe(host.current);
    const visibilityChanged = () => update();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      intersection?.disconnect();
      owner.stop();
      if (observer.current === owner) {
        observer.current = undefined;
        updateVisibility.current = undefined;
      }
    };
    // Scope identity, not a fresh object each render, owns the observation.
  }, [bridge, identity, canRead]);
  useEffect(() => {
    observer.current?.setCanInvoke(canInvoke);
    // Intersection/visibility admission is rechecked by a visibility event as well.
    updateVisibility.current?.(visible);
  }, [visible, canInvoke]);
  const view = state.view;
  const shown = frozen ?? view;
  const frame = shown?.frame;
  const noteTarget = frozen?.annotations.find((item) => item.ref === noteRef);
  const highlighted = shown?.annotations.find((item) => item.ref === (noteRef || hoverRef));
  useEffect(() => {
    if (!frozen) return;
    const exitSelection = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFrozenState(undefined);
        setNoteRef('');
        setHoverRef('');
        setNote('');
      }
    };
    document.addEventListener('keydown', exitSelection);
    return () => document.removeEventListener('keydown', exitSelection);
  }, [frozen]);
  useEffect(() => {
    if (noteRef) noteEditor.current?.focus();
  }, [noteRef]);
  const actionable = !!view && state.fresh && canInvoke && !state.pending;
  const human = actionable && view.state === 'human';
  const selected = state.fresh ? view?.selectedAnnotation : undefined;
  const previousSelection = useRef(false);
  useEffect(() => {
    if (previousSelection.current && state.fresh && !view?.selectedAnnotation) {
      setMessage('页面已变化，原引用已失效；请重新选择。');
      setText('');
    }
    if (state.fresh) previousSelection.current = !!view?.selectedAnnotation;
  }, [state.fresh, view?.selectedAnnotation]);
  const invoke = (action: AgentBrowserAction, input: Record<string, Json> = {}) => {
    if (!view || !actionable) return;
    setMessage('');
    void observer.current?.invoke(action, {
      browserId: view.browserId,
      generation: view.generation,
      ...input,
    });
  };
  return (
    <section className="agent-browser-panel" aria-label="Agent 浏览器" ref={host}>
      <div className="agent-browser-status" role="status">
        <strong>
          {view
            ? labels[view.state]
            : state.loading
              ? '正在读取浏览器…'
              : state.available
                ? '此会话还没有 Agent 浏览器'
                : '此连接尚未提供 Agent 浏览器'}
        </strong>
        <span>独立于你的网页标签；关闭侧栏不会停止任务。</span>
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {view?.error && <p role="alert">{agentBrowserErrorMessage(view.error)}</p>}
      {view && (
        <>
          <div className="agent-browser-toolbar">
            <Button
              variant={frozen ? 'outline' : 'ghost'}
              aria-pressed={!!frozen}
              disabled={!frozen && (!state.fresh || !frame || decoded !== frame.data)}
              onClick={() => {
                if (frozen) {
                  setFrozen(undefined);
                  setHoverRef('');
                  setNoteRef('');
                  setNote('');
                } else if (view?.frame && decoded === view.frame.data) {
                  setFrozen(structuredClone(view));
                  setNoteRef('');
                  setHoverRef('');
                  setNote('');
                }
              }}
            >
              ⌖ {frozen ? '退出指向 · Esc' : '指向元素'}
            </Button>
            {view.state === 'agent' && (
              <Button variant="outline" disabled={!actionable} onClick={() => invoke('handoff')}>
                暂停并接管
              </Button>
            )}
            {view.state === 'human' && (
              <Button variant="outline" disabled={!actionable} onClick={() => invoke('resume')}>
                交还 Agent
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={
                !actionable ||
                !['starting', 'agent', 'human', 'outcome_unknown'].includes(view.state)
              }
              onClick={() => invoke('close')}
            >
              结束浏览器
            </Button>
          </div>
          <div className="agent-browser-location">
            <strong>{view.title || '未命名页面'}</strong>
            <span title={view.url}>{view.url || '尚未打开网页'}</span>
          </div>
          {frame && shown ? (
            <div className="agent-browser-canvas">
              <button
                type="button"
                className={`agent-browser-frame${frozen ? ' is-pointing' : ''}`}
                aria-label={
                  frozen
                    ? '在冻结快照中选取注释元素（不会点击网页）'
                    : '浏览器画面；接管后可选择操作元素'
                }
                disabled={(!frozen && !human) || decoded !== frame.data}
                onMouseMove={(event) => {
                  if (!frozen) return;
                  const image = event.currentTarget.querySelector('img');
                  const point = image
                    ? agentBrowserPoint(
                        frame,
                        image.getBoundingClientRect(),
                        event.clientX,
                        event.clientY,
                      )
                    : undefined;
                  setHoverRef(point ? (agentBrowserHit(shown, point)?.ref ?? '') : '');
                }}
                onMouseLeave={() => setHoverRef('')}
                onClick={(event) => {
                  const image = event.currentTarget.querySelector('img');
                  if (!image || decoded !== frame.data) return;
                  const point = agentBrowserPoint(
                    frame,
                    image.getBoundingClientRect(),
                    event.clientX,
                    event.clientY,
                  );
                  const target = point ? agentBrowserHit(shown, point) : undefined;
                  if (!target) {
                    setMessage('此处没有可引用元素；目前仅支持这份快照提供的元素。');
                    return;
                  }
                  if (frozen) {
                    setNoteRef(target.ref);
                    setNote('');
                  } else invoke('select', { seq: view.seq, ref: target.ref });
                }}
              >
                <img
                  src={`data:image/jpeg;base64,${frame.data}`}
                  alt={frozen ? '用于注释的冻结网页快照' : '网页实时画面'}
                  draggable={false}
                  onLoad={(event) => setDecoded(event.currentTarget.src.slice(23))}
                  onError={() => {
                    setDecoded('');
                    setMessage('画面解码失败，无法选取。');
                  }}
                />
                {highlighted && frozen && (
                  <span
                    className="agent-browser-region is-selected"
                    style={{
                      left: `${(highlighted.box.x / frame.width) * 100}%`,
                      top: `${(highlighted.box.y / frame.height) * 100}%`,
                      width: `${(highlighted.box.width / frame.width) * 100}%`,
                      height: `${(highlighted.box.height / frame.height) * 100}%`,
                    }}
                  />
                )}
              </button>
              {frozen && (
                <p className="agent-browser-help">
                  冻结快照 · Agent 继续运行 · 只选取已有元素 · Esc 退出
                  {view.seq !== frozen.seq ? ' · 页面已有更新，此处保留当时画面' : ''}
                </p>
              )}
              {frozen && noteTarget && (
                <form
                  className="agent-browser-note"
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      onAnnotate(browserNoteInput(frozen, noteTarget, note));
                      setNoteRef('');
                      setNote('');
                      setMessage('已加入注释草稿，将随下一次提示词发送。');
                    } catch {
                      setMessage('未能加入注释，请检查图片准备状态与数量上限。');
                    }
                  }}
                >
                  <strong>
                    {noteTarget.role} · {noteTarget.name || noteTarget.ref}
                  </strong>
                  <textarea
                    ref={noteEditor}
                    aria-label="注释说明"
                    placeholder="描述你希望 Agent 关注的内容…"
                    maxLength={2000}
                    rows={3}
                    value={note}
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setNoteRef('');
                        setNote('');
                      }}
                    >
                      取消
                    </Button>
                    <Button type="submit" variant="outline">
                      加入提示词
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <p className="agent-browser-empty">尚无可用画面。</p>
          )}
          {!state.fresh && frame && <p role="status">此画面尚未重新核实，操作与引用暂不可用。</p>}
          {view.state === 'human' && (
            <>
              <p className="agent-browser-help">
                点击编号区域只选取引用。网页操作需要使用下方明确按钮。
              </p>
              <label>
                页面元素
                <select
                  aria-label="页面元素"
                  disabled={!human}
                  value={selected?.ref ?? ''}
                  onChange={(event) =>
                    invoke('select', { seq: view.seq, ref: event.currentTarget.value || null })
                  }
                >
                  <option value="">选择一个元素</option>
                  {view.annotations.map((item) => (
                    <option key={item.ref} value={item.ref}>
                      {item.number}. {item.name || item.role} ({item.ref})
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <div className="agent-browser-selection">
                  <strong>已选：{selected.name || selected.role}</strong>
                  <span>
                    {selected.ref} · {selected.role}
                  </span>
                  <Button
                    variant="outline"
                    disabled={!human}
                    onClick={() =>
                      invoke('input', {
                        command: { action: 'click', ref: selected.ref, seq: view.seq },
                      })
                    }
                  >
                    点击所选元素
                  </Button>
                  <label>
                    填入内容
                    <input
                      aria-label="填入内容"
                      aria-describedby={fillNoticeId}
                      maxLength={16384}
                      value={text}
                      onChange={(event) => setText(event.currentTarget.value)}
                    />
                  </label>
                  <p id={fillNoticeId} className="agent-browser-help">
                    普通填写内容会进入会话记录；此入口不支持输入密码、验证码或其他凭据。
                  </p>
                  <Button
                    variant="outline"
                    disabled={!human}
                    onClick={() =>
                      invoke('input', {
                        command: { action: 'fill', ref: selected.ref, seq: view.seq, value: text },
                      })
                    }
                  >
                    填入所选元素
                  </Button>
                </div>
              )}
              <form
                className="agent-browser-navigate"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (address.trim())
                    invoke('input', { command: { action: 'navigate', url: address.trim() } });
                }}
              >
                <label>
                  打开网址
                  <input
                    aria-label="打开网址"
                    maxLength={8192}
                    placeholder="https://…"
                    value={address}
                    onChange={(event) => setAddress(event.currentTarget.value)}
                  />
                </label>
                <Button variant="outline" type="submit" disabled={!human || !address.trim()}>
                  前往
                </Button>
              </form>
              <div className="agent-browser-toolbar">
                <Button
                  variant="outline"
                  disabled={!human}
                  onClick={() =>
                    invoke('input', { command: { action: 'scroll', direction: 'up', amount: 500 } })
                  }
                >
                  向上滚动
                </Button>
                <Button
                  variant="outline"
                  disabled={!human}
                  onClick={() =>
                    invoke('input', {
                      command: { action: 'scroll', direction: 'down', amount: 500 },
                    })
                  }
                >
                  向下滚动
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {state.pending && (
        <div role="status">
          正在核实原操作；不会重复提交。
          <Button variant="ghost" onClick={() => observer.current?.checkOriginal()}>
            查询原操作
          </Button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
