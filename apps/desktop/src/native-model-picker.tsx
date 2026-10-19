import { ModelEffortSelector } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeReasoningEffort,
  NativeSelection,
} from './native-bridge';
import { useNativeDiagnostics } from './native-diagnostics';
import { NativeDisplayCache } from './native-display-cache';

export type NativeModelChoice = { modelId?: string; reasoningEffort?: NativeReasoningEffort };
function errorCode(cause: unknown) {
  const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
  return /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'model_selection_unavailable';
}
/** Display identity is independent of the new read selection. */
export function nativeModelScope(
  generation: number,
  selection?: NativeSelection,
  preparing?: { storeId: string },
  revision?: string,
) {
  const storeId = preparing?.storeId ?? selection?.storeId;
  const identity = preparing
    ? `${generation}/${preparing.storeId}/new-conversation`
    : `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  return {
    storeId,
    boundary: JSON.stringify([generation, storeId, revision]),
    displayKey: JSON.stringify([
      preparing ? 'preparing' : 'session',
      selection?.session.id,
      selection?.session.workspaceId,
    ]),
    readKey: JSON.stringify([identity, revision]),
  };
}

/** One bounded presentation owner shared by navigation and its visible picker. */
export class NativeModelSnapshots {
  private boundary?: string;
  private entries = new NativeDisplayCache<NativeModelSettingsFacts>();
  get(scope: ReturnType<typeof nativeModelScope>) {
    return this.boundary === scope.boundary ? this.entries.get(scope.displayKey) : undefined;
  }
  observe(scope: ReturnType<typeof nativeModelScope>) {
    if (this.boundary !== scope.boundary) {
      this.entries.clear();
      this.boundary = scope.boundary;
    }
  }
  set(scope: ReturnType<typeof nativeModelScope>, facts: NativeModelSettingsFacts) {
    this.observe(scope);
    this.entries.set(scope.displayKey, facts);
  }
}
export type NativePreparedModels = {
  key: string;
  facts?: NativeModelSettingsFacts;
  error: string;
};

/** Settle model display before a cold page is published; errors remain local to the picker. */
export async function prepareNativeModels(
  bridge: NativeBridge,
  generation: number,
  selection?: NativeSelection,
  preparing?: { storeId: string },
  revision?: string,
): Promise<NativePreparedModels> {
  const scope = nativeModelScope(generation, selection, preparing, revision);
  try {
    const response = await bridge.request({
      method: preparing ? 'conversation.models.read' : 'input.models.read',
      generation,
    });
    if (
      !response ||
      !('models' in response) ||
      !('kind' in response) ||
      response.kind !== 'settings.models'
    )
      throw Error('model_selection_unavailable');
    if (scope.storeId !== undefined && response.storeId !== scope.storeId)
      throw Error('store_identity_mismatch');
    return { key: scope.readKey, facts: response, error: '' };
  } catch (cause) {
    return { key: scope.readKey, error: errorCode(cause) ?? 'model_selection_unavailable' };
  }
}

export function NativeModelPicker({
  bridge,
  generation,
  selection,
  preparing,
  revision,
  value,
  onChange,
  onReady,
  disabled = false,
  snapshots: sharedSnapshots,
  prepared,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  preparing?: { storeId: string };
  revision?: string;
  value: NativeModelChoice;
  onChange: (value: NativeModelChoice) => void;
  onReady: (ready: boolean, choice?: NativeModelChoice) => void;
  disabled?: boolean;
  snapshots?: NativeModelSnapshots;
  prepared?: NativePreparedModels;
}) {
  const diagnostics = useNativeDiagnostics();
  const localSnapshots = useRef(new NativeModelSnapshots());
  const snapshots = sharedSnapshots ?? localSnapshots.current;
  const scope = nativeModelScope(generation, selection, preparing, revision);
  snapshots.observe(scope);
  const readKey = scope.readKey;
  const [state, setState] = useState<{
    key: string;
    facts?: NativeModelSettingsFacts;
    reading: boolean;
    error: string;
  }>();
  const preparedState =
    prepared?.key === readKey && (!prepared.facts || prepared.facts.storeId === scope.storeId)
      ? { ...prepared, reading: false }
      : undefined;
  const currentState = preparedState ?? (state?.key === readKey ? state : undefined);
  const facts = currentState ? currentState.facts : snapshots.get(scope);
  const reading = !currentState || currentState.reading;
  const error = currentState?.error ?? '';
  const current = useRef(readKey);
  current.current = readKey;
  const sequence = useRef(0),
    readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const models = facts?.models.filter((model) => model.enabled && model.configured) ?? [];
  const requestedId = value.modelId ?? facts?.selectedModelId;
  const selectedId = requestedId ?? facts?.defaultModelId;
  const selected = models.find((model) => model.id === selectedId);
  const supported = selected?.reasoningEffortChoices ?? [];
  const effort = value.reasoningEffort ?? selected?.reasoningEffort;
  const allowedEffort =
    value.reasoningEffort === undefined || supported.includes(value.reasoningEffort);
  const ready = !!selected && allowedEffort && !reading && !error && !disabled;
  const readyId = ready ? selected?.id : undefined;
  useEffect(() => {
    if (current.current !== readKey) return;
    readyCallback.current(
      ready,
      readyId
        ? {
            modelId: readyId,
            ...(value.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: value.reasoningEffort }),
          }
        : undefined,
    );
  }, [readKey, ready, readyId, value.reasoningEffort]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reads follow exact scope and settings revision; callbacks and temporary effort do not restart IO.
  useEffect(() => {
    const original = readKey,
      request = ++sequence.current;
    if (preparedState) {
      if (preparedState.facts) snapshots.set(scope, preparedState.facts);
      return;
    }
    const retained = snapshots.get(scope);
    setState({ key: readKey, facts: retained, error: '', reading: true });
    readyCallback.current(false);
    void prepareNativeModels(bridge, generation, selection, preparing, revision).then((result) => {
      if (current.current !== original || sequence.current !== request) return;
      if (result.facts) snapshots.set(scope, result.facts);
      setState({
        key: readKey,
        facts: result.facts ?? retained,
        error: result.error,
        reading: false,
      });
    });
    return () => {
      sequence.current++;
    };
  }, [readKey, bridge, prepared]);
  function choose(modelId: string) {
    if (!reading && !error && !disabled && models.some((model) => model.id === modelId))
      onChange({ modelId });
  }
  function setEffort(reasoningEffort: NativeReasoningEffort) {
    if (!ready || !selected || !supported.includes(reasoningEffort)) return;
    onChange({
      ...value,
      ...(value.modelId === undefined ? { modelId: selected.id } : {}),
      reasoningEffort,
    });
  }
  return (
    <section
      data-model-picker
      aria-label="下一轮模型选择"
      aria-busy={reading || disabled || undefined}
    >
      <ModelEffortSelector
        model={
          selected
            ? {
                id: selected.id,
                provider: selected.provider ?? '其他',
                name: selected.model ?? selected.id,
              }
            : undefined
        }
        models={models.map((model) => ({
          id: model.id,
          provider: model.provider ?? '其他',
          name: model.model ?? model.id,
          reasoningEffort: model.reasoningEffort ?? undefined,
          reasoningEffortChoices: model.reasoningEffortChoices ?? [],
        }))}
        disabled={reading || disabled}
        reasoningEffort={effort ?? undefined}
        onModelChange={(_provider, _name, id) => {
          if (id !== undefined) choose(id);
        }}
        onReasoningEffortChange={(effort) => setEffort(effort)}
      />
      {reading && diagnostics && <p role="status">正在读取可选模型。</p>}
      {error && <p role="alert">模型目录不可用：{error}</p>}
      {!reading && !error && !selected && (requestedId || diagnostics) && (
        <p role="alert">
          {requestedId
            ? `所选模型 ${requestedId} 当前不可用，请重新选择。`
            : '没有已启用且配置可用的默认模型，请选择模型。'}
        </p>
      )}
      {selected && !allowedEffort && <p role="alert">原临时思考档位当前不可用，请重新选择。</p>}
    </section>
  );
}
