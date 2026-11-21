import { useLayoutEffect, useRef, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import type { NativeBridge, NativeRequest, NativeResult } from './native-bridge';
import {
  isNativeSettingsRequest,
  type NativeSettingsBridge,
  type NativeSettingsState,
} from './native-settings-bridge';
import type { ThemePreference } from './native-theme';

type Release = {
  method: 'settings.skills.close' | 'settings.skills.document.close';
  generation: number;
  readId: string;
};

const recoveryState = (
  result: NativeResult,
  { generation, storeId }: NativeSettingsState,
): NativeResult => {
  if (!result || !('creationSubmissions' in result) || result.generation !== generation)
    throw Error('native_generation_changed');
  const snapshotStore = result.selection?.storeId ?? result.directory?.storeId;
  if (
    !storeId ||
    snapshotStore !== storeId ||
    (result.directory && result.directory.storeId !== storeId)
  )
    throw Error('store_identity_mismatch');
  return {
    generation,
    directory: { storeId, workspaces: [], sessions: [] },
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    providerSettingsSubmissions: result.providerSettingsSubmissions?.filter(
      (row) => row.storeId === storeId,
    ),
    modelSettingsSubmissions: result.modelSettingsSubmissions?.filter(
      (row) => row.storeId === storeId,
    ),
  };
};

/** The ordinary Root bridge remains the only application authority. */
export function NativeSettingsRoot({
  port,
  bridge,
  state: props,
  onClose,
  onEditorChange,
  onThemeChange,
  onSaved,
  onUnavailable,
}: {
  port: NativeSettingsBridge;
  bridge: NativeBridge;
  state: Omit<NativeSettingsState, 'instanceId'>;
  onClose(): void;
  onEditorChange(editor: DesktopEditor): void;
  onThemeChange(theme: ThemePreference): void;
  onSaved(): void;
  onUnavailable(): void;
}) {
  const [instanceId] = useState(() => crypto.randomUUID());
  const opening = useRef(true);
  const lastPresentation = useRef<string | undefined>(undefined);
  const live = useRef({ props, onClose, onEditorChange, onThemeChange, onSaved, onUnavailable });
  useLayoutEffect(() => {
    live.current = { props, onClose, onEditorChange, onThemeChange, onSaved, onUnavailable };
  });
  useLayoutEffect(() => {
    let active = true;
    const reads = new Map<string, Release>();
    const settingsReaders = new Map<string, NativeRequest>();
    const originalFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = (request: NativeRequest) => void bridge.request(request).catch(() => {});
    const unwatch = port.watchActions((action) => {
      if (!active || action.instanceId !== instanceId) return;
      const current = live.current;
      if (action.type === 'request') {
        const request = action.request;
        if (
          !isNativeSettingsRequest(request) ||
          !('generation' in request) ||
          request.generation !== current.props.generation
        ) {
          port.reply(instanceId, action.requestId, {
            ok: false,
            code: 'native_generation_changed',
          });
          return;
        }
        if ('expectedStoreId' in request && request.expectedStoreId !== current.props.storeId) {
          port.reply(instanceId, action.requestId, { ok: false, code: 'store_identity_mismatch' });
          return;
        }
        const g = request.generation;
        if (request.method === 'settings.providers.read')
          settingsReaders.set('providers', { method: 'settings.providers.close', generation: g });
        if (request.method === 'settings.models.read')
          settingsReaders.set('models', { method: 'settings.models.close', generation: g });
        if (request.method === 'settings.userMcp.read')
          settingsReaders.set('mcp', { method: 'settings.userMcp.close', generation: g });
        if (request.method === 'settings.providers.close') settingsReaders.delete('providers');
        if (request.method === 'settings.models.close') settingsReaders.delete('models');
        if (request.method === 'settings.userMcp.close') settingsReaders.delete('mcp');
        let resource: Release | undefined;
        if (request.method === 'settings.skills.open')
          resource = { method: 'settings.skills.close', generation: g, readId: request.readId };
        if (request.method === 'settings.skills.document')
          resource = {
            method: 'settings.skills.document.close',
            generation: g,
            readId: request.readId,
          };
        if (resource) reads.set(resource.readId, resource);
        if (
          request.method === 'settings.skills.close' ||
          request.method === 'settings.skills.document.close'
        )
          reads.delete(request.readId);
        void (async () => {
          try {
            let value = await bridge.request(request);
            if (!active) {
              if (resource) release(resource);
              return;
            }
            const newest = live.current.props;
            if (newest.generation !== g || newest.storeId !== current.props.storeId)
              throw Error('native_generation_changed');
            if (request.method === 'state') value = recoveryState(value, { ...newest, instanceId });
            if (
              request.method === 'settings.userMcp.close' ||
              request.method === 'settings.userMcp.clear'
            )
              value = null;
            port.reply(instanceId, action.requestId, { ok: true, value });
          } catch (error) {
            if (!active) return;
            const code =
              error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
                ? error.message
                : 'native_settings_failed';
            port.reply(instanceId, action.requestId, { ok: false, code });
          }
        })();
      } else if (action.type === 'saved') current.onSaved();
      else if (action.type === 'editor') current.onEditorChange(action.editor);
      else if (action.type === 'theme') current.onThemeChange(action.theme);
      else {
        if (action.type === 'unavailable') current.onUnavailable();
        current.onClose();
      }
    });
    return () => {
      active = false;
      unwatch();
      port.close(instanceId);
      opening.current = true;
      lastPresentation.current = undefined;
      for (const request of settingsReaders.values()) release(request);
      for (const request of reads.values()) release(request);
      requestAnimationFrame(() => {
        if (originalFocus?.isConnected && !originalFocus.closest('[inert]'))
          originalFocus.focus({ preventScroll: true });
      });
    };
  }, [port, bridge, instanceId]);
  useLayoutEffect(() => {
    try {
      const snapshot = JSON.stringify(props);
      if (!opening.current && snapshot === lastPresentation.current) return;
      port.present({ ...props, instanceId }, opening.current);
      lastPresentation.current = snapshot;
      opening.current = false;
    } catch {
      live.current.onUnavailable();
      live.current.onClose();
    }
  }, [port, props, instanceId]);
  return null;
}
