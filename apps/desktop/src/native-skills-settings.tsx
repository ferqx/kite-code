import type { SkillCataloguePage } from '@kite-ai/client';
import { RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NativeBridge, NativeSelection, NativeSkillsScope } from './native-bridge';
import { readNativeSkillCatalogue } from './native-skills';

const safeError = (cause: unknown) => {
  const code = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code)
    ? code
    : 'skill_catalogue_unavailable';
};
const stateLabel = { available: '可用', disabled: '已禁用', unavailable: '不可用' } as const;
const sourceLabel = (source: SkillCataloguePage['entries'][number]['source']) =>
  source === undefined
    ? '来源未记录'
    : source === null
      ? '来源无法确定'
      : `${source.scope === 'project' ? '项目' : '用户'} · ${source.origin === 'profile' ? 'Profile Skills' : source.origin === 'configured' ? '配置位置' : source.origin}`;

export function NativeSkillsSettings({
  bridge,
  generation,
  selection,
  historyEpoch,
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const panelId = useId();
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId,
    viewSelection = selection?.viewSelection ?? 0;
  const scope: NativeSkillsScope | undefined = useMemo(
    () =>
      storeId && sessionId && workspaceId
        ? { generation, viewSelection, historyEpoch, storeId, sessionId, workspaceId }
        : undefined,
    [generation, viewSelection, historyEpoch, storeId, sessionId, workspaceId],
  );
  const identity = scope
    ? `${scope.generation}/${scope.viewSelection}/${scope.historyEpoch}/${scope.storeId}/${scope.sessionId}/${scope.workspaceId}`
    : '';
  const [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{
      identity: string;
      facts?: SkillCataloguePage;
      error?: string;
      busy: boolean;
    }>({ identity, busy: false });
  const [detail, setDetail] = useState<{ identity: string; id: string }>();
  const origin = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const readIdentity = `${identity}/${refresh}`,
    current = useRef(readIdentity);
  current.current = readIdentity;
  const facts = view.identity === identity ? view.facts : undefined;
  const error = view.identity === identity ? view.error : undefined;
  const busy = view.identity === identity && view.busy;
  const canRead = !!scope && selection?.canReadSkills === true;
  const detailId = canRead && detail?.identity === identity ? detail.id : undefined;
  const entry =
    facts?.availability === 'available'
      ? facts.entries.find((value) => value.id === detailId)
      : undefined;

  useEffect(() => {
    if (!canRead || !scope) {
      setView({ identity, busy: false });
      return;
    }
    const abort = new AbortController();
    setView((old) => ({
      identity,
      facts: old.identity === identity ? old.facts : undefined,
      busy: true,
    }));
    void readNativeSkillCatalogue({
      bridge,
      scope,
      signal: abort.signal,
      isCurrent: () => current.current === readIdentity,
    })
      .then((value) => {
        if (!abort.signal.aborted && current.current === readIdentity)
          setView({ identity, facts: value, busy: false });
      })
      .catch((cause) => {
        if (!abort.signal.aborted && current.current === readIdentity)
          setView((old) => ({
            identity,
            facts: old.identity === identity ? old.facts : undefined,
            busy: false,
            error: safeError(cause),
          }));
      });
    return () => abort.abort();
  }, [bridge, identity, readIdentity, canRead, scope]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new read scope must discard the old detail selection even when skill IDs match.
  useEffect(() => {
    setDetail(undefined);
    origin.current = null;
    restoreFocus.current = false;
  }, [identity, canRead]);

  function close() {
    restoreFocus.current = true;
    setDetail(undefined);
  }
  const closeCurrent = useRef(close);
  closeCurrent.current = close;
  useEffect(() => {
    if (editorControl)
      editorControl.current =
        detailId && panelHost ? { close: () => closeCurrent.current() } : null;
    if (detailId && panelHost) detailHeading.current?.focus();
    if (!detailId && restoreFocus.current) {
      restoreFocus.current = false;
      (origin.current?.isConnected ? origin.current : refreshButton.current)?.focus();
    }
    return () => {
      if (editorControl) editorControl.current = null;
    };
  }, [detailId, panelHost, editorControl]);

  return (
    <section
      className="catalogue-settings skills-settings"
      aria-label="Skills 目录"
      aria-busy={busy || undefined}
    >
      <header className="provider-page-heading">
        <div>
          <h2>Skills</h2>
          <p>查看当前工作区自动发现的 Skills，以及它们的来源与可用状态。</p>
        </div>
        <button
          ref={refreshButton}
          className="provider-button provider-refresh"
          type="button"
          disabled={!canRead || busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新 Skills 目录
        </button>
      </header>
      {!selection ? (
        <div className="provider-empty">
          <h3>尚未选择工作区</h3>
          <p>选择会话后查看所属工作区的 Skills。</p>
        </div>
      ) : !canRead ? (
        <p className="provider-notice" role="status">
          当前服务未提供 Skills 目录。
        </p>
      ) : (
        <>
          {error && (
            <p className="provider-notice provider-notice-error" role="alert">
              Skills 目录读取失败：{error}。
              {facts ? '保留上次完整目录，尚未确认最新状态。' : '尚未取得完整目录。'}
            </p>
          )}
          {facts && (
            <div className="provider-workspace">
              <div className="provider-directory">
                {facts.availability === 'unavailable' ? (
                  <p className="provider-notice" role="status">
                    Skills 目录当前不可用：{facts.reason}。
                  </p>
                ) : (
                  <>
                    <div className="provider-directory-heading">
                      <span>已发现的 Skills</span>
                      <span>{facts.entries.length}</span>
                    </div>
                    <ul className="provider-instance-list" aria-label="Skills 条目">
                      {facts.entries.map((item) => (
                        <li key={item.id}>
                          <button
                            className="provider-instance settings-catalogue-row"
                            type="button"
                            aria-label={`查看 ${item.name || item.id} 详情`}
                            aria-expanded={detailId === item.id}
                            aria-controls={detailId === item.id ? panelId : undefined}
                            data-selected={detailId === item.id || undefined}
                            disabled={!panelHost}
                            onClick={(event) => {
                              origin.current = event.currentTarget;
                              setDetail({ identity, id: item.id });
                            }}
                          >
                            <span className="provider-instance-info">
                              <strong>{item.name || item.id}</strong>
                              <span className="settings-catalogue-summary">
                                {item.description ?? '摘要未记录'}
                              </span>
                              <span>配置来源：{sourceLabel(item.source)}</span>
                            </span>
                            <span
                              className={`provider-badge${item.state === 'available' ? ' is-configured' : ''}`}
                            >
                              <span className="provider-status-dot" />
                              {stateLabel[item.state]}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!facts.entries.length && (
                      <div className="provider-empty">
                        <h3>暂无 Skills</h3>
                        <p>当前工作区没有可发现的 Skill。</p>
                      </div>
                    )}
                    <p className="provider-page-note">
                      <span>已完整读取 {facts.entries.length} 项 Skill。</span>工作区：
                      {selection.session.workspaceId}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      <p className="provider-directory-note">
        Skills 由可信配置来源自动发现，此处仅展示只读目录。目录可用状态不授予执行权限。
      </p>
      {detailId &&
        panelHost &&
        createPortal(
          <RightSidebar
            id={panelId}
            label={`${entry?.name || entry?.id || 'Skill'} 详情`}
            title="Skill 详情"
            onClose={close}
          >
            <div
              className="catalogue-settings skills-settings provider-panel-content"
              aria-busy={busy || undefined}
            >
              <div className="provider-editor">
                <header className="provider-editor-heading">
                  <div>
                    <h3 ref={detailHeading} tabIndex={-1}>
                      {entry?.name || entry?.id || 'Skill 详情'}
                    </h3>
                    <p>只读目录信息</p>
                  </div>
                  {entry && (
                    <span
                      className={`provider-badge${entry.state === 'available' ? ' is-configured' : ''}`}
                    >
                      <span className="provider-status-dot" />
                      {stateLabel[entry.state]}
                    </span>
                  )}
                </header>
                <div className="provider-editor-body">
                  {error && (
                    <p className="provider-notice provider-notice-error" role="alert">
                      详情尚未确认最新状态：{error}。保留上次完整目录。
                    </p>
                  )}
                  {entry ? (
                    <div className="settings-catalogue-details">
                      <section className="provider-form-section">
                        <h4>摘要</h4>
                        <p style={{ whiteSpace: 'pre-wrap' }}>
                          {entry.description ?? '摘要未记录'}
                        </p>
                      </section>
                      <section className="provider-form-section">
                        <h4>目录信息</h4>
                        <p>配置来源：{sourceLabel(entry.source)}</p>
                        {entry.reason && <p>原因：{entry.reason}</p>}
                        <details>
                          <summary>技术详情</summary>
                          <p>配置 ID：{entry.id}</p>
                          <p>版本：{entry.version ?? '未记录'}</p>
                        </details>
                      </section>
                      {(!!entry.requiredCapabilities.length ||
                        !!entry.missingCapabilities.length) && (
                        <section className="provider-form-section">
                          <h4>能力要求</h4>
                          {!!entry.requiredCapabilities.length && (
                            <p>需要能力：{entry.requiredCapabilities.join('、')}</p>
                          )}
                          {!!entry.missingCapabilities.length && (
                            <p>缺少能力：{entry.missingCapabilities.join('、')}</p>
                          )}
                        </section>
                      )}
                    </div>
                  ) : (
                    <p className="provider-notice" role="status">
                      {facts?.availability === 'unavailable'
                        ? `Skills 目录当前不可用：${facts.reason}。`
                        : '此 Skill 已不在最新目录中，请返回列表重新选择。'}
                    </p>
                  )}
                </div>
                <footer className="provider-editor-footer">
                  <button className="provider-button" type="button" onClick={close}>
                    返回列表
                  </button>
                </footer>
              </div>
            </div>
          </RightSidebar>,
          panelHost,
        )}
    </section>
  );
}
