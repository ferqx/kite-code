import { useEffect, useRef, useState } from 'react';
import type {
  NativeBridge,
  NativeProvider,
  NativeProviderOperation,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeSelection,
} from './native-bridge';

type Provider = NativeProviderSettingsFacts['providers'][number];
function safeError(cause: unknown) {
  const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
  return /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'configuration_unavailable';
}
function validEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function NativeProviderSettings({
  bridge,
  generation,
  selection,
  submissions,
  onSaved,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeProviderSubmission[];
  onSaved?: () => void;
}) {
  const [facts, setFacts] = useState<NativeProviderSettingsFacts>();
  const [providerId, setProviderId] = useState<NativeProvider>();
  const panelCurrent = useRef(providerId);
  panelCurrent.current = providerId;
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [baseURL, setBaseURL] = useState(''),
    [modelNames, setModelNames] = useState(''),
    [secret, setSecret] = useState('');
  const [credential, setCredential] = useState<NativeProviderOperation['credential']>('replace');
  const [fieldError, setFieldError] = useState<{ field: 'url' | 'key'; message: string }>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [writing, setWriting] = useState(false),
    [saved, setSaved] = useState(false);
  const [local, setLocal] = useState<NativeProviderSubmission[]>([]);
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0),
    flight = useRef(false);
  const urlField = useRef<HTMLInputElement>(null),
    keyField = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const all = new Map(submissions.map((submission) => [submission.commandId, submission]));
  for (const submission of local) all.set(submission.commandId, submission);
  const originals = [...all.values()];
  const pending =
    facts &&
    originals.some(
      (submission) =>
        submission.storeId === facts.storeId &&
        ['submitting', 'unknown'].includes(submission.phase),
    );
  const provider = facts?.providers.find((entry) => entry.id === providerId);
  const connection = provider?.connections.find((entry) => entry.id === connectionId);
  const writable =
    facts?.canWrite && (!connection || connection.canWrite) && !pending && !reading && !writing;
  function remember(submission: NativeProviderSubmission) {
    setLocal((values) => [
      ...values.filter((entry) => entry.commandId !== submission.commandId),
      submission,
    ]);
  }
  async function read(afterSave = false) {
    const original = identity,
      request = ++sequence.current;
    setReading(true);
    setError('');
    try {
      const response = await bridge.request({ method: 'settings.providers.read', generation });
      if (current.current !== original || sequence.current !== request) return;
      if (
        !response ||
        !('providers' in response) ||
        !('kind' in response) ||
        response.kind !== 'settings.providers'
      )
        throw Error('configuration_unavailable');
      if (selection && response.storeId !== selection.storeId)
        throw Error('store_identity_mismatch');
      setFacts(response);
      if (afterSave && panelCurrent.current === providerId) {
        const savedProvider = response.providers.find((entry) => entry.id === providerId);
        const savedConnection = savedProvider?.connections.find(
          (entry) => entry.baseURL.replace(/\/$/, '') === baseURL.trim().replace(/\/$/, ''),
        );
        if (savedConnection) {
          setConnectionId(savedConnection.id);
          setBaseURL(savedConnection.baseURL);
          setModelNames(savedConnection.modelNames.join('\n'));
          setCredential(
            savedConnection.hasCredential
              ? 'keep'
              : savedProvider!.requiresCredential
                ? 'replace'
                : 'none',
          );
        }
      }
    } catch (cause) {
      if (current.current === original && sequence.current === request) {
        setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
        setError(
          `${afterSave ? '已保存，刷新配置失败；请刷新后选择模型，无需重复保存。' : '提供商配置读取失败：'}${safeError(cause)}`,
        );
      }
    } finally {
      if (current.current === original && sequence.current === request) setReading(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The host selection seals the read identity.
  useEffect(() => {
    sequence.current++;
    setFacts(undefined);
    setProviderId(undefined);
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setError('');
    setSaved(false);
    setWriting(false);
    flight.current = false;
    void read();
    return () => {
      sequence.current++;
      void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  function choose(entry: Provider, button?: HTMLButtonElement) {
    if (button) origin.current = button;
    const existing = entry.connections[0];
    setProviderId(entry.id);
    setConnectionId(existing?.id ?? null);
    setBaseURL(existing?.baseURL ?? entry.defaultBaseURL);
    setModelNames(existing?.modelNames.join('\n') ?? '');
    setSecret('');
    setCredential(existing?.hasCredential ? 'keep' : entry.requiresCredential ? 'replace' : 'none');
    setFieldError(undefined);
    setError('');
    setSaved(false);
  }
  function chooseConnection(id: string) {
    if (!provider) return;
    const selected = provider.connections.find((entry) => entry.id === id);
    setConnectionId(selected?.id ?? null);
    setBaseURL(selected?.baseURL ?? provider.defaultBaseURL);
    setModelNames(selected?.modelNames.join('\n') ?? '');
    setSecret('');
    setCredential(
      selected?.hasCredential ? 'keep' : provider.requiresCredential ? 'replace' : 'none',
    );
    setFieldError(undefined);
    setSaved(false);
  }
  function close() {
    sequence.current++;
    setProviderId(undefined);
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setFieldError(undefined);
    void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
    origin.current?.focus();
  }
  async function save() {
    if (!facts || !provider || !writable || flight.current) return;
    if (!validEndpoint(baseURL.trim())) {
      setFieldError({ field: 'url', message: '请输入有效的 HTTP 或 HTTPS 服务地址。' });
      urlField.current?.focus();
      return;
    }
    if (
      (credential === 'replace' && !secret.trim()) ||
      (provider.requiresCredential && credential === 'none') ||
      (credential === 'keep' && !connection?.hasCredential)
    ) {
      setFieldError({ field: 'key', message: '请输入 API key。' });
      keyField.current?.focus();
      return;
    }
    const original = identity,
      request = ++sequence.current;
    const operation: NativeProviderOperation = {
      provider: provider.id,
      connectionId,
      baseURL: baseURL.trim(),
      modelNames: [
        ...new Set(
          modelNames
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ],
      credential,
    };
    const key = credential === 'replace' ? secret : undefined;
    setSecret('');
    setFieldError(undefined);
    setError('');
    setSaved(false);
    setWriting(true);
    flight.current = true;
    try {
      const response = await bridge.request({
        method: 'settings.providers.save',
        generation,
        observationId: facts.observationId,
        operation,
        ...(key === undefined ? {} : { secret: key }),
      });
      if (
        !response ||
        !('phase' in response) ||
        !('kind' in response) ||
        response.kind !== 'settings.providers.submission'
      )
        throw Error('configuration_unavailable');
      remember(response);
      if (current.current !== original || sequence.current !== request) return;
      if (response.phase === 'applied') {
        onSaved?.();
        if (panelCurrent.current !== operation.provider) return;
        setSaved(true);
        await read(true);
      } else if (response.phase === 'unknown')
        setError('保存结果未知。请查询原提交；刷新配置不能确认这次保存结果。');
      else if (response.error) setError(`保存失败：${response.error}`);
    } catch (cause) {
      if (current.current === original && sequence.current === request)
        setError(`保存结果未确认：${safeError(cause)}。请核对原提交。`);
    } finally {
      if (current.current === original) {
        flight.current = false;
        setWriting(false);
      }
    }
  }
  async function lookup(submission: NativeProviderSubmission) {
    if (flight.current) return;
    const original = identity;
    flight.current = true;
    setWriting(true);
    try {
      const response = await bridge.request({
        method: 'settings.providers.lookup',
        generation,
        commandId: submission.commandId,
      });
      if (
        !response ||
        !('phase' in response) ||
        !('kind' in response) ||
        response.kind !== 'settings.providers.submission'
      )
        throw Error('configuration_unavailable');
      remember(response);
      if (response.phase === 'applied' && current.current === original) onSaved?.();
    } catch (cause) {
      if (current.current === original) setError(`原提交查询失败：${safeError(cause)}`);
    } finally {
      if (current.current === original) {
        flight.current = false;
        setWriting(false);
      }
    }
  }
  return (
    <section aria-label="提供商设置">
      <h2>提供商</h2>
      <p>保存配置供后续运行采用。配置可用表示结构已保存，远端连接与执行仍需实际核实。</p>
      <button type="button" disabled={reading || writing} onClick={() => void read()}>
        刷新提供商配置
      </button>
      {reading && <p role="status">正在读取提供商配置。</p>}
      {error && <p role="alert">{error}</p>}
      {saved && !error && <p role="status">已保存提供商配置。</p>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: provider ? 'minmax(180px, 1fr) minmax(280px, 2fr)' : '1fr',
          gap: 24,
        }}
      >
        <ul aria-label="提供商列表">
          {facts?.providers.map((entry) => (
            <li key={entry.id}>
              <span>
                {entry.label} · {entry.connections.length ? '已配置' : '未配置'}
              </span>{' '}
              <button
                type="button"
                aria-label={`${entry.connections.length ? '编辑' : '配置'} ${entry.label}`}
                onClick={(event) => choose(entry, event.currentTarget)}
              >
                {entry.connections.length ? '编辑' : '配置'}
              </button>
            </li>
          ))}
        </ul>
        {provider && (
          <form
            aria-label={`${provider.label} 配置`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3>{provider.label}</h3>
            <button type="button" onClick={close}>
              关闭提供商配置
            </button>
            <label>
              连接
              <select
                aria-label="提供商连接"
                value={connectionId ?? ''}
                disabled={writing}
                onChange={(event) => chooseConnection(event.currentTarget.value)}
              >
                {provider.connections.map((entry, index) => (
                  <option key={entry.id} value={entry.id}>
                    连接 {index + 1} · {entry.baseURL}
                  </option>
                ))}
                <option value="">新增连接</option>
              </select>
            </label>
            <label>
              服务地址
              <input
                ref={urlField}
                aria-label="服务地址"
                type="text"
                value={baseURL}
                disabled={writing}
                aria-invalid={fieldError?.field === 'url'}
                onInput={(event) => {
                  setBaseURL(event.currentTarget.value);
                  setFieldError(undefined);
                }}
              />
            </label>
            {fieldError?.field === 'url' && <p role="alert">{fieldError.message}</p>}
            <label>
              凭据
              <select
                aria-label="凭据处理"
                value={credential}
                disabled={writing}
                onChange={(event) => {
                  setCredential(event.currentTarget.value as NativeProviderOperation['credential']);
                  setSecret('');
                  setFieldError(undefined);
                }}
              >
                {connection?.hasCredential && <option value="keep">保留已保存凭据</option>}
                <option value="replace">保存新 API key</option>
                {!provider.requiresCredential && <option value="none">不使用凭据</option>}
              </select>
            </label>
            {credential === 'replace' && (
              <label>
                API key
                <input
                  ref={keyField}
                  aria-label="API key"
                  autoComplete="off"
                  type="password"
                  value={secret}
                  disabled={writing}
                  aria-invalid={fieldError?.field === 'key'}
                  onInput={(event) => {
                    setSecret(event.currentTarget.value);
                    setFieldError(undefined);
                  }}
                />
              </label>
            )}
            {fieldError?.field === 'key' && <p role="alert">{fieldError.message}</p>}
            <label>
              模型名称
              <textarea
                aria-label="模型名称"
                value={modelNames}
                disabled={writing}
                onInput={(event) => setModelNames(event.currentTarget.value)}
              />
            </label>
            <p>每行一个准确模型名称；留空时保存会查询该连接的模型目录。</p>
            <button type="submit" disabled={!writable}>
              保存提供商配置
            </button>
            {writing && <p role="status">正在提交原提供商配置。</p>}
            {pending && <p role="status">原 Store 有未决提交，请先查询原结果。</p>}
          </form>
        )}
      </div>
      {facts?.errors.map((code) => (
        <p role="alert" key={code}>
          {code}
        </p>
      ))}
      {!!originals.length && (
        <section aria-label="提供商原提交">
          <h3>原提供商提交</h3>
          {originals.map((submission) => (
            <article key={submission.commandId}>
              <p>
                {submission.operation.provider} · {submission.phase} · 原 Store {submission.storeId}
              </p>
              <p>原提交 {submission.commandId}</p>
              {submission.credentialState && (
                <p>
                  {submission.credentialState === 'stored'
                    ? 'API key 已存入凭证库。'
                    : submission.credentialState === 'outcome_unknown'
                      ? 'API key 保存结果待核实，请查询原提交。'
                      : '本次没有保存新的 API key。'}
                </p>
              )}
              {submission.configurationState && (
                <p>
                  {submission.configurationState === 'published'
                    ? '模型配置已保存，用于下一次新运行。'
                    : submission.configurationState === 'outcome_unknown'
                      ? '模型配置保存结果待核实，请查询原提交。'
                      : '模型配置未保存；凭证保存结果单独显示。'}
                </p>
              )}
              {submission.error && <p role="alert">{submission.error}</p>}
              {submission.phase === 'unknown' && (
                <button
                  type="button"
                  disabled={reading || writing}
                  onClick={() => void lookup(submission)}
                >
                  查询原提供商提交
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
