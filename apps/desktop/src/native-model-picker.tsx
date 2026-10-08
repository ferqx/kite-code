import { ModelEffortSelector } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeReasoningEffort,
  NativeSelection,
} from './native-bridge';

export type NativeModelChoice = { modelId?: string; reasoningEffort?: NativeReasoningEffort };
function errorCode(cause: unknown) {
  const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
  return /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'model_selection_unavailable';
}
export function NativeModelPicker({
  bridge,
  generation,
  selection,
  revision,
  value,
  onChange,
  onReady,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  revision?: string;
  value: NativeModelChoice;
  onChange: (value: NativeModelChoice) => void;
  onReady: (ready: boolean, choice?: NativeModelChoice) => void;
}) {
  const [facts, setFacts] = useState<NativeModelSettingsFacts>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
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
  const ready = !!selected && allowedEffort && !reading && !error;
  const readyId = ready ? selected?.id : undefined;
  useEffect(() => {
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
  }, [ready, readyId, value.reasoningEffort]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Catalogue reads use only scope and settings revision, never observer event objects or temporary effort.
  useEffect(() => {
    const original = identity,
      request = ++sequence.current;
    setFacts(undefined);
    setError('');
    setReading(true);
    readyCallback.current(false);
    void bridge
      .request({ method: 'input.models.read', generation })
      .then((response) => {
        if (current.current !== original || sequence.current !== request) return;
        if (
          !response ||
          !('models' in response) ||
          !('kind' in response) ||
          response.kind !== 'settings.models'
        )
          throw Error('model_selection_unavailable');
        if (selection && response.storeId !== selection.storeId)
          throw Error('store_identity_mismatch');
        setFacts(response);
      })
      .catch((cause) => {
        if (current.current === original && sequence.current === request)
          setError(errorCode(cause));
      })
      .finally(() => {
        if (current.current === original && sequence.current === request) setReading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [identity, revision, bridge]);
  function choose(modelId: string) {
    if (!reading && !error && models.some((model) => model.id === modelId)) onChange({ modelId });
  }
  function setEffort(reasoningEffort?: NativeReasoningEffort) {
    if (!selected || (reasoningEffort !== undefined && !supported.includes(reasoningEffort)))
      return;
    onChange({
      ...value,
      ...(value.modelId === undefined ? { modelId: selected.id } : {}),
      reasoningEffort,
    });
  }
  return (
    <section aria-label="下一轮模型选择">
      <ModelEffortSelector
        key={`${identity}/${revision}`}
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
          reasoningEffortSupported: !!model.reasoningEffortChoices?.length,
          reasoningEffort: model.reasoningEffort ?? undefined,
          reasoningEffortChoices: model.reasoningEffortChoices ?? [],
        }))}
        disabled={reading}
        reasoningEffort={effort ?? undefined}
        onModelChange={(_provider, _name, id) => {
          if (id !== undefined) choose(id);
        }}
        onReasoningEffortChange={(effort) => setEffort(effort)}
        onReasoningEffortReset={() => setEffort(undefined)}
        onReasoningEffortOff={() => setEffort('none')}
      />
      {reading && <p role="status">正在读取可选模型。</p>}
      {error && <p role="alert">模型目录不可用：{error}</p>}
      {!reading && !error && !selected && (
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
