import { Button, Input, RightSidebar } from '@kite-ai/ui/desktop';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NativeBridge } from './native-bridge';
import {
  isSkillMarketplaceQuery,
  type SkillMarketplaceResult,
  type SkillMarketplaceSelection,
} from './skill-marketplace-contract';

function errorCode(cause: unknown) {
  const error = cause as { code?: string; message?: string } | undefined;
  return error?.code ?? error?.message;
}

const restartRequired = '当前客户端尚未加载 Skills 搜索和安装。请完全退出并重新启动客户端。';

function searchError(cause: unknown) {
  switch (errorCode(cause)) {
    case 'invalid_native_request':
      return restartRequired;
    case 'skill_marketplace_rate_limited':
      return 'Skills.sh 请求过于频繁，请稍后重试。';
    case 'skill_marketplace_invalid_response':
      return '无法读取 Skills.sh 返回的结果，请稍后重试。';
    default:
      return '暂时无法搜索 Skills.sh，请检查网络后重试。';
  }
}

function installError(cause: unknown) {
  switch (errorCode(cause)) {
    case 'invalid_native_request':
      return restartRequired;
    case 'skill_marketplace_rate_limited':
      return '下载请求过于频繁，请稍后重试。';
    case 'skill_marketplace_install_busy':
      return '另一个 Skill 正在安装，请稍后重试。';
    case 'skill_marketplace_mutation_busy':
      return '另一个 Skills 操作正在进行，请稍后重试。';
    case 'skill_marketplace_snapshot_unavailable':
      return '暂时无法下载此 Skill，请稍后重试。';
    case 'skill_marketplace_invalid_snapshot':
      return '此 Skill 的文件缺失或格式不受支持。';
    case 'skill_marketplace_unsafe_directory':
      return '无法安全访问用户 Skills 目录，请检查安装位置。';
    case 'skill_marketplace_target_occupied':
      return '安装位置已被占用，请检查用户 Skills 目录。';
    default:
      return '暂时无法安装此 Skill，请重试。';
  }
}

const resultKey = ({ source, skillId }: SkillMarketplaceSelection) => `${source}/${skillId}`;

type Installation =
  | { status: 'installing' | 'installed' | 'already-installed' }
  | { status: 'failed'; error: string };

const installationAction: Record<Installation['status'], string> = {
  installing: '安装中…',
  installed: '已安装',
  'already-installed': '已有同名 Skill',
  failed: '重试安装',
};

type Search =
  | { status: 'searching'; query: string }
  | { status: 'complete'; results: readonly SkillMarketplaceResult[] }
  | { status: 'failed'; error: string };

// Installation belongs to the settings page and can complete after its search panel closes.
export function NativeSkillMarketplace({
  bridge,
  generation,
  panelId,
  panelHost,
  uninstalled,
  uninstalling,
  onClose,
  onInstalled,
}: {
  bridge: NativeBridge;
  generation: number;
  panelId: string;
  panelHost: HTMLElement | null;
  uninstalled?: { slug: string };
  uninstalling?: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [installations, setInstallations] = useState<ReadonlyMap<string, Installation>>(new Map());
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!uninstalled) return;
    const suffix = `/${uninstalled.slug}`;
    setInstallations((old) => {
      const next = new Map(old);
      for (const [key, entry] of old) {
        if (key.endsWith(suffix) && entry.status !== 'installing') next.delete(key);
      }
      return next.size === old.size ? old : next;
    });
  }, [uninstalled]);

  async function install({ source, skillId }: SkillMarketplaceSelection) {
    const key = resultKey({ source, skillId });
    const existing = installations.get(key)?.status;
    if (
      pending.current ||
      uninstalling ||
      existing === 'installed' ||
      existing === 'already-installed'
    )
      return;
    pending.current = true;
    const update = (state: Installation) => {
      if (mounted.current) setInstallations((old) => new Map(old).set(key, state));
    };
    update({ status: 'installing' });
    try {
      const reply = await bridge.request({
        method: 'settings.skills.install',
        generation,
        selection: { source, skillId },
      });
      if (
        !reply ||
        !('kind' in reply) ||
        reply.kind !== 'settings.skills.install' ||
        !('result' in reply) ||
        reply.result?.name !== skillId ||
        (reply.result.status !== 'installed' && reply.result.status !== 'already-installed')
      )
        throw Error('skill_marketplace_install_failed');
      update({ status: reply.result.status });
      if (mounted.current) onInstalled();
    } catch (cause) {
      update({ status: 'failed', error: installError(cause) });
    } finally {
      pending.current = false;
    }
  }

  return panelHost
    ? createPortal(
        <SearchPanel
          bridge={bridge}
          generation={generation}
          id={panelId}
          installations={installations}
          uninstalling={uninstalling}
          install={install}
          onClose={onClose}
        />,
        panelHost,
      )
    : null;
}

function SearchPanel({
  bridge,
  generation,
  id,
  installations,
  uninstalling,
  install,
  onClose,
}: {
  bridge: NativeBridge;
  generation: number;
  id: string;
  installations: ReadonlyMap<string, Installation>;
  uninstalling?: boolean;
  install: (selection: SkillMarketplaceSelection) => Promise<void>;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const latestSearch = useRef(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>();
  useEffect(() => {
    input.current?.focus();
    return () => {
      latestSearch.current++;
    };
  }, []);

  const keyword = query.trim();
  const searching = search?.status === 'searching';
  const installing = [...installations.values()].some((value) => value.status === 'installing');
  const validKeyword = isSkillMarketplaceQuery(keyword);
  const pendingKeyword = searching && search.query === keyword;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validKeyword || pendingKeyword) return;
    const current = ++latestSearch.current;
    setSearch({ status: 'searching', query: keyword });
    try {
      const reply = await bridge.request({
        method: 'settings.skills.search',
        generation,
        query: keyword,
      });
      if (
        !reply ||
        !('kind' in reply) ||
        reply.kind !== 'settings.skills.search' ||
        !('results' in reply) ||
        !Array.isArray(reply.results)
      )
        throw Error('skill_marketplace_invalid_response');
      if (current === latestSearch.current)
        setSearch({ status: 'complete', results: reply.results });
    } catch (cause) {
      if (current === latestSearch.current)
        setSearch({ status: 'failed', error: searchError(cause) });
    }
  }

  return (
    <RightSidebar id={id} label="搜索 Skills" onClose={onClose}>
      <div className="catalogue-settings skills-settings provider-panel-content">
        <div className="provider-editor right-sidebar-editor">
          <form className="skill-marketplace-search" aria-label="搜索 Skills" onSubmit={submit}>
            <Input
              ref={input}
              type="search"
              aria-label="Skill 关键词"
              placeholder="在 Skills.sh 搜索关键词"
              maxLength={100}
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Button
              className="provider-button provider-save"
              type="submit"
              disabled={!validKeyword}
              aria-disabled={pendingKeyword || undefined}
            >
              {pendingKeyword ? '搜索中…' : '搜索'}
            </Button>
          </form>
          <div
            className="provider-editor-body right-sidebar-editor-body"
            aria-busy={searching || undefined}
          >
            {search?.status === 'searching' && (
              <p className="skill-marketplace-empty" role="status">
                正在搜索 Skills.sh…
              </p>
            )}
            {search?.status === 'failed' && (
              <p className="provider-notice provider-notice-error" role="alert">
                {search.error}
              </p>
            )}
            {search?.status === 'complete' &&
              (search.results.length ? (
                <ul className="provider-instance-list" aria-label="Skills 搜索结果">
                  {search.results.map((entry) => {
                    const key = resultKey(entry);
                    const state = installations.get(key);
                    const action = state ? installationAction[state.status] : '安装';
                    const actionable =
                      !installing && !uninstalling && (!state || state.status === 'failed');
                    return (
                      <li className="skill-marketplace-result" key={key}>
                        <div className="provider-instance-info">
                          <strong>{entry.name}</strong>
                          <span>{entry.source}</span>
                        </div>
                        <Button
                          className="provider-button"
                          type="button"
                          aria-label={`${action} ${entry.name}（${entry.source}）`}
                          aria-disabled={!actionable || undefined}
                          onClick={() => {
                            if (actionable) void install(entry);
                          }}
                        >
                          {action}
                        </Button>
                        {state?.status === 'failed' && (
                          <p className="skill-marketplace-install-error" role="alert">
                            {state.error}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="skill-marketplace-empty" role="status">
                  未找到相关 Skills，请试试其他关键词。
                </p>
              ))}
          </div>
          <footer className="provider-editor-footer right-sidebar-editor-footer">
            <span className="skill-marketplace-destination">
              安装到 <code>~/.kite-code/skills</code>
            </span>
            <Button className="provider-button" type="button" onClick={onClose}>
              关闭
            </Button>
          </footer>
        </div>
      </div>
    </RightSidebar>
  );
}
