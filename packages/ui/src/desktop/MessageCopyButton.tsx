import { Copy01Icon, CopyXIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memo, useMemo } from 'react';
import { useTextCopy } from './clipboard';
import { Button } from './ui';

/** The host supplies exact text; this control never reconstructs a message or Turn. */
export function MessageCopyButton({
  text,
  copyRole,
  writeClipboardText,
  disabled = false,
}: {
  text: string;
  copyRole?: 'user' | 'assistant';
  writeClipboardText?: (text: string) => Promise<void>;
  disabled?: boolean;
}) {
  const { copyState, copyMessage, readActive } = useTextCopy(text, writeClipboardText, disabled);
  return useMemo(
    () => (
      <CopyButtonView
        copyState={copyState}
        copyRole={copyRole}
        copyMessage={copyMessage}
        readActive={readActive}
        disabled={disabled}
      />
    ),
    [copyState, copyRole, copyMessage, readActive, disabled],
  );
}

const CopyButtonView = memo(function CopyButtonView({
  copyState,
  copyRole,
  copyMessage,
  readActive,
  disabled,
}: {
  copyState: ReturnType<typeof useTextCopy>['copyState'];
  copyRole?: 'user' | 'assistant';
  copyMessage: () => Promise<void>;
  readActive: boolean;
  disabled: boolean;
}) {
  const copyLabel =
    copyState === 'copied'
      ? '已复制消息'
      : copyState === 'failed'
        ? '复制失败，请重试'
        : copyRole === 'user'
          ? '复制本轮用户消息'
          : '复制本轮Agent回复';
  return (
    <Button
      type="button"
      className="message-copy"
      data-copy-state={copyState}
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-disabled={!readActive || disabled || undefined}
      aria-label={copyLabel}
      title={copyLabel}
      onClick={() => void copyMessage()}
    >
      <HugeiconsIcon
        icon={copyState === 'copied' ? Tick02Icon : copyState === 'failed' ? CopyXIcon : Copy01Icon}
      />
    </Button>
  );
});
