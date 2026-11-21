import { useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installNativeInputModality } from './native-input-modality';
import type { NativeSettingsOverlayBridge, NativeSettingsState } from './native-settings-bridge';
import { NativeSettingsWorkspace } from './native-settings-workspace';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import './native-global-dialog.css';

function Settings({
  port,
  state,
}: {
  port: NativeSettingsOverlayBridge;
  state: NativeSettingsState;
}) {
  const { instanceId, theme } = state;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const bridge = useMemo(
    () => ({
      request: (request: import('./native-bridge').NativeRequest) =>
        port.request(instanceId, request),
    }),
    [port, instanceId],
  );
  return (
    <NativeSettingsWorkspace
      bridge={bridge}
      state={state}
      retentionKey={port}
      onClose={() => port.action(instanceId, { type: 'close' })}
      onEditorChange={(editor) => port.action(instanceId, { type: 'editor', editor })}
      onThemeChange={(theme) => port.action(instanceId, { type: 'theme', theme })}
      onSaved={() => port.action(instanceId, { type: 'saved' })}
    />
  );
}

function NativeSettings({ port }: { port: NativeSettingsOverlayBridge }) {
  const [state, setState] = useState<NativeSettingsState | null>(null);
  useLayoutEffect(() => {
    const unwatch = port.watch(setState);
    port.ready();
    return unwatch;
  }, [port]);
  return state ? <Settings key={state.instanceId} port={port} state={state} /> : null;
}

const port = window.kiteSettingsOverlay;
if (/Macintosh|Mac OS X/i.test(navigator.userAgent))
  document.documentElement.dataset.settingsMacos = '';
installNativeInputModality(document);
if (port) createRoot(document.getElementById('root')!).render(<NativeSettings port={port} />);
