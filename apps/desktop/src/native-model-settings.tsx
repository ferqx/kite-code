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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only the original host selection invalidates the read.
  useEffect(() => {
    sequence.current++;
    setFacts(undefined);
    setReading(false);
    setError('');
    setWriting(false);
    inFlight.current = false;
    return () => {
      sequence.current++;
      void bridge.request({ method: 'settings.models.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  function showError(cause: unknown) {
    const code = (cause as { code?: string }).code ?? (cause as Error).message;
    setError(/^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'configuration_unavailable');
  }
  async function read(scope: 'user' | 'workspace', afterSave = false) {
    const original = identity,
      request = ++sequence.current;
    setReading(true);
    setError('');
    if (!afterSave)
      setFacts((previous) =>
        previous?.scope === scope ? { ...previous, canWrite: false } : undefined,
      );
    try {
      const value = await bridge.request({ method: 'settings.models.read', generation, scope });
      if (current.current !== original || sequence.current !== request) return;
      if (!value || !('models' in value) || !('kind' in value) || value.kind !== 'settings.models')
        throw Error('configuration_unavailable');
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
        if (observed) await read(observed.scope, true);
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
  for (const model of facts?.models ?? []) {
    const provider = model.provider ?? '其他';
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  const canWrite = facts?.canWrite && !pending && !reading && !writing;
  return (
    <section aria-label="模型设置">
      <h2>模型与配置</h2>
      <p>
        期望配置用于后续执行，活动轮次保留开始时的配置。配置可用不表示已完成远端模型发现或凭据验证。
      </p>
      <button type="button" disabled={reading || writing} onClick={() => void read('user')}>
        读取用户模型配置
      </button>
      <button
        type="button"
        disabled={reading || writing || !selection}
        onClick={() => void read('workspace')}
      >
        读取当前项目模型配置
      </button>
      {reading && <p role="status">正在读取原作用域配置。</p>}
      {error && <p role="alert">模型配置不可用：{error}</p>}
      {facts && (
        <>
          <p>
            {facts.scope === 'user' ? '用户配置' : `项目配置 ${facts.workspaceId}`} ·
            当前期望默认模型：{facts.defaultModelId ?? '未选择'}
          </p>
          {facts.errors.map((code) => (
            <p role="alert" key={code}>
              配置诊断：{code}
            </p>
          ))}
          {[...groups].map(([provider, models]) => (
            <section aria-label={`模型提供商 ${provider}`} key={provider}>
              <h3>{provider}</h3>
              <ul>
                {models.map((model) => (
                  <li key={model.id}>
                    {model.id} · {model.provider} · {model.model} ·{' '}
                    {model.enabled ? '启用' : '禁用'} ·{' '}
                    {model.configured ? '配置可用' : '配置不完整'}
                    {model.diagnostics.map((code) => (
                      <span key={code}> {code}</span>
                    ))}
                    <button
                      type="button"
                      aria-label={`${model.enabled ? '禁用' : '启用'}模型 ${model.id}`}
                      disabled={!canWrite || (model.enabled && model.id === facts.defaultModelId)}
                      onClick={() =>
                        void write(
                          {
                            method: 'settings.models.enabled',
                            generation,
                            observationId: facts.observationId,
                            modelId: model.id,
                            enabled: !model.enabled,
                          },
                          facts,
                        )
                      }
                    >
                      {model.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      type="button"
                      aria-label={`设为默认 ${model.id}`}
                      disabled={
                        !canWrite ||
                        !model.enabled ||
                        !model.configured ||
                        model.id === facts.defaultModelId
                      }
                      onClick={() =>
                        void write(
                          {
                            method: 'settings.models.default',
                            generation,
                            observationId: facts.observationId,
                            modelId: model.id,
                          },
                          facts,
                        )
                      }
                    >
                      设为默认
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!facts.errors.length && !facts.models.length && <p>当前期望配置没有模型。</p>}
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
