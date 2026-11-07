import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Cancel01Icon,
  HandIcon,
  Loading03Icon,
  Shield01Icon,
  ShieldAlertIcon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AttachmentFileCard } from './AttachmentFileCard';
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
import {
  FullPermissionConfirmationDialog,
  fullPermissionConfirmationCopy,
} from './FullPermissionConfirmationDialog';
import { cn } from './lib/utils';
import { ModelEffortSelector, type ModelOption, type ThinkingEffort } from './ModelEffortSelector';
import { PromptEditor, type PromptEditorHandle } from './PromptEditor';
import { QueuedMessages, type QueuedMessagesProps } from './QueuedMessages';
import { ReadGate } from './ReadGate';
import { Button } from './ui';

const contextTokenFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const ShieldTerminalIcon: ComponentProps<typeof HugeiconsIcon>['icon'] = [
  ...Shield01Icon,
  [
    'path',
    {
      d: 'M8 9.5L10.5 12L8 14.5M13 14.5H16',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      key: 'terminal',
    },
  ],
];

const permissionModes = [
  { value: 'accept_edits', icon: HandIcon },
  { value: 'auto', icon: ShieldTerminalIcon },
  { value: 'full', icon: ShieldAlertIcon },
] as const;

const permissionCopy = {
  zh: {
    name: '权限',
    placeholder: '审核方式',
    heading: '如何处理操作请求？',
    helper: '为当前对话选择审批方式',
    grants: '当前会话授权',
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
  },
  en: {
    name: 'Permission',
    placeholder: 'Approval mode',
    heading: 'How should actions be approved?',
    helper: 'Choose an approval mode for this conversation',
    grants: 'Current session grants',
    accept_edits: {
      label: 'Request Approval',
      menuLabel: 'Request Approval',
      detail: 'Allow workspace writes; approve external writes and internet access',
    },
    auto: {
      label: 'Auto',
      menuLabel: 'Automatic check',
      detail: 'Review safety; rejected actions do not execute and include a reason',
    },
    full: {
      label: 'Full',
      menuLabel: 'Full permission',
      detail: 'Allow external writes and internet access; extreme dangers remain denied',
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
    signal?: AbortSignal,
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
  /** Explicit prepared context is input even when the text editor is empty. */
  contextHasInput?: boolean;
  options?: ReactNode;
  inputLabel?: string;
  sendLabel?: string;
  sendDisabled?: boolean;
  /** Scope handoff and read freshness are independent of business availability. */
  readOnly?: boolean;
  readGate?: { send?: boolean; cancel?: boolean; permission?: boolean };
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
  confirmFullPermission?: (options: {
    language: 'zh' | 'en';
    signal: AbortSignal;
  }) => Promise<boolean>;
  onPermissionGrants?: () => void;
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
  metricsLoading?: boolean;
  submitStatus?: string;
  sending?: boolean;
  promptHidden?: boolean;
  /** Keep only the original permission control while a business interaction owns the input. */
  permissionWhenPromptHidden?: boolean;
}
function canConfirmFull(props: ComposerProps) {
  return (
    !!props.permission &&
    props.permission !== 'full' &&
    !!props.onPermissionChange &&
    !props.disabled &&
    !props.readOnly &&
    !props.readGate?.permission &&
    !props.permissionDisabled &&
    !props.permissionPending &&
    (!props.promptHidden || props.permissionWhenPromptHidden === true)
  );
}
function samePermissionContext(original: ComposerProps, latest: ComposerProps) {
  return (
    latest.permission === original.permission &&
    latest.scopeKey === original.scopeKey &&
    latest.fullPermissionScope === original.fullPermissionScope &&
    latest.onPermissionChange === original.onPermissionChange &&
    latest.confirmFullPermission === original.confirmFullPermission
  );
}
function currentFullPermission(original: ComposerProps, latest: ComposerProps) {
  return canConfirmFull(latest) && samePermissionContext(original, latest);
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
  const fullConfirmation = useRef<AbortController | null>(null);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const [fullPermissionError, setFullPermissionError] = useState(false);
  const [attachmentMenuLayout, setAttachmentMenuLayout] = useState({
    width: 0,
    alignOffset: 0,
    sideOffset: 6,
  });
  const current = useRef(props);
  const filePick = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileDialog = useRef<ComposerProps | null>(null);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [preparingFiles, setPreparingFiles] = useState(false);
  const [fileError, setFileError] = useState<string>();
  useLayoutEffect(() => {
    if (current.current.scopeKey !== props.scopeKey) {
      fileDialog.current = null;
      filePick.current?.abort();
      filePick.current = null;
      setPickingFiles(false);
      setPreparingFiles(false);
      setFileError(undefined);
    }
    if (
      current.current.scopeKey !== props.scopeKey ||
      props.disabled ||
      props.readOnly ||
      props.promptHidden
    )
      setAttachmentMenuOpen(false);
    if (!canConfirmFull(props) || !samePermissionContext(current.current, props)) {
      const wasConfirming = !!fullConfirmation.current || confirmingFullScope !== null;
      fullConfirmation.current?.abort();
      fullConfirmation.current = null;
      setConfirmingFull(false);
      setFullPermissionError(false);
      if (wasConfirming) setPermissionMenuOpen(false);
      setConfirmingFullScope(null);
    }
    if (
      current.current.scopeKey !== props.scopeKey ||
      current.current.fullPermissionScope !== props.fullPermissionScope ||
      props.permissionDisabled ||
      props.readOnly ||
      props.readGate?.permission ||
      (props.promptHidden && !props.permissionWhenPromptHidden)
    )
      setPermissionMenuOpen(false);
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
      filePick.current?.abort();
      filePick.current = null;
      fileDialog.current = null;
      fullConfirmation.current?.abort();
      fullConfirmation.current = null;
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
    if (!filePickingEnabled || original.disabled || original.readOnly || !fileInput.current) return;
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
    if (
      !selected.length ||
      original.disabled ||
      original.readOnly ||
      current.current.scopeKey !== original.scopeKey
    )
      return;
    filePick.current?.abort();
    const token = new AbortController();
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
      setPreparingFiles(ordinary.length > 0);
      const files = ordinary.length ? await original.onFileReferences!(ordinary, token.signal) : [];
      const latest = current.current;
      if (
        filePick.current !== token ||
        latest.scopeKey !== original.scopeKey ||
        latest.disabled ||
        latest.readOnly ||
        latest.promptHidden
      )
        return;
      setPreparingFiles(false);
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
      // The host releases prepared files that were never handed to onFilesSelected.
      // Successfully adopted attachments have already left this preparation scope.
      token.abort();
      if (filePick.current === token) {
        filePick.current = null;
        setPickingFiles(false);
        setPreparingFiles(false);
      }
    }
  }
  const permissionLanguage =
    typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en';
  const permissionText = permissionCopy[permissionLanguage];
  async function confirmFullPermission() {
    const original = current.current;
    if (fullConfirmation.current || !currentFullPermission(original, original)) return;
    setFullPermissionError(false);
    if (!original.confirmFullPermission) {
      setConfirmingFullScope(original.fullPermissionScope ?? '');
      return;
    }
    const confirmation = new AbortController();
    fullConfirmation.current = confirmation;
    setConfirmingFull(true);
    setPermissionMenuOpen(false);
    const owned = () =>
      fullConfirmation.current === confirmation &&
      !confirmation.signal.aborted &&
      currentFullPermission(original, current.current);
    try {
      const accepted = await original.confirmFullPermission({
        language: permissionLanguage,
        signal: confirmation.signal,
      });
      if (accepted === true && owned()) original.onPermissionChange?.('full');
    } catch {
      if (owned()) setFullPermissionError(true);
    } finally {
      if (fullConfirmation.current === confirmation) {
        fullConfirmation.current = null;
        setConfirmingFull(false);
      }
    }
  }
  const permissionLabel = props.permission
    ? permissionText[props.permission].label
    : permissionText.placeholder;
  const cacheTokenTotal =
    (props.cacheMetrics?.cacheHitTokens ?? 0) + (props.cacheMetrics?.cacheMissTokens ?? 0);
  const cacheHitPercentage =
    !props.metricsLoading && cacheTokenTotal > 0
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
    (!!props.draft.trim() ||
      !!props.images?.length ||
      !!props.files?.length ||
      !!props.contextHasInput);
  const canSubmit = canSend && !props.readOnly && !props.readGate?.send;
  const showStop =
    !props.sending &&
    props.active &&
    !!props.onCancel &&
    ((!props.draft.trim() &&
      !props.images?.length &&
      !props.files?.length &&
      !props.contextHasInput) ||
      props.stopping);
  const permissionControl = (props.permission || props.sessionLoading) &&
    props.onPermissionChange && (
      <DropdownMenu
        open={permissionMenuOpen}
        onOpenChange={(open) => {
          if (
            !open ||
            (!fullConfirmation.current &&
              !current.current.permissionDisabled &&
              !current.current.readOnly &&
              !current.current.readGate?.permission &&
              current.current.permission)
          )
            setPermissionMenuOpen(open);
        }}
      >
        <DropdownMenuTrigger asChild>
          <ShadcnButton
            variant="ghost"
            size="sm"
            className={cn(
              'permission-trigger',
              props.permission === 'full' && 'permission-trigger-full',
            )}
            data-permission-trigger
            readOnly={props.readGate?.permission}
            aria-busy={
              confirmingFull || props.permissionPending || props.sessionLoading || undefined
            }
            aria-label={`${permissionText.name}${permissionLanguage === 'zh' ? '：' : ': '}${permissionLabel}${props.permissionPending ? (permissionLanguage === 'zh' ? '，切换中' : ', changing') : ''}`}
            disabled={confirmingFull || props.permissionDisabled || !props.permission}
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
                fullConfirmation.current ||
                current.current.permissionDisabled ||
                current.current.readOnly ||
                current.current.readGate?.permission ||
                !current.current.permission ||
                value === current.current.permission
              )
                return;
              if (value === 'full') {
                void confirmFullPermission();
              } else {
                setFullPermissionError(false);
                current.current.onPermissionChange?.(
                  value as NonNullable<ComposerProps['permission']>,
                );
              }
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
                      mode.value === 'full' && 'permission-menu-item-full',
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
          {props.onPermissionGrants && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => current.current.onPermissionGrants?.()}>
                {permissionText.grants}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  const fullPermissionDialog = !props.confirmFullPermission && (
    <FullPermissionConfirmationDialog
      language={permissionLanguage}
      open={confirmingFullScope !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmingFullScope(null);
      }}
      confirmDisabled={!canConfirmFull(props)}
      onConfirm={() => {
        if (
          !canConfirmFull(current.current) ||
          confirmingFullScope !== (current.current.fullPermissionScope ?? '')
        )
          return;
        current.current.onPermissionChange?.('full');
      }}
    />
  );
  const permissionError = fullPermissionError && (
    <p className="composer-input-error" role="alert">
      {fullPermissionConfirmationCopy[permissionLanguage].failed}
    </p>
  );
  if (props.promptHidden) {
    return props.permissionWhenPromptHidden ? (
      <ReadGate blocked={props.readOnly}>
        <div className="composer-toolbar" data-business-permissions>
          {permissionControl}
        </div>
        {permissionError}
        {fullPermissionDialog}
      </ReadGate>
    ) : null;
  }
  return (
    <ReadGate blocked={props.readOnly}>
      {props.context}
      <form
        ref={form}
        className="composer"
        data-permission-pending={props.permissionPending || undefined}
        data-session-loading={props.sessionLoading || undefined}
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
          if (canSubmit) props.onSend?.();
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
                !current.current.readOnly &&
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
            if (canSubmit) props.onSend?.();
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
        {permissionError}
        {preparingFiles && (
          <div
            className="flex items-center gap-2 px-3 py-1 text-sm text-muted-foreground"
            role="status"
            aria-label="正在添加附件"
          >
            <HugeiconsIcon
              icon={Loading03Icon}
              className="size-[var(--ui-icon-size,14px)] animate-spin"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                filePick.current?.abort();
                filePick.current = null;
                setPreparingFiles(false);
                setPickingFiles(false);
              }}
            >
              取消添加
            </Button>
          </div>
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
                    size="icon"
                    className="composer-attach"
                    aria-label="添加附件"
                    title="添加文件"
                    disabled={props.disabled || pickingFiles}
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
            {permissionControl}
          </div>
          <div className="composer-trailing">
            <div className="composer-metrics" aria-busy={props.metricsLoading || undefined}>
              <span
                className="composer-cache-rate"
                title={
                  cacheHitPercentage === undefined
                    ? props.metricsLoading
                      ? '正在读取缓存用量'
                      : '暂无缓存用量数据'
                    : `缓存命中 ${props.cacheMetrics!.cacheHitTokens} / ${cacheTokenTotal} tokens`
                }
              >
                {`缓存 ${cacheHitPercentage ?? 0}%`}
              </span>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <svg
                      className="composer-context-usage"
                      viewBox="0 0 16 16"
                      fill="none"
                      role="img"
                      tabIndex={props.metricsLoading ? undefined : 0}
                      aria-label={
                        props.metricsLoading
                          ? '正在读取上下文占用'
                          : contextPercentage === undefined
                            ? '上下文占用未知'
                            : `上下文占用约 ${contextPercentage}%`
                      }
                      aria-description={
                        props.metricsLoading
                          ? undefined
                          : `上下文估算 ${contextTokens ?? '未知'} / ${contextWindowTokens ?? '未知'} tokens`
                      }
                    >
                      <circle className="composer-context-track" cx="8" cy="8" r="6" />
                      {!props.metricsLoading &&
                        contextPercentage !== undefined &&
                        contextPercentage > 0 && (
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
                  </TooltipTrigger>
                  {!props.metricsLoading && (
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
                        {contextTokens === undefined
                          ? '已用未知，'
                          : `已用 ${contextTokenFormat.format(contextTokens).toLowerCase()} 标记，`}
                        {contextWindowTokens === undefined
                          ? '总量未知'
                          : `共 ${contextTokenFormat.format(contextWindowTokens).toLowerCase()}`}
                      </span>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="composer-actions">
              {showStop ? (
                <Button
                  className="primary composer-action stop-action"
                  size="icon"
                  aria-label={props.stopping ? '正在停止…' : '停止任务'}
                  title={props.stopping ? '正在停止…' : '停止任务'}
                  onClick={props.onCancel}
                  disabled={props.stopping || props.cancelDisabled}
                  readOnly={props.readGate?.cancel}
                >
                  <HugeiconsIcon icon={StopIcon} fill="currentColor" strokeWidth={0} />
                </Button>
              ) : (
                <Button
                  className="primary composer-action"
                  size="icon"
                  type="submit"
                  aria-label={
                    props.sendLabel ??
                    (props.sending
                      ? '正在发送消息'
                      : props.submitStatus
                        ? `发送消息：${props.submitStatus}`
                        : props.active
                          ? '排队后续输入'
                          : '发送消息')
                  }
                  title={
                    props.sendLabel ??
                    (props.sending
                      ? '正在发送消息'
                      : props.submitStatus || (props.active ? '排队后续输入' : '发送消息'))
                  }
                  aria-busy={props.sending || undefined}
                  disabled={!canSend}
                  readOnly={props.readGate?.send}
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
      {fullPermissionDialog}
      {props.submitStatus && (
        <span className="sr-only" aria-live="polite">
          {props.submitStatus}
        </span>
      )}
    </ReadGate>
  );
}
