import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  BotIcon,
  Cancel01Icon,
  FlashIcon,
  Loading03Icon,
  StopIcon,
  TriangleAlertIcon,
  UserQuestion01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Fragment,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AttachmentFileCard } from './AttachmentFileCard';
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { cn } from './lib/utils';
import { ModelEffortSelector, type ModelOption, type ThinkingEffort } from './ModelEffortSelector';
import { PromptEditor, type PromptEditorHandle } from './PromptEditor';
import { QueuedMessages, type QueuedMessagesProps } from './QueuedMessages';
import { Button } from './ui';

const contextTokenFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const permissionModes = [
  { value: 'accept_edits', icon: UserQuestion01Icon },
  { value: 'auto', icon: BotIcon },
  { value: 'full', icon: FlashIcon },
] as const;

const permissionCopy = {
  zh: {
    name: '权限',
    placeholder: '审核方式',
    heading: '如何处理操作请求？',
    helper: '为当前对话选择审批方式',
    accept_edits: {
      label: '请求批准',
      menuLabel: '请求批准',
      detail: '允许工作区写入；外部写入和联网须批准',
    },
    auto: {
      label: '自动审核',
      menuLabel: '自动审核',
      detail: '模型审核安全性；明确拒绝不会执行并说明原因',
    },
    full: {
      label: '完全访问',
      menuLabel: '完全访问',
      detail: '允许外部写入和联网；极危险操作仍拒绝',
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
    placeholder: 'Approval mode',
    heading: 'How should actions be approved?',
    helper: 'Choose an approval mode for this conversation',
    accept_edits: {
      label: 'Request Approval',
      menuLabel: 'Request Approval',
      detail: 'Allow workspace writes; approve external writes and internet access',
    },
    auto: {
      label: 'Auto',
      menuLabel: 'Automatic review',
      detail: 'Review safety; rejected actions do not execute and include a reason',
    },
    full: {
      label: 'Full',
      menuLabel: 'Full permission',
      detail: 'Allow external writes and internet access; extreme dangers remain denied',
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
  queue?: QueuedMessagesProps;
  /** Changed by the host after a queue withdrawal has filled the controlled draft. */
  queueFocusKey?: string | number;
  inputRef?: Ref<PromptEditorHandle>;
  scopeKey?: string;
  /** A host can reject with code file_picker_restart_required when its picker is not loaded. */
  onFileReferences?: (
    files: readonly File[],
  ) => Promise<readonly { name: string; uri: string }[]> | readonly { name: string; uri: string }[];
  onFilesSelected?: (files: readonly { name: string; uri: string }[]) => void;
  files?: readonly { id: string; name: string; uri: string }[];
  onRemoveFile?: (id: string) => void;
  onImageFiles?: (files: readonly File[]) => void;
  imageLimit?: number;
  images?: readonly {
    id: string;
    name: string;
    url: string;
    loading?: boolean;
    error?: string;
    previewError?: string;
  }[];
  onRemoveImage?: (id: string) => void;
  imageError?: string;
  context?: ReactNode;
  options?: ReactNode;
  inputLabel?: string;
  sendLabel?: string;
  sendDisabled?: boolean;
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
  models?: readonly ModelOption[];
  reasoningEffort?: string;
  onReasoningEffortChange?: (effort: ThinkingEffort) => void;
  onModelChange?: (provider: string, name: string) => void;
  modelDisabled?: boolean;
  permission?: 'accept_edits' | 'auto' | 'full';
  fullPermissionScope?: string;
  onPermissionChange?: (permission: 'accept_edits' | 'auto' | 'full') => void;
  permissionDisabled?: boolean;
  permissionPending?: boolean;
  sessionLoading?: boolean;
  contextUsage?: {
    readonly totalInputTokens: number;
    readonly contextWindowTokens?: number;
  };
  cacheMetrics?: {
    readonly cacheHitTokens: number;
    readonly cacheMissTokens: number;
  };
  submitStatus?: string;
  sending?: boolean;
  promptHidden?: boolean;
}
export function Composer(props: ComposerProps) {
  const editor = useRef<PromptEditorHandle>(null);
  const queueFocus = useRef({ scope: props.scopeKey, key: props.queueFocusKey });
  useLayoutEffect(() => {
    const prior = queueFocus.current;
    if (prior.scope !== props.scopeKey || props.queueFocusKey === undefined) {
      queueFocus.current = { scope: props.scopeKey, key: props.queueFocusKey };
      return;
    }
    if (prior.key === props.queueFocusKey || props.promptHidden || props.disabled) return;
    queueFocus.current = { scope: props.scopeKey, key: props.queueFocusKey };
    editor.current?.focus();
    editor.current?.moveCaretToEnd();
  }, [props.scopeKey, props.queueFocusKey, props.promptHidden, props.disabled]);
  const form = useRef<HTMLFormElement>(null);
  const attachmentTrigger = useRef<HTMLButtonElement>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [confirmingFullScope, setConfirmingFullScope] = useState<string | null>(null);
  const [attachmentMenuLayout, setAttachmentMenuLayout] = useState({
    width: 0,
    alignOffset: 0,
    sideOffset: 6,
  });
  const current = useRef(props);
  const filePick = useRef<object | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileDialog = useRef<ComposerProps | null>(null);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [fileError, setFileError] = useState<string>();
  useLayoutEffect(() => {
    if (current.current.scopeKey !== props.scopeKey) {
      fileDialog.current = null;
      filePick.current = null;
      setPickingFiles(false);
      setFileError(undefined);
    }
    if (current.current.scopeKey !== props.scopeKey || props.disabled || props.promptHidden)
      setAttachmentMenuOpen(false);
    if (
      current.current.scopeKey !== props.scopeKey ||
      current.current.fullPermissionScope !== props.fullPermissionScope ||
      props.permissionDisabled ||
      props.promptHidden
    ) {
      setPermissionMenuOpen(false);
      setConfirmingFullScope(null);
    }
    current.current = props;
  });
  useLayoutEffect(() => {
    if (!attachmentMenuOpen || !form.current || !attachmentTrigger.current) return;
    const measure = () => {
      const bounds = form.current?.getBoundingClientRect();
      const trigger = attachmentTrigger.current?.getBoundingClientRect();
      if (!bounds || !trigger) return;
      const next = {
        width: bounds.width,
        alignOffset: bounds.left - trigger.left,
        sideOffset: trigger.top - bounds.top + 6,
      };
      setAttachmentMenuLayout((prior) =>
        prior.width === next.width &&
        prior.alignOffset === next.alignOffset &&
        prior.sideOffset === next.sideOffset
          ? prior
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(form.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [attachmentMenuOpen]);
  useLayoutEffect(
    () => () => {
      filePick.current = null;
      fileDialog.current = null;
    },
    [],
  );
  const filePickingEnabled = !!(props.onFileReferences || props.onImageFiles);
  useLayoutEffect(() => {
    if (!filePickingEnabled) return;
    const input = fileInput.current;
    const cancel = () => {
      fileDialog.current = null;
    };
    input?.addEventListener('cancel', cancel);
    return () => input?.removeEventListener('cancel', cancel);
  }, [filePickingEnabled]);
  function pickFiles() {
    const original = current.current;
    if (!filePickingEnabled || original.disabled || !fileInput.current) return;
    fileDialog.current = original;
    fileInput.current.value = '';
    fileInput.current.click();
  }
  useImperativeHandle(
    props.inputRef,
    () => ({
      focus: () => editor.current?.focus(),
      moveCaretToEnd: () => editor.current?.moveCaretToEnd(),
    }),
    [],
  );
  async function attachFiles(selected: readonly File[], original = current.current) {
    if (!selected.length || original.disabled || current.current.scopeKey !== original.scopeKey)
      return;
    const token = {};
    filePick.current = token;
    setPickingFiles(true);
    setFileError(undefined);
    try {
      const isImage = (file: File) =>
        file.type.startsWith('image/') ||
        /\.(?:png|jpe?g|webp|gif|avif|bmp|heic|heif|svg|tiff?|ico)$/i.test(file.name);
      const images = selected.filter(isImage);
      const ordinary = selected.filter((file) => !isImage(file));
      if ((current.current.images?.length ?? 0) + images.length > (original.imageLimit ?? 10))
        throw Object.assign(Error('input_image_count_limit'), { code: 'input_image_count_limit' });
      if (ordinary.length && !original.onFileReferences) throw Error('file_reference_unavailable');
      if (images.length && !original.onImageFiles) throw Error('image_input_unavailable');
      const files = ordinary.length ? await original.onFileReferences!(ordinary) : [];
      const latest = current.current;
      if (filePick.current !== token || latest.scopeKey !== original.scopeKey || latest.disabled)
        return;
      if (
        new Set([...(latest.files ?? []).map((file) => file.uri), ...files.map((file) => file.uri)])
          .size > 128
      ) {
        setFileError('文件附件最多 128 个，请移除部分后重试。');
        return;
      }
      if (images.length) {
        const preparing = original.onImageFiles!(images);
        if (files.length) original.onFilesSelected?.(files);
        await preparing;
      } else if (files.length) original.onFilesSelected?.(files);
    } catch (error) {
      if (filePick.current === token && current.current.scopeKey === original.scopeKey)
        setFileError(
          (error as { code?: string })?.code === 'input_image_count_limit'
            ? `每条消息最多添加 ${original.imageLimit ?? 10} 张图片，请减少数量后重试。`
            : (error as { code?: string })?.code === 'input_image_window_count_limit'
              ? '当前窗口待发送图片过多，请移除其他会话中的部分图片后重试。'
              : (error as { code?: string })?.code === 'file_picker_restart_required'
                ? '文件选择功能尚未加载，请完全退出并重新打开应用。'
                : '无法添加文件，请重试。',
        );
    } finally {
      if (filePick.current === token) {
        filePick.current = null;
        setPickingFiles(false);
      }
    }
  }
  const permissionLanguage =
    typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en';
  const permissionText = permissionCopy[permissionLanguage];
  const permissionLabel = props.permission
    ? permissionText[props.permission].label
    : permissionText.placeholder;
  const cacheTokenTotal =
    (props.cacheMetrics?.cacheHitTokens ?? 0) + (props.cacheMetrics?.cacheMissTokens ?? 0);
  const cacheHitPercentage =
    cacheTokenTotal > 0
      ? Math.round(((props.cacheMetrics?.cacheHitTokens ?? 0) / cacheTokenTotal) * 100)
      : undefined;
  const contextTokens = props.contextUsage?.totalInputTokens;
  const contextWindowTokens = props.contextUsage?.contextWindowTokens;
  const contextPercentage =
    contextTokens !== undefined &&
    Number.isSafeInteger(contextTokens) &&
    contextTokens >= 0 &&
    contextWindowTokens !== undefined &&
    Number.isSafeInteger(contextWindowTokens) &&
    contextWindowTokens > 0
      ? Math.round((contextTokens / contextWindowTokens) * 100)
      : undefined;
  const canSend =
    !!props.onSend &&
    !props.disabled &&
    !props.sendDisabled &&
    !props.sending &&
    !pickingFiles &&
    !props.images?.some((image) => image.loading || image.error) &&
    (!!props.draft.trim() || !!props.images?.length || !!props.files?.length);
  const showStop =
    !props.sending &&
    props.active &&
    !!props.onCancel &&
    ((!props.draft.trim() && !props.images?.length && !props.files?.length) || props.stopping);
  // Preserve only previously enabled presentation during a routine read gate. Business
  // disabled states (empty draft, sending, stopping, file preparation) remain visible.
  const presentation = useRef(
    new Map<
      string,
      { send: boolean; stop: boolean; attach: boolean; input: boolean; permission: boolean }
    >(),
  );
  const presentationScope = props.scopeKey ?? 'composer';
  const previousPresentation = props.sessionLoading
    ? presentation.current.get(presentationScope)
    : undefined;
  useLayoutEffect(() => {
    if (props.sessionLoading) return;
    presentation.current.delete(presentationScope);
    presentation.current.set(presentationScope, {
      send: canSend,
      stop: !!showStop && !props.stopping && !props.cancelDisabled,
      attach: !props.disabled && !pickingFiles,
      input: !props.disabled,
      permission: !!props.permission && !props.permissionDisabled,
    });
    while (presentation.current.size > 12)
      presentation.current.delete(presentation.current.keys().next().value!);
  });
  if (props.promptHidden) {
    return null;
  }
  return (
    <>
      {props.context}
      <form
        ref={form}
        className="composer"
        data-permission-pending={props.permissionPending || undefined}
        data-session-loading={props.sessionLoading || undefined}
        data-preserve-input={previousPresentation?.input || undefined}
        onPointerDownCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('button:disabled')) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onMouseDown={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            (!event.currentTarget.contains(target) ||
              target.closest(
                'button, textarea, input, a, [contenteditable="true"], [role="menu"], [role="menuitem"]',
              ))
          )
            return;
          event.preventDefault();
          editor.current?.focus();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) props.onSend?.();
        }}
      >
        {props.queue && (
          <QueuedMessages
            key={props.scopeKey}
            {...props.queue}
            disabled={props.disabled || props.queue.disabled}
          />
        )}
        {filePickingEnabled && (
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="选择文件"
            onChange={(event) => {
              const selected = fileDialog.current;
              fileDialog.current = null;
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (
                selected &&
                selected.scopeKey === current.current.scopeKey &&
                !current.current.disabled &&
                files.length
              )
                void attachFiles(files, selected);
            }}
          />
        )}
        {(!!props.images?.length || !!props.files?.length) && (
          <section className="composer-attachments" aria-label="待发送附件">
            {props.files?.map((file) => (
              <AttachmentFileCard name={file.name} key={file.id}>
                {props.onRemoveFile && (
                  <Button
                    className="composer-attachment-remove"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`移除附件 ${file.name}`}
                    disabled={props.disabled}
                    onClick={() => props.onRemoveFile?.(file.id)}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} />
                  </Button>
                )}
              </AttachmentFileCard>
            ))}
            {props.images?.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <div
                  className="composer-attachment-preview"
                  aria-busy={(!image.url && !image.previewError && !image.error) || undefined}
                >
                  {image.url ? (
                    <img src={image.url} alt={image.name} decoding="async" />
                  ) : image.previewError || image.error ? (
                    <span>{image.previewError ?? '预览不可用'}</span>
                  ) : null}
                </div>
                <span className="composer-attachment-name" title={image.error ?? image.name}>
                  {image.error ?? image.name}
                </span>
                {props.onRemoveImage && (
                  <Button
                    className="composer-attachment-remove"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`移除图片 ${image.name}`}
                    disabled={props.disabled}
                    onClick={() => props.onRemoveImage?.(image.id)}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} />
                  </Button>
                )}
              </div>
            ))}
          </section>
        )}
        <PromptEditor
          inputRef={editor}
          value={props.draft}
          scopeKey={props.scopeKey ?? 'composer'}
          label={props.inputLabel ?? '任务输入'}
          disabled={props.disabled}
          onChange={props.onChange}
          onSend={() => {
            if (canSend) props.onSend?.();
          }}
          onFiles={
            filePickingEnabled
              ? (files) => {
                  void attachFiles(files);
                }
              : undefined
          }
        />
        {(props.imageError || fileError) && (
          <p className="composer-input-error" role="alert">
            {props.imageError || fileError}
          </p>
        )}
        <div className="composer-bottom">
          <div className="composer-options">
            {filePickingEnabled && (
              <DropdownMenu
                open={attachmentMenuOpen}
                onOpenChange={(open) => {
                  if (!open || !current.current.disabled) setAttachmentMenuOpen(open);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <ShadcnButton
                    ref={attachmentTrigger}
                    variant="ghost"
                    size="icon-sm"
                    className="composer-attach"
                    aria-label="添加附件"
                    title="添加文件"
                    disabled={props.disabled || pickingFiles}
                    data-preserve-enabled={
                      (!!previousPresentation?.attach && !pickingFiles) || undefined
                    }
                    aria-busy={pickingFiles || undefined}
                  >
                    <HugeiconsIcon icon={Add01Icon} />
                  </ShadcnButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="composer-attach-menu"
                  portalled={false}
                  side="top"
                  align="start"
                  alignOffset={attachmentMenuLayout.alignOffset}
                  sideOffset={attachmentMenuLayout.sideOffset}
                  collisionPadding={12}
                  style={{ width: attachmentMenuLayout.width || undefined }}
                  aria-label="添加附件"
                >
                  <DropdownMenuLabel className="composer-attach-menu-label">添加</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    <DropdownMenuItem aria-label="添加文件" onSelect={pickFiles}>
                      <HugeiconsIcon icon={Attachment01Icon} aria-hidden="true" />
                      <span>添加文件</span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {props.options}
            {props.onModelChange && props.models?.length ? (
              <ModelEffortSelector
                model={props.model}
                models={props.models}
                onModelChange={props.onModelChange}
                reasoningEffort={props.reasoningEffort}
                onReasoningEffortChange={props.onReasoningEffortChange}
                disabled={props.modelDisabled}
              />
            ) : props.onSettings ? (
              <Button className="ghost model-button" onClick={props.onSettings}>
                {props.model?.name || '配置模型'}
              </Button>
            ) : (
              <span>{props.model?.name}</span>
            )}
            {(props.permission || props.sessionLoading) && props.onPermissionChange && (
              <DropdownMenu
                open={permissionMenuOpen}
                onOpenChange={(open) => {
                  if (!open || (!current.current.permissionDisabled && current.current.permission))
                    setPermissionMenuOpen(open);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <ShadcnButton
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'permission-trigger',
                      props.permission === 'full' && 'permission-trigger-danger',
                    )}
                    data-permission-trigger
                    data-preserve-enabled={previousPresentation?.permission || undefined}
                    aria-busy={props.permissionPending || props.sessionLoading || undefined}
                    aria-label={`${permissionText.name}${permissionLanguage === 'zh' ? '：' : ': '}${permissionLabel}${props.permissionPending ? (permissionLanguage === 'zh' ? '，切换中' : ', changing') : ''}`}
                    disabled={props.permissionDisabled || !props.permission}
                  >
                    <HugeiconsIcon
                      data-icon="inline-start"
                      icon={
                        permissionModes.find((mode) => mode.value === props.permission)?.icon ??
                        Loading03Icon
                      }
                    />
                    <span>{permissionLabel}</span>
                    <HugeiconsIcon data-icon="inline-end" icon={ArrowDown01Icon} />
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
                      if (
                        current.current.permissionDisabled ||
                        !current.current.permission ||
                        value === current.current.permission
                      )
                        return;
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
          <div className="composer-trailing">
            {(cacheHitPercentage !== undefined || props.contextUsage) && (
              <div className="composer-metrics">
                {cacheHitPercentage !== undefined && (
                  <span
                    className="composer-cache-rate"
                    title={`缓存命中 ${props.cacheMetrics!.cacheHitTokens} / ${cacheTokenTotal} tokens`}
                  >
                    缓存 {cacheHitPercentage}%
                  </span>
                )}
                {props.contextUsage && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="composer-context-usage"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            contextPercentage === undefined
                              ? '上下文占用未知'
                              : `上下文占用约 ${contextPercentage}%`
                          }
                          aria-description={`上下文估算 ${contextTokens} / ${contextWindowTokens ?? '未知'} tokens`}
                        >
                          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <circle className="composer-context-track" cx="8" cy="8" r="6" />
                            {contextPercentage !== undefined && contextPercentage > 0 && (
                              <circle
                                cx="8"
                                cy="8"
                                r="6"
                                pathLength="100"
                                strokeDasharray={`${Math.min(contextPercentage, 100)} 100`}
                                transform="rotate(-90 8 8)"
                              />
                            )}
                          </svg>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent
                        className="kite-client composer-context-tooltip"
                        side="top"
                        sideOffset={8}
                        collisionPadding={12}
                      >
                        <span>上下文窗口</span>
                        <span>
                          {contextPercentage === undefined
                            ? '占用比例未知'
                            : `约 ${contextPercentage}% 已用`}
                        </span>
                        <span>
                          已用 {contextTokenFormat.format(contextTokens!).toLowerCase()} 标记，
                          {contextWindowTokens === undefined
                            ? '总量未知'
                            : `共 ${contextTokenFormat.format(contextWindowTokens).toLowerCase()}`}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            )}
            <div className="composer-actions">
              {showStop ? (
                <Button
                  className="primary composer-action stop-action"
                  size="icon-sm"
                  aria-label={props.stopping ? '正在停止…' : '停止任务'}
                  title={props.stopping ? '正在停止…' : '停止任务'}
                  onClick={props.onCancel}
                  disabled={props.stopping || props.cancelDisabled}
                  data-preserve-enabled={
                    (!!previousPresentation?.stop && !props.stopping) || undefined
                  }
                >
                  <HugeiconsIcon icon={StopIcon} fill="currentColor" strokeWidth={0} />
                </Button>
              ) : (
                <Button
                  className="primary composer-action"
                  size="icon-sm"
                  type="submit"
                  aria-label={
                    props.sendLabel ??
                    (props.sending
                      ? '正在发送消息'
                      : props.submitStatus
                        ? `发送消息：${props.submitStatus}`
                        : props.active
                          ? '发送运行中引导'
                          : '发送消息')
                  }
                  title={
                    props.sendLabel ??
                    (props.sending
                      ? '正在发送消息'
                      : props.submitStatus || (props.active ? '发送运行中引导' : '发送消息'))
                  }
                  aria-busy={props.sending || undefined}
                  disabled={!canSend}
                  data-preserve-enabled={
                    (!!previousPresentation?.send &&
                      !props.sending &&
                      !pickingFiles &&
                      !props.images?.some((image) => image.loading || image.error) &&
                      (!!props.draft.trim() || !!props.images?.length || !!props.files?.length)) ||
                    undefined
                  }
                >
                  <HugeiconsIcon
                    icon={props.sending ? Loading03Icon : ArrowUp02Icon}
                    className={props.sending ? 'motion-safe:animate-spin' : undefined}
                    strokeWidth={2}
                  />
                </Button>
              )}
            </div>
          </div>
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
                if (
                  current.current.permissionDisabled ||
                  confirmingFullScope !== (current.current.fullPermissionScope ?? '')
                )
                  return;
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
