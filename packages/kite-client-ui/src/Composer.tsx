import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  BotIcon,
  FlashIcon,
  Loading03Icon,
  SquareStopIcon,
  TriangleAlertIcon,
  UserQuestion01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, type ReactNode, type Ref, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { Button as ShadcnButton } from './components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { cn } from './lib/utils';
import { Button, Textarea } from './ui';

const permissionModes = [
  { value: 'accept_edits', icon: UserQuestion01Icon },
  { value: 'auto', icon: BotIcon },
  { value: 'full', icon: FlashIcon },
] as const;

const permissionCopy = {
  zh: {
    name: '权限',
    heading: '如何处理操作请求？',
    helper: '为当前对话选择审批方式',
    accept_edits: {
      label: '询问',
      menuLabel: '需要时询问我',
      detail: '需批准的操作会暂停，等待你确认',
    },
    auto: {
      label: '自动',
      menuLabel: '自动审查',
      detail: '审批模型先判断命令，必要时再询问',
    },
    full: {
      label: '完全',
      menuLabel: '完全权限',
      detail: '跳过常规审批，改动可能难以撤销',
    },
    fullWarning: {
      title: '要开启完全权限吗？',
      description:
        '开启后，代理无需逐项征得你的同意，就能在当前环境允许的范围内运行命令、读取或修改文件，以及访问互联网。',
      riskTitle: '请留意这些风险',
      impact: '文件可能被覆盖或删除；命令和联网操作可能接触、传输敏感数据，造成难以撤销的损失。',
      limit: '你可以随时切回其他审批方式；系统限制仍然有效。',
      cancel: '取消',
      confirm: '启用完全权限',
    },
  },
  en: {
    name: 'Permission',
    heading: 'How should actions be approved?',
    helper: 'Choose an approval mode for this conversation',
    accept_edits: {
      label: 'Ask',
      menuLabel: 'Ask me when needed',
      detail: 'Pause for your approval when required',
    },
    auto: {
      label: 'Auto',
      menuLabel: 'Automatic review',
      detail: 'Review commands first; ask when needed',
    },
    full: {
      label: 'Full',
      menuLabel: 'Full permission',
      detail: 'Skip routine approvals; changes may be hard to undo',
    },
    fullWarning: {
      title: 'Enable Full permission?',
      description:
        'The agent can act without asking for each approval. Within the capabilities available in this environment, it can run commands, read or change files, and access the internet.',
      riskTitle: 'Risks to consider',
      impact:
        'Files could be overwritten or deleted. Commands and network access could expose or transmit sensitive data and cause changes that are hard to undo.',
      limit: 'You can switch back to another approval mode at any time. System limits still apply.',
      cancel: 'Cancel',
      confirm: 'Enable Full',
    },
  },
} as const;

export interface ComposerProps {
  inputRef?: Ref<HTMLTextAreaElement>;
  context?: ReactNode;
  draft: string;
  onChange: (value: string) => void;
  onSend?: () => void;
  onCancel?: () => void;
  onSettings?: () => void;
  active: boolean;
  stopping: boolean;
  cancelDisabled?: boolean;
  disabled: boolean;
  model?: { readonly provider: string; readonly name: string };
  models?: readonly {
    readonly provider: string;
    readonly name: string;
  }[];
  onModelChange?: (provider: string, name: string) => void;
  modelDisabled?: boolean;
  permission?: 'accept_edits' | 'auto' | 'full';
  fullPermissionScope?: string;
  onPermissionChange?: (permission: 'accept_edits' | 'auto' | 'full') => void;
  permissionDisabled?: boolean;
  permissionPending?: boolean;
  sessionLoading?: boolean;
  submitStatus?: string;
  promptHidden?: boolean;
}
export function Composer(props: ComposerProps) {
  const composing = useRef(false);
  const [confirmingFullScope, setConfirmingFullScope] = useState<string | null>(null);
  const permissionLanguage =
    typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en';
  const permissionText = permissionCopy[permissionLanguage];
  const canSend = !!props.onSend && !props.disabled && !!props.draft.trim() && !props.active;
  const selectedModel = props.model
    ? props.models?.find(
        (model) => model.provider === props.model?.provider && model.name === props.model?.name,
      )
    : undefined;
  const modelValue = selectedModel
    ? `${selectedModel.provider}\0${selectedModel.name}`
    : props.model
      ? `current\0${props.model.provider}\0${props.model.name}`
      : '';
  if (props.promptHidden) {
    return null;
  }
  return (
    <>
      {props.context}
      <form
        className="composer"
        data-permission-pending={props.permissionPending || undefined}
        data-session-loading={props.sessionLoading || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && !composing.current) props.onSend?.();
        }}
      >
        <Textarea
          ref={props.inputRef}
          aria-label="任务输入"
          placeholder="描述你想完成的工作…"
          value={props.draft}
          onChange={(event) => props.onChange(event.target.value)}
          disabled={props.disabled}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (canSend) props.onSend?.();
          }}
        />
        <div className="composer-bottom">
          <div className="composer-options">
            {props.onModelChange && props.models?.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="ghost model-trigger"
                    data-model-trigger
                    aria-label={`模型：${props.model?.name ?? '选择模型'}`}
                    title={props.model?.name}
                    disabled={props.modelDisabled}
                  >
                    <span>{props.model?.name ?? '选择模型'}</span>
                    <HugeiconsIcon data-icon="inline-end" icon={ArrowDown01Icon} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="model-menu"
                  portalled={false}
                  side="top"
                  align="start"
                  sideOffset={6}
                  aria-label="模型"
                >
                  <DropdownMenuRadioGroup value={modelValue}>
                    {props.model && !selectedModel && (
                      <DropdownMenuGroup>
                        <DropdownMenuRadioItem value={modelValue} disabled indicatorPosition="end">
                          {props.model.name}
                        </DropdownMenuRadioItem>
                      </DropdownMenuGroup>
                    )}
                    {[...new Set(props.models.map((model) => model.provider))].map((provider) => (
                      <DropdownMenuGroup key={provider}>
                        <DropdownMenuLabel className="model-provider-label">
                          {provider}
                        </DropdownMenuLabel>
                        {props
                          .models!.filter((model) => model.provider === provider)
                          .map((model) => (
                            <DropdownMenuRadioItem
                              key={`${model.provider}\0${model.name}`}
                              value={`${model.provider}\0${model.name}`}
                              indicatorPosition="end"
                              onSelect={() => props.onModelChange?.(model.provider, model.name)}
                            >
                              {model.name}
                            </DropdownMenuRadioItem>
                          ))}
                      </DropdownMenuGroup>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : props.onSettings ? (
              <Button className="ghost model-button" onClick={props.onSettings}>
                {props.model?.name || '配置模型'}
              </Button>
            ) : (
              <span>{props.model?.name}</span>
            )}
            {props.permission && props.onPermissionChange && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <ShadcnButton
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'permission-trigger',
                      props.permission === 'full' && 'permission-trigger-danger',
                    )}
                    data-permission-trigger
                    aria-label={`${permissionText.name}${permissionLanguage === 'zh' ? '：' : ': '}${permissionText[props.permission].label}${props.permissionPending ? (permissionLanguage === 'zh' ? '，切换中' : ', changing') : ''}`}
                    disabled={props.permissionDisabled}
                  >
                    <HugeiconsIcon
                      data-icon="inline-start"
                      icon={permissionModes.find((mode) => mode.value === props.permission)!.icon}
                    />
                    <span>{permissionText[props.permission].label}</span>
                    <HugeiconsIcon
                      data-icon="inline-end"
                      className={props.permissionPending ? 'motion-safe:animate-spin' : undefined}
                      icon={props.permissionPending ? Loading03Icon : ArrowDown01Icon}
                    />
                  </ShadcnButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="permission-menu"
                  portalled={false}
                  side="top"
                  align="start"
                  sideOffset={6}
                  aria-label={permissionText.name}
                >
                  <DropdownMenuLabel className="permission-menu-heading">
                    <span>{permissionText.heading}</span>
                    <small>{permissionText.helper}</small>
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={props.permission}
                    onValueChange={(value) => {
                      if (value === props.permission) return;
                      if (value === 'full') {
                        setConfirmingFullScope(props.fullPermissionScope ?? '');
                      } else
                        props.onPermissionChange?.(
                          value as NonNullable<ComposerProps['permission']>,
                        );
                    }}
                  >
                    <DropdownMenuGroup>
                      {permissionModes.map((mode) => (
                        <Fragment key={mode.value}>
                          {mode.value === 'full' && (
                            <DropdownMenuSeparator className="permission-menu-divider" />
                          )}
                          <DropdownMenuRadioItem
                            value={mode.value}
                            indicatorPosition="end"
                            className={cn(
                              'permission-menu-item',
                              mode.value === 'full' && 'permission-menu-item-danger',
                            )}
                          >
                            <HugeiconsIcon icon={mode.icon} aria-hidden="true" />
                            <span className="permission-menu-copy">
                              <span>{permissionText[mode.value].menuLabel}</span>
                              <small>{permissionText[mode.value].detail}</small>
                            </span>
                          </DropdownMenuRadioItem>
                        </Fragment>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {props.active ? (
            props.onCancel && (
              <Button
                className="primary composer-action stop-action"
                size="icon-sm"
                aria-label={props.stopping ? '正在停止…' : '停止任务'}
                title={props.stopping ? '正在停止…' : '停止任务'}
                onClick={props.onCancel}
                disabled={props.stopping || props.cancelDisabled}
              >
                <HugeiconsIcon icon={SquareStopIcon} />
              </Button>
            )
          ) : (
            <Button
              className="primary composer-action"
              size="icon-sm"
              type="submit"
              aria-label={props.submitStatus ? `发送消息：${props.submitStatus}` : '发送消息'}
              title={props.submitStatus || '发送消息'}
              disabled={!canSend}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} />
            </Button>
          )}
        </div>
      </form>
      <AlertDialog
        open={confirmingFullScope !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingFullScope(null);
        }}
      >
        <AlertDialogContent className="full-permission-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="full-permission-title">
              <HugeiconsIcon
                className="full-permission-title-icon"
                icon={TriangleAlertIcon}
                aria-hidden="true"
              />
              {permissionText.fullWarning.title}
            </AlertDialogTitle>
            <AlertDialogDescription asChild className="full-permission-description">
              <div>
                <p className="full-permission-intro">{permissionText.fullWarning.description}</p>
                <div className="full-permission-risk-notice">
                  <strong className="full-permission-risk-heading">
                    {permissionText.fullWarning.riskTitle}
                  </strong>
                  <p className="full-permission-risk-copy">{permissionText.fullWarning.impact}</p>
                </div>
                <p className="full-permission-limit">{permissionText.fullWarning.limit}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{permissionText.fullWarning.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={props.permissionDisabled}
              onClick={() => {
                if (confirmingFullScope !== (props.fullPermissionScope ?? '')) return;
                props.onPermissionChange?.('full');
              }}
            >
              <HugeiconsIcon data-icon="inline-start" icon={TriangleAlertIcon} aria-hidden="true" />
              {permissionText.fullWarning.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {props.submitStatus && (
        <span className="sr-only" aria-live="polite">
          {props.submitStatus}
        </span>
      )}
    </>
  );
}
