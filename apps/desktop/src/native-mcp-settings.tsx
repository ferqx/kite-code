import type { UserMcpSettingsView, UserMcpToolsPage } from '@kite-ai/client';
import { RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeUserMcpFacts,
  NativeUserMcpOperation,
  NativeUserMcpRequest,
  NativeUserMcpResult,
  NativeUserMcpSubmission,
} from './mcp-bridge';
import type { NativeBridge } from './native-bridge';

type Source = UserMcpSettingsView['sources'][number];
const pending = (value: NativeUserMcpSubmission) =>
  ['submitting', 'pending', 'outcome_unknown'].includes(value.phase);
const errorCode = (error: unknown) =>
  (error as { code?: string })?.code ?? (error as Error)?.message ?? '';
const errorMessage = (code?: string) =>
  (
    ({
      mcp_name_required: '请填写名称，只使用字母、数字、点、横线或下划线。',
      mcp_http_url_invalid: '请填写不含登录信息或查询参数的 HTTP 地址。',
      mcp_absolute_command_required: '请填写启动命令的绝对路径。',
      mcp_scope_unavailable: '暂时无法连接服务，请稍后重试。',
      mcp_observation_changed: '配置已变化，请刷新后重试。',
      mcp_operation_pending: '请先查看尚未确认的操作结果。',
      mcp_storage_unavailable: '暂时无法保存操作，请重新打开应用后重试。',
      mcp_tools_unavailable: '暂时无法读取工具，请刷新连接后重试。',
      mcp_source_changed: '配置已变化，请刷新后重试。',
      mcp_source_unavailable: '暂时无法读取配置，请刷新后重试。',
      mcp_intent_consumed: '该操作已经提交，请查看操作结果。',
    }) as Record<string, string>
  )[code ?? ''] ?? '暂时无法完成操作，请刷新后重试。';
const operationLabel: Record<NativeUserMcpOperation['kind'], string> = {
  add: '添加 MCP',
  remove: '删除 MCP',
  enabled: '更改启用状态',
  authStatus: '检查登录状态',
  login: '登录',
  authRefresh: '刷新登录',
  clear: '清除登录',
  revoke: '撤销登录',
  bind: '绑定登录信息',
  connect: '连接',
  refresh: '刷新工具',
  reconnect: '重新连接',
  disconnect: '断开连接',
};
const connectionLabel = (source: Source) =>
  !source.configured && source.connection.state !== 'disconnected'
    ? source.connection.state === 'outcome_unknown'
      ? '连接待确认'
      : '待断开'
    : !source.enabled
      ? '已停用'
      : {
          disconnected: '未连接',
          connecting: '连接中',
          ready: '已连接',
          failed: '连接失败',
          outcome_unknown: '连接待确认',
        }[source.connection.state];
const authenticationLabel = (source: Source) =>
  ({
    none: '无需登录',
    missing: '未登录',
    present: '已登录',
    locked: '登录信息已锁定',
    unavailable: '登录状态不可用',
    unknown: '尚未检查',
  })[source.authentication.status];
const toolInfo = (
  value: unknown,
): { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown } => {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    name: typeof row.name === 'string' ? row.name : '工具',
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    ...('inputSchema' in row ? { inputSchema: row.inputSchema } : {}),
    ...('outputSchema' in row ? { outputSchema: row.outputSchema } : {}),
  };
};

export function NativeMcpSettings({
  bridge,
  generation,
  storeId,
  submissions,
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
  submissions: readonly NativeUserMcpSubmission[];
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const fieldId = useId();
  const [facts, setFacts] = useState<NativeUserMcpFacts>();
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'add' } | { kind: 'source'; id: string }>();
  const [review, setReview] = useState<NativeUserMcpOperation>();
  const [name, setName] = useState(''),
    [transport, setTransport] = useState<'http' | 'stdio'>('http'),
    [address, setAddress] = useState('');
  const [expiry, setExpiry] = useState('');
  const [local, setLocal] = useState<NativeUserMcpSubmission[]>([]);
  const [tools, setTools] = useState<UserMcpToolsPage>(),
    [toolsLoading, setToolsLoading] = useState(false);
  const [expandedTool, setExpandedTool] = useState<number>();
  const [fieldError, setFieldError] = useState<'name' | 'address'>();
  const addButton = useRef<HTMLButtonElement>(null),
    refreshButton = useRef<HTMLButtonElement>(null),
    origin = useRef<HTMLElement | null>(null),
    nameField = useRef<HTMLInputElement>(null),
    addressField = useRef<HTMLInputElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const identity = `${generation}/${storeId ?? ''}`,
    current = useRef(identity);
  current.current = identity;
  const readVersion = useRef(0),
    toolVersion = useRef(0),
    flight = useRef(false),
    restoreFocus = useRef(false);
  const records = new Map(local.map((row) => [row.commandId, row]));
  for (const row of submissions) records.set(row.commandId, row);
  const notices = [...records.values()].filter(
    (row) => row.phase !== 'completed' && row.phase !== 'cancelled',
  );
  const pendingOperation = [...records.values()].some(
    (row) => row.storeId === storeId && pending(row) && (!row.legacy || row.legacyUser),
  );
  const writable = !!facts?.canWrite && !busy && !pendingOperation && !reading;
  const source =
    panel?.kind === 'source' ? facts?.sources.find((row) => row.id === panel.id) : undefined;
  const cleanupOnly = !!source && (!source.configured || !facts?.canWrite);
  const sourceName = (id: string) => facts?.sources.find((row) => row.id === id)?.name ?? 'MCP';
  const canCleanup = (operation: NativeUserMcpOperation) =>
    operation.kind === 'disconnect' &&
    !!facts?.sources.some(
      (row) =>
        row.id === operation.serverId &&
        (!row.configured || !facts?.canWrite) &&
        row.connection.state !== 'disconnected',
    ) &&
    !busy &&
    !reading &&
    ![...records.values()].some(
      (row) =>
        row.storeId === storeId &&
        pending(row) &&
        !row.legacy &&
        row.operation.kind === 'disconnect' &&
        row.operation.serverId === operation.serverId,
    );

  const remember = (row: NativeUserMcpSubmission) =>
    setLocal((rows) => [...rows.filter((old) => old.commandId !== row.commandId), row]);
  async function request(
    input: NativeUserMcpRequest,
    isCurrent: () => boolean = () => true,
  ): Promise<NativeUserMcpResult | undefined> {
    const original = identity;
    try {
      const result = await bridge.request(input);
      if (current.current !== original || !isCurrent()) return undefined;
      if (!result || !('kind' in result) || !result.kind.startsWith('settings.userMcp'))
        throw Error('mcp_source_unavailable');
      return result as NativeUserMcpResult;
    } catch (cause) {
      if (current.current === original && isCurrent()) setError(errorCode(cause));
    }
    return undefined;
  }
  function resetTools() {
    toolVersion.current++;
    setTools(undefined);
    setExpandedTool(undefined);
    setToolsLoading(false);
  }
  async function read() {
    const original = identity,
      version = ++readVersion.current;
    setReading(true);
    setError('');
    resetTools();
    const result = await request({ method: 'settings.userMcp.read', generation });
    if (current.current !== original || readVersion.current !== version) return;
    setReading(false);
    if (result?.kind === 'settings.userMcp' && result.storeId === storeId) {
      setFacts(result);
      setReview(undefined);
    }
  }
  function closePanel(restore = true) {
    resetTools();
    setPanel(undefined);
    setReview(undefined);
    setError('');
    restoreFocus.current = restore;
  }
  function openPanel(next: NonNullable<typeof panel>, trigger: HTMLElement) {
    resetTools();
    origin.current = trigger;
    restoreFocus.current = false;
    setError('');
    setFieldError(undefined);
    setReview(undefined);
    setPanel(next);
    if (next.kind === 'add') {
      setName('');
      setAddress('');
      setTransport('http');
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: this read lease follows only the global Store and connection identity.
  useEffect(() => {
    setFacts(undefined);
    setLocal([]);
    closePanel(false);
    flight.current = false;
    setBusy(false);
    void read();
    return () => {
      if (current.current === identity) current.current = `${identity}/closed`;
      readVersion.current++;
      toolVersion.current++;
      void bridge.request({ method: 'settings.userMcp.close', generation }).catch(() => {});
    };
    // Session selection is deliberately absent from this global page identity.
  }, [identity, bridge, generation]);
  useEffect(() => {
    if (panel?.kind === 'add') nameField.current?.focus();
  }, [panel]);
  useEffect(() => {
    if (!panel && !reading && !busy && restoreFocus.current) {
      restoreFocus.current = false;
      (origin.current?.isConnected && !origin.current.matches(':disabled')
        ? origin.current
        : addButton.current && !addButton.current.disabled
          ? addButton.current
          : refreshButton.current
      )?.focus();
    }
  }, [panel, reading, busy]);
  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);
  useEffect(() => {
    if (!editorControl || !panel) return;
    const control = { close: () => closePanel() };
    editorControl.current = control;
    return () => {
      if (editorControl.current === control) editorControl.current = null;
    };
  });
  async function submit(operation: NativeUserMcpOperation) {
    if (!facts || flight.current) return;
    const cleanup = canCleanup(operation);
    if (!writable && !cleanup) return;
    const original = identity;
    flight.current = true;
    setBusy(true);
    setError('');
    const result = await request({
      method: 'settings.userMcp.submit',
      generation,
      observationId: facts.observationId,
      operation,
    });
    if (current.current !== original) return;
    flight.current = false;
    setBusy(false);
    if (result?.kind !== 'settings.userMcp.submission') return;
    remember(result);
    setReview(undefined);
    if (result.phase === 'completed') {
      if (operation.kind === 'add' || operation.kind === 'remove' || cleanup) closePanel();
      await read();
    }
  }
  async function recover(row: NativeUserMcpSubmission, cancel = false) {
    if (busy || row.association !== 'current' || flight.current) return;
    const original = identity;
    flight.current = true;
    setBusy(true);
    setError('');
    const result = await request({
      method: cancel ? 'settings.userMcp.cancel' : 'settings.userMcp.lookup',
      generation,
      commandId: row.commandId,
    });
    if (current.current !== original) return;
    flight.current = false;
    setBusy(false);
    if (result?.kind === 'settings.userMcp.submission') {
      remember(result);
      if (!pending(result)) await read();
    }
  }
  async function loadTools(afterIndex?: number) {
    if (!facts || !source || source.connection.generation === null || toolsLoading || reading)
      return;
    const version = ++toolVersion.current,
      original = identity;
    setToolsLoading(true);
    const result = await request(
      {
        method: 'settings.userMcp.tools',
        generation,
        observationId: facts.observationId,
        serverId: source.id,
        connectionGeneration: source.connection.generation,
        ...(afterIndex === undefined ? {} : { afterIndex }),
      },
      () => toolVersion.current === version,
    );
    if (current.current !== original || toolVersion.current !== version) return;
    setToolsLoading(false);
    if (result?.kind === 'settings.userMcp.tools' && result.page.serverId === source.id) {
      setTools((previous) =>
        afterIndex !== undefined && previous?.generation === result.page.generation
          ? { ...result.page, entries: [...previous.entries, ...result.page.entries] }
          : result.page,
      );
      if (afterIndex === undefined) setExpandedTool(undefined);
    }
  }
  function reviewAdd() {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name.trim())) {
      setError('mcp_name_required');
      setFieldError('name');
      nameField.current?.focus();
      return;
    }
    if (transport === 'http') {
      try {
        const url = new URL(address.trim());
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          address.includes('${')
        )
          throw Error();
      } catch {
        setError('mcp_http_url_invalid');
        setFieldError('address');
        addressField.current?.focus();
        return;
      }
    } else if (
      (!address.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(address)) ||
      [...address].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      address.includes('${')
    ) {
      setError('mcp_absolute_command_required');
      setFieldError('address');
      addressField.current?.focus();
      return;
    }
    setError('');
    setFieldError(undefined);
    setReview({
      kind: 'add',
      name: name.trim(),
      entry:
        transport === 'http'
          ? { type: 'http', url: address.trim() }
          : { type: 'stdio', command: address.trim() },
    });
  }
  const action = (
    label: string,
    operation: NativeUserMcpOperation,
    confirm = false,
    disabled = false,
  ) => (
    <button
      type="button"
      className="provider-button"
      disabled={(!writable && !canCleanup(operation)) || disabled}
      onClick={() => (confirm ? setReview(operation) : void submit(operation))}
    >
      {label}
    </button>
  );
  const alert = error && (
    <p className="provider-notice provider-notice-error" role="alert">
      {errorMessage(error)}
    </p>
  );
  return (
    <section
      className="catalogue-settings provider-settings"
      aria-label="MCP settings"
      aria-busy={reading || undefined}
    >
      <header className="provider-page-header">
        <div>
          <h2>MCP</h2>
          <p>管理你的工具服务、连接和登录信息。</p>
        </div>
        <div className="provider-page-actions">
          <button
            type="button"
            className="provider-button"
            onClick={() => void read()}
            disabled={reading || busy}
            aria-label="Refresh MCP settings"
            ref={refreshButton}
          >
            刷新
          </button>
          <button
            type="button"
            className="provider-button provider-save"
            ref={addButton}
            disabled={!writable}
            onClick={(event) => openPanel({ kind: 'add' }, event.currentTarget)}
          >
            新增 MCP
          </button>
        </div>
      </header>
      {!panel && alert}
      {facts?.errors.map((value, index) => (
        <p className="provider-notice provider-notice-error" role="alert" key={`${value}/${index}`}>
          {errorMessage(value)}
        </p>
      ))}
      {facts && (
        <section className="catalogue-section" aria-label="MCP sources">
          <div className="provider-directory-heading">
            <h3>我的 MCP</h3>
            <span>{facts.sources.length}</span>
          </div>
          <ul className="provider-instance-list">
            {facts.sources.map((row) => (
              <li
                key={row.id}
                className="provider-instance"
                data-selected={source?.id === row.id || undefined}
              >
                <span className="provider-mark catalogue-mark" aria-hidden="true">
                  ⌘
                </span>
                <div className="provider-instance-info">
                  <strong>{row.name}</strong>
                  <span>
                    {row.transport?.toUpperCase() ?? '配置需要检查'}
                    {row.address ? ` · ${row.address}` : ''}
                  </span>
                </div>
                <span
                  className={`provider-badge${row.connection.state === 'ready' ? ' is-configured' : ''}`}
                >
                  <span className="provider-status-dot" />
                  {connectionLabel(row)}
                </span>
                <div className="provider-instance-actions">
                  <button
                    type="button"
                    className="provider-button"
                    aria-label={`管理 ${row.name}`}
                    aria-expanded={source?.id === row.id}
                    aria-controls={source?.id === row.id ? `${fieldId}-editor` : undefined}
                    onClick={(event) =>
                      openPanel({ kind: 'source', id: row.id }, event.currentTarget)
                    }
                  >
                    管理
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!facts.sources.length && (
            <div className="provider-empty">
              <h3>暂无 MCP</h3>
              <p>添加工具服务即可开始使用。</p>
            </div>
          )}
        </section>
      )}
      {notices.map((row) => (
        <section
          className="provider-notice"
          key={row.commandId}
          aria-label={row.legacy ? '此前的 MCP 操作' : 'MCP 操作结果'}
        >
          <p>
            {row.legacy
              ? '此前的 MCP 操作'
              : row.operation.kind === 'add'
                ? row.operation.name
                : sourceName(row.operation.serverId)}{' '}
            · {pending(row) ? '操作结果待确认。' : '操作未完成。'}
          </p>
          {row.association !== 'current' && <p>连接原服务后可查看操作结果。</p>}
          <div className="catalogue-actions">
            <button
              type="button"
              className="provider-button"
              disabled={busy || row.association !== 'current'}
              onClick={() => void recover(row)}
            >
              查看结果
            </button>
            {pending(row) && !row.legacy && (
              <button
                type="button"
                className="provider-button"
                disabled={busy || row.association !== 'current'}
                onClick={() => void recover(row, true)}
              >
                取消操作
              </button>
            )}
          </div>
        </section>
      ))}
      {panel &&
        panelHost &&
        createPortal(
          <RightSidebar
            id={`${fieldId}-editor`}
            label={panel.kind === 'add' ? '新增 MCP' : (source?.name ?? 'MCP')}
            title={panel.kind === 'add' ? '新增 MCP' : (source?.name ?? 'MCP')}
            onClose={() => closePanel()}
          >
            <div className="catalogue-settings provider-panel-content">
              <div className="provider-editor">
                <div className="provider-editor-body">
                  {alert}
                  {panel.kind === 'add' && (
                    <form
                      id={`${fieldId}-add`}
                      aria-label="Add MCP source"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (writable) reviewAdd();
                      }}
                    >
                      <section className="provider-form-section">
                        <h4>连接信息</h4>
                        <div className="provider-form-grid">
                          <label className="provider-field">
                            名称
                            <input
                              ref={nameField}
                              aria-label="Name"
                              value={name}
                              aria-invalid={fieldError === 'name'}
                              onChange={(event) => {
                                setName(event.target.value);
                                setReview(undefined);
                              }}
                              placeholder="例如：knowledge-base"
                            />
                          </label>
                          <label className="provider-field">
                            传输方式
                            <select
                              aria-label="Transport"
                              value={transport}
                              onChange={(event) => {
                                setTransport(event.target.value as typeof transport);
                                setReview(undefined);
                              }}
                            >
                              <option value="http">HTTP URL</option>
                              <option value="stdio">stdio 本地命令</option>
                            </select>
                          </label>
                          <label className="provider-field">
                            {transport === 'http' ? '服务地址' : '命令的绝对路径'}
                            <input
                              ref={addressField}
                              aria-label="URL or command"
                              value={address}
                              aria-invalid={fieldError === 'address'}
                              onChange={(event) => {
                                setAddress(event.target.value);
                                setReview(undefined);
                              }}
                              placeholder={
                                transport === 'http'
                                  ? 'https://example.com/mcp'
                                  : '/absolute/path/to/server'
                              }
                            />
                          </label>
                        </div>
                      </section>
                    </form>
                  )}
                  {source && cleanupOnly && (
                    <section className="provider-form-section">
                      <h4>连接</h4>
                      <p>配置已不可用，可以断开已有连接。</p>
                      {action(
                        '断开连接',
                        { kind: 'disconnect', serverId: source.id },
                        false,
                        source.connection.state === 'disconnected',
                      )}
                    </section>
                  )}
                  {source && !cleanupOnly && (
                    <>
                      <section className="provider-form-section">
                        <h4>连接</h4>
                        <p>
                          {connectionLabel(source)}
                          {source.connection.toolCount !== null
                            ? ` · ${source.connection.toolCount} 个工具`
                            : ''}
                        </p>
                        <div className="catalogue-actions">
                          {action(source.enabled ? '停用' : '启用', {
                            kind: 'enabled',
                            serverId: source.id,
                            enabled: !source.enabled,
                          })}
                          {action(
                            '建立连接',
                            { kind: 'connect', serverId: source.id },
                            false,
                            !source.enabled ||
                              !source.configured ||
                              source.connection.state === 'ready',
                          )}
                          {action(
                            '重新连接',
                            { kind: 'reconnect', serverId: source.id },
                            true,
                            !source.enabled || !source.configured,
                          )}
                          {action(
                            '断开连接',
                            { kind: 'disconnect', serverId: source.id },
                            false,
                            source.connection.state === 'disconnected',
                          )}
                        </div>
                        {!!source.diagnostics.length && (
                          <p className="provider-field-help">连接配置需要检查，请修正后刷新。</p>
                        )}
                      </section>
                      <section className="provider-form-section">
                        <h4>登录信息</h4>
                        <p>{authenticationLabel(source)}</p>
                        <div className="catalogue-actions">
                          {action('检查状态', { kind: 'authStatus', serverId: source.id })}
                          {source.authentication.loginAllowed &&
                            action('登录', { kind: 'login', serverId: source.id })}
                          {source.authentication.policy !== 'none' && (
                            <>
                              {action('刷新登录', { kind: 'authRefresh', serverId: source.id })}
                              {action('清除登录', { kind: 'clear', serverId: source.id }, true)}
                              {action('撤销登录', { kind: 'revoke', serverId: source.id }, true)}
                            </>
                          )}
                        </div>
                        {source.authentication.policy === 'credential' && (
                          <div className="provider-form-grid">
                            <label className="provider-field">
                              登录信息有效期
                              <input
                                type="datetime-local"
                                aria-label="Credential expiry"
                                value={expiry}
                                onChange={(event) => setExpiry(event.target.value)}
                              />
                            </label>
                            <button
                              type="button"
                              className="provider-button"
                              disabled={
                                !writable ||
                                !Number.isFinite(Date.parse(expiry)) ||
                                Date.parse(expiry) <= Date.now()
                              }
                              onClick={() =>
                                setReview({
                                  kind: 'bind',
                                  serverId: source.id,
                                  expiresAt: Date.parse(expiry),
                                })
                              }
                            >
                              绑定登录信息
                            </button>
                          </div>
                        )}
                      </section>
                      <section className="provider-form-section">
                        <h4>工具</h4>
                        <div className="catalogue-actions">
                          <button
                            type="button"
                            className="provider-button"
                            disabled={
                              reading || toolsLoading || source.connection.state !== 'ready'
                            }
                            onClick={() => void loadTools()}
                          >
                            查看工具
                          </button>
                          {action(
                            '刷新工具',
                            { kind: 'refresh', serverId: source.id },
                            false,
                            source.connection.state !== 'ready',
                          )}
                        </div>
                        {tools && (
                          <>
                            <ul>
                              {tools.entries.map((entry) => {
                                const info = toolInfo(entry.descriptor);
                                return (
                                  <li key={entry.index}>
                                    <strong>{info.name}</strong>
                                    {info.description && <p>{info.description}</p>}
                                    {(info.inputSchema !== undefined ||
                                      info.outputSchema !== undefined) && (
                                      <button
                                        type="button"
                                        className="provider-button"
                                        onClick={() =>
                                          setExpandedTool(
                                            expandedTool === entry.index ? undefined : entry.index,
                                          )
                                        }
                                        aria-expanded={expandedTool === entry.index}
                                      >
                                        {expandedTool === entry.index ? '收起参数' : '查看参数'}
                                      </button>
                                    )}
                                    {expandedTool === entry.index && (
                                      <>
                                        {info.inputSchema !== undefined && (
                                          <>
                                            <h5>输入参数</h5>
                                            <pre data-mcp-schema="input">
                                              {JSON.stringify(info.inputSchema, null, 2)}
                                            </pre>
                                          </>
                                        )}
                                        {info.outputSchema !== undefined && (
                                          <>
                                            <h5>返回内容</h5>
                                            <pre data-mcp-schema="output">
                                              {JSON.stringify(info.outputSchema, null, 2)}
                                            </pre>
                                          </>
                                        )}
                                      </>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            {tools.nextAfterIndex !== null && (
                              <button
                                type="button"
                                className="provider-button"
                                disabled={toolsLoading}
                                onClick={() => void loadTools(tools.nextAfterIndex!)}
                              >
                                下一页
                              </button>
                            )}
                            {!tools.entries.length && tools.complete && <p>暂无工具。</p>}
                          </>
                        )}
                      </section>
                      <section className="provider-form-section">
                        <h4>删除</h4>
                        {action('删除 MCP', { kind: 'remove', serverId: source.id }, true)}
                      </section>
                    </>
                  )}
                  {review && (
                    <section
                      className="provider-form-section"
                      aria-label="Confirm exact MCP operation"
                    >
                      <h4 ref={heading} tabIndex={-1}>
                        确认更改
                      </h4>
                      <p>
                        {review.kind === 'add' ? review.name : sourceName(review.serverId)} ·{' '}
                        {operationLabel[review.kind]}
                        {review.kind === 'enabled' ? ` · ${review.enabled ? '启用' : '停用'}` : ''}
                      </p>
                      {review.kind === 'add' && (
                        <p>
                          {review.entry.type === 'http' ? review.entry.url : review.entry.command}
                        </p>
                      )}
                      <div className="catalogue-actions">
                        <button
                          type="button"
                          className="provider-button provider-save"
                          aria-label="Confirm exact MCP operation"
                          disabled={!writable}
                          onClick={() => void submit(review)}
                        >
                          确认
                        </button>
                        <button
                          type="button"
                          className="provider-button"
                          disabled={busy}
                          onClick={() => setReview(undefined)}
                        >
                          返回编辑
                        </button>
                      </div>
                    </section>
                  )}
                </div>
                {panel.kind === 'add' && !review && (
                  <footer className="provider-editor-footer">
                    <button
                      type="submit"
                      form={`${fieldId}-add`}
                      className="provider-button provider-save"
                      disabled={!writable}
                    >
                      添加
                    </button>
                  </footer>
                )}
              </div>
            </div>
          </RightSidebar>,
          panelHost,
        )}
    </section>
  );
}
