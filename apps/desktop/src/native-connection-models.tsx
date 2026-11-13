import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '@kite-ai/ui/desktop';
import { useLayoutEffect, useRef, useState } from 'react';
import { NativeModelSettingsRows, type NativeModelSettingsState } from './native-model-settings';

/** Connection ownership is supplied as exact route IDs, independently of display names. */
export function NativeConnectionModels({
  state,
  modelIds,
  label,
}: {
  state: NativeModelSettingsState;
  modelIds: readonly string[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const focusedRow = useRef<HTMLElement | null>(null);
  const ids = new Set(modelIds);
  const models = state.facts?.models.filter((model) => ids.has(model.id)) ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const visibleModels = needle
    ? models.filter((model) => model.model?.toLocaleLowerCase().includes(needle))
    : models;
  const visibleIds = visibleModels.map((model) => model.id);
  const modelKey = JSON.stringify(visibleIds);
  // A protected outcome can disable the focused switch; a refresh can remove its model.
  // Keep keyboard reading in this manager instead of letting focus fall to body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recheck focus after rows or write eligibility change.
  useLayoutEffect(() => {
    const previous = focusedRow.current;
    if (!open || !previous || (previous.isConnected && !previous.hasAttribute('disabled'))) return;
    focusedRow.current = null;
    const active = previous.ownerDocument.activeElement;
    if (!active || active === previous.ownerDocument.body || active === previous)
      viewportRef.current?.focus({ preventScroll: true });
  }, [open, modelKey, state.canToggle]);
  const container = open
    ? (triggerRef.current?.closest<HTMLElement>('.desktop-settings') ??
      triggerRef.current?.parentElement)
    : undefined;
  return (
    <div className="connection-models">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery('');
            focusedRow.current = null;
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            className="connection-models-trigger"
            aria-label={`管理 ${label} 的模型`}
            disabled={!state.facts}
          >
            <span>
              {state.facts
                ? `${models.length} 个模型 · 已启用 ${models.filter((model) => model.enabled).length} 个`
                : state.reading
                  ? '正在读取模型…'
                  : '模型暂不可用'}
            </span>
            <span className="connection-models-action">
              管理模型
              <svg aria-hidden="true" data-icon="inline-end" viewBox="0 0 24 24" fill="none">
                <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
          </Button>
        </PopoverTrigger>
        {open && container && (
          <PopoverContent
            className="connection-models-popover settings-models"
            aria-label={`${label} 的模型管理`}
            align="end"
            sideOffset={8}
            collisionPadding={12}
            container={container}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus({ preventScroll: true });
            }}
          >
            <Input
              ref={searchRef}
              className="connection-models-search"
              type="search"
              aria-label={`搜索 ${label} 的模型`}
              placeholder="搜索模型名称"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                if (viewportRef.current) viewportRef.current.scrollTop = 0;
              }}
            />
            <ScrollArea
              className="connection-models-scroll"
              fade="y"
              viewportClassName="connection-models-viewport"
              viewportRef={viewportRef}
              viewportProps={{ role: 'region', 'aria-label': `${label} 的模型列表`, tabIndex: 0 }}
            >
              <div
                onFocusCapture={(event) => {
                  if (event.target.getAttribute('role') === 'switch')
                    focusedRow.current = event.target;
                }}
              >
                <NativeModelSettingsRows state={state} modelIds={visibleIds} />
                {!visibleIds.length && (
                  <p className="connection-models-empty" role="status">
                    {models.length ? '没有匹配的模型' : '暂无模型'}
                  </p>
                )}
              </div>
            </ScrollArea>
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
