import { RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeBridge,
  NativeProvider,
  NativeProviderOperation,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeSelection,
} from './native-bridge';

type ProviderIconName = 'refresh' | 'plus' | 'connection' | 'shield' | 'models';
function ProviderIcon({ name }: { name: ProviderIconName }) {
  const paths: Record<ProviderIconName, string> = {
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17',
    plus: 'M12 5v14M5 12h14',
    connection:
      'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    shield: 'M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Zm-4 9 3 3 5-6',
    models: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const providerPresentation: Record<NativeProvider, { mark: string; description: string }> = {
  openai: { mark: 'O', description: 'OpenAI 官方 API，支持两种接口协议' },
  deepseek: { mark: 'D', description: '连接 DeepSeek 官方模型服务' },
  compatible: { mark: '</>', description: '使用兼容 OpenAI 协议的自定义服务' },
  ollama: { mark: '◉', description: '连接本机或自托管的 Ollama 模型' },
  codex: { mark: 'C', description: '自动复用本机 Codex 的 ChatGPT 登录' },
};
function ProviderMark({ provider }: { provider: NativeProvider }) {
  return (
    <span className={`provider-mark provider-mark-${provider}`} aria-hidden="true">
      {providerPresentation[provider].mark}
    </span>
  );
}

type Protocol = NonNullable<NativeProviderOperation['protocol']>;
function protocolLabel(protocol?: Protocol) {
  return protocol === 'responses' ? 'Responses' : 'Chat Completions';
}
function supportsResponses(provider: NativeProvider) {
  return provider === 'openai' || provider === 'compatible';
}
type Provider = NativeProviderSettingsFacts['providers'][number];
type Connection = Provider['connections'][number];
type PanelMode = 'add' | 'edit' | 'remove';
function connectionLabel(provider: Provider, connection: Connection) {
  return (
    connection.name?.trim() || `${provider.label} ${provider.connections.indexOf(connection) + 1}`
  );
}
function connectionFingerprint(provider: Provider, connection?: Connection) {
  // The observation ID also binds credentials that are intentionally absent from these public facts.
  // This snapshot additionally guards changed facts when an observation ID is reused by a fixture.
  return JSON.stringify({
    provider: provider.id,
    requiresCredential: provider.requiresCredential,
    ...(connection
      ? {
          id: connection.id,
          name: connection.name ?? '',
          baseURL: connection.baseURL,
          protocol: connection.protocol ?? 'chat-completions',
          hasCredential: connection.hasCredential,
          modelNames: connection.modelNames,
          modelIds: connection.modelIds ?? [],
          defaultModelIds: connection.defaultModelIds ?? [],
        }
      : {}),
  });
}
function presetLabel(provider: Provider) {
  return provider.id === 'compatible' ? '自定义服务商' : provider.label;
}
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
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeProviderSubmission[];
  onSaved?: () => void;
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const fieldId = useId();
  const [facts, setFacts] = useState<NativeProviderSettingsFacts>();
  const [providerId, setProviderId] = useState<NativeProvider>();
  const [panelMode, setPanelMode] = useState<PanelMode>();
  const [name, setName] = useState('');
  const [draftBasis, setDraftBasis] = useState<{
    storeId: string;
    observationId: number;
    fingerprint: string;
  }>();
  const editorVersion = useRef(0);
  const panelCurrent = useRef(providerId);
  panelCurrent.current = providerId;
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<Protocol>('chat-completions');
  const [baseURL, setBaseURL] = useState(''),
    [modelNames, setModelNames] = useState(''),
    [secret, setSecret] = useState('');
  const [credential, setCredential] = useState<NativeProviderOperation['credential']>('replace');
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'url' | 'key';
    message: string;
  }>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [writing, setWriting] = useState(false);
  const [local, setLocal] = useState<NativeProviderSubmission[]>([]);
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const mounted = useRef(true);
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0),
    flight = useRef(false);
  const nameField = useRef<HTMLInputElement>(null),
    presetField = useRef<HTMLSelectElement>(null),
    cancelField = useRef<HTMLButtonElement>(null),
    addButton = useRef<HTMLButtonElement>(null),
    urlField = useRef<HTMLInputElement>(null),
    keyField = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
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
  const entries =
    facts?.providers.flatMap((provider) =>
      provider.connections.map((connection) => ({ provider, connection })),
    ) ?? [];
  const draftStale =
    !!draftBasis &&
    (!facts ||
      !provider ||
      draftBasis.storeId !== facts.storeId ||
      (connectionId !== null && draftBasis.observationId !== facts.observationId) ||
      draftBasis.fingerprint !== connectionFingerprint(provider, connection));
  const blockedRemoval =
    !!connection?.defaultModelIds?.length || !!connection?.scheduledTaskNames?.length;
  const writable =
    facts?.canWrite &&
    provider?.id !== 'codex' &&
    (panelMode === 'add' || !!connection) &&
    (!connection || connection.canWrite) &&
    !pending &&
    !draftStale &&
    !reading &&
    !writing;
  const panelTitle =
    panelMode === 'remove' ? '删除提供商' : panelMode === 'edit' ? '编辑提供商' : '新增提供商';
  const editingLabel =
    provider && connection
      ? connectionLabel(provider, connection)
      : provider
        ? presetLabel(provider)
        : '选择服务商预设';
  function remember(submission: NativeProviderSubmission) {
    setLocal((values) => [
      ...values.filter((entry) => entry.commandId !== submission.commandId),
      submission,
    ]);
  }
  async function read(afterSave?: 'upsert' | 'remove') {
    const editing = editorVersion.current;
    const original = identity,
      request = ++sequence.current;
    setReading(true);
    // Main releases the previous observation before reading; closing cannot restore it.
    setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
    setError('');
    try {
      const response = await bridge.request({ method: 'settings.providers.read', generation });
      if (current.current !== original || sequence.current !== request) return false;
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
      return true;
    } catch (cause) {
      if (
        current.current === original &&
        sequence.current === request &&
        (!afterSave || editing === editorVersion.current)
      ) {
        setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
        setError(
          `${afterSave === 'remove' ? '已删除，刷新配置失败；请刷新列表，无需重复删除。' : afterSave ? '已保存，刷新配置失败；请刷新后选择模型，无需重复保存。' : '提供商配置读取失败：'}${safeError(cause)}`,
        );
      }
      return false;
    } finally {
      if (current.current === original && sequence.current === request) setReading(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The host selection seals the read identity.
  useEffect(() => {
    mounted.current = true;
    sequence.current++;
    setFacts(undefined);
    setProviderId(undefined);
    setPanelMode(undefined);
    setDraftBasis(undefined);
    setName('');
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setError('');
    setWriting(false);
    flight.current = false;
    void read();
    return () => {
      mounted.current = false;
      sequence.current++;
      void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  function choose(
    entry: Provider,
    existing?: Connection,
    mode: PanelMode = 'add',
    button?: HTMLButtonElement,
  ) {
    editorVersion.current++;
    if (button) origin.current = button;
    setPanelMode(mode);
    setProviderId(entry.id);
    setConnectionId(existing?.id ?? null);
    setDraftBasis(
      facts
        ? {
            storeId: facts.storeId,
            observationId: facts.observationId,
            fingerprint: connectionFingerprint(entry, existing),
          }
        : undefined,
    );
    setName(existing ? connectionLabel(entry, existing) : presetLabel(entry));
    setProtocol(existing?.protocol ?? 'chat-completions');
    setBaseURL(existing?.baseURL ?? entry.defaultBaseURL);
    setModelNames(existing?.modelNames.join('\n') ?? '');
    setSecret('');
    setCredential(existing?.hasCredential ? 'keep' : entry.requiresCredential ? 'replace' : 'none');
    setFieldError(undefined);
    setError('');
  }
  function add(button: HTMLButtonElement) {
    const preset = facts?.providers.find((entry) => entry.id !== 'codex');
    if (preset) choose(preset, undefined, 'add', button);
  }
  function close() {
    restoreFocus.current = true;
    editorVersion.current++;
    sequence.current++;
    setReading(false);
    setProviderId(undefined);
    setPanelMode(undefined);
    setDraftBasis(undefined);
    setName('');
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setFieldError(undefined);
    void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
  }
  const closeCurrent = useRef(close);
  closeCurrent.current = close;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching between instances of one preset must reset field focus.
  useEffect(() => {
    if (editorControl)
      editorControl.current = panelMode ? { close: () => closeCurrent.current() } : null;
    if (!panelMode && restoreFocus.current) {
      restoreFocus.current = false;
      (origin.current?.isConnected ? origin.current : addButton.current)?.focus();
    }
    if (panelMode && panelHost) {
      if (panelMode === 'remove') cancelField.current?.focus();
      else if (panelMode === 'add') presetField.current?.focus();
      else nameField.current?.focus();
    }
    return () => {
      if (editorControl) editorControl.current = null;
    };
  }, [providerId, connectionId, panelMode, panelHost, editorControl]);
  async function save() {
    if (!facts || !provider || !writable || flight.current) return;
    if (panelMode === 'remove') {
      if (!connection || blockedRemoval) return;
      await submit({
        kind: 'remove',
        provider: provider.id,
        connectionId: connection.id,
        baseURL: connection.baseURL,
        ...(supportsResponses(provider.id)
          ? { protocol: connection.protocol ?? 'chat-completions' }
          : {}),
        modelNames: [],
        credential: 'none',
      });
      return;
    }
    if (!name.trim()) {
      setFieldError({ field: 'name', message: '请输入提供商名称。' });
      nameField.current?.focus();
      return;
    }
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
    const operation: NativeProviderOperation = {
      kind: 'upsert',
      name: name.trim(),
      provider: provider.id,
      connectionId,
      baseURL: baseURL.trim(),
      ...(supportsResponses(provider.id) ? { protocol } : {}),
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
    await submit(operation, credential === 'replace' ? secret : undefined);
  }
  async function submit(operation: NativeProviderOperation, key?: string) {
    if (!facts || flight.current) return;
    const original = identity,
      request = ++sequence.current,
      editing = editorVersion.current;
    const action = operation.kind === 'remove' ? '删除' : '保存';
    setSecret('');
    setFieldError(undefined);
    setError('');
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
      if (!mounted.current) return;
      remember(response);
      if (current.current === original && response.phase === 'applied') onSaved?.();
      if (
        current.current !== original ||
        sequence.current !== request ||
        editorVersion.current !== editing
      )
        return;
      if (response.phase === 'applied') {
        if (editorVersion.current !== editing || panelCurrent.current !== operation.provider)
          return;
        await refreshApplied(operation, editing);
      } else if (response.phase !== 'unknown' && response.error)
        setError(`${action}失败：${response.error}`);
    } catch {
      if (
        current.current === original &&
        sequence.current === request &&
        editorVersion.current === editing
      )
        setError(`${action}结果未确认，请查看结果。`);
    } finally {
      if (mounted.current && current.current === original) {
        flight.current = false;
        setWriting(false);
      }
    }
  }
  async function refreshApplied(
    operation: NativeProviderOperation,
    editing: number,
    closeEditor = true,
  ) {
    if (
      (await read(operation.kind ?? 'upsert')) &&
      editorVersion.current === editing &&
      closeEditor
    )
      close();
  }
  async function lookup(submission: NativeProviderSubmission) {
    if (flight.current) return;
    const original = identity,
      editing = editorVersion.current;
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
      if (!mounted.current) return;
      remember(response);
      if (response.phase === 'applied' && current.current === original) onSaved?.();
      if (current.current === original && editing === editorVersion.current) {
        setError(
          response.phase === 'failed'
            ? `更改失败：${response.error ?? 'configuration_unavailable'}`
            : '',
        );
        if (response.phase === 'applied')
          await refreshApplied(
            response.operation,
            editing,
            panelCurrent.current === response.operation.provider &&
              connectionId === response.operation.connectionId &&
              (panelMode === 'remove') === (response.operation.kind === 'remove'),
          );
      }
    } catch {
      if (mounted.current && current.current === original && editing === editorVersion.current)
        setError('暂时无法查看结果，请稍后重试。');
    } finally {
      if (mounted.current && current.current === original) {
        flight.current = false;
        setWriting(false);
      }
    }
  }
  const unresolvedSubmissions = originals.filter((submission) => submission.phase === 'unknown');
  const unresolvedNotice = unresolvedSubmissions.length > 0 && (
    <section className="provider-pending" aria-label="待确认的提供商更改">
      {unresolvedSubmissions.map((submission) => (
        <div className="provider-notice" key={submission.commandId}>
          <p role="status">
            {submission.operation.name ||
              facts?.providers.find((entry) => entry.id === submission.operation.provider)?.label ||
              submission.operation.provider}
            ：{submission.operation.kind === 'remove' ? '删除' : '保存'}结果待确认。
            {facts && submission.storeId !== facts.storeId && '此更改来自先前的数据源。'}
          </p>
          <button
            className="provider-button"
            type="button"
            disabled={reading || writing}
            onClick={() => void lookup(submission)}
          >
            查看结果
          </button>
        </div>
      ))}
    </section>
  );
  return (
    <section aria-label="提供商设置" className="provider-settings" aria-busy={reading || undefined}>
      <header className="provider-page-heading">
        <div>
          <h2>提供商</h2>
          <p>连接你的模型服务，按需配置接口与模型。</p>
        </div>
        <div className="provider-page-actions">
          <button
            className="provider-button provider-refresh"
            type="button"
            aria-label="刷新提供商配置"
            disabled={reading || writing}
            onClick={() => void read()}
          >
            <ProviderIcon name="refresh" />
            <span>刷新配置</span>
          </button>
          <button
            ref={addButton}
            aria-expanded={panelMode === 'add'}
            aria-controls={panelMode === 'add' ? `${fieldId}-editor` : undefined}
            className="provider-button provider-save"
            type="button"
            disabled={!facts}
            onClick={(event) => add(event.currentTarget)}
          >
            <ProviderIcon name="plus" />
            新增提供商
          </button>
        </div>
      </header>
      {!panelMode && error && (
        <p className="provider-notice provider-notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-workspace">
        <div className="provider-directory">
          <div className="provider-directory-heading">
            <span>已添加的提供商</span>
            <span>{facts ? entries.length : '—'}</span>
          </div>
          <ul aria-label="提供商列表" className="provider-instance-list">
            {entries.map(({ provider: entry, connection: item }) => {
              const label = connectionLabel(entry, item);
              const selected =
                providerId === entry.id && connectionId === item.id && panelMode !== 'add';
              return (
                <li
                  className="provider-instance"
                  key={`${entry.id}/${item.id}`}
                  data-selected={selected || undefined}
                >
                  <ProviderMark provider={entry.id} />
                  <div className="provider-instance-info">
                    <strong>{label}</strong>
                    <span>
                      {presetLabel(entry)} · {protocolLabel(item.protocol)} ·{' '}
                      {item.modelNames.length} 个模型
                    </span>
                    {entry.id === 'codex' && (
                      <span>由本机 Codex 登录管理，自动复用认证；模型可在模型设置中选择。</span>
                    )}
                  </div>
                  <span className={`provider-badge${item.canWrite ? ' is-configured' : ''}`}>
                    <span className="provider-status-dot" />
                    {entry.id === 'codex' ? '自动接入' : item.canWrite ? '已配置' : '只读'}
                  </span>
                  {entry.id !== 'codex' && (
                    <div className="provider-instance-actions">
                      <button
                        className="provider-button"
                        type="button"
                        aria-label={`编辑 ${label}`}
                        aria-expanded={selected && panelMode === 'edit'}
                        aria-controls={selected ? `${fieldId}-editor` : undefined}
                        onClick={(event) => choose(entry, item, 'edit', event.currentTarget)}
                      >
                        编辑
                      </button>
                      <button
                        className="provider-button provider-delete-link"
                        type="button"
                        aria-label={`删除 ${label}`}
                        aria-expanded={selected && panelMode === 'remove'}
                        aria-controls={selected ? `${fieldId}-editor` : undefined}
                        onClick={(event) => choose(entry, item, 'remove', event.currentTarget)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {facts && !entries.length && (
            <div className="provider-empty">
              <ProviderIcon name="connection" />
              <h3>尚未添加提供商</h3>
              <p>添加一个模型服务，开始配置你的模型。</p>
              <button
                className="provider-button"
                type="button"
                onClick={(event) => add(event.currentTarget)}
              >
                添加第一个提供商
              </button>
            </div>
          )}
        </div>
        {panelMode &&
          panelHost &&
          createPortal(
            <RightSidebar
              id={`${fieldId}-editor`}
              label={provider ? `${editingLabel} 配置` : '新增提供商'}
              title={panelTitle}
              onClose={close}
            >
              <div className="provider-settings provider-panel-content">
                {!provider ? (
                  <p className="provider-notice" role="status">
                    请刷新配置后重试。
                  </p>
                ) : panelMode !== 'add' && !connection ? (
                  <div className="provider-editor">
                    <div className="provider-editor-body">
                      <p className="provider-notice" role="status">
                        此提供商已不在最新配置中，请返回列表重新选择。
                      </p>
                    </div>
                    <footer className="provider-editor-footer">
                      <button className="provider-button" type="button" onClick={close}>
                        返回列表
                      </button>
                    </footer>
                  </div>
                ) : panelMode === 'remove' && connection ? (
                  <form
                    className="provider-editor"
                    aria-label={`删除 ${editingLabel} 确认`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <header className="provider-editor-heading">
                      <ProviderMark provider={provider.id} />
                      <div>
                        <h3>{editingLabel}</h3>
                        <p>删除前确认影响范围</p>
                      </div>
                    </header>
                    <div className="provider-editor-body">
                      {draftStale && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {panelMode === 'remove'
                            ? '已重新读取配置。请从列表重新打开此提供商，重新确认删除影响。'
                            : '已重新读取配置，当前草稿已保留。请从列表重新打开此提供商，核对最新配置后再提交。'}
                        </p>
                      )}
                      {error && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {error}
                        </p>
                      )}
                      <section className="provider-removal-impact" aria-label="删除影响">
                        <h4>将删除 {connection.modelNames.length} 个关联模型</h4>
                        {connection.modelNames.length ? (
                          <ul>
                            {connection.modelNames.map((model, index) => (
                              <li key={`${index}/${model}`}>{model}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>此提供商没有关联模型。</p>
                        )}
                        <p>仅删除此连接及其模型配置。系统凭证库中的 API key 会保留。</p>
                        <p>不会自动选择替代模型，也不会修改已经开始的运行。</p>
                        {connection.defaultModelIds?.length ? (
                          <p className="provider-notice provider-notice-error" role="alert">
                            此提供商包含当前全局默认模型。请先在“模型”设置中选择其他默认模型，再删除。
                          </p>
                        ) : (
                          <p>不影响当前全局默认模型。</p>
                        )}
                        {connection.scheduledTaskNames?.length ? (
                          <div className="provider-notice provider-notice-error" role="alert">
                            <p>以下定时任务正在使用此提供商的模型，请先修改或删除这些任务：</p>
                            <ul>
                              {connection.scheduledTaskNames.map((task, index) => (
                                <li key={`${index}/${task}`}>{task}</li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p>没有定时任务引用此提供商的模型。</p>
                        )}
                      </section>
                      {pending && !unresolvedSubmissions.length && (
                        <p className="provider-notice" role="status">
                          有提供商更改尚未确认，暂时无法保存。
                        </p>
                      )}
                      {facts && !facts.canWrite && !pending && !reading && (
                        <p className="provider-notice" role="status">
                          当前配置只读，请刷新并检查配置错误后重试。
                        </p>
                      )}
                      {unresolvedNotice}
                    </div>
                    <footer className="provider-editor-footer">
                      <button
                        ref={cancelField}
                        className="provider-button"
                        type="button"
                        onClick={close}
                      >
                        取消
                      </button>
                      <button
                        className="provider-button provider-remove"
                        type="submit"
                        disabled={!writable || blockedRemoval}
                      >
                        {writing ? '正在删除…' : '确认删除提供商'}
                      </button>
                    </footer>
                  </form>
                ) : (
                  <form
                    className="provider-editor"
                    aria-label={`${editingLabel} 配置`}
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <header className="provider-editor-heading">
                      <ProviderMark provider={provider.id} />
                      <div>
                        <h3>{editingLabel}</h3>
                        <p>{connection ? presetLabel(provider) : '添加新的模型连接'}</p>
                      </div>
                    </header>
                    <div className="provider-editor-body">
                      {draftStale && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {panelMode === 'remove'
                            ? '已重新读取配置。请从列表重新打开此提供商，重新确认删除影响。'
                            : '已重新读取配置，当前草稿已保留。请从列表重新打开此提供商，核对最新配置后再提交。'}
                        </p>
                      )}
                      {error && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {error}
                        </p>
                      )}
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-connection-heading`}
                      >
                        <h4 id={`${fieldId}-connection-heading`}>
                          <ProviderIcon name="connection" />
                          连接设置
                        </h4>
                        <div className="provider-form-grid">
                          {panelMode === 'add' && (
                            <label className="provider-field">
                              <span>服务商预设</span>
                              <select
                                ref={presetField}
                                aria-label="服务商预设"
                                value={provider.id}
                                disabled={writing}
                                onChange={(event) => {
                                  const preset = facts?.providers.find(
                                    (entry) =>
                                      entry.id !== 'codex' &&
                                      entry.id === event.currentTarget.value,
                                  );
                                  if (preset) choose(preset);
                                }}
                              >
                                {facts?.providers
                                  .filter((entry) => entry.id !== 'codex')
                                  .map((entry) => (
                                    <option key={entry.id} value={entry.id}>
                                      {presetLabel(entry)}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          )}
                          <label className="provider-field">
                            <span>提供商名称</span>
                            <input
                              ref={nameField}
                              aria-label="提供商名称"
                              aria-describedby={
                                fieldError?.field === 'name' ? `${fieldId}-name-error` : undefined
                              }
                              maxLength={80}
                              value={name}
                              disabled={writing}
                              aria-invalid={fieldError?.field === 'name'}
                              onInput={(event) => {
                                setName(event.currentTarget.value);
                                setFieldError(undefined);
                              }}
                            />
                          </label>
                          {fieldError?.field === 'name' && (
                            <p
                              className="provider-field-error"
                              id={`${fieldId}-name-error`}
                              role="alert"
                            >
                              {fieldError.message}
                            </p>
                          )}
                          {supportsResponses(provider.id) && (
                            <label className="provider-field">
                              <span>API 协议</span>
                              <select
                                aria-label="API 协议"
                                aria-describedby={`${fieldId}-protocol-help`}
                                value={protocol}
                                disabled={writing}
                                onChange={(event) => {
                                  setProtocol(event.currentTarget.value as Protocol);
                                }}
                              >
                                <option value="chat-completions">Chat Completions</option>
                                <option value="responses">Responses</option>
                              </select>
                            </label>
                          )}
                        </div>
                        {supportsResponses(provider.id) && (
                          <p className="provider-field-help" id={`${fieldId}-protocol-help`}>
                            按服务商支持的接口选择；现有配置默认使用 Chat Completions。
                          </p>
                        )}
                        <label className="provider-field">
                          <span>服务地址</span>
                          <input
                            ref={urlField}
                            aria-label="服务地址"
                            aria-describedby={
                              fieldError?.field === 'url'
                                ? `${fieldId}-url-error`
                                : `${fieldId}-url-help`
                            }
                            type="text"
                            spellCheck={false}
                            placeholder="https://api.example.com/v1"
                            value={baseURL}
                            disabled={writing}
                            aria-invalid={fieldError?.field === 'url'}
                            onInput={(event) => {
                              setBaseURL(event.currentTarget.value);
                              setFieldError(undefined);
                            }}
                          />
                        </label>
                        {fieldError?.field === 'url' ? (
                          <p
                            className="provider-field-error"
                            id={`${fieldId}-url-error`}
                            role="alert"
                          >
                            {fieldError.message}
                          </p>
                        ) : (
                          <p className="provider-field-help" id={`${fieldId}-url-help`}>
                            填写 API 基础地址，无需追加 /chat/completions 或 /responses。
                          </p>
                        )}
                      </section>
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-credential-heading`}
                      >
                        <h4 id={`${fieldId}-credential-heading`}>
                          <ProviderIcon name="shield" />
                          访问凭据
                        </h4>
                        <label className="provider-field">
                          <span>凭据</span>
                          <select
                            aria-label="凭据处理"
                            value={credential}
                            disabled={writing}
                            onChange={(event) => {
                              setCredential(
                                event.currentTarget.value as NativeProviderOperation['credential'],
                              );
                              setSecret('');
                              setFieldError(undefined);
                            }}
                          >
                            {connection?.hasCredential && (
                              <option value="keep">保留已保存凭据</option>
                            )}
                            <option value="replace">保存新 API key</option>
                            {!provider.requiresCredential && (
                              <option value="none">不使用凭据</option>
                            )}
                          </select>
                        </label>
                        {credential === 'replace' && (
                          <label className="provider-field">
                            <span>
                              API key <span className="provider-field-optional">仅用于此连接</span>
                            </span>
                            <input
                              ref={keyField}
                              aria-label="API key"
                              aria-describedby={
                                fieldError?.field === 'key'
                                  ? `${fieldId}-key-error`
                                  : `${fieldId}-key-help`
                              }
                              autoComplete="off"
                              spellCheck={false}
                              type="password"
                              placeholder="输入 API key"
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
                        {fieldError?.field === 'key' ? (
                          <p
                            className="provider-field-error"
                            id={`${fieldId}-key-error`}
                            role="alert"
                          >
                            {fieldError.message}
                          </p>
                        ) : (
                          <p className="provider-field-help" id={`${fieldId}-key-help`}>
                            {credential === 'keep'
                              ? '继续使用已保存的凭据，无需重新输入。'
                              : credential === 'none'
                                ? '此连接不会附带 API key。'
                                : '提交后清空输入，密钥不会回显。'}
                          </p>
                        )}
                      </section>
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-models-heading`}
                      >
                        <h4 id={`${fieldId}-models-heading`}>
                          <ProviderIcon name="models" />
                          模型
                        </h4>
                        <label className="provider-field">
                          <span>
                            模型名称 <span className="provider-field-optional">可选</span>
                          </span>
                          <textarea
                            aria-label="模型名称"
                            aria-describedby={`${fieldId}-models-help`}
                            rows={3}
                            spellCheck={false}
                            placeholder="每行输入一个模型名称"
                            value={modelNames}
                            disabled={writing}
                            onInput={(event) => setModelNames(event.currentTarget.value)}
                          />
                        </label>
                        <p className="provider-field-help" id={`${fieldId}-models-help`}>
                          每行一个准确模型名称；留空时保存会查询该连接的模型目录。
                        </p>
                      </section>
                      {pending && !unresolvedSubmissions.length && (
                        <p className="provider-notice" role="status">
                          有提供商更改尚未确认，暂时无法保存。
                        </p>
                      )}
                      {facts && !facts.canWrite && !pending && !reading && (
                        <p className="provider-notice" role="status">
                          当前配置只读，请刷新并检查配置错误后重试。
                        </p>
                      )}
                      {unresolvedNotice}
                    </div>
                    <footer className="provider-editor-footer">
                      <button className="provider-button" type="button" onClick={close}>
                        取消
                      </button>
                      <button
                        className="provider-button provider-save"
                        type="submit"
                        disabled={!writable}
                      >
                        {writing ? '正在保存…' : '保存提供商配置'}
                      </button>
                    </footer>
                  </form>
                )}
              </div>
            </RightSidebar>,
            panelHost,
          )}
      </div>
      {facts?.errors.map((code) => (
        <p className="provider-notice provider-notice-error" role="alert" key={code}>
          {code}
        </p>
      ))}
      {!panelMode && unresolvedNotice}
    </section>
  );
}
