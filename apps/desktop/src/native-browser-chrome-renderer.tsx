import { SessionTabsChrome } from '@kite-ai/ui/desktop';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  isNativeBrowserChromeEnvelope,
  type NativeBrowserChromeAction,
  type NativeBrowserChromeBridge,
  type NativeBrowserChromeEnvelope,
  type NativeBrowserChromeResult,
} from './native-browser-chrome-bridge';
import {
  NativeBrowserChromeControl,
  NativeBrowserChromeToolbar,
} from './native-browser-chrome-presentation';
import type { NativeBrowserToolbarAction } from './native-browser-chrome-types';
import { applyTheme } from './native-theme';

function ownerKey(value: NativeBrowserChromeEnvelope) {
  const { storeId, sessionId, generation, viewSelection } = value.snapshot.scope;
  return JSON.stringify([
    storeId,
    sessionId,
    generation,
    viewSelection,
    value.snapshot.tabs.scopeKey,
    value.snapshot.toolbar.id,
  ]);
}
function bindingKey(value: NativeBrowserChromeEnvelope) {
  return JSON.stringify([ownerKey(value), value.attachment, value.pageToken]);
}
function actionable(value: NativeBrowserChromeEnvelope) {
  return (
    value.hosted &&
    value.actionable &&
    value.snapshot.hosted &&
    value.snapshot.interactive &&
    !value.snapshot.covered &&
    value.snapshot.tabs.visible &&
    value.snapshot.tabs.present
  );
}
type Send = (
  binding: string,
  action: NativeBrowserChromeAction,
) => Promise<NativeBrowserChromeResult>;
interface Edit {
  binding: string;
  value: string;
  delivery: number;
  forwarded: boolean;
  echoed: boolean;
}

function Chrome({
  envelope,
  delivery,
  send,
}: {
  envelope: NativeBrowserChromeEnvelope;
  delivery: number;
  send: Send;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(envelope);
  const binding = useRef(bindingKey(envelope));
  const mounted = useRef(true);
  const editing = useRef(false);
  const composing = useRef(false);
  const draft = useRef(envelope.snapshot.toolbar.address);
  const [address, setAddress] = useState(draft.current);
  const edit = useRef<Edit | undefined>(undefined);
  const submitting = useRef<'waiting' | 'sent' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const uncertain = useRef(false);
  const [issue, setIssue] = useState('');
  const echoWait = useRef(false);
  const setDraft = (value: string) => {
    draft.current = value;
    setAddress(value);
  };
  const cancelSubmission = () => {
    submitting.current = undefined;
    echoWait.current = false;
    setBusy(false);
  };
  useLayoutEffect(() => {
    live.current = envelope;
    const next = bindingKey(envelope);
    if (binding.current !== next) {
      binding.current = next;
      edit.current = undefined;
      uncertain.current = false;
      cancelSubmission();
      setIssue('');
    }
    const current = edit.current;
    if (
      current &&
      current.binding === next &&
      delivery > current.delivery &&
      envelope.snapshot.toolbar.address === current.value
    )
      current.echoed = true;
    if (current?.forwarded && current.echoed && !editing.current && !submitting.current)
      edit.current = undefined;
    if (!editing.current && !composing.current && !submitting.current && !edit.current)
      setDraft(envelope.snapshot.toolbar.address);
    if (!envelope.snapshot.toolbar.canNavigate || !actionable(envelope)) cancelSubmission();
    tryNavigate();
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function emit(action: NativeBrowserChromeAction, relevant = () => true) {
    const original = binding.current;
    if (uncertain.current && action.part !== 'focus-root' && action.part !== 'escape')
      return 'unconfirmed' as const;
    if (!uncertain.current) setIssue('');
    const result = await send(original, action);
    if (!mounted.current || binding.current !== original) return 'stale' as const;
    if (result === 'unconfirmed') {
      uncertain.current = true;
      cancelSubmission();
      setIssue('操作结果未确认，请返回主界面核对；不会自动重发。');
    } else if (result === 'stale' && relevant()) {
      cancelSubmission();
      setIssue('页面状态已变化，原操作未发送。');
    }
    return result;
  }
  function changeAddress(value: string, restoring = false) {
    setDraft(value);
    const admitted =
      actionable(live.current) && !uncertain.current && live.current.snapshot.toolbar.canNavigate;
    if (!restoring && !editing.current) {
      editing.current = true;
      if (admitted)
        void emit({ part: 'toolbar', action: { type: 'address-focus', focused: true } });
    }
    if (!admitted) return;
    const pending: Edit = {
      binding: binding.current,
      value,
      delivery,
      forwarded: false,
      echoed: false,
    };
    edit.current = pending;
    void emit(
      { part: 'toolbar', action: { type: 'address-change', value } },
      () => edit.current === pending,
    ).then((result) => {
      if (
        result !== 'forwarded' ||
        !mounted.current ||
        edit.current !== pending ||
        binding.current !== pending.binding
      )
        return;
      pending.forwarded = true;
      tryNavigate();
    });
  }
  function tryNavigate() {
    if (
      submitting.current !== 'waiting' ||
      composing.current ||
      uncertain.current ||
      !actionable(live.current) ||
      !live.current.snapshot.toolbar.canNavigate
    )
      return;
    const pending = edit.current;
    if (
      pending &&
      (!pending.forwarded ||
        !pending.echoed ||
        pending.value !== draft.current ||
        pending.binding !== binding.current)
    )
      return;
    if (live.current.snapshot.toolbar.address !== draft.current) return;
    submitting.current = 'sent';
    echoWait.current = false;
    const original = binding.current;
    void emit({ part: 'toolbar', action: { type: 'navigate' } }).then(() => {
      if (mounted.current && binding.current === original) cancelSubmission();
    });
  }
  function toolbarAction(action: NativeBrowserToolbarAction) {
    if (action.type === 'address-change') {
      changeAddress(action.value);
      return;
    }
    if (action.type === 'address-focus') {
      editing.current = action.focused;
      if (!action.focused) {
        edit.current = undefined;
        cancelSubmission();
      }
      if (actionable(live.current) && !uncertain.current) void emit({ part: 'toolbar', action });
      return;
    }
    if (!actionable(live.current) || uncertain.current) return;
    if (
      ['navigate', 'back', 'forward', 'reload'].includes(action.type) &&
      !live.current.snapshot.toolbar.canNavigate
    )
      return;
    if (action.type === 'navigate') {
      if (composing.current || submitting.current || !live.current.snapshot.toolbar.canNavigate)
        return;
      submitting.current = 'waiting';
      setBusy(true);
      echoWait.current = true;
      setIssue('');
      if (
        !edit.current ||
        edit.current.value !== draft.current ||
        edit.current.binding !== binding.current
      ) {
        if (live.current.snapshot.toolbar.address !== draft.current) changeAddress(draft.current);
      }
      tryNavigate();
      return;
    }
    cancelSubmission();
    void emit({ part: 'toolbar', action });
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (editing.current || submitting.current) {
        cancelSubmission();
        edit.current = undefined;
        const original = live.current.snapshot.toolbar.readonlyURL;
        setDraft(original);
        editing.current = false;
        if (actionable(live.current) && !uncertain.current) {
          changeAddress(original, true);
          void emit({ part: 'toolbar', action: { type: 'address-focus', focused: false } });
        }
      } else void emit({ part: 'escape' });
      return;
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const controls = [
      ...(host.current?.querySelectorAll<HTMLElement>('button, input, [tabindex]') ?? []),
    ].filter(
      (node) =>
        node.tabIndex >= 0 &&
        !node.matches(':disabled') &&
        !node.closest('[hidden], [inert]') &&
        getComputedStyle(node).display !== 'none' &&
        getComputedStyle(node).visibility !== 'hidden',
    );
    if (
      (event.shiftKey && document.activeElement === controls[0]) ||
      (!event.shiftKey && document.activeElement === controls.at(-1))
    ) {
      event.preventDefault();
      void emit({ part: 'focus-root' });
    }
  }
  const canAct = actionable(envelope) && !uncertain.current;
  // Preserve an in-progress editor/IME across a geometry attachment handshake.
  // Local echo grants no action: every dispatch is separately admitted above.
  const localEditing =
    (editing.current || composing.current) &&
    envelope.snapshot.toolbar.canNavigate &&
    !envelope.snapshot.covered &&
    !uncertain.current;
  const toolbar = {
    ...envelope.snapshot.toolbar,
    address: envelope.snapshot.toolbar.canNavigate
      ? address
      : envelope.snapshot.toolbar.readonlyURL,
    canNavigate: !busy && (canAct || localEditing) && envelope.snapshot.toolbar.canNavigate,
    canGoBack: canAct && envelope.snapshot.toolbar.canGoBack,
    canGoForward: canAct && envelope.snapshot.toolbar.canGoForward,
    hasPage: canAct && envelope.snapshot.toolbar.hasPage,
  };
  return (
    <div
      className="kite-client"
      ref={host}
      onKeyDownCapture={keyboard}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
        if (editing.current) changeAddress(draft.current);
      }}
    >
      <section className="session-tabs" aria-label="浏览器界面" aria-busy={!canAct || busy}>
        <SessionTabsChrome
          data={envelope.snapshot.tabs}
          dispatch={(action) => {
            if (!canAct) return;
            cancelSubmission();
            void emit({ part: 'tabs', action }).then((result) => {
              if (
                result === 'forwarded' &&
                (action.type === 'collapse' ||
                  (action.type === 'close' && envelope.snapshot.tabs.tabs.length === 1))
              )
                void emit({ part: 'focus-root' });
            });
          }}
        />
        <NativeBrowserChromeToolbar
          data={toolbar}
          dispatch={toolbarAction}
          tools={
            <>
              {(issue || (busy && echoWait.current)) && (
                <span
                  role="status"
                  title={issue || '正在核对地址，确认后仅发送一次前往操作。'}
                  className="hint"
                >
                  {issue ? (uncertain.current ? '操作未确认' : '页面已变化') : '正在核对地址'}
                </span>
              )}
              {envelope.snapshot.control && (
                <NativeBrowserChromeControl
                  data={envelope.snapshot.control}
                  dispatch={(action) => {
                    if (canAct) void emit({ part: 'control', action });
                  }}
                />
              )}
            </>
          }
        />
      </section>
    </div>
  );
}

/** Sidecar display only. The restricted bridge cannot read or execute Root business state. */
export function NativeBrowserChromeRenderer({
  bridge = window.kiteBrowserChrome,
}: {
  bridge?: NativeBrowserChromeBridge;
} = {}) {
  const [state, setState] = useState<{ envelope: NativeBrowserChromeEnvelope; delivery: number }>();
  const [unavailable, setUnavailable] = useState(false);
  const current = useRef<NativeBrowserChromeEnvelope | null>(null);
  const sequence = useRef({ attachment: '', value: 0 });
  useEffect(() => {
    if (!bridge) {
      setUnavailable(true);
      return;
    }
    let disposed = false,
      delivery = 0,
      watched = 0;
    const receive = (value: NativeBrowserChromeEnvelope | null) => {
      if (disposed) return;
      if (!isNativeBrowserChromeEnvelope(value)) {
        current.current = null;
        setState(undefined);
        return;
      }
      if (
        current.current &&
        bindingKey(current.current) === bindingKey(value) &&
        current.current.snapshot.revision > value.snapshot.revision
      )
        return;
      current.current = value;
      setUnavailable(false);
      setState({ envelope: value, delivery: ++delivery });
    };
    const unwatch = bridge.watch((value) => {
      watched++;
      receive(value);
    });
    void bridge.read().then(
      (value) => {
        if (watched === 0) receive(value);
      },
      () => {
        if (!disposed && watched === 0) setUnavailable(true);
      },
    );
    return () => {
      disposed = true;
      current.current = null;
      unwatch();
    };
  }, [bridge]);
  useLayoutEffect(() => {
    if (!state) return;
    applyTheme(state.envelope.snapshot.theme);
    document.documentElement.dataset.windowMaterial = state.envelope.snapshot.material ?? 'none';
  }, [state]);
  const send = useCallback<Send>(
    async (binding, action) => {
      const value = current.current;
      if (
        !bridge ||
        !value ||
        bindingKey(value) !== binding ||
        (action.part !== 'escape' && action.part !== 'focus-root' && !actionable(value))
      )
        return 'stale';
      // Main attachments are unique. Retired bindings cannot send again, so
      // retain only the current counter rather than every resize attachment.
      if (sequence.current.attachment !== value.attachment)
        sequence.current = { attachment: value.attachment, value: 0 };
      const nextSequence = sequence.current.value + 1;
      if (!Number.isSafeInteger(nextSequence)) return 'unconfirmed';
      sequence.current.value = nextSequence;
      try {
        return await bridge.send({
          ...action,
          attachment: value.attachment,
          pageToken: value.pageToken,
          sequence: nextSequence,
          revision: value.snapshot.revision,
        });
      } catch {
        return 'unconfirmed';
      }
    },
    [bridge],
  );
  if (!state) return unavailable ? <p role="status">浏览器界面尚未核实，请返回主界面。</p> : null;
  return <Chrome key={ownerKey(state.envelope)} {...state} send={send} />;
}
