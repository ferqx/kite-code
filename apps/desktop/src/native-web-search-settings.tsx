import { Button as DesktopButton, Input, webSearchLinks } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { NativeSettingsSelect } from './native-settings-select';

import { nativeSearchSettingsPort } from './native-web-search-bridge';
import {
  type SearchAdapter,
  type SearchDraft,
  type SearchMode,
  type SearchProbe,
  type SearchService,
  type SearchView,
  searchAdapterNames,
  searchDraftIssue,
  type WebSearchSettingsPort,
  webSearchProblem,
} from './web-search-settings-model';
export function NativeBoundWebSearchSettings({
  bridge,
  generation,
  storeId,
  sessionId,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  sessionId?: string;
}) {
  const port = useMemo(
    () => nativeSearchSettingsPort(bridge, { generation, expectedStoreId: storeId }, sessionId),
    [bridge, generation, storeId, sessionId],
  );
  return (
    <NativeWebSearchSettings key={JSON.stringify([generation, storeId, sessionId])} port={port} />
  );
}
export function NativeWebSearchSettings({ port }: { port: WebSearchSettingsPort }) {
  const formId = useId();
  const [facts, setFacts] = useState<SearchView>(),
    [draft, setDraft] = useState<SearchDraft>();
  const [secretDirty, setSecretDirty] = useState(false);
  const [error, setError] = useState(''),
    [probe, setProbe] = useState<SearchProbe>();
  const [busy, setBusy] = useState<'read' | 'save' | 'test'>(),
    operation = useRef(false),
    epoch = useRef(0);
  const keys = useRef(new Map<string, HTMLInputElement>());
  const clearKeys = useCallback(() => {
    for (const input of keys.current.values()) input.value = '';
    setSecretDirty(false);
  }, []);
  const accept = useCallback(
    (view: SearchView) => {
      clearKeys();
      setFacts(view);
      setDraft(view.draft);
      setProbe(undefined);
    },
    [clearKeys],
  );
  const read = useCallback(async () => {
    if (operation.current) return;
    const token = ++epoch.current;
    operation.current = true;
    setBusy('read');
    setError('');
    try {
      const view = await port.read();
      if (token === epoch.current) accept(view);
    } catch {
      if (token === epoch.current) setError('暂时无法读取网页搜索设置。');
    } finally {
      if (token === epoch.current) {
        operation.current = false;
        setBusy(undefined);
      }
    }
  }, [port, accept]);
  useEffect(() => {
    void read();
    return () => {
      epoch.current++;
      operation.current = false;
    };
  }, [read]);
  const dirty = secretDirty || JSON.stringify(draft) !== JSON.stringify(facts?.draft);
  const edit = (next: SearchDraft) => {
    setDraft(next);
    setProbe(undefined);
    setError('');
  };
  const change = (id: string, fn: (p: SearchService) => SearchService) => {
    if (draft) edit({ ...draft, providers: draft.providers.map((p) => (p.id === id ? fn(p) : p)) });
  };
  const add = () => {
    if (
      !draft ||
      draft.providers.length >= 16 ||
      draft.providers.some((p) => p.account.kind === 'dedicated' && !p.account.hasCredential)
    )
      return;
    const id = crypto.randomUUID();
    edit({
      ...draft,
      providers: [
        ...draft.providers,
        {
          id,
          name: 'DeepSeek 搜索',
          adapter: 'deepseek-search',
          account: { kind: 'dedicated', hasCredential: false },
          maxResults: 5,
        },
      ],
    });
  };
  async function action(kind: 'save' | 'test') {
    if (operation.current || !draft || !facts) return;
    if (kind === 'save') {
      if (!facts.canWrite) return;
      const issue = searchDraftIssue(draft, (id) => !!keys.current.get(id)?.value.trim());
      if (issue) {
        setError(issue);
        return;
      }
    } else if (dirty || !facts.route.available) return;
    operation.current = true;
    const token = ++epoch.current;
    setBusy(kind);
    setError('');
    setProbe(undefined);
    try {
      if (kind === 'save') {
        const credentials = draft.providers.flatMap((p) => {
          const input = keys.current.get(p.id);
          return input?.value && p.account.kind === 'dedicated'
            ? [{ providerId: p.id, secret: input.value }]
            : [];
        });
        // Do not put key material into React state, persistent drafts, error messages or retry queues.
        if (credentials.length > 1) {
          setError('每次只能保存一个专用账户的密钥。');
          return;
        }
        clearKeys();
        const value = await port.save(facts.revision, draft, credentials);
        if (token === epoch.current) accept(value);
      } else {
        const result = await port.test(facts.revision);
        if (token === epoch.current) setProbe(result);
      }
    } catch (e) {
      if (token === epoch.current)
        setError(
          webSearchProblem(
            e,
            kind === 'save'
              ? '未确认保存结果。请重新读取设置后再操作。'
              : '未确认搜索结果，未自动重试。',
          ),
        );
    } finally {
      if (token === epoch.current) {
        operation.current = false;
        setBusy(undefined);
      }
    }
  }
  return (
    <section
      className="general-settings catalogue-settings"
      aria-label="网页搜索设置"
      aria-busy={!!busy}
    >
      <header className="settings-page-heading">
        <div>
          <h2>网页搜索</h2>
          <p>使用自己的账户。设置对下一次运行生效。</p>
        </div>
      </header>
      {facts && draft && (
        <>
          <fieldset
            className="settings-card web-search-settings"
            disabled={!facts.canWrite || !!busy}
          >
            <legend>搜索配置</legend>
            <label htmlFor={`${formId}-mode`}>
              模式
              <NativeSettingsSelect
                id={`${formId}-mode`}
                aria-label="搜索模式"
                value={draft.mode}
                disabled={!facts.canWrite || !!busy}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'provider', label: '指定提供商' },
                  { value: 'disabled', label: '关闭搜索' },
                ]}
                onValueChange={(v) =>
                  edit({
                    ...draft,
                    mode: v as SearchMode,
                    providerId: v === 'disabled' ? undefined : draft.providerId,
                  })
                }
              />
            </label>
            {draft.mode === 'disabled' ? (
              <small>仅关闭搜索，不影响网页读取或其他网络工具。</small>
            ) : (
              <label htmlFor={`${formId}-provider`}>
                {draft.mode === 'auto' ? '备用搜索服务' : '搜索服务'}
                <NativeSettingsSelect
                  id={`${formId}-provider`}
                  aria-label="选择搜索服务"
                  disabled={!facts.canWrite || !!busy}
                  value={draft.providerId ?? '-'}
                  onValueChange={(v) => edit({ ...draft, providerId: v === '-' ? undefined : v })}
                  options={[
                    { value: '-', label: draft.mode === 'auto' ? '无备用服务' : '请选择' },
                    ...draft.providers.map((p) => ({ value: p.id, label: p.name || '未命名' })),
                  ]}
                />
              </label>
            )}
            {draft.providers.map((p) => (
              <fieldset key={p.id}>
                <legend>{p.name || '搜索服务'}</legend>
                <label htmlFor={`${formId}-${p.id}-name`}>
                  服务名称
                  <Input
                    id={`${formId}-${p.id}-name`}
                    value={p.name}
                    maxLength={80}
                    onChange={(e) => change(p.id, (a) => ({ ...a, name: e.target.value }))}
                  />
                </label>
                <label htmlFor={`${formId}-${p.id}-adapter`}>
                  提供商类型
                  <NativeSettingsSelect
                    id={`${formId}-${p.id}-adapter`}
                    aria-label="提供商类型"
                    disabled={!facts.canWrite || !!busy}
                    value={p.adapter}
                    options={Object.entries(searchAdapterNames).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onValueChange={(adapter) => {
                      if (adapter === p.adapter) return;
                      const input = keys.current.get(p.id);
                      if (input) input.value = '';
                      change(p.id, (a) => ({
                        id: a.id,
                        name: a.name,
                        adapter: adapter as SearchAdapter,
                        account: { kind: 'dedicated', hasCredential: false },
                        ...(adapter === 'openai-search' ? { modelId: '' } : { maxResults: 5 }),
                      }));
                    }}
                  />
                </label>
                <label htmlFor={`${formId}-${p.id}-account`}>
                  账户
                  <NativeSettingsSelect
                    id={`${formId}-${p.id}-account`}
                    aria-label="搜索账户"
                    disabled={!facts.canWrite || !!busy}
                    value={
                      p.account.kind === 'dedicated' ? 'dedicated' : `account:${p.account.alias}`
                    }
                    options={[
                      { value: 'dedicated', label: '搜索专用账户' },
                      ...facts.accounts
                        .filter((a) => a.adapter === p.adapter)
                        .map((a) => ({ value: `account:${a.alias}`, label: a.name })),
                    ]}
                    onValueChange={(v) =>
                      change(p.id, (a) => ({
                        ...a,
                        account:
                          v === 'dedicated'
                            ? { kind: 'dedicated', hasCredential: false }
                            : { kind: 'provider', alias: v.slice(8) },
                      }))
                    }
                  />
                </label>
                {p.account.kind === 'dedicated' && (
                  <label htmlFor={`${formId}-${p.id}-key`}>
                    API Key
                    <Input
                      id={`${formId}-${p.id}-key`}
                      key={p.adapter}
                      type="password"
                      autoComplete="new-password"
                      maxLength={4096}
                      placeholder={p.account.hasCredential ? '已设置，留空保留' : undefined}
                      ref={(node) => {
                        if (node) keys.current.set(p.id, node);
                        else keys.current.delete(p.id);
                      }}
                      onChange={() => {
                        setSecretDirty([...keys.current.values()].some((input) => !!input.value));
                        setProbe(undefined);
                      }}
                    />
                  </label>
                )}
                {p.adapter === 'openai-search' ? (
                  <label htmlFor={`${formId}-${p.id}-model`}>
                    搜索模型
                    <Input
                      id={`${formId}-${p.id}-model`}
                      value={p.modelId ?? ''}
                      maxLength={128}
                      onChange={(e) => change(p.id, (a) => ({ ...a, modelId: e.target.value }))}
                    />
                  </label>
                ) : (
                  <label htmlFor={`${formId}-${p.id}-limit`}>
                    结果数量
                    <Input
                      id={`${formId}-${p.id}-limit`}
                      type="number"
                      min={1}
                      max={10}
                      value={p.maxResults ?? 5}
                      onChange={(e) =>
                        change(p.id, (a) => ({ ...a, maxResults: e.target.valueAsNumber }))
                      }
                    />
                  </label>
                )}
                <DesktopButton
                  variant="ghost"
                  onClick={() =>
                    edit({
                      ...draft,
                      providerId: draft.providerId === p.id ? undefined : draft.providerId,
                      providers: draft.providers.filter((v) => v.id !== p.id),
                    })
                  }
                >
                  移除服务
                </DesktopButton>
              </fieldset>
            ))}
            <div>
              <DesktopButton
                variant="outline"
                disabled={
                  draft.providers.length >= 16 ||
                  draft.providers.some(
                    (p) => p.account.kind === 'dedicated' && !p.account.hasCredential,
                  )
                }
                onClick={add}
              >
                添加搜索服务
              </DesktopButton>{' '}
              <DesktopButton disabled={!dirty} onClick={() => void action('save')}>
                {busy === 'save' ? '正在保存…' : '保存设置'}
              </DesktopButton>
            </div>
          </fieldset>
          <div className="settings-card web-search-settings">
            <strong>当前生效路径：{facts.route.label}</strong>
            <small>测试会提交一次真实查询“Kite web search connectivity test”，可能产生费用。</small>
            <DesktopButton
              variant="outline"
              disabled={!!busy || dirty || !facts.route.available}
              onClick={() => void action('test')}
            >
              {busy === 'test' ? '正在测试…' : '测试搜索'}
            </DesktopButton>
            {probe && (
              <div role="status">
                <strong>
                  {probe.route}：
                  {probe.errorCode
                    ? webSearchProblem(probe.errorCode, '搜索未完成。')
                    : probe.observed
                      ? '已观察到搜索'
                      : '未观察到搜索'}
                </strong>
                <ul>
                  {webSearchLinks(probe.sources).map((s) => (
                    <li key={s.url}>
                      <a href={s.url} rel="noopener noreferrer" target="_blank">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
      {error && (
        <div role="alert">
          {error}{' '}
          <DesktopButton variant="outline" disabled={!!busy} onClick={() => void read()}>
            重新读取
          </DesktopButton>
        </div>
      )}
    </section>
  );
}
