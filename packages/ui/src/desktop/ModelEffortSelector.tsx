import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from './components/ui/command';
import { PillSelectTrigger } from './components/ui/pill-select-trigger';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { ScrollArea } from './components/ui/scroll-area';
import { Separator } from './components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { effortNames, GemSlider } from './GemSlider';
import { cn } from './lib/utils';

const effortValues = ['low', 'medium', 'high', 'xhigh', 'max', 'ultar'] as const;
const defaultEffortIndex = effortValues.indexOf('medium');
export type ThinkingEffort = (typeof effortValues)[number];
export interface ModelOption {
  readonly id?: string;
  readonly provider: string;
  readonly name: string;
  readonly reasoningEffort?: string;
  readonly reasoningEffortChoices?: readonly (ThinkingEffort | 'none' | 'minimal')[];
}
export interface ModelEffortSelectorProps {
  model?: { readonly id?: string; readonly provider: string; readonly name: string };
  models: readonly ModelOption[];
  onModelChange: (provider: string, name: string, id?: string) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (effort: ThinkingEffort) => void;
  modelSelectionHint?: string;
  disabled?: boolean;
}

function popoverSize(element: HTMLElement) {
  const style = getComputedStyle(element);
  return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
}

export function ModelEffortSelector(props: ModelEffortSelectorProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const [activeProvider, setActiveProvider] = useState('');
  const modelSwitch = useRef<HTMLButtonElement>(null);
  const modelView = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const previousSize = useRef<
    { width: number; height: number; view: 'effort' | 'models' } | undefined
  >(undefined);
  const resizeAnimation = useRef<Animation | null>(null);
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const selected = props.models.find((model) =>
    props.model?.id !== undefined
      ? model.id === props.model.id
      : model.provider === props.model?.provider && model.name === props.model.name,
  );
  const canAdjustEffort = !!selected && !!props.onReasoningEffortChange;
  const configuredEffort = props.reasoningEffort ?? selected?.reasoningEffort;
  const effortIndex = (effortValues as readonly string[]).indexOf(configuredEffort ?? '');
  const effortLabel =
    effortIndex >= 0
      ? effortNames[effortIndex]
      : configuredEffort === 'none'
        ? '关闭'
        : configuredEffort || '未指定';
  const choices = effortValues.filter(
    (value) =>
      selected?.reasoningEffortChoices === undefined ||
      selected.reasoningEffortChoices.includes(value),
  );
  const allowedPositions = choices.map((value) => effortValues.indexOf(value));
  const provider = providers.includes(activeProvider) ? activeProvider : providers[0];

  function changeView(next: 'effort' | 'models') {
    if (next === view) return;
    const element = popover.current;
    previousSize.current =
      element &&
      typeof element.animate === 'function' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? { ...popoverSize(element), view: next }
        : undefined;
    resizeAnimation.current?.cancel();
    setView(next);
  }

  useLayoutEffect(() => {
    const from = previousSize.current;
    previousSize.current = undefined;
    const element = popover.current;
    if (!from || from.view !== view || !element) return;
    const to = popoverSize(element);
    if (![from.width, from.height, to.width, to.height].every(Number.isFinite)) return;
    const animation = element.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' },
    );
    resizeAnimation.current = animation;
    const release = () => {
      if (resizeAnimation.current === animation) resizeAnimation.current = null;
    };
    animation.onfinish = release;
    animation.oncancel = release;
    return () => {
      animation.cancel();
      release();
    };
  }, [view]);

  useEffect(() => {
    if (view !== 'models') return;
    const tab = modelView.current?.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    );
    tab?.focus({ preventScroll: true });
    const viewport = tab?.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!tab || !viewport) return;
    const item = tab.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    if (item.top < area.top) viewport.scrollTop += item.top - area.top;
    else if (item.bottom > area.bottom) viewport.scrollTop += item.bottom - area.bottom;
  }, [view]);
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  function focusModelSwitch() {
    requestAnimationFrame(() => modelSwitch.current?.focus({ preventScroll: true }));
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && props.disabled) return;
        setOpen(next);
        if (next) {
          setView('effort');
          setActiveProvider(props.model?.provider ?? providers[0] ?? '');
        }
      }}
    >
      <PopoverTrigger asChild>
        <PillSelectTrigger
          className="model-trigger model-effort-trigger"
          data-model-trigger
          aria-label={`模型：${props.model?.name ?? '选择模型'}${canAdjustEffort && effortLabel ? `，思考程度：${effortLabel}` : ''}`}
          title={props.model ? `${props.model.provider} / ${props.model.name}` : undefined}
          disabled={props.disabled}
          suffix={
            canAdjustEffort && effortLabel ? (
              <span className="model-effort-summary">{effortLabel}</span>
            ) : undefined
          }
        >
          {props.model?.name ?? '选择模型'}
        </PillSelectTrigger>
      </PopoverTrigger>
      <PopoverContent
        ref={popover}
        side="top"
        align="start"
        sideOffset={6}
        className={cn('model-effort-popover', view === 'models' && 'model-effort-popover-models')}
        aria-label="模型与思考程度"
        onEscapeKeyDown={(event) => {
          if (view === 'models') {
            event.preventDefault();
            changeView('effort');
            focusModelSwitch();
          }
        }}
      >
        {view === 'effort' ? (
          <div className="model-effort-panel">
            <div className="flex min-w-0 flex-col items-center gap-2">
              {canAdjustEffort && effortLabel && (
                <output
                  className="effort-value"
                  data-maximum={effortIndex === 5}
                  aria-live="polite"
                >
                  {effortLabel}
                </output>
              )}
              <PillSelectTrigger
                ref={modelSwitch}
                className="model-effort-switch"
                indicator="right"
                onClick={() => {
                  setActiveProvider(props.model?.provider ?? providers[0] ?? '');
                  changeView('models');
                }}
                aria-label={`选择模型，当前 ${props.model ? `${props.model.provider} / ${props.model.name}` : '未选择'}`}
              >
                {props.model ? `${props.model.provider} / ${props.model.name}` : '选择模型'}
              </PillSelectTrigger>
            </div>
            {canAdjustEffort && (
              <div className="mt-1">
                {choices.length > 1 ? (
                  <GemSlider
                    value={
                      allowedPositions.includes(effortIndex)
                        ? effortIndex
                        : allowedPositions.includes(defaultEffortIndex)
                          ? defaultEffortIndex
                          : allowedPositions[0]!
                    }
                    valueText={effortLabel}
                    allowedValues={allowedPositions}
                    onValueChange={(value) => props.onReasoningEffortChange?.(effortValues[value]!)}
                  />
                ) : choices.length === 1 ? (
                  <Button
                    variant="ghost"
                    onClick={() => props.onReasoningEffortChange?.(choices[0]!)}
                  >
                    {effortNames[allowedPositions[0]!]}
                  </Button>
                ) : null}
              </div>
            )}
            {!selected && <p className="model-effort-unavailable">请先选择模型</p>}
            {props.modelSelectionHint && (
              <p className="model-effort-unavailable">{props.modelSelectionHint}</p>
            )}
          </div>
        ) : (
          <Tabs
            ref={modelView}
            orientation="vertical"
            value={provider}
            onValueChange={setActiveProvider}
            className="model-effort-columns"
          >
            <div className="flex min-h-0 min-w-0 flex-col gap-0.5 p-1">
              <span className="px-2 py-1.5 text-muted-foreground">提供商</span>
              <ScrollArea type="auto" className="min-h-0 flex-1" data-provider-scroll>
                <TabsList aria-label="模型提供商" className="model-effort-providers">
                  {providers.map((item) => (
                    <TabsTrigger key={item} value={item} className="model-effort-provider">
                      <span className="truncate" title={item}>
                        {item}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </ScrollArea>
            </div>
            <Separator orientation="vertical" />
            <div className="flex min-h-0 min-w-0 flex-col gap-0.5 p-1">
              <span className="px-2 py-1.5 text-muted-foreground">模型</span>
              {providers.map((item) => (
                <TabsContent key={item} value={item} tabIndex={-1} className="m-0 min-h-0 flex-1">
                  <Command
                    label={`${item} 模型`}
                    className="rounded-none outline-none"
                    tabIndex={0}
                    shouldFilter={false}
                    defaultValue={
                      props.model?.provider === item
                        ? (props.model.id ?? props.model.name)
                        : undefined
                    }
                  >
                    <ScrollArea type="auto" className="min-h-0 flex-1" data-model-scroll>
                      <CommandList label={`${item} 模型`} className="max-h-none overflow-visible">
                        <CommandGroup className="px-0 py-0.5">
                          {props.models
                            .filter((model) => model.provider === item)
                            .map((model) => (
                              <CommandItem
                                key={model.id ?? model.name}
                                value={model.id ?? model.name}
                                aria-label={model.id ? `选择模型 ${model.id}` : undefined}
                                onSelect={() => {
                                  props.onModelChange(model.provider, model.name, model.id);
                                  changeView('effort');
                                  focusModelSwitch();
                                }}
                                className="model-effort-option"
                                data-current={selected === model || undefined}
                              >
                                <span className="truncate" title={model.name}>
                                  {model.name}
                                  {model.id &&
                                    props.models.filter(
                                      (entry) =>
                                        entry.provider === model.provider &&
                                        entry.name === model.name,
                                    ).length > 1 && (
                                      <small className="text-muted-foreground"> · {model.id}</small>
                                    )}
                                </span>
                                {selected === model && (
                                  <HugeiconsIcon icon={Tick02Icon} aria-label="当前模型" />
                                )}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </ScrollArea>
                  </Command>
                </TabsContent>
              ))}
            </div>
          </Tabs>
        )}
      </PopoverContent>
    </Popover>
  );
}
