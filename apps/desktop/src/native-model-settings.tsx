import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  ScrollArea,
} from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
  NativeSelection,
} from './native-bridge';
import { nativeModelToggleQueue } from './native-model-toggle-queue';

export type NativeModelSettingsProps = {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeModelSettingsSubmission[];
  onSaved?: () => void | Promise<void>;
  onRecovered?: () => void;
  revision?: number;
  blocked?: boolean;
  hardBlocked?: boolean;
  acquireWrite?: () => (() => void) | undefined;
};
export type NativeModelSettingsState = ReturnType<typeof useNativeModelSettings>;

export function useNativeModelSettings({
  bridge,
  generation,
  selection,
  submissions,
  onSaved,
  onRecovered,
  revision = 0,
  blocked = false,
  hardBlocked = false,
  acquireWrite,
}: NativeModelSettingsProps) {
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const current = useRef(identity);
  current.current = identity;
  const queue = useMemo(
    () => nativeModelToggleQueue(bridge, generation, identity, selection?.storeId),
    [bridge, generation, identity, selection?.storeId],
  );
  const { facts, reading, writing, healthy, error, local } = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const observedRevision = useRef(revision);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision refresh has its own effect; mounting a retained worker never reads over its continuation.
  useEffect(() => {
    observedRevision.current = revision;
    queue.start();
    return () => queue.detach(current.current !== identity);
  }, [queue, identity]);
  useEffect(() => {
    if (observedRevision.current === revision) return;
    observedRevision.current = revision;
    void queue.refresh();
  }, [queue, revision]);
  const refresh = () => queue.refresh();
  const write = (input: NativeRequest, _observed?: NativeModelSettingsFacts) => queue.write(input);
  const originals = useMemo(() => {
    const all = new Map(submissions.map((entry) => [entry.commandId, entry]));
    for (const entry of local) {
      const host = all.get(entry.commandId);
      // A settled watcher receipt supersedes an older local unknown.
      if (!host || !['applied', 'failed'].includes(host.phase)) all.set(entry.commandId, entry);
    }
    return [...all.values()];
  }, [submissions, local]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Initial model facts bind the Store before same-Store cold originals can be scheduled.
  useEffect(() => {
    queue.reconcile(originals);
    if (hardBlocked) queue.suspend();
  }, [queue, originals, hardBlocked, facts?.storeId]);
  const pending =
    queue.awaitingOriginal ||
    (!!facts &&
      originals.some(
        (submission) =>
          submission.storeId === facts.storeId &&
          submission.scope === facts.scope &&
          submission.workspaceId === facts.workspaceId &&
          ['submitting', 'unknown'].includes(submission.phase),
      ));
  const unresolvedSubmissions = originals.filter((submission) => submission.phase === 'unknown');
  const unknown = unresolvedSubmissions.some(
    (submission) =>
      submission.storeId === facts?.storeId &&
      submission.scope === facts?.scope &&
      submission.workspaceId === facts?.workspaceId,
  );
  const foreignPending = originals.some((submission) => queue.foreignPending(submission));
  const groups = new Map<string, NativeModelSettingsFacts['models']>();
  const names = new Map<string, number>();
  for (const model of facts?.models ?? []) {
    const provider = model.provider ?? '其他';
    const group = groups.get(provider);
    if (group) group.push(model);
    else groups.set(provider, [model]);
    const name = JSON.stringify([provider, model.model ?? model.id]);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  queue.update({
    blocked,
    hardBlocked,
    pending,
    unknown,
    foreignPending,
    acquireWrite,
    onSaved,
    onRecovered,
  });
  const canWrite =
    !!facts?.canWrite && !pending && !reading && !writing && !blocked && !hardBlocked;
  const canToggle =
    !!facts?.canWrite &&
    !unknown &&
    !foreignPending &&
    !hardBlocked &&
    (healthy || (!pending && !reading && !writing && !blocked));
  const selectableModels = facts?.models.filter((model) => model.enabled && model.configured) ?? [];
  const selectedModel = selectableModels.find((model) => model.id === facts?.defaultModelId);
  function modelName(model: NativeModelSettingsFacts['models'][number]) {
    const name = model.model ?? model.id;
    return names.get(JSON.stringify([model.provider ?? '其他', name]))! > 1
      ? `${name} · ${model.id}`
      : name;
  }
  return {
    generation,
    facts,
    reading,
    writing,
    pending,
    error,
    canWrite,
    canToggle,
    refresh,
    write,
    groups,
    selectableModels,
    selectedModel,
    modelName,
    unresolvedSubmissions,
  };
}

export function NativeDefaultModelSettings({ state }: { state: NativeModelSettingsState }) {
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    // Radix mounts its focus scope after opening; hand the settled scope to the search field.
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [menuOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new query resets browsing, never facts refresh or tool outcomes.
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    generation,
    facts,
    reading,
    canWrite,
    groups,
    selectableModels,
    selectedModel,
    modelName,
    write,
  } = state;
  return (
    <>
      <div className="settings-card settings-model-current">
        <div className="settings-row">
          <span>
            <strong>默认模型</strong>
            <small>用于后续执行，正在运行的任务不受影响</small>
          </span>
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setQuery('');
              setMenuOpen(open);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                className="settings-model-trigger"
                aria-label="默认模型"
                disabled={!canWrite || !selectableModels.length}
              >
                <span>
                  {selectedModel
                    ? `${selectedModel.provider ?? '其他'} · ${modelName(selectedModel)}`
                    : reading
                      ? '默认模型'
                      : facts?.defaultModelId
                        ? `${facts.defaultModelId} · 当前不可用`
                        : selectableModels.length
                          ? '选择模型'
                          : '暂无可用模型'}
                </span>
                <svg aria-hidden="true" data-icon="inline-end" viewBox="0 0 24 24" fill="none">
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="model-menu settings-model-menu"
              portalled={false}
              align="end"
              sideOffset={6}
              aria-label="选择默认模型"
              ref={menuRef}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' || event.target === searchRef.current) return;
                const first = menuRef.current?.querySelector(
                  '[role="menuitemradio"]:not([data-disabled])',
                );
                if (event.target === first) {
                  event.preventDefault();
                  event.stopPropagation();
                  searchRef.current?.focus();
                }
              }}
            >
              <div className="settings-model-search-toolbar">
                <input
                  ref={searchRef}
                  type="search"
                  className="settings-model-search"
                  aria-label="搜索默认模型"
                  placeholder="搜索模型、提供商或 ID"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') return;
                    event.stopPropagation();
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      const items = menuRef.current?.querySelectorAll<HTMLElement>(
                        '[role="menuitemradio"]:not([data-disabled])',
                      );
                      const item =
                        event.key === 'ArrowDown' ? items?.[0] : items?.[items.length - 1];
                      item?.focus();
                    }
                  }}
                />
              </div>
              <ScrollArea
                className="settings-model-menu-scroll"
                fade="y"
                viewportClassName="settings-model-menu-viewport"
                viewportRef={viewportRef}
                viewportProps={{ tabIndex: -1 }}
              >
                <DropdownMenuRadioGroup value={selectedModel?.id ?? ''}>
                  {[...groups].map(([provider, models]) => {
                    const needle = query.trim().toLocaleLowerCase();
                    const selectable = models.filter(
                      (model) =>
                        model.enabled &&
                        model.configured &&
                        (!needle ||
                          [model.id, model.model ?? '', model.provider ?? ''].some((value) =>
                            value.toLocaleLowerCase().includes(needle),
                          )),
                    );
                    return selectable.length ? (
                      <DropdownMenuGroup key={provider}>
                        <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                        {selectable.map((model) => (
                          <DropdownMenuRadioItem
                            key={model.id}
                            value={model.id}
                            indicatorPosition="end"
                            aria-label={`设为默认 ${model.id}`}
                            disabled={!canWrite || model.id === selectedModel?.id}
                            onSelect={() => {
                              if (canWrite && model.id !== selectedModel?.id)
                                void write(
                                  {
                                    method: 'settings.models.default',
                                    generation,
                                    observationId: facts!.observationId,
                                    modelId: model.id,
                                  },
                                  facts,
                                );
                            }}
                          >
                            {modelName(model)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuGroup>
                    ) : null;
                  })}
                </DropdownMenuRadioGroup>
                {!selectableModels.some((model) =>
                  [model.id, model.model ?? '', model.provider ?? ''].some((value) =>
                    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                  ),
                ) && <p className="settings-model-search-empty">没有匹配的可用模型</p>}
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <NativeModelSettingsFeedback state={state} />
    </>
  );
}

export function NativeModelSettingsFeedback({ state }: { state: NativeModelSettingsState }) {
  const { generation, facts, reading, writing, error, write, unresolvedSubmissions } = state;
  return (
    <>
      {error && <p role="alert">模型配置不可用：{error}</p>}
      {facts?.errors.map((code) => (
        <p role="alert" key={code}>
          配置诊断：{code}
        </p>
      ))}
      {facts &&
        !facts.canWrite &&
        !state.pending &&
        !reading &&
        !writing &&
        !error &&
        !facts.errors.length && <p role="status">当前配置不可修改。</p>}
      {!!unresolvedSubmissions.length && (
        <section aria-label="待确认的模型更改">
          {unresolvedSubmissions.map((submission) => (
            <article key={submission.commandId}>
              <p role="status">
                {submission.operation.kind === 'default'
                  ? '默认模型'
                  : submission.operation.enabled
                    ? '模型启用'
                    : '模型禁用'}
                更改结果待确认。
              </p>
              <button
                type="button"
                disabled={writing || reading}
                onClick={() =>
                  void write({
                    method: 'settings.models.lookup',
                    generation,
                    commandId: submission.commandId,
                  })
                }
              >
                查看结果
              </button>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

export function NativeModelSettingsRows({
  state,
  modelIds,
}: {
  state: NativeModelSettingsState;
  modelIds?: readonly string[];
}) {
  const { generation, facts, reading, writing, canToggle, groups, modelName, write } = state;
  const renderRows = (models: NativeModelSettingsFacts['models']) =>
    models.map((model) => (
      <label className="settings-model-option" key={model.id} data-enabled={model.enabled}>
        <span>
          <strong>{modelName(model)}</strong>
          {model.diagnostics.map((code) => (
            <small key={code}>{code}</small>
          ))}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={`启用模型 ${model.id}`}
          checked={model.enabled}
          aria-checked={model.enabled}
          disabled={!canToggle}
          onChange={(event) => {
            if (canToggle)
              void write(
                {
                  method: 'settings.models.enabled',
                  generation,
                  observationId: facts!.observationId,
                  modelId: model.id,
                  enabled: event.currentTarget.checked,
                },
                facts,
              );
          }}
        />
      </label>
    ));
  if (modelIds !== undefined) {
    const ids = new Set(modelIds);
    return (
      <div className="settings-model-options" aria-busy={reading || writing}>
        {renderRows(facts?.models.filter((model) => ids.has(model.id)) ?? [])}
      </div>
    );
  }
  return (
    <div className="model-list" aria-busy={reading || writing}>
      {[...groups].map(([provider, models]) => {
        const configured = models.filter((model) => model.configured).length;
        const readiness = !configured
          ? 'not_configured'
          : configured === models.length
            ? 'ready'
            : 'degraded';
        return (
          <section
            aria-label={`模型提供商 ${provider}`}
            className="settings-model-provider"
            key={provider}
          >
            <div className="settings-model-provider-heading">
              <div className="settings-model-provider-identity">
                <strong>{provider}</strong>
                <span>{models.length} 个模型</span>
              </div>
              <span className="settings-model-status" data-readiness={readiness}>
                {readiness === 'ready'
                  ? '配置可用'
                  : readiness === 'degraded'
                    ? '部分配置可用'
                    : '配置不完整'}
              </span>
            </div>
            <div className="settings-model-options">{renderRows(models)}</div>
          </section>
        );
      })}
      {facts && !facts.errors.length && !facts.models.length && (
        <p className="settings-model-empty">尚无模型配置，请连接提供商。</p>
      )}
    </div>
  );
}

export function NativeModelSettings(props: NativeModelSettingsProps) {
  const state = useNativeModelSettings(props);
  return (
    <section
      aria-label="模型设置"
      className="settings-models"
      aria-busy={state.reading || undefined}
    >
      <div className="settings-models-title">
        <div>
          <h2>模型</h2>
          <p className="settings-models-description">选择默认模型，管理任务中可用的模型。</p>
        </div>
        <button
          type="button"
          disabled={state.reading || state.writing}
          onClick={() => void state.refresh()}
        >
          刷新配置
        </button>
      </div>
      <NativeDefaultModelSettings state={state} />
      <div className="settings-model-section-heading">
        <h3>模型列表</h3>
        <span>开启后显示在任务的模型列表中</span>
      </div>
      <NativeModelSettingsRows state={state} />
    </section>
  );
}
