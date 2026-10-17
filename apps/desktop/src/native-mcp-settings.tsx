import type { McpAuthStatus, McpToolsPage } from '@kite-ai/client';
import { RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeBridge,
  NativeMcpFacts,
  NativeMcpOperation,
  NativeMcpRemovalPreview,
  NativeMcpRequest,
  NativeMcpResult,
  NativeMcpSubmission,
  NativeSelection,
} from './native-bridge';

const safeError = (cause: unknown) =>
  /^[a-z][a-z0-9_]{0,80}$/.test((cause as Error)?.message ?? '')
    ? (cause as Error).message
    : 'mcp_unavailable';
export function NativeMcpSettings({
  bridge,
  generation,
  selection,
  submissions,
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeMcpSubmission[];
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const fieldId = useId();
  const [panel, setPanel] = useState<{
    kind: 'add' | 'server' | 'source' | 'tools';
    key?: string;
  }>();
  const origin = useRef<HTMLButtonElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const nameField = useRef<HTMLInputElement | null>(null);
  const addressField = useRef<HTMLInputElement | null>(null);
  const restoreFocus = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const reviewOrigin = useRef<HTMLElement | null>(null);
  const restoreReviewFocus = useRef(false);
  const [fieldError, setFieldError] = useState<'name' | 'address'>();
  const [reading, setReading] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const toolsVersion = useRef(0);
  const [facts, setFacts] = useState<NativeMcpFacts>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [local, setLocal] = useState<NativeMcpSubmission[]>([]);
  const [removal, setRemoval] = useState<NativeMcpRemovalPreview>();
  const [previewReading, setPreviewReading] = useState(false);
  const [review, setReview] = useState<NativeMcpOperation>(),
    [name, setName] = useState(''),
    [scope, setScope] = useState<'user' | 'workspace'>('user'),
    [transport, setTransport] = useState<'http' | 'stdio'>('http'),
    [address, setAddress] = useState(''),
    [expiry, setExpiry] = useState('');
  const [auth, setAuth] = useState<Record<string, McpAuthStatus>>({}),
    [tools, setTools] = useState<McpToolsPage>(),
    [descriptor, setDescriptor] = useState('');
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
  const readVersion = useRef(0);
  const sequence = useRef(0),
    flight = useRef(false),
    reader = useRef<string | undefined>(undefined);
  const originals = new Map(local.map((value) => [value.commandId, value]));
  for (const value of submissions) originals.set(value.commandId, value);
  const records = [...originals.values()];
  const pending = records.some(
    (value) =>
      value.storeId === facts?.storeId &&
      ['submitting', 'pending', 'outcome_unknown'].includes(value.phase),
  );
  const writable = !!facts?.canWrite && !pending && !busy;
  const remember = (value: NativeMcpSubmission) =>
    setLocal((values) => [...values.filter((item) => item.commandId !== value.commandId), value]);
  async function request(input: NativeMcpRequest): Promise<NativeMcpResult | undefined> {
    const original = identity,
      seq = ++sequence.current;
    setError('');
    try {
      const result = await bridge.request(input);
      if (current.current !== original || seq !== sequence.current) return undefined;
      if (!result || !('kind' in result) || !result.kind.startsWith('settings.mcp'))
        throw Error('mcp_unavailable');
      return result as NativeMcpResult;
    } catch (cause) {
      if (current.current === original && seq === sequence.current) setError(safeError(cause));
    }
    return undefined;
  }
  function chooseReview(operation?: NativeMcpOperation) {
    if (operation) reviewOrigin.current = document.activeElement as HTMLElement | null;
    sequence.current++;
    setRemoval(undefined);
    setPreviewReading(false);
    setReview(operation);
  }
  async function removePreview(serverId: string, scope: 'user' | 'workspace') {
    if (!facts || !writable) return;
    reviewOrigin.current = document.activeElement as HTMLElement | null;
    chooseReview();
    setPreviewReading(true);
    const original = identity,
      expectedSequence = sequence.current + 1;
    const result = await request({
      method: 'settings.mcp.removePreview',
      generation,
      observationId: facts.observationId,
      serverId,
      scope,
    });
    if (current.current !== original || sequence.current !== expectedSequence) return;
    setPreviewReading(false);
    if (!result) return;
    if (
      result.kind !== 'settings.mcp.removePreview' ||
      result.observationId !== facts.observationId ||
      result.serverId !== serverId ||
      result.scope !== scope ||
      result.preview.target.serverId !== serverId ||
      result.preview.target.source.kind !== scope
    ) {
      setError('mcp_removal_preview_invalid');
      return;
    }
    setRemoval(result);
    setReview({ kind: 'remove', serverId, scope });
  }
  async function read() {
    const original = identity,
      version = ++readVersion.current;
    closePanel(false);
    setReading(true);
    closeDescriptor();
    setTools(undefined);
    chooseReview();
    setAuth({});
    setFacts(undefined);
    const result = await request({ method: 'settings.mcp.read', generation });
    if (current.current !== original || readVersion.current !== version) return;
    setReading(false);
    if (result?.kind === 'settings.mcp') {
      if (
        selection &&
        (result.storeId !== selection.storeId || result.sessionId !== selection.session.id)
      ) {
        setError('mcp_scope_mismatch');
        return;
      }
      setFacts(result);
    }
  }
  function closeDescriptor() {
    const readId = reader.current;
    reader.current = undefined;
    setDescriptor('');
    if (readId)
      void bridge
        .request({ method: 'settings.mcp.descriptor.close', generation, readId })
        .catch(() => {});
  }
  function closePanel(restore = true) {
    restoreFocus.current = restore;
    restoreReviewFocus.current = false;
    chooseReview();
    closeDescriptor();
    setTools(undefined);
    toolsVersion.current++;
    setToolsLoading(false);
    setPanel(undefined);
    setName('');
    setScope('user');
    setTransport('http');
    setAddress('');
    setExpiry('');
    setFieldError(undefined);
  }
  function openPanel(value: NonNullable<typeof panel>, trigger: HTMLButtonElement) {
    closePanel(false);
    setError('');
    origin.current = trigger;
    setPanel(value);
  }
  const closeCurrent = useRef(closePanel);
  closeCurrent.current = closePanel;
  useEffect(() => {
    if (editorControl)
      editorControl.current = panel ? { close: () => closeCurrent.current() } : null;
    if (!panel && restoreFocus.current) {
      restoreFocus.current = false;
      const trigger = origin.current;
      (trigger?.isConnected && !trigger.disabled
        ? trigger
        : addButton.current && !addButton.current.disabled
          ? addButton.current
          : refreshButton.current
      )?.focus();
    }
    if (panel && panelHost) {
      if (panel.kind === 'add') nameField.current?.focus();
      else panelHost.querySelector<HTMLButtonElement>('.right-sidebar-close')?.focus();
    }
    return () => {
      if (editorControl) editorControl.current = null;
    };
  }, [panel, panelHost, editorControl]);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (!previewReading && restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      (reviewOrigin.current?.isConnected ? reviewOrigin.current : nameField.current)?.focus();
    }
  }, [review, previewReading]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Every host selection invalidates all observation and reader responses.
  useEffect(() => {
    sequence.current++;
    setFacts(undefined);
    setTools(undefined);
    setAuth({});
    chooseReview();
    setName('');
    setAddress('');
    setExpiry('');
    setBusy(false);
    flight.current = false;
    void read();
    return () => {
      sequence.current++;
      closeDescriptor();
      void bridge.request({ method: 'settings.mcp.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  async function submit(operation: NativeMcpOperation) {
    if (!writable || !facts || flight.current) return;
    flight.current = true;
    setBusy(true);
    const original = identity;
    try {
      const result = await request({
        method: 'settings.mcp.submit',
        generation,
        observationId: facts.observationId,
        operation,
      });
      if (result?.kind === 'settings.mcp.submission') {
        remember(result);
        closePanel();
      }
    } finally {
      if (current.current === original) {
        flight.current = false;
        setBusy(false);
      }
    }
  }
  async function originalAction(
    method: 'settings.mcp.lookup' | 'settings.mcp.cancel',
    value: NativeMcpSubmission,
  ) {
    if (value.association !== 'current' || busy || flight.current) return;
    flight.current = true;
    setBusy(true);
    const original = identity;
    try {
      const result = await request({ method, generation, commandId: value.commandId });
      if (result?.kind === 'settings.mcp.submission') remember(result);
    } finally {
      if (current.current === original) {
        flight.current = false;
        setBusy(false);
      }
    }
  }
  async function loadTools(recordKey: string, startIndex = 0) {
    if (!facts) return;
    const original = identity,
      version = ++toolsVersion.current;
    setToolsLoading(true);
    closeDescriptor();
    const result = await request({
      method: 'settings.mcp.tools',
      generation,
      observationId: facts.observationId,
      recordKey,
      startIndex,
    });
    if (current.current !== original || toolsVersion.current !== version) return;
    setToolsLoading(false);
    if (result?.kind === 'settings.mcp.tools' && result.observationId === facts.observationId)
      setTools(result.page);
  }
  async function loadDescriptor(index: number) {
    if (!facts || !tools) return;
    const entry = tools.entries.find((value) => value.index === index);
    if (!entry) return;
    closeDescriptor();
    const original = identity,
      seq = ++sequence.current,
      readId = crypto.randomUUID();
    reader.current = readId;
    setError('');
    try {
      const opened = (await bridge.request({
        method: 'settings.mcp.descriptor',
        generation,
        observationId: facts.observationId,
        recordKey: tools.recordKey,
        index,
        readId,
      })) as NativeMcpResult;
      if (
        !opened ||
        !('kind' in opened) ||
        opened.kind !== 'settings.mcp.descriptor' ||
        opened.readId !== readId ||
        opened.bodySha256 !== entry.descriptorHash ||
        String(opened.bodyBytes) !== entry.descriptorBytes
      )
        throw Error('mcp_descriptor_invalid');
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (true) {
        if (current.current !== original || seq !== sequence.current || reader.current !== readId)
          return;
        const chunk = (await bridge.request({
          method: 'settings.mcp.descriptor.read',
          generation,
          readId,
          offset,
          limit: 65536,
        })) as NativeMcpResult;
        if (
          !chunk ||
          !('kind' in chunk) ||
          chunk.kind !== 'settings.mcp.descriptor.chunk' ||
          chunk.readId !== readId ||
          chunk.offset !== offset
        )
          throw Error('mcp_descriptor_invalid');
        const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
        if (
          chunk.nextOffset !== offset + bytes.length ||
          chunk.nextOffset > opened.bodyBytes ||
          (!chunk.eof && !bytes.length)
        )
          throw Error('mcp_descriptor_invalid');
        parts.push(bytes);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      if (offset !== opened.bodyBytes) throw Error('mcp_descriptor_invalid');
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const part of parts) {
        bytes.set(part, cursor);
        cursor += part.length;
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (digest !== opened.bodySha256) throw Error('mcp_descriptor_invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      JSON.parse(text);
      if (current.current === original && seq === sequence.current && reader.current === readId)
        setDescriptor(text);
    } catch (cause) {
      if (current.current === original && seq === sequence.current && reader.current === readId)
        setError(safeError(cause));
    } finally {
      if (reader.current === readId) {
        reader.current = undefined;
        void bridge
          .request({ method: 'settings.mcp.descriptor.close', generation, readId })
          .catch(() => {});
      }
    }
  }
  const selectedServer =
    panel?.kind === 'server' ? facts?.servers.find((value) => value.id === panel.key) : undefined;
  const selectedSource =
    panel?.kind === 'source'
      ? facts?.sources.find((value) => `${value.source.kind}/${value.id}` === panel.key)
      : undefined;
  const sourceName = (id: string) => facts?.sources.find((value) => value.id === id)?.name ?? id;
  const panelTitle =
    panel?.kind === 'add'
      ? '新增 MCP'
      : panel?.kind === 'tools'
        ? '工具快照'
        : panel?.kind === 'source'
          ? '管理 MCP 来源'
          : 'MCP 连接详情';
  const badge = (label: string, available: boolean) => (
    <span className={`provider-badge${available ? ' is-configured' : ''}`}>
      <span className="provider-status-dot" />
      {label}
    </span>
  );
  const exactReview = (previewReading || review) && (
    <section
      className="provider-form-section"
      aria-label={previewReading ? 'MCP removal preview loading' : 'Confirm exact MCP operation'}
    >
      <h4 ref={reviewHeading} tabIndex={-1}>
        {previewReading ? '正在核对删除影响' : '确认准确操作'}
      </h4>
      {previewReading ? (
        <p role="status">Reading exact source removal preview.</p>
      ) : (
        <pre>{JSON.stringify(review, null, 2)}</pre>
      )}
      {review?.kind === 'remove' && removal && (
        <section aria-label="Exact source removal preview">
          <h4>Declaration to remove</h4>
          <pre>{JSON.stringify(removal.preview.target, null, 2)}</pre>
          <h4>Fallback after removal</h4>
          {removal.preview.fallback ? (
            <>
              <p>
                Removing this declaration reveals the following source. It has its own selection,
                approval and authentication requirements.
              </p>
              <pre>{JSON.stringify(removal.preview.fallback, null, 2)}</pre>
            </>
          ) : (
            <p>No fallback declaration was reported.</p>
          )}
        </section>
      )}
      <p className="provider-field-help">
        来源与认证变更不授予远端工具权限。已有凭据绑定仍需在原 Source Review 中单独确认。
      </p>
    </section>
  );
  return (
    <section aria-label="MCP settings" className="catalogue-settings mcp-settings">
      <header className="provider-page-heading">
        <div>
          <h2>MCP</h2>
          <p>管理工具服务的配置来源、连接和认证。</p>
        </div>
        <div className="provider-page-actions">
          <button
            className="provider-button"
            type="button"
            onClick={() => void read()}
            disabled={reading}
            aria-label="Refresh MCP settings"
            ref={refreshButton}
          >
            刷新
          </button>
          <button
            className="provider-button provider-save"
            ref={addButton}
            type="button"
            disabled={!writable}
            onClick={(event) => openPanel({ kind: 'add' }, event.currentTarget)}
          >
            新增 MCP
          </button>
        </div>
      </header>
      {!selection && (
        <div className="provider-notice">
          Select a current Session to manage MCP settings. Original submissions remain available
          below.
        </div>
      )}
      {reading && (
        <p className="provider-notice" role="status">
          正在读取 MCP 配置…
        </p>
      )}
      {error && !panel && (
        <p className="provider-notice provider-notice-error" role="alert">
          {!selection && error === 'mcp_scope_unavailable'
            ? 'MCP settings need a current Session. Select a Session and reopen MCP settings.'
            : error}
        </p>
      )}
      {facts?.errors.map((value, index) => (
        <p className="provider-notice provider-notice-error" role="alert" key={`${index}/${value}`}>
          {value}
        </p>
      ))}
      {facts && (
        <>
          <section aria-label="MCP directory" className="catalogue-section">
            <div className="provider-directory-heading">
              <h3 aria-label="Safe directory">连接目录</h3>
              <span>{facts.servers.length}</span>
            </div>
            <ul className="provider-instance-list">
              {facts.servers.map((server) => (
                <li
                  key={server.id}
                  className="provider-instance"
                  data-selected={selectedServer?.id === server.id || undefined}
                >
                  <span className="provider-mark catalogue-mark" aria-hidden="true">
                    ⌘
                  </span>
                  <div className="provider-instance-info">
                    <strong>{sourceName(server.id)}</strong>
                    <span>
                      {server.transport.toUpperCase()} · {server.source.kind} ·{' '}
                      {server.reason ?? (server.admitted ? '来源已准入' : '来源待准入')}
                    </span>
                  </div>
                  {badge(
                    server.available ? '可用' : server.selected ? '不可用' : '未启用',
                    server.available,
                  )}
                  <div className="provider-instance-actions">
                    <button
                      type="button"
                      className="provider-button"
                      aria-label={`管理连接 ${server.id}`}
                      aria-expanded={selectedServer?.id === server.id}
                      aria-controls={
                        selectedServer?.id === server.id ? `${fieldId}-editor` : undefined
                      }
                      onClick={(event) =>
                        openPanel({ kind: 'server', key: server.id }, event.currentTarget)
                      }
                    >
                      管理
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {!facts.servers.length && (
              <div className="provider-empty">
                <h3>暂无 MCP 连接</h3>
                <p>添加配置来源后，可在此核对状态和管理连接。</p>
              </div>
            )}
          </section>
          <section aria-label="MCP sources" className="catalogue-section">
            <div className="provider-directory-heading">
              <h3>配置来源</h3>
              <span>
                {facts.sources.length}
                {facts.nextAfterId ? '+' : ''}
              </span>
            </div>
            <div className="provider-instance-list">
              {facts.sources.map((source) => (
                <article
                  key={`${source.source.kind}/${source.id}`}
                  className="provider-instance"
                  data-selected={selectedSource === source || undefined}
                >
                  <span className="provider-mark catalogue-mark" aria-hidden="true">
                    ◇
                  </span>
                  <div className="provider-instance-info">
                    <h4>{source.name}</h4>
                    <span>
                      {source.source.kind === 'workspace' ? '工作区' : '用户'} ·{' '}
                      {(source.transport ?? '未知传输').toUpperCase()}
                    </span>
                  </div>
                  {badge(source.enabled ? '已启用' : '已禁用', source.enabled)}
                  <div className="provider-instance-actions">
                    <button
                      type="button"
                      className="provider-button"
                      aria-label={`管理来源 ${source.source.kind} ${source.id}`}
                      aria-expanded={selectedSource === source}
                      onClick={(event) =>
                        openPanel(
                          { kind: 'source', key: `${source.source.kind}/${source.id}` },
                          event.currentTarget,
                        )
                      }
                    >
                      管理
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!facts.sources.length && (
              <div className="provider-empty">
                <h3>尚未添加配置来源</h3>
                <p>支持 HTTP 地址或本地 stdio 命令。</p>
              </div>
            )}
            {facts.nextAfterId && (
              <button
                aria-label="加载更多来源"
                className="provider-button catalogue-pagination"
                type="button"
                onClick={async () => {
                  const result = await request({
                    method: 'settings.mcp.sources',
                    generation,
                    observationId: facts.observationId,
                    afterId: facts.nextAfterId!,
                  });
                  if (
                    result?.kind === 'settings.mcp.sources' &&
                    result.observationId === facts.observationId
                  )
                    setFacts((value) =>
                      value?.observationId === result.observationId
                        ? {
                            ...value,
                            sources: [...value.sources, ...result.sources],
                            nextAfterId: result.nextAfterId,
                          }
                        : value,
                    );
                }}
              >
                Next sources page
              </button>
            )}
          </section>
          <section aria-label="MCP tool snapshots" className="catalogue-section">
            <div className="provider-directory-heading">
              <h3>工具快照</h3>
              <span>
                {facts.snapshots.length}
                {facts.nextAfterKey ? '+' : ''}
              </span>
            </div>
            <ul className="provider-instance-list">
              {facts.snapshots.map((snapshot) => (
                <li className="provider-instance" key={snapshot.recordKey}>
                  <div className="provider-instance-info">
                    <strong>{sourceName(snapshot.origin.serverId)}</strong>
                    <span>
                      {snapshot.toolCount} 个工具 · {snapshot.availability}
                    </span>
                  </div>
                  <div className="provider-instance-actions">
                    <button
                      type="button"
                      className="provider-button"
                      disabled={snapshot.availability !== 'available'}
                      aria-label={`Open tools ${snapshot.recordKey}`}
                      onClick={(event) => {
                        openPanel({ kind: 'tools', key: snapshot.recordKey }, event.currentTarget);
                        void loadTools(snapshot.recordKey);
                      }}
                    >
                      查看工具
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {!facts.snapshots.length && (
              <p className="catalogue-empty-note">暂无已记录的工具快照。</p>
            )}
            {facts.nextAfterKey && (
              <button
                aria-label="加载更多快照"
                className="provider-button catalogue-pagination"
                type="button"
                onClick={async () => {
                  const result = await request({
                    method: 'settings.mcp.snapshots',
                    generation,
                    observationId: facts.observationId,
                    afterKey: facts.nextAfterKey!,
                  });
                  if (
                    result?.kind === 'settings.mcp.snapshots' &&
                    result.observationId === facts.observationId
                  )
                    setFacts((value) =>
                      value?.observationId === result.observationId
                        ? {
                            ...value,
                            snapshots: [...value.snapshots, ...result.snapshots],
                            nextAfterKey: result.nextAfterKey,
                          }
                        : value,
                    );
                }}
              >
                Next snapshots page
              </button>
            )}
          </section>
        </>
      )}
      {!!records.length && (
        <section aria-label="Original MCP submissions" className="provider-submissions">
          <h3>原始提交</h3>
          {records.map((value) => (
            <article className="provider-submission" key={value.commandId}>
              <p>
                <strong>{value.serverId ?? value.name ?? 'source'}</strong> ·{' '}
                {value.phase === 'outcome_unknown' ? 'Outcome unknown; not completed' : value.phase}
              </p>
              {value.summary && <p>{value.summary}</p>}
              {value.error && <p role="alert">{value.error}</p>}
              <details className="provider-submission-details">
                <summary>提交详情</summary>
                <p>
                  {value.commandId} · {value.actionId} · Store {value.storeId} · Session{' '}
                  {value.sessionId} · association {value.association}
                </p>
                {value.fact && <pre>{JSON.stringify(value.fact, null, 2)}</pre>}
              </details>
              <div className="catalogue-actions">
                <button
                  aria-label={`Check original ${value.commandId}`}
                  className="provider-button"
                  type="button"
                  disabled={value.association !== 'current' || busy}
                  onClick={() => void originalAction('settings.mcp.lookup', value)}
                >
                  查询原提交
                </button>
                {['pending', 'submitting', 'outcome_unknown'].includes(value.phase) && (
                  <button
                    aria-label={`Cancel exact original ${value.commandId}`}
                    className="provider-button"
                    type="button"
                    disabled={value.association !== 'current' || busy}
                    onClick={() => void originalAction('settings.mcp.cancel', value)}
                  >
                    申请取消原操作
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      <p className="provider-page-note">
        连接、来源准入、认证和工具权限分别核对。查看目录不会授予执行权限。
      </p>
      {panel &&
        panelHost &&
        createPortal(
          <RightSidebar
            id={`${fieldId}-editor`}
            label={panelTitle}
            title={panelTitle}
            onClose={() => closePanel()}
          >
            <div className="catalogue-settings provider-panel-content">
              <div className="provider-editor">
                <div className="provider-editor-body">
                  {error && (
                    <p className="provider-notice provider-notice-error" role="alert">
                      {error}
                    </p>
                  )}
                  {panel.kind === 'add' && (
                    <form
                      id={`${fieldId}-add`}
                      aria-label="Add MCP source"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!writable) return;
                        if (!name.trim()) {
                          setError('mcp_name_required');
                          setFieldError('name');
                          nameField.current?.focus();
                          return;
                        }
                        if (transport === 'http') {
                          try {
                            const url = new URL(address);
                            if (
                              !['http:', 'https:'].includes(url.protocol) ||
                              url.username ||
                              url.password ||
                              url.hash
                            )
                              throw Error();
                          } catch {
                            setError('mcp_http_url_invalid');
                            setFieldError('address');
                            addressField.current?.focus();
                            return;
                          }
                        } else if (!address.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(address)) {
                          setError('mcp_absolute_command_required');
                          setFieldError('address');
                          addressField.current?.focus();
                          return;
                        }
                        setFieldError(undefined);
                        setError('');
                        chooseReview({
                          kind: 'add',
                          name: name.trim(),
                          scope,
                          entry:
                            transport === 'http'
                              ? { type: 'http', url: address }
                              : { type: 'stdio', command: address },
                        });
                      }}
                    >
                      <section className="provider-form-section">
                        <h4>连接信息</h4>
                        <div className="provider-form-grid">
                          <label className="provider-field">
                            名称
                            <input
                              aria-label="Name"
                              ref={nameField}
                              value={name}
                              aria-invalid={fieldError === 'name'}
                              onChange={(event) => {
                                setName(event.target.value);
                                chooseReview();
                              }}
                              placeholder="例如：团队知识库"
                            />
                          </label>
                          <label className="provider-field">
                            配置范围
                            <select
                              aria-label="Scope"
                              value={scope}
                              onChange={(event) => {
                                setScope(event.target.value as typeof scope);
                                chooseReview();
                              }}
                            >
                              <option value="user">用户</option>
                              <option value="workspace">工作区</option>
                            </select>
                          </label>
                          <label className="provider-field">
                            传输方式
                            <select
                              aria-label="Transport"
                              value={transport}
                              onChange={(event) => {
                                setTransport(event.target.value as typeof transport);
                                chooseReview();
                              }}
                            >
                              <option value="http">HTTP URL</option>
                              <option value="stdio">stdio 本地命令</option>
                            </select>
                          </label>
                          <label className="provider-field">
                            {transport === 'http' ? '服务地址' : '命令的绝对路径'}
                            <input
                              aria-label="URL or command"
                              ref={addressField}
                              value={address}
                              aria-invalid={fieldError === 'address'}
                              onChange={(event) => {
                                setAddress(event.target.value);
                                chooseReview();
                              }}
                              placeholder={
                                transport === 'http'
                                  ? 'https://example.com/mcp'
                                  : '/absolute/path/to/server'
                              }
                            />
                          </label>
                        </div>
                        <p className="provider-field-help">
                          仅填写不含凭据的 HTTP
                          地址或绝对命令路径。来源审批与认证在后续独立步骤处理。
                        </p>
                      </section>
                    </form>
                  )}
                  {selectedServer && facts && (
                    <>
                      <section className="provider-form-section">
                        <h4>{sourceName(selectedServer.id)}</h4>
                        <p className="provider-field-help">
                          {selectedServer.transport.toUpperCase()} · {selectedServer.source.kind}
                        </p>
                        <details className="catalogue-details">
                          <summary>安全目录详情</summary>
                          <pre>{JSON.stringify(selectedServer, null, 2)}</pre>
                        </details>
                      </section>
                      <section className="provider-form-section">
                        <h4>启用范围</h4>
                        <div className="catalogue-actions">
                          {(['user', 'workspace'] as const).flatMap((targetScope) =>
                            [true, false].map((enabled) => (
                              <button
                                aria-label={`Select ${targetScope} ${selectedServer.id}: ${enabled ? 'enable' : 'disable'}`}
                                className="provider-button"
                                key={`${targetScope}/${enabled}`}
                                type="button"
                                disabled={!writable}
                                onClick={() =>
                                  chooseReview({
                                    kind: 'select',
                                    serverId: selectedServer.id,
                                    scope: targetScope,
                                    enabled,
                                  })
                                }
                              >
                                {targetScope === 'workspace' ? '工作区' : '用户'} ·{' '}
                                {enabled ? '启用' : '禁用'}
                              </button>
                            )),
                          )}
                        </div>
                      </section>
                      <section className="provider-form-section">
                        <h4>连接与目录</h4>
                        <div className="catalogue-actions">
                          <button
                            aria-label={`Connect ${selectedServer.id}`}
                            className="provider-button"
                            type="button"
                            disabled={!writable}
                            onClick={() =>
                              void submit({ kind: 'connect', serverId: selectedServer.id })
                            }
                          >
                            建立连接
                          </button>
                          {records
                            .filter(
                              (value) =>
                                value.serverId === selectedServer.id &&
                                value.storeId === facts.storeId &&
                                value.sessionId === facts.sessionId &&
                                value.phase === 'completed' &&
                                value.association === 'current' &&
                                value.fact &&
                                'ready' in value.fact &&
                                value.fact.ready &&
                                value.fact.live,
                            )
                            .map((value) => (
                              <div className="catalogue-actions" key={value.commandId}>
                                <button
                                  aria-label={`Refresh catalogue from ${value.commandId}`}
                                  className="provider-button"
                                  type="button"
                                  disabled={!writable}
                                  onClick={() =>
                                    void submit({
                                      kind: 'refresh',
                                      serverId: selectedServer.id,
                                      commandId: value.commandId,
                                    })
                                  }
                                >
                                  刷新目录
                                </button>
                                <button
                                  aria-label={`Strong reconnect from ${value.commandId}`}
                                  className="provider-button"
                                  type="button"
                                  disabled={!writable}
                                  onClick={() =>
                                    chooseReview({
                                      kind: 'reconnect',
                                      serverId: selectedServer.id,
                                      commandId: value.commandId,
                                    })
                                  }
                                >
                                  强制重连
                                </button>
                              </div>
                            ))}
                        </div>
                      </section>
                      <section className="provider-form-section">
                        <h4>认证</h4>
                        <div className="catalogue-actions">
                          <button
                            aria-label={`Read auth status ${selectedServer.id}`}
                            className="provider-button"
                            type="button"
                            onClick={async () => {
                              const result = await request({
                                method: 'settings.mcp.auth',
                                generation,
                                observationId: facts.observationId,
                                serverId: selectedServer.id,
                              });
                              if (
                                result?.kind === 'settings.mcp.auth' &&
                                result.observationId === facts.observationId
                              )
                                setAuth((values) => ({
                                  ...values,
                                  [selectedServer.id]: result.status,
                                }));
                            }}
                          >
                            读取认证状态
                          </button>
                          {selectedServer.transport === 'http' &&
                            (['login', 'authRefresh', 'clear', 'revoke'] as const).map((kind) => (
                              <button
                                aria-label={`${{ login: 'Login', authRefresh: 'Refresh authentication', clear: 'Clear authentication', revoke: 'Revoke authentication' }[kind]} ${selectedServer.id}`}
                                className="provider-button"
                                type="button"
                                key={kind}
                                disabled={!writable}
                                onClick={() => chooseReview({ kind, serverId: selectedServer.id })}
                              >
                                {
                                  {
                                    login: '登录',
                                    authRefresh: '刷新认证',
                                    clear: '清除认证',
                                    revoke: '撤销认证',
                                  }[kind]
                                }
                              </button>
                            ))}
                        </div>
                        {auth[selectedServer.id] && (
                          <pre>{JSON.stringify(auth[selectedServer.id], null, 2)}</pre>
                        )}
                      </section>
                    </>
                  )}
                  {selectedSource && (
                    <>
                      <section className="provider-form-section">
                        <h4>{selectedSource.name}</h4>
                        <p className="provider-field-help">
                          {selectedSource.source.kind === 'workspace' ? '工作区来源' : '用户来源'} ·{' '}
                          {(selectedSource.transport ?? '未知传输').toUpperCase()}
                        </p>
                        <details className="catalogue-details">
                          <summary>配置来源详情</summary>
                          <pre>{JSON.stringify(selectedSource, null, 2)}</pre>
                        </details>
                        <p className="provider-field-help">
                          此处管理现有来源的批准、凭据绑定和删除。地址等原始配置由配置来源管理。
                        </p>
                      </section>
                      {selectedSource.source.kind === 'workspace' && (
                        <section className="provider-form-section">
                          <h4>来源批准</h4>
                          <button
                            aria-label={`Request project approval ${selectedSource.id}`}
                            className="provider-button"
                            type="button"
                            disabled={!writable}
                            onClick={() =>
                              void submit({ kind: 'approve', serverId: selectedSource.id })
                            }
                          >
                            请求项目批准
                          </button>
                        </section>
                      )}
                      {selectedSource.transport === 'http' && (
                        <section className="provider-form-section">
                          <h4>已有凭据绑定</h4>
                          <label className="provider-field">
                            绑定到期时间（Unix 毫秒）
                            <input
                              aria-label="Binding expiry (Unix milliseconds)"
                              value={expiry}
                              onChange={(event) => {
                                setExpiry(event.target.value);
                                chooseReview();
                              }}
                              inputMode="numeric"
                            />
                          </label>
                          <p className="provider-field-help">
                            填写绑定到期时间，仅引用已有凭据，不在此输入或读取秘密。
                          </p>
                          <button
                            aria-label={`Review existing credential binding ${selectedSource.id}`}
                            className="provider-button"
                            type="button"
                            disabled={
                              !writable ||
                              !Number.isSafeInteger(Number(expiry)) ||
                              Number(expiry) <= Date.now()
                            }
                            onClick={() =>
                              chooseReview({
                                kind: 'bind',
                                serverId: selectedSource.id,
                                expiresAt: Number(expiry),
                              })
                            }
                          >
                            复核已有凭据绑定
                          </button>
                        </section>
                      )}
                      <section className="provider-form-section">
                        <h4>删除来源</h4>
                        <p className="provider-field-help">
                          先读取准确声明与回退来源，核对后再确认删除。
                        </p>
                        <button
                          aria-label={`Remove exact ${selectedSource.source.kind} source ${selectedSource.id}`}
                          className="provider-button provider-delete-link"
                          type="button"
                          disabled={!writable}
                          onClick={() =>
                            void removePreview(selectedSource.id, selectedSource.source.kind)
                          }
                        >
                          删除此来源
                        </button>
                      </section>
                    </>
                  )}
                  {panel.kind === 'tools' && (
                    <section className="provider-form-section">
                      <h4>不可变工具快照</h4>
                      {toolsLoading && <p role="status">正在读取工具快照…</p>}
                      {!tools ? (
                        !toolsLoading && (
                          <p className="provider-field-help">暂未取得工具快照，请关闭后重试。</p>
                        )
                      ) : (
                        <>
                          <p className="provider-field-help">
                            Tool page index {tools.startIndex} · live {String(tools.live)} ·{' '}
                            {tools.reason ?? tools.availability}
                          </p>
                          {tools.entries.map((entry) => (
                            <article className="provider-submission" key={entry.index}>
                              <p>
                                {entry.index} · {entry.label} · {entry.definitionId}@
                                {entry.definitionVersion} ·{' '}
                                {entry.labelComplete ? 'complete label' : 'label preview'}
                              </p>
                              <button
                                aria-label={`Read full descriptor ${entry.index}`}
                                className="provider-button"
                                type="button"
                                onClick={() => void loadDescriptor(entry.index)}
                              >
                                查看完整描述
                              </button>
                            </article>
                          ))}
                          {tools.nextIndex !== null && (
                            <button
                              aria-label="Next tools page"
                              className="provider-button catalogue-pagination"
                              type="button"
                              onClick={() => void loadTools(tools.recordKey, tools.nextIndex!)}
                            >
                              下一页工具
                            </button>
                          )}
                        </>
                      )}
                      {descriptor && <pre data-mcp-descriptor="verified">{descriptor}</pre>}
                    </section>
                  )}
                  {exactReview}
                </div>
                <footer className="provider-editor-footer">
                  <button
                    className="provider-button"
                    type="button"
                    aria-label={panel.kind === 'tools' ? 'Close tool reader' : undefined}
                    onClick={() => closePanel()}
                  >
                    {panel.kind === 'tools' ? '关闭' : '取消'}
                  </button>
                  {(review || previewReading) && (
                    <div className="catalogue-actions">
                      {review && (
                        <button
                          aria-label="Confirm exact MCP operation"
                          className="provider-button provider-save"
                          type="button"
                          disabled={
                            !writable ||
                            (review.kind === 'remove' &&
                              (!removal ||
                                removal.observationId !== facts?.observationId ||
                                removal.serverId !== review.serverId ||
                                removal.scope !== review.scope))
                          }
                          onClick={() => void submit(review)}
                        >
                          确认操作
                        </button>
                      )}
                      <button
                        aria-label="Close operation review"
                        className="provider-button"
                        type="button"
                        onClick={() => {
                          restoreReviewFocus.current = true;
                          chooseReview();
                        }}
                      >
                        返回修改
                      </button>
                    </div>
                  )}
                  {panel.kind === 'add' && !review && (
                    <button
                      aria-label="Review add source"
                      className="provider-button provider-save"
                      type="submit"
                      form={`${fieldId}-add`}
                      disabled={!writable}
                    >
                      复核新增
                    </button>
                  )}
                </footer>
              </div>
            </div>
          </RightSidebar>,
          panelHost,
        )}
    </section>
  );
}
