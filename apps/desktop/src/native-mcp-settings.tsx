import type { UserMcpSettingsView, UserMcpToolsPage } from '@kite-ai/client';
import { Button, Input, RightSidebar, SettingsActionIcon, Switch } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeUserMcpFacts,
  NativeUserMcpOperation,
  NativeUserMcpRequest,
  NativeUserMcpResult,
  NativeUserMcpSubmission,
} from './mcp-bridge';
import type { NativeBridge } from './native-bridge';
import { emptyMcpDraft, mcpDraftEntry, NativeMcpAddFields } from './native-mcp-add-form';
import { McpSourceMenu, McpToolCatalogue } from './native-mcp-components';
import {
  mcpSettingsError as errorMessage,
  type McpFeedbackNotice,
  mcpFeedbackNotices,
} from './native-mcp-feedback';
import { NativeSettingsListRow } from './native-settings-list-row';

type Source = UserMcpSettingsView['sources'][number];
const pending = (value: NativeUserMcpSubmission) =>
  ['submitting', 'pending', 'outcome_unknown'].includes(value.phase);
const errorCode = (error: unknown) =>
  (error as { code?: string })?.code ?? (error as Error)?.message ?? '';
const operationLabel: Record<NativeUserMcpOperation['kind'], string> = {
  add: '添加 MCP',
  remove: '删除 MCP',
  enabled: '更改启用状态',
  authStatus: '检查登录状态',
  login: '登录',
  authRefresh: '刷新登录',
  clear: '退出登录',
  revoke: '撤销授权',
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
      : '待清理'
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
  source.authentication.policy === 'environment'
    ? '使用环境变量'
    : {
        none: '无需登录',
        missing: '未登录',
        present: '已登录',
        locked: '登录信息已锁定',
        unavailable: '登录状态不可用',
        unknown: '尚未检查',
      }[source.authentication.status];

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
  const [observationValid, setObservationValid] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'add' } | { kind: 'source'; id: string }>();
  const activePanel = useRef(panel);
  activePanel.current = panel;
  const [review, setReview] = useState<NativeUserMcpOperation>();
  const [draft, setDraft] = useState(emptyMcpDraft);
  const { name, transport } = draft;
  const address = transport === 'http' ? draft.url : draft.command;
  const [expiry, setExpiry] = useState('');
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [pendingObservation, setPendingObservation] = useState(0);
  const [local, setLocal] = useState<NativeUserMcpSubmission[]>([]);
  const [tools, setTools] = useState<UserMcpToolsPage>(),
    [toolsLoading, setToolsLoading] = useState(false);
  const [toolsFailed, setToolsFailed] = useState(false);
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
    restoreReviewFocus = useRef(false),
    restoreFocus = useRef(false);
  // Keep Main's stable record order and authoritative states; local replies only fill missing IDs.
  const records = new Map(submissions.map((row) => [row.commandId, row]));
  for (const row of local) if (!records.has(row.commandId)) records.set(row.commandId, row);
  const notices = mcpFeedbackNotices([...records.values()], facts?.sources ?? [], dismissed);
  const pendingOperation = [...records.values()].some(
    (row) => row.storeId === storeId && pending(row) && (!row.legacy || row.legacyUser),
  );
  const livePendingId = [...records.values()].find(
    (row) =>
      row.storeId === storeId &&
      row.phase === 'pending' &&
      row.association === 'current' &&
      !row.legacy,
  )?.commandId;
  const writable = !!facts?.canWrite && observationValid && !busy && !pendingOperation && !reading;
  const source =
    panel?.kind === 'source' ? facts?.sources.find((row) => row.id === panel.id) : undefined;
  const cleanupOnly = !!source && (!source.configured || !facts?.canWrite);
  const sourceName = (id: string) => facts?.sources.find((row) => row.id === id)?.name ?? 'MCP';
  const statusLabel = (source: Source) => {
    const operation = [...records.values()].find(
      (row) =>
        row.storeId === storeId &&
        row.association === 'current' &&
        !row.legacy &&
        row.phase === 'pending' &&
        'serverId' in row.operation &&
        row.operation.serverId === source.id,
    )?.operation;
    return operation?.kind === 'login'
      ? '登录中'
      : operation?.kind === 'connect' || operation?.kind === 'reconnect'
        ? '连接中'
        : operation?.kind === 'disconnect'
          ? '正在断开'
          : connectionLabel(source);
  };
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
    setToolsFailed(false);
    setToolsLoading(false);
  }
  async function read() {
    const original = identity,
      version = ++readVersion.current;
    setReading(true);
    setObservationValid(false);
    setError('');
    resetTools();
    const result = await request({ method: 'settings.userMcp.read', generation });
    if (current.current !== original || readVersion.current !== version) return;
    setReading(false);
    if (result?.kind === 'settings.userMcp' && result.storeId === storeId) {
      setFacts(result);
      setObservationValid(true);
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
  function settlePanel(row: NativeUserMcpSubmission, observedPanel: typeof panel) {
    if (row.phase !== 'completed' || !observedPanel || activePanel.current !== observedPanel)
      return;
    const operation = row.operation;
    if (operation.kind === 'add' && observedPanel.kind === 'add') closePanel();
    else if (
      observedPanel.kind === 'source' &&
      'serverId' in operation &&
      observedPanel.id === operation.serverId &&
      (operation.kind === 'remove' || (operation.kind === 'disconnect' && cleanupOnly))
    )
      closePanel();
  }
  function openPanel(next: NonNullable<typeof panel>, trigger: HTMLElement) {
    if (panel?.kind === 'add' && next.kind === 'add') return;
    resetTools();
    origin.current = trigger;
    restoreFocus.current = false;
    setError('');
    setFieldError(undefined);
    setReview(undefined);
    setEditingExpiry(false);
    setExpiry('');
    setPanel(next);
    if (next.kind === 'add') {
      setDraft(emptyMcpDraft());
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: this read lease follows only the global Store and connection identity.
  useEffect(() => {
    setFacts(undefined);
    setLocal([]);
    setDismissed([]);
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
    if (review) {
      heading.current?.focus();
      restoreReviewFocus.current = true;
    } else if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      panelHost?.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')?.focus();
    }
  }, [review, panelHost]);
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
    const observedPanel = activePanel.current;
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
    if (result.phase === 'completed' && operation.kind === 'bind') setEditingExpiry(false);
    settlePanel(result, observedPanel);
    if (!pending(result)) await read();
  }
  async function recover(row: NativeUserMcpSubmission, cancel = false) {
    if (busy || row.association !== 'current' || flight.current) return;
    const original = identity;
    const observedPanel = activePanel.current;
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
    setPendingObservation((value) => value + 1);
    if (result?.kind === 'settings.userMcp.submission') {
      remember(result);
      settlePanel(result, observedPanel);
      if (!pending(result)) await read();
    }
  }
  const observePending = useEffectEvent((commandId: string) => {
    const row = records.get(commandId);
    if (row?.phase === 'pending' && row.storeId === storeId && row.association === 'current')
      void recover(row);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: every completed lookup, including an immediate pending reply, schedules the next observation.
  useEffect(() => {
    if (!livePendingId || busy || reading) return;
    // Only observe a live accepted operation. Cold/unknown originals still need an explicit lookup.
    const timer = setTimeout(() => observePending(livePendingId), 750);
    return () => clearTimeout(timer);
    // A fast pending reply can batch busy=true/false into one render; the next poll still needs a timer.
  }, [livePendingId, busy, reading, pendingObservation]);
  async function loadTools(afterIndex?: number) {
    if (
      !facts ||
      !observationValid ||
      !source ||
      source.connection.generation === null ||
      toolsLoading ||
      reading
    )
      return;
    const version = ++toolVersion.current,
      original = identity;
    setToolsLoading(true);
    setToolsFailed(false);
    setError('');
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
    setToolsFailed(!result);
    if (result?.kind === 'settings.userMcp.tools' && result.page.serverId === source.id) {
      setTools((previous) =>
        afterIndex !== undefined && previous?.generation === result.page.generation
          ? { ...result.page, entries: [...previous.entries, ...result.page.entries] }
          : result.page,
      );
    }
  }
  const observeTools = useEffectEvent(() => void loadTools());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new observation or connection retires the old catalogue lease.
  useEffect(() => {
    if (
      panel?.kind === 'source' &&
      source?.connection.state === 'ready' &&
      !cleanupOnly &&
      observationValid &&
      !reading
    )
      observeTools();
  }, [
    panel,
    facts?.observationId,
    source?.connection.state,
    source?.connection.generation,
    cleanupOnly,
    observationValid,
    reading,
  ]);
  async function dismiss(rows: readonly NativeUserMcpSubmission[]) {
    if (
      !rows.length ||
      rows.some(
        (row) => row.phase !== 'failed' || row.association !== 'current' || row.storeId !== storeId,
      ) ||
      busy ||
      flight.current
    )
      return;
    const original = identity;
    flight.current = true;
    setBusy(true);
    try {
      for (const row of rows) {
        await bridge.request({
          method: 'settings.userMcp.clear',
          generation,
          commandId: row.commandId,
        });
        if (current.current !== original) return;
        setDismissed((ids) => [...ids, row.commandId]);
        setLocal((rows) => rows.filter((value) => value.commandId !== row.commandId));
      }
    } catch (cause) {
      if (current.current === original) setError(errorCode(cause));
    } finally {
      if (current.current === original) {
        flight.current = false;
        setBusy(false);
      }
    }
  }
  function addSource() {
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
      !address.trim() ||
      address.trim().startsWith('@') ||
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
    try {
      void submit({ kind: 'add', name: name.trim(), entry: mcpDraftEntry(draft) });
    } catch (cause) {
      setError(errorCode(cause));
    }
  }

  const sourceOperation = [...records.values()].find(
    (row) =>
      row.storeId === storeId &&
      pending(row) &&
      'serverId' in row.operation &&
      row.operation.serverId === source?.id,
  );
  const cancellableSourceOperation =
    sourceOperation?.phase === 'pending' &&
    sourceOperation.association === 'current' &&
    !sourceOperation.legacy
      ? sourceOperation
      : undefined;
  const cancelPrimary =
    cancellableSourceOperation &&
    ['login', 'connect', 'reconnect'].includes(cancellableSourceOperation.operation.kind);
  const addOperation = [...records.values()].find(
    (row) =>
      row.storeId === storeId &&
      row.phase === 'pending' &&
      row.association === 'current' &&
      !row.legacy &&
      row.operation.kind === 'add' &&
      panel?.kind === 'add' &&
      row.operation.name === name.trim(),
  );
  const needsLogin =
    !!source?.authentication.loginAllowed && source.authentication.status !== 'present';
  const canConnect =
    source?.connection.state === 'disconnected' || source?.connection.state === 'failed';
  const primaryLabel =
    sourceOperation?.phase === 'outcome_unknown'
      ? '等待确认'
      : cancelPrimary
        ? sourceOperation?.operation.kind === 'login'
          ? '取消登录'
          : '取消连接'
        : sourceOperation?.operation.kind === 'login'
          ? '登录中…'
          : sourceOperation?.operation.kind === 'connect' ||
              source?.connection.state === 'connecting'
            ? '连接中…'
            : needsLogin
              ? '登录'
              : source?.connection.state === 'failed'
                ? '重试连接'
                : '建立连接';
  const alert = error && (
    <p className="provider-notice provider-notice-error" role="alert">
      {errorMessage(error)}
    </p>
  );
  const reviewDescription =
    review?.kind === 'remove'
      ? '删除后，此服务将从你的 MCP 列表中移除。'
      : review?.kind === 'clear'
        ? '清除此设备保存的登录信息。再次使用时需要重新登录。'
        : review?.kind === 'revoke'
          ? '向服务撤销授权并清除此设备的登录信息。再次使用时需要重新授权。'
          : '更新此服务已保存的凭据有效期。';
  const belongsToPanel = ({ row }: McpFeedbackNotice) =>
    row.operation.kind === 'add'
      ? panel?.kind === 'add' && row.operation.name === name.trim()
      : !!source && row.operation.serverId === source.id;
  const failureMessage = (row: NativeUserMcpSubmission) => {
    const serverId = 'serverId' in row.operation ? row.operation.serverId : undefined;
    return errorMessage(
      row.error,
      row.operation,
      facts?.sources.find((source) => source.id === serverId),
    );
  };
  const operationNotice = ({ row, key, failures }: McpFeedbackNotice) => (
    <section
      className="mcp-inline-notice"
      role={row.phase === 'failed' ? 'alert' : 'status'}
      key={key}
      aria-label={row.legacy ? '此前的 MCP 操作' : 'MCP 操作结果'}
    >
      <p>
        {row.legacy
          ? '此前的 MCP 操作'
          : row.operation.kind === 'add'
            ? row.operation.name
            : sourceName(row.operation.serverId)}{' '}
        · {pending(row) ? '操作结果待确认。' : failureMessage(row)}
      </p>
      {row.association !== 'current' && <p>连接原服务后可查看操作结果。</p>}
      <div className="catalogue-actions">
        {pending(row) &&
          (row.phase !== 'pending' || row.legacy || row.association !== 'current') && (
            <Button
              type="button"
              className="provider-button"
              disabled={busy || row.association !== 'current'}
              onClick={() => void recover(row)}
            >
              查看结果
            </Button>
          )}
        {pending(row) && !row.legacy && (
          <Button
            type="button"
            className="provider-button"
            disabled={busy || row.association !== 'current'}
            onClick={() => void recover(row, true)}
          >
            {row.operation.kind === 'login' && row.phase === 'pending' ? '取消登录' : '取消操作'}
          </Button>
        )}
        {!pending(row) && (
          <Button
            type="button"
            className="provider-button"
            disabled={busy || row.association !== 'current'}
            onClick={() => void dismiss(failures)}
          >
            关闭提示
          </Button>
        )}
      </div>
    </section>
  );
  return (
    <section
      className="catalogue-settings provider-settings mcp-settings"
      aria-label="MCP settings"
      aria-busy={reading || undefined}
    >
      <header className="settings-page-heading">
        <div>
          <h2>MCP</h2>
          <p>连接工具服务，扩展助手的能力。</p>
        </div>
        <div className="provider-page-actions">
          <Button
            type="button"
            className="provider-button"
            size="icon-sm"
            onClick={() => void read()}
            disabled={reading || busy}
            aria-label="Refresh MCP settings"
            title="刷新列表"
            ref={refreshButton}
          >
            <SettingsActionIcon name="refresh" />
          </Button>
          <Button
            type="button"
            className="provider-button provider-save"
            ref={addButton}
            disabled={!writable}
            onClick={(event) => openPanel({ kind: 'add' }, event.currentTarget)}
          >
            新增 MCP
          </Button>
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
              <NativeSettingsListRow
                key={row.id}
                label={`管理 ${row.name}`}
                title={row.name}
                description={`${row.transport?.toUpperCase() ?? '配置需要检查'}${row.address ? ` · ${row.address}` : ''}`}
                selected={source?.id === row.id}
                controls={source?.id === row.id ? `${fieldId}-editor` : undefined}
                disabled={!panelHost}
                onOpen={(event) => openPanel({ kind: 'source', id: row.id }, event.currentTarget)}
                status={
                  <span
                    className={`provider-badge${row.connection.state === 'ready' ? ' is-configured' : ''}`}
                  >
                    <span className="provider-status-dot" />
                    {statusLabel(row)}
                  </span>
                }
                actions={
                  <Switch
                    aria-label={`启用 ${row.name}`}
                    checked={row.enabled}
                    disabled={!writable || !row.configured}
                    onCheckedChange={(enabled) =>
                      void submit({ kind: 'enabled', serverId: row.id, enabled })
                    }
                  />
                }
              />
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
      {notices
        .filter((notice) => pending(notice.row) && !belongsToPanel(notice))
        .map(operationNotice)}
      {panel &&
        panelHost &&
        createPortal(
          <RightSidebar
            id={`${fieldId}-editor`}
            label={panel.kind === 'add' ? '新增 MCP' : (source?.name ?? 'MCP')}
            title={panel.kind === 'add' ? '新增 MCP' : (source?.name ?? 'MCP')}
            onClose={() => closePanel()}
          >
            <div className="catalogue-settings provider-panel-content mcp-settings">
              <div className="provider-editor right-sidebar-editor">
                <div className="provider-editor-body right-sidebar-editor-body">
                  {panel.kind === 'add' && (
                    <form
                      id={`${fieldId}-add`}
                      aria-label="Add MCP source"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (writable) addSource();
                      }}
                    >
                      <NativeMcpAddFields
                        draft={draft}
                        onChange={setDraft}
                        disabled={busy || pendingOperation}
                        nameField={nameField}
                        addressField={addressField}
                        fieldError={fieldError}
                        fieldId={fieldId}
                      />
                    </form>
                  )}
                  {source && cleanupOnly && (
                    <section className="provider-form-section">
                      <h4>连接</h4>
                      <p>
                        {source.connection.state === 'ready'
                          ? '配置已不可用，可以断开已有连接。'
                          : '配置已不可用，可以清理遗留的连接资源。'}
                      </p>
                      <Button
                        className="provider-button"
                        disabled={
                          !canCleanup({ kind: 'disconnect', serverId: source.id }) ||
                          source.connection.state === 'disconnected'
                        }
                        onClick={() => void submit({ kind: 'disconnect', serverId: source.id })}
                      >
                        {source.connection.state === 'ready' ||
                        source.connection.state === 'connecting'
                          ? '断开连接'
                          : '清理连接'}
                      </Button>
                      {cancellableSourceOperation && (
                        <Button
                          className="provider-button"
                          disabled={busy}
                          onClick={() => void recover(cancellableSourceOperation, true)}
                        >
                          取消操作
                        </Button>
                      )}
                    </section>
                  )}
                  {source && !cleanupOnly && !review && (
                    <>
                      <section className="provider-form-section">
                        <div className="mcp-detail-heading">
                          <div className="provider-instance-info">
                            <strong>{source.name}</strong>
                            <span>{source.address}</span>
                          </div>
                          <McpSourceMenu
                            source={source}
                            disabled={!writable}
                            container={panelHost}
                            onAction={(operation, confirm) =>
                              confirm ? setReview(operation) : void submit(operation)
                            }
                            onBind={() => setEditingExpiry(true)}
                            onCancel={
                              cancellableSourceOperation && !cancelPrimary
                                ? () => void recover(cancellableSourceOperation, true)
                                : undefined
                            }
                            cancelDisabled={busy}
                          />
                        </div>
                        <div className="mcp-detail-status">
                          <span
                            className={`provider-badge${source.connection.state === 'ready' ? ' is-configured' : ''}`}
                          >
                            <span className="provider-status-dot" />
                            {statusLabel(source)}
                          </span>
                          <span>{authenticationLabel(source)}</span>
                        </div>
                        <div className="mcp-detail-actions">
                          <label className="mcp-enable" htmlFor={`${fieldId}-enabled`}>
                            启用此服务
                            <Switch
                              id={`${fieldId}-enabled`}
                              aria-label={`启用 ${source.name}`}
                              checked={source.enabled}
                              disabled={!writable}
                              onCheckedChange={(enabled) =>
                                void submit({ kind: 'enabled', serverId: source.id, enabled })
                              }
                            />
                          </label>
                          {((source.enabled &&
                            (canConnect || source.connection.state === 'connecting')) ||
                            cancelPrimary) && (
                            <Button
                              className={
                                cancelPrimary ? 'provider-button' : 'provider-button provider-save'
                              }
                              disabled={
                                cancelPrimary
                                  ? busy
                                  : !writable || source.connection.state === 'connecting'
                              }
                              onClick={() =>
                                cancelPrimary && cancellableSourceOperation
                                  ? void recover(cancellableSourceOperation, true)
                                  : void submit({
                                      kind: needsLogin
                                        ? 'login'
                                        : source.diagnostics.includes('mcp_source_conflict')
                                          ? 'reconnect'
                                          : 'connect',
                                      serverId: source.id,
                                    })
                              }
                            >
                              {primaryLabel}
                            </Button>
                          )}
                        </div>
                        {cancellableSourceOperation?.operation.kind === 'login' && (
                          <p className="provider-field-help" role="status">
                            请在浏览器中完成登录。
                          </p>
                        )}
                        {!source.enabled && (
                          <p className="provider-field-help">启用后可连接此服务。</p>
                        )}
                        {!!source.diagnostics.length && (
                          <p className="provider-field-help">连接配置需要检查，请修正后刷新。</p>
                        )}
                      </section>
                      {editingExpiry && source.authentication.policy === 'credential' && (
                        <section className="provider-form-section">
                          <h4>凭据有效期</h4>
                          <label className="provider-field" htmlFor={`${fieldId}-expiry`}>
                            有效期至
                            <Input
                              id={`${fieldId}-expiry`}
                              type="datetime-local"
                              aria-label="Credential expiry"
                              value={expiry}
                              onChange={(event) => setExpiry(event.target.value)}
                            />
                          </label>
                          <div className="catalogue-actions">
                            <Button
                              className="provider-button"
                              onClick={() => setEditingExpiry(false)}
                            >
                              取消
                            </Button>
                            <Button
                              className="provider-button provider-save"
                              disabled={
                                !writable ||
                                !Number.isFinite(Date.parse(expiry)) ||
                                Date.parse(expiry) <= Date.now()
                              }
                              onClick={() =>
                                void submit({
                                  kind: 'bind',
                                  serverId: source.id,
                                  expiresAt: Date.parse(expiry),
                                })
                              }
                            >
                              保存
                            </Button>
                          </div>
                        </section>
                      )}
                      {source.connection.state === 'ready' ? (
                        <McpToolCatalogue
                          key={`${facts?.observationId}/${source.id}/${source.connection.generation}`}
                          page={tools}
                          loading={toolsLoading}
                          failed={toolsFailed || (!observationValid && !reading)}
                          onRetry={() => void (observationValid ? loadTools() : read())}
                          onMore={(after) => void loadTools(after)}
                        />
                      ) : (
                        <p className="catalogue-empty-note">连接后可查看此服务提供的工具。</p>
                      )}
                    </>
                  )}
                  {review && (
                    <section
                      className="provider-form-section"
                      aria-label="Confirm exact MCP operation"
                    >
                      <h4 ref={heading} tabIndex={-1}>
                        {operationLabel[review.kind]}？
                      </h4>
                      <p className="mcp-confirm-name">
                        {'serverId' in review ? sourceName(review.serverId) : ''}
                      </p>
                      <p className="provider-field-help">{source?.address}</p>
                      <p className="provider-field-help">{reviewDescription}</p>
                    </section>
                  )}
                  {alert}
                  {notices.filter(belongsToPanel).map(operationNotice)}
                </div>
                {(panel.kind === 'add' || review) && (
                  <footer className="provider-editor-footer right-sidebar-editor-footer">
                    <Button
                      className="provider-button"
                      disabled={busy}
                      onClick={() =>
                        review
                          ? setReview(undefined)
                          : addOperation
                            ? void recover(addOperation, true)
                            : closePanel()
                      }
                    >
                      {addOperation ? '取消添加' : '取消'}
                    </Button>
                    {review ? (
                      <Button
                        className="provider-button provider-remove"
                        aria-label="Confirm exact MCP operation"
                        disabled={!writable}
                        onClick={() => void submit(review)}
                      >
                        {operationLabel[review.kind]}
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        form={`${fieldId}-add`}
                        className="provider-button provider-save"
                        disabled={!writable}
                      >
                        {busy || pendingOperation ? '正在添加…' : '添加'}
                      </Button>
                    )}
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
