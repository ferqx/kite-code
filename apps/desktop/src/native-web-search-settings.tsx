import { NativeSettingsHeading } from './native-settings-heading';
import './native-web-search-settings.css';
import { Button, SettingsNavigationIcon } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSettingsRequestPort } from './native-bridge';
import { nativeSearchSettingsPort } from './native-web-search-bridge';
import type { SearchView, WebSearchSettingsPort } from './web-search-settings-model';

type SettingsReader = Pick<WebSearchSettingsPort, 'read'>;
export function NativeBoundWebSearchSettings({
  bridge,
  generation,
  storeId,
  sessionId,
  onManageProviders,
}: {
  bridge: NativeSettingsRequestPort;
  generation: number;
  storeId: string;
  sessionId?: string;
  onManageProviders: () => void;
}) {
  const port = useMemo(
    () => nativeSearchSettingsPort(bridge, { generation, expectedStoreId: storeId }, sessionId),
    [bridge, generation, storeId, sessionId],
  );
  return (
    <NativeWebSearchSettings
      key={JSON.stringify([generation, storeId, sessionId])}
      port={port}
      onManageProviders={onManageProviders}
    />
  );
}

function fallbackStatus(view: SearchView) {
  if (view.draft.mode === 'disabled') return { label: '已关闭', detail: '不会调用备用提供商。' };
  const derived = view.derivedDeepSeek;
  switch (derived?.status) {
    case 'configured':
      return {
        label: '已配置',
        detail: `默认备用提供商为「${derived.label || 'DeepSeek'}」。本次明确选择的模型有可用的 DeepSeek 提供商时优先使用。`,
      };
    case 'ambiguous':
      return {
        label: '按模型选择',
        detail: '有多个 DeepSeek 提供商。按当前或默认模型选择，不能确定时不调用。',
      };
    case 'unavailable':
      return { label: '未配置', detail: '在“提供商与模型”中配置 DeepSeek，可用于备用搜索。' };
    default:
      return { label: '未报告', detail: '当前连接的服务未报告自动备用搜索状态。' };
  }
}

export function NativeWebSearchSettings({
  port,
  onManageProviders,
}: {
  port: SettingsReader;
  onManageProviders?: () => void;
}) {
  const [facts, setFacts] = useState<SearchView>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    pending = useRef(false);
  const read = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const view = await port.read();
      if (token === epoch.current) setFacts(view);
    } catch {
      if (token === epoch.current) setError('暂时无法读取网页搜索设置。');
    } finally {
      if (token === epoch.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [port]);
  useEffect(() => {
    void read();
    return () => {
      epoch.current++;
      pending.current = false;
    };
  }, [read]);
  const off = facts?.draft.mode === 'disabled';
  const nativeFirst = facts?.draft.mode === 'auto';
  const fallback = facts && fallbackStatus(facts);
  return (
    <section
      className="general-settings web-search-preferences"
      aria-label="网页搜索设置"
      aria-busy={!!busy}
    >
      <NativeSettingsHeading
        title="网页搜索"
        actions={
          facts &&
          fallback &&
          onManageProviders && (
            <Button
              type="button"
              variant="ghost"
              className="search-manage"
              onClick={onManageProviders}
            >
              管理提供商
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
                <path
                  d="m6 4 4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Button>
          )
        }
      />
      {facts && fallback && (
        <ul className="search-pref-list" aria-label="搜索来源">
          <li className="search-pref-row">
            <span className="search-pref-mark">
              <SettingsNavigationIcon name="webSearch" />
            </span>
            <div className="search-pref-copy">
              <strong>模型自带搜索</strong>
              <span>
                {off
                  ? '网页搜索已关闭。'
                  : nativeFirst
                    ? '当前模型和权限支持时，优先使用。'
                    : '当前设置指定了搜索服务。'}
              </span>
            </div>
            <span className="search-pref-state">
              {off ? '已关闭' : nativeFirst ? '优先' : '未选用'}
            </span>
          </li>
          <li className="search-pref-row">
            <span className="search-pref-mark">
              <SettingsNavigationIcon name="providers" />
            </span>
            <div className="search-pref-copy">
              <strong>备用搜索</strong>
              <span>{fallback.detail}</span>
            </div>
            <span
              className="search-pref-state"
              data-configured={
                (!off && facts.derivedDeepSeek?.status === 'configured') || undefined
              }
            >
              {fallback.label}
            </span>
          </li>
        </ul>
      )}
      {error && (
        <div className="search-pref-result" role="alert">
          {error}{' '}
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void read()}>
            重新读取
          </Button>
        </div>
      )}
    </section>
  );
}
