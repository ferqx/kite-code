import { ModelEffortSelector, ReadGate, resolveThinkingEffort } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeReasoningEffort,
  NativeRecommendedModel,
  NativeSelection,
} from './native-bridge';
import { useNativeDiagnostics } from './native-diagnostics';
import { NativeDisplayCache } from './native-display-cache';
import {
  readNativeRecommendedModel,
  rememberNativeRecommendedModel,
} from './native-model-preference';

export type NativeModelChoice = { modelId?: string; reasoningEffort?: NativeReasoningEffort };
/** A cached label only; displaying it never starts a read or qualifies a choice. */
export type NativeModelDisplay = {
  model?: {
    id: string;
    provider: string;
    name: string;
    reasoningEffortChoices?: readonly NativeReasoningEffort[];
  };
  reasoningEffort?: NativeReasoningEffort;
};
export type NativeModelPresentation = { settled: boolean; display?: NativeModelDisplay };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ModelProtocol = 'chat-completions' | 'responses';
function modelProtocol(model: {
  provider?: unknown;
  protocol?: unknown;
}): ModelProtocol | undefined {
  if (model.protocol === undefined)
    return model.provider === 'codex' ? 'responses' : 'chat-completions';
  if (model.protocol !== 'responses' && model.protocol !== 'chat-completions') return;
  if (model.provider === 'codex' && model.protocol !== 'responses') return;
  if (
    (model.provider === 'deepseek' || model.provider === 'ollama') &&
    model.protocol !== 'chat-completions'
  )
    return;
  return model.protocol;
}

/** The Core view keeps its first actual Run even when recent history is bounded. */
function sessionProtocol(selection?: NativeSelection): {
  protocol?: ModelProtocol;
  unavailable: boolean;
} {
  const first = selection?.runs?.[0];
  if (!first) return { unavailable: false };
  if (first.sessionId !== selection?.session.id) return { unavailable: true };
  const manifest = object(first.configuration);
  let snapshot = object(manifest?.snapshot);
  if (snapshot?.kind === 'human_input_processing')
    snapshot = object(snapshot.originalConfiguration);
  const models = object(snapshot?.configuration)?.models;
  if (
    typeof manifest?.modelId !== 'string' ||
    snapshot?.version !== 1 ||
    typeof snapshot.digest !== 'string' ||
    !Array.isArray(models)
  )
    return { unavailable: true };
  const matches = models.filter((model) => object(model)?.id === manifest.modelId);
  const model = matches.length === 1 ? object(matches[0]) : undefined;
  const protocol =
    model &&
    typeof model.provider === 'string' &&
    ['openai', 'deepseek', 'compatible', 'ollama', 'codex'].includes(model.provider)
      ? modelProtocol(model)
      : undefined;
  return protocol ? { protocol, unavailable: false } : { unavailable: true };
}

/** Restore only the current Session's latest frozen model choice. */
function previousSessionEffort(
  selection: NativeSelection | undefined,
  modelId: string | undefined,
): NativeReasoningEffort | undefined {
  if (!selection || !modelId) return;
  let latest: NativeSelection['runs'][number] | undefined;
  for (const run of selection.runs ?? []) {
    if (
      run.sessionId === selection.session.id &&
      run.originStoreId === selection.storeId &&
      Number.isSafeInteger(run.createdAt) &&
      (!latest || run.createdAt > latest.createdAt)
    )
      latest = run;
  }
  const manifest = object(latest?.configuration);
  if (manifest?.modelId !== modelId) return;
  const snapshot = object(manifest.snapshot);
  if (snapshot?.version !== 1 || typeof snapshot.digest !== 'string') return;
  const models = object(snapshot.configuration)?.models;
  if (!Array.isArray(models)) return;
  const matches = models.filter((model) => object(model)?.id === modelId);
  if (matches.length !== 1) return;
  const effort = object(object(matches[0])?.options)?.reasoningEffort;
  return (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultar'] as const).find(
    (value) => value === effort,
  );
}
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
  private pending = new Map<
    string,
    { bridge: NativeBridge; promise: Promise<NativePreparedModels> }
  >();
  get(scope: ReturnType<typeof nativeModelScope>) {
    return this.boundary === scope.boundary ? this.entries.get(scope.displayKey) : undefined;
  }
  observe(scope: ReturnType<typeof nativeModelScope>) {
    if (this.boundary !== scope.boundary) {
      this.entries.clear();
      this.pending.clear();
      this.boundary = scope.boundary;
    }
  }
  set(scope: ReturnType<typeof nativeModelScope>, facts: NativeModelSettingsFacts) {
    this.observe(scope);
    this.entries.set(scope.displayKey, facts);
  }
  recommend(scope: ReturnType<typeof nativeModelScope>, choice: NativeRecommendedModel) {
    if (this.boundary !== scope.boundary) return;
    const key = JSON.stringify(['preparing', undefined, undefined]);
    const facts = this.entries.get(key);
    if (facts) this.entries.set(key, { ...facts, recommendedModel: choice });
  }
  async prepare(
    bridge: NativeBridge,
    generation: number,
    selection?: NativeSelection,
    preparing?: { storeId: string },
    revision?: string,
  ): Promise<NativePreparedModels> {
    const scope = nativeModelScope(generation, selection, preparing, revision);
    this.observe(scope);
    let entry = this.pending.get(scope.readKey);
    if (entry?.bridge !== bridge) {
      entry = {
        bridge,
        promise: prepareNativeModels(bridge, generation, selection, preparing, revision),
      };
      this.pending.set(scope.readKey, entry);
      const original = entry;
      const settle = () => {
        if (this.pending.get(scope.readKey) === original) this.pending.delete(scope.readKey);
      };
      void entry.promise.then(settle, settle);
    }
    return structuredClone(await entry.promise);
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
    return {
      key: scope.readKey,
      facts: preparing
        ? { ...response, recommendedModel: await readNativeRecommendedModel(response.storeId) }
        : response,
      error: '',
    };
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
  preview,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  preparing?: { storeId: string };
  revision?: string;
  value: NativeModelChoice;
  onChange: (value: NativeModelChoice) => void;
  onReady: (
    ready: boolean,
    choice?: NativeModelChoice,
    presentation?: NativeModelPresentation,
  ) => void;
  disabled?: boolean;
  snapshots?: NativeModelSnapshots;
  prepared?: NativePreparedModels;
  preview?: NativeModelDisplay;
}) {
  const diagnostics = useNativeDiagnostics();
  const localSnapshots = useRef(new NativeModelSnapshots());
  const snapshots = sharedSnapshots ?? localSnapshots.current;
  const scope = nativeModelScope(generation, selection, preparing, revision);
  if (!preview) snapshots.observe(scope);
  const readKey = scope.readKey;
  const [state, setState] = useState<{
    key: string;
    facts?: NativeModelSettingsFacts;
    reading: boolean;
    error: string;
  }>();
  const [saveError, setSaveError] = useState<string>();
  const preparedState =
    prepared?.key === readKey && (!prepared.facts || prepared.facts.storeId === scope.storeId)
      ? { ...prepared, reading: false }
      : undefined;
  const currentState = preparedState ?? (state?.key === readKey ? state : undefined);
  const facts = preview ? undefined : currentState ? currentState.facts : snapshots.get(scope);
  const reading = !!preview || disabled || !currentState || currentState.reading;
  const error = preview || disabled ? '' : (currentState?.error ?? '');
  const current = useRef(readKey);
  current.current = readKey;
  const sequence = useRef(0),
    readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const protocol = preparing ? { unavailable: false } : sessionProtocol(selection);
  const models =
    facts?.models.filter(
      (model) =>
        model.enabled &&
        model.configured &&
        (!protocol.protocol || modelProtocol(model) === protocol.protocol),
    ) ?? [];
  const recommendation = preparing ? facts?.recommendedModel : undefined;
  const recommended = models.find((model) => model.id === recommendation?.modelId);
  const requestedId = value.modelId ?? (preparing ? undefined : facts?.selectedModelId);
  const selectedId = requestedId ?? recommended?.id;
  const selected = models.find((model) => model.id === selectedId);
  const supported = selected?.reasoningEffortChoices ?? [];
  const previousEffort = preparing ? undefined : previousSessionEffort(selection, selected?.id);
  const recommendedEffort =
    preparing && value.modelId === undefined && recommended?.id === selected?.id
      ? recommendation?.reasoningEffort
      : undefined;
  const requestEffort = value.reasoningEffort ?? previousEffort ?? recommendedEffort;
  const modelEffort = selected
    ? resolveThinkingEffort(selected.reasoningEffort, selected.reasoningEffortChoices)
    : undefined;
  const effort = requestEffort ?? modelEffort;
  const allowedEffort =
    requestEffort === undefined ||
    requestEffort === modelEffort ||
    supported.includes(requestEffort) ||
    (value.reasoningEffort === undefined &&
      (requestEffort === 'none' || requestEffort === 'minimal'));
  const observed = !!selected && allowedEffort && !protocol.unavailable && !error;
  const ready = observed && !reading && !disabled;
  const readyId = observed ? selected?.id : undefined;
  const display = useMemo<NativeModelDisplay | undefined>(() => {
    if (reading || error || protocol.unavailable || (requestedId && (!selected || !allowedEffort)))
      return;
    // An explicitly unselected model is a complete display, without send eligibility.
    return {
      model: selected
        ? {
            id: selected.id,
            provider: selected.provider ?? '其他',
            name: selected.model ?? selected.id,
            reasoningEffortChoices: selected.reasoningEffortChoices ?? [],
          }
        : undefined,
      reasoningEffort: effort ?? undefined,
    };
  }, [reading, error, protocol.unavailable, requestedId, selected, allowedEffort, effort]);
  useLayoutEffect(() => {
    if (current.current !== readKey) return;
    readyCallback.current(
      ready,
      readyId
        ? {
            modelId: readyId,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          }
        : undefined,
      { settled: !reading, display },
    );
  }, [readKey, ready, readyId, effort, reading, display]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reads follow exact scope and settings revision; callbacks and temporary effort do not restart IO.
  useEffect(() => {
    const original = readKey,
      request = ++sequence.current;
    if (preview) return;
    const retained = snapshots.get(scope);
    // A retained footer can be mounted before Main has selected its target.
    // It may display cached facts, but must not start or settle that target's IO.
    if (disabled) {
      setState({ key: readKey, facts: retained, error: '', reading: true });
      return;
    }
    if (preparedState) {
      if (preparedState.facts) snapshots.set(scope, preparedState.facts);
      return;
    }
    setState({ key: readKey, facts: retained, error: '', reading: true });
    void snapshots.prepare(bridge, generation, selection, preparing, revision).then((result) => {
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
  }, [readKey, bridge, prepared, disabled, preview]);
  const preferenceSequence = useRef(0);
  async function remember(
    choice: NativeModelChoice,
    effectiveEffort?: NativeReasoningEffort | null,
  ) {
    onChange(choice);
    if (!facts || !choice.modelId) return;
    const recommendation = {
      modelId: choice.modelId,
      ...(effectiveEffort == null ? {} : { reasoningEffort: effectiveEffort }),
    };
    const request = ++preferenceSequence.current;
    const original = readKey;
    try {
      await rememberNativeRecommendedModel(facts.storeId, recommendation);
      if (current.current !== original || preferenceSequence.current !== request) return;
      snapshots.recommend(scope, recommendation);
      setSaveError(undefined);
    } catch {
      if (current.current !== original || preferenceSequence.current !== request) return;
      setSaveError(readKey);
    }
  }
  function choose(modelId: string) {
    const model = models.find((entry) => entry.id === modelId);
    if (!reading && !error && !disabled && !protocol.unavailable && model)
      remember(
        { modelId },
        resolveThinkingEffort(
          (preparing ? undefined : previousSessionEffort(selection, modelId)) ??
            model.reasoningEffort,
          model.reasoningEffortChoices,
        ),
      );
  }
  function setEffort(reasoningEffort: NativeReasoningEffort) {
    if (
      reading ||
      error ||
      disabled ||
      protocol.unavailable ||
      !selected ||
      !supported.includes(reasoningEffort)
    )
      return;
    remember(
      {
        ...value,
        ...(value.modelId === undefined ? { modelId: selected.id } : {}),
        reasoningEffort,
      },
      reasoningEffort,
    );
  }
  return (
    <section
      data-model-picker
      aria-label="下一轮模型选择"
      aria-busy={reading || disabled || undefined}
    >
      <ReadGate blocked={reading || disabled}>
        <ModelEffortSelector
          scopeKey={JSON.stringify([scope.boundary, scope.displayKey])}
          model={
            preview
              ? preview.model
              : selected
                ? {
                    id: selected.id,
                    provider: selected.provider ?? '其他',
                    name: selected.model ?? selected.id,
                  }
                : undefined
          }
          models={
            preview
              ? preview.model
                ? [preview.model]
                : []
              : models.map((model) => ({
                  id: model.id,
                  provider: model.provider ?? '其他',
                  name: model.model ?? model.id,
                  reasoningEffort: model.reasoningEffort ?? undefined,
                  reasoningEffortChoices: model.reasoningEffortChoices ?? [],
                }))
          }
          disabled={!preview && protocol.unavailable}
          reasoningEffort={preview ? preview.reasoningEffort : (effort ?? undefined)}
          onModelChange={(_provider, _name, id) => {
            if (id !== undefined) choose(id);
          }}
          onReasoningEffortChange={(effort) => setEffort(effort)}
          modelSelectionHint={protocol.protocol ? '仅显示当前对话可用的模型' : undefined}
        />
      </ReadGate>
      {!preview && protocol.unavailable && (
        <p role="alert">无法确认此会话首次运行的模型协议，暂时无法发送。</p>
      )}
      {error && <p role="alert">模型目录不可用：{error}</p>}
      {!preview && saveError === readKey && (
        <p role="alert">未能记住推荐模型与思考程度，请重新选择。</p>
      )}
      {!reading && !error && !selected && (requestedId || diagnostics) && (
        <p role="alert">
          {requestedId ? `所选模型 ${requestedId} 当前不可用，请重新选择。` : '请选择模型。'}
        </p>
      )}
      {!preview && selected && !allowedEffort && (
        <p role="alert">原临时思考档位当前不可用，请重新选择。</p>
      )}
    </section>
  );
}
