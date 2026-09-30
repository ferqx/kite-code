import { ArrowDown01Icon, ArrowRight01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from './components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { ScrollArea } from './components/ui/scroll-area';
import { Separator } from './components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { effortNames, GemSlider } from './GemSlider';
import { cn } from './lib/utils';

const effortValues = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof effortValues)[number];
export interface ModelOption {
  readonly provider: string;
  readonly name: string;
  readonly reasoningEffortSupported?: boolean;
  readonly reasoningEffort?: string;
}
export interface ModelEffortSelectorProps {
  model?: { readonly provider: string; readonly name: string };
  models: readonly ModelOption[];
  onModelChange: (provider: string, name: string) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (effort: ThinkingEffort) => void;
  disabled?: boolean;
}

export function ModelEffortSelector(props: ModelEffortSelectorProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const [activeProvider, setActiveProvider] = useState('');
  const modelSwitch = useRef<HTMLButtonElement>(null);
  const modelView = useRef<HTMLDivElement>(null);
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const selected = props.models.find(
    (model) => model.provider === props.model?.provider && model.name === props.model.name,
  );
  const supported = selected?.reasoningEffortSupported === true && !!props.onReasoningEffortChange;
  const configuredEffort = props.reasoningEffort ?? selected?.reasoningEffort;
  const effortIndex = (effortValues as readonly string[]).indexOf(configuredEffort ?? '');
  const effortLabel = effortIndex >= 0 ? effortNames[effortIndex] : configuredEffort || '默认';
  const provider = providers.includes(activeProvider) ? activeProvider : providers[0];

  useEffect(() => {
    if (view === 'models')
      modelView.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
  }, [view]);
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  function focusModelSwitch() {
    requestAnimationFrame(() => modelSwitch.current?.focus());
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setView('effort');
          setActiveProvider(props.model?.provider ?? providers[0] ?? '');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="model-trigger model-effort-trigger"
          data-model-trigger
          aria-label={`模型：${props.model?.name ?? '选择模型'}${supported ? `，思考程度：${effortLabel}` : ''}`}
          title={props.model ? `${props.model.provider} / ${props.model.name}` : undefined}
          disabled={props.disabled}
        >
          <span className="truncate">{props.model?.name ?? '选择模型'}</span>
          {supported && <span className="model-effort-summary">{effortLabel}</span>}
          <HugeiconsIcon data-icon="inline-end" icon={ArrowDown01Icon} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn('model-effort-popover', view === 'models' && 'model-effort-popover-models')}
        aria-label="模型与思考程度"
        onEscapeKeyDown={(event) => {
          if (view === 'models') {
            event.preventDefault();
            setView('effort');
            focusModelSwitch();
          }
        }}
      >
        {view === 'effort' ? (
          <div className="model-effort-panel">
            <div className="flex min-w-0 flex-col items-center">
              {supported && (
                <output
                  className="effort-value"
                  data-maximum={effortIndex === 5}
                  aria-live="polite"
                >
                  {effortLabel}
                </output>
              )}
              <Button
                ref={modelSwitch}
                variant="ghost"
                className="model-effort-switch"
                onClick={() => {
                  setActiveProvider(props.model?.provider ?? providers[0] ?? '');
                  setView('models');
                }}
                aria-label={`选择模型，当前 ${props.model ? `${props.model.provider} / ${props.model.name}` : '未选择'}`}
              >
                <span className="truncate">
                  {props.model ? `${props.model.provider} / ${props.model.name}` : '选择模型'}
                </span>
                <HugeiconsIcon data-icon="inline-end" icon={ArrowRight01Icon} />
              </Button>
            </div>
            {supported ? (
              <div className="mt-3">
                <GemSlider
                  value={effortIndex >= 0 ? effortIndex : 2}
                  valueText={effortLabel}
                  onValueChange={(value) => props.onReasoningEffortChange?.(effortValues[value]!)}
                />
              </div>
            ) : (
              <p className="model-effort-unavailable">当前模型不支持思考程度调节</p>
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
            <div className="flex min-h-0 flex-col gap-2 p-2">
              <span className="px-3 pt-1 text-muted-foreground">提供商</span>
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
            <div className="flex min-h-0 min-w-0 flex-col gap-2 py-2">
              <span className="px-3 pt-1 text-muted-foreground">模型</span>
              {providers.map((item) => (
                <TabsContent key={item} value={item} tabIndex={-1} className="m-0 min-h-0 flex-1">
                  <Command
                    label={`${item} 模型`}
                    tabIndex={0}
                    shouldFilter={false}
                    defaultValue={props.model?.provider === item ? props.model.name : undefined}
                  >
                    <ScrollArea type="auto" className="min-h-0 flex-1" data-model-scroll>
                      <CommandList label={`${item} 模型`} className="max-h-none overflow-visible">
                        <CommandGroup>
                          {props.models
                            .filter((model) => model.provider === item)
                            .map((model) => (
                              <CommandItem
                                key={model.name}
                                value={model.name}
                                onSelect={() => {
                                  props.onModelChange(model.provider, model.name);
                                  setView('effort');
                                  focusModelSwitch();
                                }}
                                className="model-effort-option"
                              >
                                <span className="truncate" title={model.name}>
                                  {model.name}
                                </span>
                                {selected?.provider === model.provider &&
                                  selected.name === model.name && (
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
