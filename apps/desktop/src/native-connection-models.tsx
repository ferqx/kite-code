import { Popover, PopoverContent, PopoverTrigger, ScrollArea } from '@kite-ai/ui/desktop';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const focusedRow = useRef<HTMLElement | null>(null);
  const ids = new Set(modelIds);
  const models = state.facts?.models.filter((model) => ids.has(model.id)) ?? [];
  const modelKey = JSON.stringify(models.map((model) => model.id));
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
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
          </button>
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
              viewportRef.current?.focus({ preventScroll: true });
            }}
          >
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
                <NativeModelSettingsRows state={state} modelIds={modelIds} />
                {!models.length && <p className="connection-models-empty">暂无模型</p>}
              </div>
            </ScrollArea>
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
