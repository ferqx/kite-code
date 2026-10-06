import type { SkillCataloguePage } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
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
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
}) {
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
  const readIdentity = `${identity}/${refresh}`,
    current = useRef(readIdentity);
  current.current = readIdentity;
  const facts = view.identity === identity ? view.facts : undefined;
  const error = view.identity === identity ? view.error : undefined;
  const busy = view.identity === identity && view.busy;
  const canRead = !!scope && selection?.canReadSkills === true;

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

  return (
    <section aria-label="Skills 目录">
      <h2>Skills</h2>
      <p>查看当前工作区的只读目录。目录可用状态不授予执行权限。</p>
      {!selection ? (
        <p>选择会话后查看所属工作区的 Skills。</p>
      ) : !canRead ? (
        <p role="status">当前服务未提供 Skills 目录。</p>
      ) : (
        <>
          <p>工作区：{selection.session.workspaceId}</p>
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            刷新 Skills 目录
          </button>
          {busy && <p role="status">正在读取完整 Skills 目录…</p>}
          {error && (
            <p role="alert">
              Skills 目录读取失败：{error}。
              {facts ? '保留上次完整目录，尚未确认最新状态。' : '尚未取得完整目录。'}
            </p>
          )}
          {facts && (
            <>
              {busy && <p>当前显示上次完整目录，正在核对最新状态。</p>}
              {facts.availability === 'unavailable' ? (
                <p role="status">Skills 目录当前不可用：{facts.reason}。</p>
              ) : (
                <>
                  <p>已完整读取 {facts.entries.length} 项 Skill。</p>
                  {!facts.entries.length && <p>当前工作区没有可发现的 Skill。</p>}
                  <ul aria-label="Skills 条目">
                    {facts.entries.map((entry) => (
                      <li key={entry.id}>
                        <details>
                          <summary>
                            {entry.name || entry.id} · {stateLabel[entry.state]}
                          </summary>
                          <p>配置 ID：{entry.id}</p>
                          <p style={{ whiteSpace: 'pre-wrap' }}>
                            {entry.description ?? '摘要未记录'}
                          </p>
                          <p>配置来源：{sourceLabel(entry.source)}</p>
                          {entry.reason && <p>原因：{entry.reason}</p>}
                          <p>版本：{entry.version ?? '未记录'}</p>
                          {!!entry.requiredCapabilities.length && (
                            <p>需要能力：{entry.requiredCapabilities.join('、')}</p>
                          )}
                          {!!entry.missingCapabilities.length && (
                            <p>缺少能力：{entry.missingCapabilities.join('、')}</p>
                          )}
                        </details>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
