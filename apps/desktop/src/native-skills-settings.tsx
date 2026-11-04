import type { UserSkillCataloguePage } from '@kite-ai/client';
import { Button, MessageContent, RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NativeBridge, NativeSkillsScope } from './native-bridge';
import { NativeSettingsListRow } from './native-settings-list-row';
import { readNativeSkillCatalogue, readNativeSkillDocument } from './native-skills';
import './native-skills-settings.css';

const safeError = (cause: unknown) => {
  const code = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code)
    ? code
    : 'skill_catalogue_unavailable';
};
type SkillEntry = UserSkillCataloguePage['entries'][number];
function SkillStatus({ entry }: { entry: SkillEntry }) {
  const label =
    entry.state === 'disabled'
      ? '已禁用'
      : entry.state === 'unavailable' && entry.reason !== 'skill_capability_missing'
        ? '需处理'
        : undefined;
  return label ? (
    <span className="provider-badge">
      <span className="provider-status-dot" />
      {label}
    </span>
  ) : null;
}
const sourceLabel = ({ id, source }: SkillEntry) =>
  id === 'computer-use' && source === null
    ? '内置技能'
    : source === undefined
      ? '未记录'
      : source === null
        ? '未提供来源信息'
        : `个人 · ${source.origin === 'profile' ? 'Profile Skills' : source.origin === 'configured' ? '自定义位置' : source.origin}`;
const reasonLabel: Record<
  Exclude<NonNullable<SkillEntry['reason']>, 'skill_capability_missing'>,
  string
> = {
  invalid_skill_configuration: '技能配置无效。',
  skill_path_denied: '无法访问技能所在位置。',
  unsupported_skill_options: '不支持此技能的配置项。',
  skill_unavailable: '暂时无法读取此技能。',
  skill_version_changed: '技能内容已更新，请刷新目录。',
  duplicate_skill_location: '多个配置指向同一技能。',
  skill_metadata_limit: '技能摘要超出大小限制。',
  skill_text_limit: '技能正文超出大小限制。',
  skill_text_invalid: '技能正文格式无效。',
  skill_path_changed: '技能所在位置已变化，请刷新目录。',
};
const documentError = (code?: string) =>
  code === 'capability_unavailable'
    ? '当前服务暂不支持查看技能正文。'
    : code === 'skill_text_limit'
      ? '技能正文较大，暂时无法在此预览。'
      : code === 'skill_unavailable'
        ? '此技能的正文当前不可读取。'
        : code === 'skill_catalogue_changed' || code === 'skill_version_changed'
          ? '技能内容已更新，请刷新目录后重新查看。'
          : '暂时无法读取技能正文，请刷新目录后重试。';
const markdownBody = (body: string) =>
  body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');

export function NativeSkillsSettings({
  bridge,
  generation,
  storeId,
  canRead: available = true,
  panelHost,
  editorControl,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
  canRead?: boolean;
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
}) {
  const panelId = useId();
  const scope: NativeSkillsScope | undefined = useMemo(
    () => (storeId ? { generation, storeId } : undefined),
    [generation, storeId],
  );
  const identity = scope ? `${scope.generation}/${scope.storeId}` : '';
  const [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{
      identity: string;
      facts?: UserSkillCataloguePage;
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
  const canRead = !!scope && available;
  const detailId = canRead && detail?.identity === identity ? detail.id : undefined;
  const entry =
    facts?.availability === 'available'
      ? facts.entries.find((value) => value.id === detailId)
      : undefined;
  const skillId = entry?.id,
    skillVersion = entry?.enabled ? entry.version : undefined,
    revision = facts?.revision;
  const documentIdentity = useMemo(
    () =>
      scope && skillId && skillVersion && revision
        ? {
            ...scope,
            skillId,
            skillVersion,
            revision,
          }
        : undefined,
    [scope, skillId, skillVersion, revision],
  );
  const documentKey = documentIdentity ? JSON.stringify(documentIdentity) : '';
  const [document, setDocument] = useState<{
    key: string;
    body?: string;
    error?: string;
    busy: boolean;
  }>();
  const currentDocument = document?.key === documentKey ? document : undefined;
  const documentSnapshot = useRef(document);
  documentSnapshot.current = document;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh retries a failed read even when its versioned identity has not changed.
  useEffect(() => {
    if (!documentIdentity || !scope) {
      setDocument(undefined);
      return;
    }
    if (
      documentSnapshot.current?.key === documentKey &&
      documentSnapshot.current.body !== undefined
    )
      return;
    const abort = new AbortController();
    setDocument({ key: documentKey, busy: true });
    void readNativeSkillDocument({
      bridge,
      scope,
      identity: {
        storeId: documentIdentity.storeId,
        skillId: documentIdentity.skillId,
        skillVersion: documentIdentity.skillVersion,
        revision: documentIdentity.revision,
      },
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setDocument({ key: documentKey, body: value.body, busy: false });
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setDocument({ key: documentKey, error: documentError(safeError(cause)), busy: false });
      });
    return () => abort.abort();
  }, [bridge, documentIdentity, documentKey, scope, refresh]);

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
          setView((old) =>
            value.availability === 'unavailable' &&
            old.identity === identity &&
            old.facts?.availability === 'available'
              ? {
                  identity,
                  facts: old.facts,
                  error: value.reason ?? 'skill_catalogue_unavailable',
                  busy: false,
                }
              : { identity, facts: value, busy: false },
          );
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new read scope discards the old detail even when skill IDs match.
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
      <header className="settings-page-heading">
        <div>
          <h2>Skills</h2>
          <p>查看内置和个人 Skills 的说明。</p>
        </div>
        <Button
          ref={refreshButton}
          className="provider-button provider-refresh"
          type="button"
          disabled={!canRead || busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新 Skills 目录
        </Button>
      </header>
      {!available ? (
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
                        <NativeSettingsListRow
                          key={item.id}
                          label={`查看 ${item.name || item.id} 详情`}
                          title={item.name || item.id}
                          description={item.description ?? '摘要未记录'}
                          metadata={`来源：${sourceLabel(item)}`}
                          selected={detailId === item.id}
                          controls={detailId === item.id ? panelId : undefined}
                          disabled={!panelHost}
                          onOpen={(event) => {
                            origin.current = event.currentTarget;
                            setDetail({ identity, id: item.id });
                          }}
                          status={<SkillStatus entry={item} />}
                        />
                      ))}
                    </ul>
                    {!facts.entries.length && (
                      <div className="provider-empty">
                        <h3>暂无 Skills</h3>
                        <p>尚未配置用户 Skill。</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
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
              <div className="provider-editor right-sidebar-editor">
                <header className="provider-editor-heading skill-detail-heading">
                  <div className="skill-detail-title">
                    <h3 ref={detailHeading} tabIndex={-1}>
                      {entry?.name || entry?.id || 'Skill 详情'}
                    </h3>
                    <span>Skill</span>
                  </div>
                  {entry && <SkillStatus entry={entry} />}
                </header>
                <div className="provider-editor-body right-sidebar-editor-body">
                  {error && (
                    <p className="provider-notice provider-notice-error" role="alert">
                      详情尚未确认最新状态：{error}。保留上次完整目录。
                    </p>
                  )}
                  {entry ? (
                    <div className="skill-detail-content">
                      <section>
                        <p className="skill-detail-description">
                          {entry.description ?? '摘要未记录'}
                        </p>
                      </section>
                      <section
                        key={`${identity}/${entry.id}/${entry.version}`}
                        className="skill-document"
                        aria-label="技能正文"
                        aria-busy={currentDocument?.busy || undefined}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded document viewport needs keyboard scrolling without invoking any action.
                        tabIndex={0}
                      >
                        {currentDocument?.body !== undefined ? (
                          <MessageContent text={markdownBody(currentDocument.body)} />
                        ) : currentDocument?.error ? (
                          <p role="status">{currentDocument.error}</p>
                        ) : !currentDocument?.busy ? (
                          <p>此技能的正文当前不可读取。</p>
                        ) : null}
                      </section>
                      <section className="skill-detail-metadata">
                        <p className="skill-detail-source">来源：{sourceLabel(entry)}</p>
                        {entry.reason && entry.reason !== 'skill_capability_missing' && (
                          <p className="skill-detail-notice">{reasonLabel[entry.reason]}</p>
                        )}
                      </section>
                    </div>
                  ) : (
                    <p className="provider-notice" role="status">
                      {facts?.availability === 'unavailable'
                        ? `Skills 目录当前不可用：${facts.reason}。`
                        : '此 Skill 已不在最新目录中，请关闭详情后重新选择。'}
                    </p>
                  )}
                </div>
                <footer className="provider-editor-footer right-sidebar-editor-footer">
                  <Button className="provider-button" type="button" onClick={close}>
                    关闭
                  </Button>
                </footer>
              </div>
            </div>
          </RightSidebar>,
          panelHost,
        )}
    </section>
  );
}
