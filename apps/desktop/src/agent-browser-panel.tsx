import type { Json } from '@kite-ai/client';
import {
  BrowserAnnotationIcon,
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectField,
  Textarea,
} from '@kite-ai/ui/desktop';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type AgentBrowserObservationOwner,
  createAgentBrowserObservationOwner,
} from './agent-browser-observation-owner';
import type { AgentBrowserAction, AgentBrowserObservation } from './agent-browser-observer';
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
  annotationOnly = false,
  expectedBrowserId,
  annotationToolbarHost,
}: {
  bridge: NativeBridge;
  scope: NativeExtensionScope;
  canRead: boolean;
  canInvoke: boolean;
  visible?: boolean;
  submissions?: readonly NativeCallerMetadata[];
  onAnnotate: (capture: BrowserNoteInput) => void;
  annotationOnly?: boolean;
  expectedBrowserId?: string;
  annotationToolbarHost?: HTMLElement | null;
}) {
  const externalTools = annotationOnly && annotationToolbarHost !== undefined;
  const [annotationToolsOpen, setAnnotationToolsOpen] = useState(false);
  const identity = JSON.stringify([scope, expectedBrowserId ?? null]);
  const annotationStarted = useRef('');
  const annotationCapture = useRef<
    { identity: string; seq?: string; pending: boolean } | undefined
  >(undefined);
  const [captureRevision, setCaptureRevision] = useState(0);
  const host = useRef<HTMLElement>(null);
  const fillNoticeId = useId();
  const elementSelectId = useId();
  const fillInputId = useId();
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const observer = useRef<AgentBrowserObservationOwner | undefined>(undefined);
  const [state, setState] = useState<AgentBrowserObservation & { scopeKey?: string }>({
    fresh: false,
    loading: true,
    available: false,
    pending: false,
  });
  const [note, setNote] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [frozenState, setFrozenState] = useState<{ identity: string; view: AgentBrowserView }>();
  const setFrozen = (view: AgentBrowserView | undefined) =>
    setFrozenState(view ? { identity, view } : undefined);
  const frozen = frozenState?.identity === identity ? frozenState.view : undefined;
  const [hoverRef, setHoverRef] = useState('');
  const [noteRef, setNoteRef] = useState('');
  const [text, setText] = useState('');
  const [addressDraft, setAddressDraft] = useState<{
    key: string;
    value: string;
    baseUrl: string;
  }>();
  const [editingAddress, setEditingAddress] = useState(false);
  const composingAddress = useRef(false);
  const [message, setMessage] = useState('');
  const updateVisibility = useRef<((visible?: boolean) => void) | undefined>(undefined);
  const [decoded, setDecoded] = useState('');
  const current = useRef({ identity, visible, canInvoke, scope, submissions });
  current.current = { identity, visible, canInvoke, scope, submissions };
  useEffect(() => {
    setAnnotationToolsOpen(false);
    setMoreOpen(false);
    setNote('');
    setFrozenState(undefined);
    setHoverRef('');
    setNoteRef('');
    setText('');
    setAddressDraft(undefined);
    setEditingAddress(false);
    composingAddress.current = false;
    setMessage('');
    setDecoded('');
    annotationStarted.current = '';
    if (!canRead) {
      setState({ fresh: false, loading: false, available: false, pending: false });
      return;
    }
    const owner = createAgentBrowserObservationOwner(
      bridge,
      current.current.scope,
      (value) => {
        if (current.current.identity === identity) setState({ ...value, scopeKey: identity });
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
  useEffect(() => {
    if (!visible) {
      annotationStarted.current = '';
      annotationCapture.current = undefined;
      setAnnotationToolsOpen(false);
      setMoreOpen(false);
      setEditingAddress(false);
    }
  }, [visible]);
  const view =
    !expectedBrowserId || state.view?.browserId === expectedBrowserId ? state.view : undefined;
  const shown = frozen ?? view;
  const frame = shown?.frame;
  useEffect(() => {
    // Capture admission can settle without a new view; that settlement rechecks freezing.
    void captureRevision;
    if (!annotationOnly || !visible || annotationStarted.current === identity) return;
    if (frozen) {
      annotationStarted.current = identity;
      return;
    }
    if (
      state.scopeKey === identity &&
      state.fresh &&
      view &&
      ['agent', 'human'].includes(view.state)
    ) {
      if (annotationCapture.current?.identity !== identity) {
        const request = { identity, seq: view.frame?.seq, pending: true };
        annotationCapture.current = request;
        void observer.current
          ?.invoke('capture', { browserId: view.browserId, generation: view.generation })
          .then((accepted) => {
            if (annotationCapture.current !== request) return;
            request.pending = accepted;
            if (!accepted) request.seq = undefined;
            setCaptureRevision((revision) => revision + 1);
          });
        return;
      }
      if (annotationCapture.current.pending && annotationCapture.current.seq === view.frame?.seq)
        return;
    }
    if (state.scopeKey === identity && state.fresh && view?.frame && decoded === view.frame.data) {
      annotationStarted.current = identity;
      setFrozenState({ identity, view: structuredClone(view) });
    }
  }, [
    annotationOnly,
    visible,
    identity,
    frozen,
    state.scopeKey,
    state.fresh,
    view,
    decoded,
    captureRevision,
  ]);
  const noteTarget = frozen?.annotations.find((item) => item.ref === noteRef);
  const highlighted = shown?.annotations.find((item) => item.ref === (noteRef || hoverRef));
  useEffect(() => {
    if (!frozen || !visible) return;
    const exitSelection = (event: KeyboardEvent) => {
      if (current.current.visible && event.key === 'Escape') {
        setFrozenState(undefined);
        setNoteRef('');
        setHoverRef('');
        setNote('');
      }
    };
    document.addEventListener('keydown', exitSelection);
    return () => document.removeEventListener('keydown', exitSelection);
  }, [frozen, visible]);
  useEffect(() => {
    if (noteRef && (!externalTools || annotationToolsOpen)) noteEditor.current?.focus();
  }, [noteRef, externalTools, annotationToolsOpen]);
  const actionable = !!view && state.fresh && canInvoke && !state.pending;
  const human = actionable && view.state === 'human';
  const addressKey = JSON.stringify([identity, view?.browserId, view?.generation]);
  const address =
    addressDraft?.key === addressKey && (editingAddress || addressDraft.baseUrl === view?.url)
      ? addressDraft.value
      : (view?.url ?? '');
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
    if (annotationOnly) return;
    if (!view || !actionable) return;
    setMessage('');
    void observer.current?.invoke(action, {
      browserId: view.browserId,
      generation: view.generation,
      ...input,
    });
  };
  const pointerControl = (
    <Button
      className="agent-browser-pointer"
      title={frozen ? '退出指向 · Esc' : '指向元素'}
      aria-label={frozen ? '⌖ 退出指向 · Esc' : '⌖ 指向元素'}
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
      <span aria-hidden="true">⌖ </span>
      <span className="agent-browser-control-label">{frozen ? '退出指向 · Esc' : '指向元素'}</span>
    </Button>
  );
  const noteForm =
    frozen && frame && noteTarget ? (
      <form
        className={
          externalTools ? 'agent-browser-note agent-browser-note-tools' : 'agent-browser-note'
        }
        style={
          externalTools
            ? undefined
            : {
                left: `clamp(3%, ${(noteTarget.box.x / frame.width) * 100}%, max(3%, calc(100% - 328px)))`,
              }
        }
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
        <Textarea
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
    ) : null;
  const statusContent = (
    <>
      <div
        className={`agent-browser-status${state.view?.frame && !externalTools ? ' sr-only' : ''}`}
        role="status"
      >
        <strong>
          {view
            ? labels[view.state]
            : state.loading
              ? '正在读取浏览器…'
              : state.available
                ? '此会话还没有 Agent 浏览器'
                : '此连接尚未提供 Agent 浏览器'}
        </strong>
        <span title="此页的只读快照；关闭注释不会停止任务。">{view?.title || '受管浏览器'}</span>
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {view?.error && <p role="alert">{agentBrowserErrorMessage(view.error)}</p>}
    </>
  );
  const freshnessNotice = !state.fresh && frame && (
    <p role="status">此画面尚未重新核实，操作与引用暂不可用。</p>
  );
  const operationStatus = (
    <>
      {state.pending && (
        <div role="status">
          正在核实原操作；不会重复提交。
          <Button variant="ghost" onClick={() => observer.current?.checkOriginal()}>
            查询原操作
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className={message.startsWith('已加入注释草稿') ? 'sr-only' : undefined}>
          {message}
        </p>
      )}
    </>
  );
  return (
    <section
      className="agent-browser-panel"
      aria-label={annotationOnly ? '冻结快照注释' : 'Agent 浏览器'}
      ref={host}
    >
      {externalTools &&
        visible &&
        annotationToolbarHost &&
        createPortal(
          <Popover open={annotationToolsOpen && visible} onOpenChange={setAnnotationToolsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="网页注释工具"
                title="网页注释工具"
              >
                <BrowserAnnotationIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              data-slot="popover-content"
              align="end"
              className="agent-browser-annotation-tools"
              onOpenAutoFocus={(event) => {
                if (noteRef) {
                  event.preventDefault();
                  noteEditor.current?.focus();
                }
              }}
              onCloseAutoFocus={(event) => {
                if (!current.current.visible) event.preventDefault();
              }}
              onEscapeKeyDown={() => {
                if (!current.current.visible) return;
                setFrozen(undefined);
                setNoteRef('');
                setHoverRef('');
                setNote('');
              }}
            >
              {statusContent}
              {view && pointerControl}
              {frozen && (
                <p className="agent-browser-help">
                  冻结快照 · Agent 继续运行 · 只选取已有元素 · Esc 退出
                  {view?.seq !== frozen.seq ? ' · 页面已有更新，此处保留当时画面' : ''}
                </p>
              )}
              {noteForm}
              {freshnessNotice}
              {operationStatus}
            </PopoverContent>
          </Popover>,
          annotationToolbarHost,
        )}
      {!externalTools && statusContent}
      {view && (
        <>
          {!externalTools && (
            <div className="agent-browser-toolbar">
              {pointerControl}
              {!annotationOnly && (
                <>
                  {view.state === 'agent' && (
                    <Button
                      className="agent-browser-control"
                      data-control="handoff"
                      aria-label="暂停并接管"
                      title="暂停并接管"
                      variant="ghost"
                      disabled={!actionable}
                      onClick={() => invoke('handoff')}
                    >
                      <span className="agent-browser-control-label">暂停并接管</span>
                    </Button>
                  )}
                  {view.state === 'human' && (
                    <Button
                      className="agent-browser-control"
                      data-control="resume"
                      aria-label="交还 Agent"
                      title="交还 Agent"
                      variant="ghost"
                      disabled={!actionable}
                      onClick={() => invoke('resume')}
                    >
                      <span className="agent-browser-control-label">交还 Agent</span>
                    </Button>
                  )}
                  <form
                    className="agent-browser-location"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (composingAddress.current || !human || frozen) return;
                      try {
                        const destination = new URL(address.trim());
                        if (
                          !['http:', 'https:'].includes(destination.protocol) ||
                          destination.username ||
                          destination.password
                        )
                          throw Error('invalid_url');
                        invoke('input', { command: { action: 'navigate', url: destination.href } });
                      } catch {
                        setMessage('请输入不含账户信息的完整 HTTP 或 HTTPS 网址。');
                      }
                    }}
                  >
                    <Input
                      aria-label="打开网址"
                      aria-describedby={!human ? 'agent-browser-address-help' : undefined}
                      title={view.url}
                      maxLength={8192}
                      placeholder="https://…"
                      value={address}
                      onChange={(event) =>
                        setAddressDraft({
                          key: addressKey,
                          value: event.currentTarget.value,
                          baseUrl: view.url,
                        })
                      }
                      onFocus={() => setEditingAddress(true)}
                      onBlur={() => setEditingAddress(false)}
                      onCompositionStart={() => {
                        composingAddress.current = true;
                      }}
                      onCompositionEnd={() => {
                        composingAddress.current = false;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setAddressDraft(undefined);
                          event.currentTarget.blur();
                        }
                        if (
                          event.key === 'Enter' &&
                          (event.nativeEvent.isComposing ||
                            composingAddress.current ||
                            event.keyCode === 229)
                        )
                          event.preventDefault();
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="submit"
                      aria-label="前往"
                      title={
                        frozen
                          ? '先退出指向'
                          : state.pending
                            ? '正在核实原操作'
                            : human
                              ? '前往'
                              : '请先暂停并接管'
                      }
                      disabled={!human || !!frozen || !address.trim()}
                    >
                      ↵
                    </Button>
                  </form>
                  <Popover open={moreOpen && visible} onOpenChange={setMoreOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="更多浏览器操作"
                        title="更多浏览器操作"
                      >
                        ⋯
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="agent-browser-more">
                      <p className="agent-browser-help">{labels[view.state]}</p>
                      {view.state === 'human' && (
                        <>
                          <p className="agent-browser-help">
                            点击编号区域只选取引用。网页操作需要使用下方明确按钮。
                          </p>
                          <label htmlFor={elementSelectId}>
                            页面元素
                            <SelectField
                              id={elementSelectId}
                              aria-label="页面元素"
                              disabled={!human}
                              value={selected?.ref ?? ''}
                              onValueChange={(value) =>
                                invoke('select', {
                                  seq: view.seq,
                                  ref: value || null,
                                })
                              }
                              options={[
                                { value: '', label: '选择一个元素' },
                                ...view.annotations.map((item) => ({
                                  value: item.ref,
                                  label: `${item.number}. ${item.name || item.role} (${item.ref})`,
                                })),
                              ]}
                            />
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
                              <label htmlFor={fillInputId}>
                                填入内容
                                <Input
                                  id={fillInputId}
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
                                    command: {
                                      action: 'fill',
                                      ref: selected.ref,
                                      seq: view.seq,
                                      value: text,
                                    },
                                  })
                                }
                              >
                                填入所选元素
                              </Button>
                            </div>
                          )}
                          <div className="agent-browser-toolbar">
                            <Button
                              variant="outline"
                              disabled={!human}
                              onClick={() =>
                                invoke('input', {
                                  command: { action: 'scroll', direction: 'up', amount: 500 },
                                })
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
                    </PopoverContent>
                  </Popover>
                </>
              )}
            </div>
          )}
          {!human && editingAddress && (
            <p id="agent-browser-address-help" className="sr-only">
              先选择“暂停并接管”，等到“由你控制”后再前往。
            </p>
          )}
          {frame && shown ? (
            <div className="agent-browser-viewport">
              <div className="agent-browser-canvas">
                <button
                  type="button"
                  className={`agent-browser-frame${frozen ? ' is-pointing' : ''}`}
                  style={{ maxWidth: `calc((100dvh - 108px) * ${frame.width / frame.height})` }}
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
                      if (externalTools) setAnnotationToolsOpen(true);
                    } else if (!annotationOnly)
                      invoke('select', { seq: view.seq, ref: target.ref });
                  }}
                >
                  <img
                    src={`data:image/jpeg;base64,${frame.data}`}
                    alt={frozen ? '用于注释的冻结网页快照' : '网页实时画面'}
                    draggable={false}
                    onLoad={(event) => {
                      const data = event.currentTarget.src.slice(23);
                      setDecoded(data);
                    }}
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
                {!externalTools && frozen && (
                  <p className="agent-browser-help agent-browser-frozen-hint">
                    冻结快照 · Agent 继续运行 · 只选取已有元素 · Esc 退出
                    {view.seq !== frozen.seq ? ' · 页面已有更新，此处保留当时画面' : ''}
                  </p>
                )}
                {!externalTools && noteForm}
              </div>
            </div>
          ) : !externalTools ? (
            <p className="agent-browser-empty">尚无可用画面。</p>
          ) : null}
          {!externalTools && freshnessNotice}
        </>
      )}
      {!externalTools && operationStatus}
    </section>
  );
}
