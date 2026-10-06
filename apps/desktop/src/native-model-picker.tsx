import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeReasoningEffort,
  NativeSelection,
} from './native-bridge';

export type NativeModelChoice = { modelId?: string; reasoningEffort?: NativeReasoningEffort };
const effortLabels: Record<NativeReasoningEffort, string> = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};
const levels: NativeReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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
  const [burst, setBurst] = useState(false);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    },
    [],
  );
  const [panel, setPanel] = useState<'effort' | 'models'>(),
    [provider, setProvider] = useState<string>();
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
  const providers = [...new Set(models.map((model) => model.provider ?? '其他'))];
  const displayedProvider =
    provider && providers.includes(provider) ? provider : (selected?.provider ?? providers[0]);
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
    setPanel(undefined);
    setProvider(undefined);
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
    onChange({ modelId });
    setPanel('effort');
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
  function releaseEffort() {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    setBurst(true);
    burstTimer.current = setTimeout(() => setBurst(false), 400);
  }
  const animationSeconds: Record<NativeReasoningEffort, number> = {
    none: 0,
    minimal: 4,
    low: 3,
    medium: 2,
    high: 1.2,
    xhigh: 0.7,
    max: 0.35,
  };
  const sliderChoices = levels.filter((level) => supported.includes(level));
  const sliderIndex = sliderChoices.indexOf(effort as NativeReasoningEffort);
  return (
    <section aria-label="下一轮模型选择" style={{ fontSize: 14 }}>
      <style>{`
        .native-thinking-gem { display: inline-block; color: #3b82f6; text-shadow: 0 0 7px #60a5fa; animation: native-thinking-starlight 2s ease-in-out infinite; }
        .native-thinking-burst { display: inline-flex; position: absolute; pointer-events: none; color: #60a5fa; gap: 6px; animation: native-thinking-particles .4s ease-out forwards; }
        @keyframes native-thinking-starlight { 50% { opacity: .45; filter: brightness(1.4); } }
        @keyframes native-thinking-particles { to { opacity: 0; transform: translateY(-12px) scale(1.7); } }
        @media (prefers-reduced-motion: reduce) { .native-thinking-gem { animation: none; } .native-thinking-burst { display: none; } }
      `}</style>
      <button
        type="button"
        aria-expanded={!!panel}
        disabled={reading}
        onClick={() => setPanel(panel ? undefined : 'effort')}
      >
        模型：
        {selected?.model ?? selected?.id ?? (requestedId ? `${requestedId}（不可用）` : '未配置')} ·
        思考：{effort ? effortLabels[effort] : '默认'}
      </button>
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
      {panel && (
        <section
          aria-label="模型与思考浮层"
          style={{
            width: 460,
            maxWidth: '100%',
            border: '1px solid currentColor',
            borderRadius: 8,
            padding: 12,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setPanel('models');
              setProvider(selected?.provider);
            }}
          >
            {selected?.model ?? '选择模型'}
          </button>
          <button type="button" onClick={() => setPanel(undefined)}>
            关闭模型选择
          </button>
          {panel === 'effort' && (
            <>
              <p>下一次新运行采用此选择；活动任务保留原模型与档位。</p>
              {!supported.length ? (
                <p>此模型不支持思考调节。</p>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="native-thinking-gem"
                    style={{
                      color: effort === 'max' ? '#8b5cf6' : '#3b82f6',
                      animationDuration: `${animationSeconds[effort ?? 'low']}s`,
                      ...(effort === 'none' ? { animation: 'none' } : {}),
                    }}
                  >
                    ✦
                  </span>
                  {burst && (
                    <span aria-hidden="true" className="native-thinking-burst">
                      · ✧ ·
                    </span>
                  )}
                  <label>
                    思考强度
                    <select
                      aria-label="思考强度"
                      value={value.reasoningEffort ?? ''}
                      onChange={(event) =>
                        setEffort(
                          event.currentTarget.value
                            ? (event.currentTarget.value as NativeReasoningEffort)
                            : undefined,
                        )
                      }
                    >
                      <option value="">
                        {selected?.reasoningEffort
                          ? `配置默认（${effortLabels[selected.reasoningEffort]}）`
                          : '默认'}
                      </option>
                      {supported.includes('none') && <option value="none">关闭</option>}
                      {sliderChoices.map((level) => (
                        <option key={level} value={level}>
                          {effortLabels[level]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!!sliderChoices.length && (
                    <label>
                      档位
                      <input
                        type="range"
                        aria-label="思考档位"
                        min={0}
                        max={sliderChoices.length - 1}
                        step={1}
                        value={Math.max(0, sliderIndex)}
                        aria-valuetext={effort ? effortLabels[effort] : '默认'}
                        onChange={(event) =>
                          setEffort(sliderChoices[Number(event.currentTarget.value)])
                        }
                        onPointerUp={releaseEffort}
                        onKeyUp={releaseEffort}
                      />
                    </label>
                  )}
                  <p>{sliderChoices.map((level) => effortLabels[level]).join(' · ')}</p>
                </>
              )}
            </>
          )}
          {panel === 'models' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', height: 280, gap: 12 }}>
              <section aria-label="模型提供商" style={{ overflowY: 'auto' }}>
                {providers.map((family) => (
                  <button
                    type="button"
                    key={family}
                    aria-pressed={displayedProvider === family}
                    onClick={() => setProvider(family)}
                  >
                    {family}
                  </button>
                ))}
              </section>
              <section aria-label="提供商模型" style={{ overflowY: 'auto' }}>
                {models
                  .filter((model) => (model.provider ?? '其他') === displayedProvider)
                  .map((model) => (
                    <button
                      type="button"
                      key={model.id}
                      aria-label={`选择模型 ${model.id}`}
                      aria-pressed={selected?.id === model.id}
                      onClick={() => choose(model.id)}
                    >
                      {model.model ?? model.id}
                      {selected?.id === model.id ? ' ✓' : ''}
                    </button>
                  ))}
              </section>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
