import { Select, SelectContent, SelectItem, SelectTrigger } from '@kite-ai/ui/desktop/select';
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installNativeInputModality } from './native-input-modality';
import type { PreviewMenuOverlayBridge, PreviewMenuState } from './native-preview-menu-bridge';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import './native-global-dialog.css';

function Menu({
  bridge,
  state,
}: {
  bridge: PreviewMenuOverlayBridge;
  state: NonNullable<PreviewMenuState>;
}) {
  const finished = useRef(false);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);
  useLayoutEffect(() => {
    if (content) bridge.shown(state.id);
  }, [bridge, content, state.id]);
  const finish = (value: string | null) => {
    if (finished.current) return;
    finished.current = true;
    bridge.finish(state.id, value);
  };
  return (
    <div className="kite-client">
      <Select
        open
        value={state.value}
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
        onValueChange={finish}
      >
        <SelectTrigger
          aria-label={state.label}
          tabIndex={-1}
          className="pointer-events-none fixed opacity-0"
          style={{
            left: state.anchor.x,
            top: state.anchor.y,
            width: state.anchor.width,
            height: state.anchor.height,
          }}
        />
        <SelectContent ref={setContent} align="start" aria-label={state.label}>
          {state.options.map(({ value, label, disabled }) => (
            <SelectItem key={value} value={value} disabled={disabled}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PreviewMenu({ bridge }: { bridge: PreviewMenuOverlayBridge }) {
  const [state, setState] = useState<PreviewMenuState>(null);
  useLayoutEffect(() => {
    const unwatch = bridge.watch(setState);
    bridge.ready();
    return unwatch;
  }, [bridge]);
  return state ? <Menu key={state.id} bridge={bridge} state={state} /> : null;
}

const bridge = window.kitePreviewMenuOverlay;
installNativeInputModality(document);
if (bridge) createRoot(document.getElementById('root')!).render(<PreviewMenu bridge={bridge} />);
