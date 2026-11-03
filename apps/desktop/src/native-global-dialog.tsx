import { ApplicationConfirmationDialog } from '@kite-ai/ui/desktop/confirmation';
import { useLayoutEffect, useRef, useState } from 'react';
import type {
  NativeGlobalDialogBridge,
  NativeGlobalDialogState,
} from './native-global-dialog-bridge';

function CurrentDialog({
  bridge,
  state,
}: {
  bridge: NativeGlobalDialogBridge;
  state: NonNullable<NativeGlobalDialogState>;
}) {
  const active = useRef(false);
  const decided = useRef(false);
  const [presented, setPresented] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
  }, [state.theme, state.language]);
  useLayoutEffect(() => {
    active.current = true;
    const frame = requestAnimationFrame(() => {
      if (!active.current || decided.current) return;
      setPresented(true);
      bridge.presented(state.requestId);
    });
    return () => {
      active.current = false;
      cancelAnimationFrame(frame);
    };
  }, [bridge, state.requestId]);
  const decide = (confirmed: boolean) => {
    if (!active.current || decided.current || (confirmed && !presented)) return;
    decided.current = true;
    bridge.decide(state.requestId, confirmed);
  };
  return (
    <ApplicationConfirmationDialog
      {...(state.kind === 'workspace-removal'
        ? { kind: state.kind, label: state.label }
        : { kind: state.kind, language: state.language })}
      open
      confirmDisabled={!presented}
      onConfirm={() => decide(true)}
      onOpenChange={(open) => {
        if (!open) decide(false);
      }}
      // Main restores the original native surface. Radix must not later focus
      // an old overlay DOM node after a replacement or native withdrawal.
      onCloseAutoFocus={(event) => event.preventDefault()}
    />
  );
}

/** This renderer has only the fixed dialog bridge, never the application bridge. */
export function NativeGlobalDialog({ bridge }: { bridge?: NativeGlobalDialogBridge }) {
  const [saved, setSaved] = useState<{
    bridge: NativeGlobalDialogBridge;
    state: NativeGlobalDialogState;
  }>();
  useLayoutEffect(() => {
    if (!bridge) return;
    let active = true;
    const unwatch = bridge.watch((state) => {
      if (active) setSaved({ bridge, state });
    });
    bridge.ready();
    return () => {
      active = false;
      unwatch();
    };
  }, [bridge]);
  const state = saved && saved.bridge === bridge ? saved.state : null;
  return state && bridge ? (
    <CurrentDialog key={state.requestId} bridge={bridge} state={state} />
  ) : null;
}
