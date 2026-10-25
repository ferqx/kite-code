import { type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsSubmission,
  NativeProviderSubmission,
  NativeSelection,
} from './native-bridge';
import { useNativeModelSettings } from './native-model-settings';
import {
  NativeProviderSettings,
  type NativeProviderSettingsActivity,
} from './native-provider-settings';

export function NativeProviderModelSettings({
  bridge,
  generation,
  selection,
  storeId = selection?.storeId,
  providerSubmissions,
  modelSubmissions,
  onSaved,
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  storeId?: string;
  providerSubmissions: readonly NativeProviderSubmission[];
  modelSubmissions: readonly NativeModelSettingsSubmission[];
  onSaved?: () => void;
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const providerReader = useRef<(() => Promise<boolean>) | null>(null);
  const [activity, setActivity] = useState<NativeProviderSettingsActivity>({
    busy: false,
    writing: false,
    pending: false,
  });
  const providerPending = providerSubmissions.some(
    (submission) =>
      (!storeId || submission.storeId === storeId) &&
      ['submitting', 'unknown'].includes(submission.phase),
  );
  const modelPending = modelSubmissions.some(
    (submission) =>
      (!storeId || submission.storeId === storeId) &&
      ['submitting', 'unknown'].includes(submission.phase),
  );
  const pending =
    activity.storeId && activity.storeId === storeId ? activity.pending : providerPending;
  const blocked = useRef(pending || modelPending);
  const scope = `${generation}/${storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const acquireWrite = useMemo(() => {
    let held = false;
    return () => {
      if (held || blocked.current || currentScope.current !== scope) return undefined;
      held = true;
      return () => {
        held = false;
      };
    };
  }, [scope]);
  const onActivityChange = useCallback((next: NativeProviderSettingsActivity) => {
    setActivity((previous) =>
      previous.busy === next.busy &&
      previous.writing === next.writing &&
      previous.pending === next.pending &&
      previous.storeId === next.storeId
        ? previous
        : next,
    );
  }, []);
  const models = useNativeModelSettings({
    bridge,
    generation,
    selection,
    submissions: modelSubmissions,
    blocked: pending || activity.writing,
    hardBlocked: pending,
    acquireWrite,
    onRecovered: () => {
      if (currentScope.current === scope) void providerReader.current?.();
    },
    onSaved: async () => {
      onSaved?.();
      if (currentScope.current !== scope) return;
      const reader = providerReader.current;
      if (!reader) return;
      await reader();
    },
  });
  blocked.current = pending || models.pending || (!models.facts && modelPending);
  return (
    <NativeProviderSettings
      bridge={bridge}
      generation={generation}
      selection={selection}
      submissions={providerSubmissions}
      refreshControl={providerReader}
      panelHost={panelHost}
      editorControl={editorControl}
      models={models}
      onActivityChange={onActivityChange}
      acquireWrite={acquireWrite}
      onRecovered={() => void models.refresh()}
      onSaved={() => {
        void models.refresh();
        onSaved?.();
      }}
    />
  );
}
