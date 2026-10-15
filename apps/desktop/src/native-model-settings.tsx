import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
  NativeSelection,
} from './native-bridge';

export function NativeModelSettings({
  bridge,
  generation,
  selection,
  submissions,
  onSaved,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeModelSettingsSubmission[];
  onSaved?: () => void;
}) {
  const [facts, setFacts] = useState<NativeModelSettingsFacts>();
  const [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const [writing, setWriting] = useState(false);
  const inFlight = useRef(false);
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity),
    sequence = useRef(0);
  current.current = identity;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read on host changes, never observer events or write results.
  useEffect(() => {
    sequence.current++;
    setFacts(undefined);
    setReading(false);
    setError('');
    setWriting(false);
    inFlight.current = false;
    void read();
    return () => {
      sequence.current++;
      void bridge.request({ method: 'settings.models.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  function showError(cause: unknown) {
    const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
    setError(/^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'configuration_unavailable');
  }
  async function read(afterSave = false) {
    const original = identity,
      request = ++sequence.current;
    setReading(true);
    setError('');
    if (!afterSave)
      setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
    try {
      const value = await bridge.request({
        method: 'settings.models.read',
        generation,
        scope: 'user',
      });
      if (current.current !== original || sequence.current !== request) return;
      if (!value || !('models' in value) || !('kind' in value) || value.kind !== 'settings.models')
        throw Error('configuration_unavailable');
      if (
        value.scope !== 'user' ||
        value.workspaceId !== undefined ||
        (selection && value.storeId !== selection.storeId)
      )
        throw Error('configuration_scope_mismatch');
      setFacts(value);
    } catch (cause) {
      if (current.current === original && sequence.current === request) {
        if (afterSave) setError('已保存模型配置，刷新失败。请重新读取，无需重复保存。');
        else showError(cause);
      }
    } finally {
      if (current.current === original && sequence.current === request) setReading(false);
    }
  }
  async function write(input: NativeRequest, observed?: NativeModelSettingsFacts) {
    if (inFlight.current) return;
    const original = identity,
      request = ++sequence.current;
    inFlight.current = true;
    setWriting(true);
    setError('');
    if (observed)
      setFacts({
        ...observed,
        canWrite: false,
        ...(input.method === 'settings.models.default' ? { defaultModelId: input.modelId } : {}),
        models: observed.models.map((model) =>
          input.method === 'settings.models.enabled' && input.modelId === model.id
            ? { ...model, enabled: input.enabled }
            : model,
        ),
      });
    try {
      const result = await bridge.request(input);
      if (current.current !== original || sequence.current !== request) return;
      if (
        !result ||
        !('phase' in result) ||
        !('kind' in result) ||
        result.kind !== 'settings.models.submission'
      )
        throw Error('configuration_unavailable');
      // Only the observation used to save may trigger a fresh read. Original lookups never rebind a new panel.
      if (result.phase === 'applied') {
        if (
          result.storeId === selection?.storeId ||
          (observed && result.storeId === observed.storeId)
        )
          onSaved?.();
        if (observed) await read(true);
      } else {
        if (result.phase === 'failed' && observed) setFacts({ ...observed, canWrite: false });
        if (result.error) setError(result.error);
      }
    } catch (cause) {
      if (current.current === original && sequence.current === request) {
        if (observed) setFacts({ ...observed, canWrite: false });
        showError(cause);
      }
    } finally {
      if (current.current === original) {
        inFlight.current = false;
        setWriting(false);
      }
    }
  }
  const pending =
    facts &&
    submissions.some(
      (submission) =>
        submission.storeId === facts.storeId &&
        submission.scope === facts.scope &&
        submission.workspaceId === facts.workspaceId &&
        ['submitting', 'unknown'].includes(submission.phase),
    );
  const groups = new Map<string, NativeModelSettingsFacts['models']>();
  const names = new Map<string, number>();
  for (const model of facts?.models ?? []) {
    const provider = model.provider ?? '其他';
    const group = groups.get(provider);
    if (group) group.push(model);
    else groups.set(provider, [model]);
    const name = JSON.stringify([provider, model.model ?? model.id]);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const canWrite = facts?.canWrite && !pending && !reading && !writing;
  const selectableModels = facts?.models.filter((model) => model.enabled && model.configured) ?? [];
  const selectedModel = selectableModels.find((model) => model.id === facts?.defaultModelId);
  function modelName(model: NativeModelSettingsFacts['models'][number]) {
    const name = model.model ?? model.id;
    return names.get(JSON.stringify([model.provider ?? '其他', name]))! > 1
      ? `${name} · ${model.id}`
      : name;
  }
  return (
    <section aria-label="模型设置" className="settings-models">
      <div className="settings-models-title">
        <div>
          <h2>模型</h2>
          <p className="settings-models-description">选择默认模型，管理任务中可用的模型。</p>
        </div>
        <button type="button" disabled={reading || writing} onClick={() => void read()}>
          刷新配置
        </button>
      </div>
      <div className="settings-card settings-model-current">
        <div className="settings-row">
          <span>
            <strong>默认模型</strong>
            <small>用于后续执行，正在运行的任务不受影响</small>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="settings-model-trigger"
                aria-label="默认模型"
                disabled={!canWrite || !selectableModels.length}
              >
                <span>
                  {selectedModel
                    ? `${selectedModel.provider ?? '其他'} · ${modelName(selectedModel)}`
                    : reading
                      ? '正在读取'
                      : facts?.defaultModelId
                        ? `${facts.defaultModelId} · 当前不可用`
                        : selectableModels.length
                          ? '选择模型'
                          : '暂无可用模型'}
                </span>
                <svg aria-hidden="true" data-icon="inline-end" viewBox="0 0 24 24" fill="none">
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="model-menu settings-model-menu"
              portalled={false}
              align="end"
              sideOffset={6}
              aria-label="选择默认模型"
            >
              <DropdownMenuRadioGroup value={selectedModel?.id ?? ''}>
                {[...groups].map(([provider, models]) => {
                  const selectable = models.filter((model) => model.enabled && model.configured);
                  return selectable.length ? (
                    <DropdownMenuGroup key={provider}>
                      <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                      {selectable.map((model) => (
                        <DropdownMenuRadioItem
                          key={model.id}
                          value={model.id}
                          indicatorPosition="end"
                          aria-label={`设为默认 ${model.id}`}
                          disabled={!canWrite || model.id === selectedModel?.id}
                          onSelect={() => {
                            if (canWrite && model.id !== selectedModel?.id)
                              void write(
                                {
                                  method: 'settings.models.default',
                                  generation,
                                  observationId: facts!.observationId,
                                  modelId: model.id,
                                },
                                facts,
                              );
                          }}
                        >
                          {modelName(model)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuGroup>
                  ) : null;
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {reading && <p role="status">正在读取原作用域配置。</p>}
      {writing && <p role="status">正在保存模型配置。</p>}
      {error && <p role="alert">模型配置不可用：{error}</p>}
      <div className="settings-model-section-heading">
        <h3>模型列表</h3>
        <span>开启后显示在任务的模型列表中</span>
      </div>
      {facts && (
        <>
          {facts.errors.map((code) => (
            <p role="alert" key={code}>
              配置诊断：{code}
            </p>
          ))}
          <div className="model-list" aria-busy={reading || writing}>
            {[...groups].map(([provider, models]) => {
              const configured = models.filter((model) => model.configured).length;
              const readiness = !configured
                ? 'not_configured'
                : configured === models.length
                  ? 'ready'
                  : 'degraded';
              return (
                <section
                  aria-label={`模型提供商 ${provider}`}
                  className="settings-model-provider"
                  key={provider}
                >
                  <div className="settings-model-provider-heading">
                    <div className="settings-model-provider-identity">
                      <strong>{provider}</strong>
                      <span>{models.length} 个模型</span>
                    </div>
                    <span className="settings-model-status" data-readiness={readiness}>
                      {readiness === 'ready'
                        ? '配置可用'
                        : readiness === 'degraded'
                          ? '部分配置可用'
                          : '配置不完整'}
                    </span>
                  </div>
                  <div className="settings-model-options">
                    {models.map((model) => (
                      <label
                        className="settings-model-option"
                        key={model.id}
                        data-enabled={model.enabled}
                      >
                        <span>
                          <strong>{modelName(model)}</strong>
                          {model.id === facts.defaultModelId && (
                            <small className="settings-model-default-badge">默认</small>
                          )}
                          {model.diagnostics.map((code) => (
                            <small key={code}>{code}</small>
                          ))}
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={`启用模型 ${model.id}`}
                          title={
                            model.enabled && model.id === facts.defaultModelId
                              ? '默认模型不能禁用，请先选择另一默认模型'
                              : undefined
                          }
                          checked={model.enabled}
                          aria-checked={model.enabled}
                          disabled={
                            !canWrite || (model.enabled && model.id === facts.defaultModelId)
                          }
                          onChange={(event) => {
                            if (canWrite && (!model.enabled || model.id !== facts.defaultModelId))
                              void write(
                                {
                                  method: 'settings.models.enabled',
                                  generation,
                                  observationId: facts.observationId,
                                  modelId: model.id,
                                  enabled: event.currentTarget.checked,
                                },
                                facts,
                              );
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              );
            })}
            {!facts.errors.length && !facts.models.length && (
              <p className="settings-model-empty">尚无模型配置，请前往“提供商”连接。</p>
            )}
          </div>
          {!canWrite && (
            <p role="status">当前观察只读。未决提交先查询原结果，其他情况请重新读取配置。</p>
          )}
        </>
      )}
      {!!submissions.length && (
        <section aria-label="模型设置提交">
          <h3>原模型设置提交</h3>
          {submissions.map((submission) => (
            <article key={submission.commandId}>
              <p>
                原 Store {submission.storeId} ·{' '}
                {submission.scope === 'user' ? '用户配置' : `项目配置 ${submission.workspaceId}`} ·{' '}
                {submission.operation.modelId} ·{' '}
                {submission.operation.kind === 'default'
                  ? '设为默认'
                  : submission.operation.enabled
                    ? '启用'
                    : '禁用'}{' '}
                · {submission.phase}
              </p>
              <p>原提交 {submission.commandId}</p>
              {submission.error && <p role="alert">{submission.error}</p>}
              {submission.phase === 'unknown' && (
                <button
                  type="button"
                  disabled={writing || reading}
                  onClick={() =>
                    void write({
                      method: 'settings.models.lookup',
                      generation,
                      commandId: submission.commandId,
                    })
                  }
                >
                  查询原提交
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
