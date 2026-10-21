import { Copy01Icon, CopyXIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
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
      size="icon-xs"
      disabled={disabled}
      aria-disabled={!readActive || disabled || undefined}
      aria-label={copyLabel}
      title={copyLabel}
      onClick={() => void copyMessage()}
    >
      <HugeiconsIcon
        className={copyState === 'copied' ? 'size-[18px]' : undefined}
        icon={copyState === 'copied' ? Tick02Icon : copyState === 'failed' ? CopyXIcon : Copy01Icon}
      />
    </Button>
  );
}
